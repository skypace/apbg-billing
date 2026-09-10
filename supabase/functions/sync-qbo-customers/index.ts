// sync-qbo-customers edge function — APBG-OPS Supabase project
// Pulls QBO Customer master into ops.qbo_customers so the margin
// dashboard can join channel taxonomy via ops.customer_channels.
//
// Mirrors sync-qbo-employees v2 / sync-qbo-items v1: lease-based token
// rotation through ops.qbo_token_cache shared with the sync-qbo pipeline.

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 3600;
const REFRESH_MIN_REMAINING_SECONDS = 300;
const LEASE_SECONDS = 20;
const LEASE_POLL_INTERVAL_MS = 750;
const LEASE_POLL_MAX_ATTEMPTS = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

type QboRef = { value?: string; name?: string };
type QboAddr = {
  Line1?: string; Line2?: string;
  City?: string; CountrySubDivisionCode?: string;
  PostalCode?: string;
};

type QboCustomer = {
  Id: string;
  DisplayName?: string;
  FullyQualifiedName?: string;
  Active?: boolean;
  Job?: boolean;
  ParentRef?: QboRef;
  CustomerTypeRef?: QboRef;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: QboAddr;
  ShipAddr?: QboAddr;
  Notes?: string;
  MetaData?: { LastUpdatedTime?: string };
};

interface ClaimResult {
  cached_access_token: string | null;
  cached_refresh_token: string | null;
  must_refresh: boolean;
  lease_acquired: boolean;
  reason: string;
}

function getRealm(): string { return Deno.env.get("QBO_REALM_ID") || ""; }
function qboBaseUrl(): string {
  const env = Deno.env.get("QBO_ENVIRONMENT") ?? "production";
  return env === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}
function getSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function claimRefresh(sb: SupabaseClient): Promise<ClaimResult> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row as ClaimResult;
}

async function persistTokens(
  sb: SupabaseClient, accessToken: string, refreshToken: string,
  expiresInSeconds: number, refreshTokenExpiresInSeconds: number | null,
): Promise<void> {
  const accessExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshExpiry = refreshTokenExpiresInSeconds
    ? new Date(Date.now() + refreshTokenExpiresInSeconds * 1000).toISOString()
    : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(),
    p_access_token: accessToken,
    p_access_expires: accessExpiry,
    p_refresh_token: refreshToken,
    p_refresh_expires: refreshExpiry,
    p_refreshed_by: "sync-qbo-customers@v1",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
}

async function releaseFailedLease(sb: SupabaseClient, message: string): Promise<void> {
  await sb.rpc("qbo_token_release_failed", {
    p_realm_id: getRealm(),
    p_error: message.slice(0, 500),
  });
}

async function intuitRefresh(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
}> {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("missing QBO_CLIENT_ID or QBO_CLIENT_SECRET env");
  const creds = btoa(clientId + ":" + clientSecret);
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + creds,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("intuit refresh failed (" + res.status + "): " + JSON.stringify(data));
  }
  return data;
}

async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < LEASE_POLL_MAX_ATTEMPTS; attempt++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const refreshSeed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!refreshSeed) {
        await releaseFailedLease(sb, "no refresh token available");
        throw new Error("no refresh token available");
      }
      try {
        const fresh = await intuitRefresh(refreshSeed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS,
          fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) {
        await releaseFailedLease(sb, (err as Error).message);
        throw err;
      }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}

async function fetchAllCustomers(sb: SupabaseClient): Promise<QboCustomer[]> {
  const realm = getRealm();
  const base = qboBaseUrl();
  const all: QboCustomer[] = [];
  const pageSize = 1000;
  let startPosition = 1;

  while (true) {
    const q = encodeURIComponent(
      `select * from Customer startposition ${startPosition} maxresults ${pageSize}`,
    );
    const url = `${base}/v3/company/${realm}/query?query=${q}&minorversion=70`;
    let token = await getAccessToken(sb);
    let resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (resp.status === 401) {
      await sb.rpc("qbo_token_release_failed", {
        p_realm_id: realm, p_error: "401 from QBO Customer query",
      });
      token = await getAccessToken(sb);
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`QBO query failed (${resp.status}): ${text}`);
    }
    const json: any = await resp.json();
    const batch: QboCustomer[] = json?.QueryResponse?.Customer ?? [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    startPosition += pageSize;
  }
  return all;
}

function toRow(c: QboCustomer) {
  const bill = c.BillAddr ?? {};
  const ship = c.ShipAddr ?? {};
  return {
    qbo_customer_id: c.Id,
    display_name: c.DisplayName ?? c.FullyQualifiedName ?? `Customer ${c.Id}`,
    fully_qualified_name: c.FullyQualifiedName ?? null,
    parent_ref_id: c.ParentRef?.value ?? null,
    is_sub_customer: c.Job ?? false,
    active: c.Active ?? true,
    customer_type_ref_id: c.CustomerTypeRef?.value ?? null,
    customer_type_name: c.CustomerTypeRef?.name ?? null,
    email: c.PrimaryEmailAddr?.Address ?? null,
    phone: c.PrimaryPhone?.FreeFormNumber ?? null,
    bill_addr_line1: bill.Line1 ?? null,
    bill_addr_city: bill.City ?? null,
    bill_addr_state: bill.CountrySubDivisionCode ?? null,
    bill_addr_postal: bill.PostalCode ?? null,
    ship_addr_city: ship.City ?? null,
    ship_addr_state: ship.CountrySubDivisionCode ?? null,
    notes: c.Notes ?? null,
    qbo_updated_at: c.MetaData?.LastUpdatedTime
      ? new Date(c.MetaData.LastUpdatedTime).toISOString() : null,
    synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const startedAt = Date.now();
  const sb = getSB();

  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

    await getAccessToken(sb);
    const customers = await fetchAllCustomers(sb);
    const rows = customers.map(toRow);
    const withType = rows.filter((r) => r.customer_type_ref_id != null).length;

    let upserted = 0;
    if (rows.length) {
      const { error } = await sb.schema("ops").from("qbo_customers")
        .upsert(rows, { onConflict: "qbo_customer_id" });
      if (error) throw error;
      upserted = rows.length;
    }

    return jsonRes({
      ok: true,
      realm_id: getRealm(),
      synced: customers.length,
      with_qbo_type: withType,
      upserted,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("sync-qbo-customers FATAL:", err);
    return jsonRes({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    }, 500);
  }
});
