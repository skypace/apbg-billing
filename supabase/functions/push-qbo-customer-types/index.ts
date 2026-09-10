// push-qbo-customer-types — APBG-OPS Supabase project
//
// Reads each customer's primary_channel from ops.customer_channels,
// ensures a matching QBO CustomerType exists (creates it if missing),
// and writes Customer.CustomerTypeRef on the customer record in QBO.
//
// Defaults to dry-run; pass {"commit": true} in the POST body to actually
// write. Returns a per-customer summary.
//
// Mirrors sync-qbo-customers v1 OAuth handling (lease-based shared token).

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
    status, headers: { "Content-Type": "application/json", ...CORS },
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
async function persistTokens(sb: SupabaseClient, accessToken: string, refreshToken: string,
  expiresInSeconds: number, refreshTokenExpiresInSeconds: number | null): Promise<void> {
  const accessExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshExpiry = refreshTokenExpiresInSeconds
    ? new Date(Date.now() + refreshTokenExpiresInSeconds * 1000).toISOString()
    : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: accessToken, p_access_expires: accessExpiry,
    p_refresh_token: refreshToken, p_refresh_expires: refreshExpiry,
    p_refreshed_by: "push-qbo-customer-types@v1",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
}
async function releaseFailedLease(sb: SupabaseClient, message: string): Promise<void> {
  await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: message.slice(0, 500) });
}
async function intuitRefresh(refreshToken: string) {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("missing QBO creds");
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

async function qboGet(sb: SupabaseClient, path: string): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("QBO GET " + path + " failed (" + res.status + "): " + text);
  }
  return res.json();
}
async function qboPost(sb: SupabaseClient, path: string, body: any): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("QBO POST " + path + " failed (" + res.status + "): " + text);
  }
  return res.json();
}

async function fetchAllCustomerTypes(sb: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let start = 1;
  const page = 1000;
  while (true) {
    const q = encodeURIComponent(`select * from CustomerType startposition ${start} maxresults ${page}`);
    const j = await qboGet(sb, "/query?query=" + q);
    const list = j?.QueryResponse?.CustomerType ?? [];
    for (const t of list) {
      if (t?.Name) map.set(String(t.Name).trim(), String(t.Id));
    }
    if (list.length < page) break;
    start += page;
  }
  return map;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const startedAt = Date.now();
  const sb = getSB();
  let commit = false;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      commit = body && body.commit === true;
    } else {
      const url = new URL(req.url);
      commit = url.searchParams.get("commit") === "true";
    }
  } catch (_e) {}

  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    await getAccessToken(sb);

    // 1. Fetch the desired primary channel for every classified customer.
    const { data: targets, error: tErr } = await sb
      .schema("ops")
      .from("customer_channels")
      .select("qbo_customer_id, channel_code, is_primary, channels:channel_code (label)")
      .eq("is_primary", true);
    if (tErr) throw new Error("read customer_channels: " + tErr.message);

    const desired = new Map<string, string>();   // qbo_customer_id → channel label
    for (const t of targets ?? []) {
      const lbl = (t as any)?.channels?.label;
      if (lbl && t.qbo_customer_id) desired.set(t.qbo_customer_id, String(lbl).trim());
    }

    // 2. Map QBO CustomerTypes by name → Id; create any missing.
    const typeMap = await fetchAllCustomerTypes(sb);
    const desiredLabels = Array.from(new Set(Array.from(desired.values())));
    const created: string[] = [];
    for (const lbl of desiredLabels) {
      if (typeMap.has(lbl)) continue;
      if (!commit) {
        created.push(lbl + " (would create)");
        continue;
      }
      const j = await qboPost(sb, "/customertype", { Name: lbl, Active: true });
      const id = j?.CustomerType?.Id;
      const name = j?.CustomerType?.Name;
      if (id && name) typeMap.set(name, id);
      created.push(lbl);
    }

    // 3. For each desired customer, GET current CustomerTypeRef and update if mismatched.
    const summary = { total: desired.size, already_correct: 0, would_update: 0, updated: 0, errors: [] as any[] };
    let i = 0;
    for (const [custId, label] of desired) {
      i++;
      try {
        const j = await qboGet(sb, "/customer/" + encodeURIComponent(custId));
        const cust = j?.Customer;
        if (!cust) { summary.errors.push({ custId, error: "customer not found in QBO" }); continue; }
        const wantId = typeMap.get(label);
        if (!wantId) { summary.errors.push({ custId, error: "no CustomerType id for " + label }); continue; }
        const currentId = cust?.CustomerTypeRef?.value;
        if (currentId === wantId) { summary.already_correct++; continue; }
        if (!commit) { summary.would_update++; continue; }
        await qboPost(sb, "/customer", {
          Id: cust.Id,
          SyncToken: cust.SyncToken,
          sparse: true,
          CustomerTypeRef: { value: wantId, name: label },
        });
        summary.updated++;
      } catch (e) {
        summary.errors.push({ custId, error: (e as Error).message });
      }
      // Be polite: brief pause every 50 to avoid rate limits.
      if (i % 50 === 0) await sleep(200);
    }

    return jsonRes({
      ok: true,
      commit,
      realm_id: getRealm(),
      desired_total: desired.size,
      types_created: created,
      summary,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("push-qbo-customer-types FATAL:", err);
    return jsonRes({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    }, 500);
  }
});
