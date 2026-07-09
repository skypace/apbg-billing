// qbo-customer-lookup v1 — live QBO customer lookup by display name, with
// mirror heal.
//
// Purpose: ops.qbo_customers refreshes once a day (sync-qbo), so a brand-new
// customer created via the SF→QBO first-invoice flow is invisible to the
// portal for up to ~24h — brix-order's "Finish onboarding" button stays
// greyed even though the customer exists in QBO. This function lets
// brix-order's admin-list-onboarding ask QBO directly and, on a hit, upserts
// the row into ops.qbo_customers immediately (the nightly sync harmlessly
// re-upserts with full detail later).
//
// body: { display_name }  → { ok, found, customer: {id, display_name, email} }
//
// Requires header x-internal-secret == INTERNAL_PAY_SECRET. verify_jwt=false.
// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 3600;
const REFRESH_MIN_REMAINING_SECONDS = 300;
const LEASE_SECONDS = 20;
const LEASE_POLL_INTERVAL_MS = 750;
const LEASE_POLL_MAX_ATTEMPTS = 40;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*, authorization, content-type, apikey, x-internal-secret",
};

function getRealm(): string { return Deno.env.get("QBO_REALM_ID") || ""; }
function isSandbox(): boolean { return (Deno.env.get("QBO_ENVIRONMENT") ?? "production") === "sandbox"; }
function accountingBase(): string {
  return isSandbox() ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}
function getSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}
// Data client pinned to the ops schema for the mirror upsert (the default
// client targets public — see the "Default-schema bug" note in CLAUDE.md).
function getOpsSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false }, db: { schema: "ops" } },
  );
}
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── QBO token (same lease/refresh pattern as qbo-charge / qbo-cylinder-audit) ──
async function claimRefresh(sb: SupabaseClient): Promise<any> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return Array.isArray(data) ? data[0] : data;
}
async function persistTokens(sb: SupabaseClient, a: string, r: string, exp: number, rExp: number | null) {
  const accessExpiry = new Date(Date.now() + exp * 1000).toISOString();
  const refreshExpiry = new Date(Date.now() + (rExp ?? REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: a, p_access_expires: accessExpiry,
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-customer-lookup@v1",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
}
async function releaseFailedLease(sb: SupabaseClient, message: string) {
  await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: message.slice(0, 500) });
}
async function intuitRefresh(refreshToken: string) {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("missing QBO creds");
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + btoa(clientId + ":" + clientSecret),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("intuit refresh failed (" + res.status + "): " + JSON.stringify(data));
  return data;
}
async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < LEASE_POLL_MAX_ATTEMPTS; attempt++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const seed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) { await releaseFailedLease(sb, "no refresh token"); throw new Error("no refresh token available"); }
      try {
        const fresh = await intuitRefresh(seed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS, fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) { await releaseFailedLease(sb, (err as Error).message); throw err; }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}


// ── QBO Accounting (v3) ──
async function acctQuery(token: string, query: string): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + "/query?query=" + encodeURIComponent(query) + "&minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) throw new Error("QBO query (" + res.status + "): " + await res.text());
  return res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST required" }, 405);

  const startedAt = Date.now();
  const sb = getSB();
  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    const secret = Deno.env.get("INTERNAL_PAY_SECRET") || "";
    const provided = req.headers.get("x-internal-secret") || "";
    if (!secret || provided !== secret) return jsonRes({ ok: false, error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const name = String(body?.display_name || "").trim().slice(0, 200);
    if (name.length < 2) throw new Error("display_name required");

    const token = await getAccessToken(sb);
    const escaped = name.replace(/'/g, "\\'");
    const data = await acctQuery(token, "select Id, DisplayName, FullyQualifiedName, ParentRef, Active, PrimaryEmailAddr, PrimaryPhone from Customer where DisplayName = '" + escaped + "'");
    const rows: any[] = data?.QueryResponse?.Customer ?? [];
    if (rows.length === 0) {
      return jsonRes({ ok: true, found: false, duration_ms: Date.now() - startedAt });
    }
    const c = rows[0];

    // Mirror heal — same conflict key as sync-qbo; nightly run re-upserts.
    let mirrored = false;
    try {
      const ops = getOpsSB();
      const { error } = await ops.from("qbo_customers").upsert([{
        qbo_customer_id: String(c.Id),
        display_name: c.DisplayName ?? null,
        fully_qualified_name: c.FullyQualifiedName ?? null,
        parent_ref_id: c.ParentRef?.value ?? null,
        is_sub_customer: !!c.ParentRef?.value,
        active: c.Active !== false,
        email: c.PrimaryEmailAddr?.Address ?? null,
        phone: c.PrimaryPhone?.FreeFormNumber ?? null,
        synced_at: new Date().toISOString(),
      }], { onConflict: "qbo_customer_id" });
      mirrored = !error;
      if (error) console.error("qbo-customer-lookup mirror upsert failed:", error.message);
    } catch (err) {
      console.error("qbo-customer-lookup mirror upsert threw:", err);
    }

    return jsonRes({
      ok: true,
      found: true,
      customer: { id: String(c.Id), display_name: c.DisplayName ?? null, email: c.PrimaryEmailAddr?.Address ?? null },
      mirrored,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("qbo-customer-lookup failed:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
