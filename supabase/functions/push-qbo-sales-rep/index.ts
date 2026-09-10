// push-qbo-sales-rep — APBG-OPS Supabase project
//
// Reads each customer's primary sales rep from ops.customer_sales_reps
// (joined to ops.sales_reps for name) and writes it to QBO as a
// Customer-level custom field named "Sales Rep".
//
// QBO Online does not expose a native SalesRep entity. The standard
// workaround is a Customer custom field. The custom field definition
// ("Sales Rep", type Text) MUST already exist in QBO Online (Settings
// → Custom fields). This function only updates values on customers
// where the field is already attached. If a customer's record has no
// CustomField entry for "Sales Rep", that customer is reported in
// summary.skipped_no_field with instructions.
//
// Defaults to dry_run; pass {commit: true} to write.

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
const CUSTOM_FIELD_NAME = "Sales Rep";

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
  return env === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}
function getSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}
function jsonRes(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function claimRefresh(sb: SupabaseClient): Promise<ClaimResult> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(), p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS, p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return (Array.isArray(data) ? data[0] : data) as ClaimResult;
}
async function persistTokens(sb: SupabaseClient, accessToken: string, refreshToken: string, expiresInSeconds: number, refreshTokenExpiresInSeconds: number | null): Promise<void> {
  const accessExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshExpiry = refreshTokenExpiresInSeconds
    ? new Date(Date.now() + refreshTokenExpiresInSeconds * 1000).toISOString()
    : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: accessToken, p_access_expires: accessExpiry,
    p_refresh_token: refreshToken, p_refresh_expires: refreshExpiry,
    p_refreshed_by: "push-qbo-sales-rep@v1",
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
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: "Basic " + creds },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("intuit refresh failed: " + JSON.stringify(data));
  return data;
}
async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < LEASE_POLL_MAX_ATTEMPTS; attempt++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const refreshSeed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!refreshSeed) { await releaseFailedLease(sb, "no refresh token"); throw new Error("no refresh token"); }
      try {
        const fresh = await intuitRefresh(refreshSeed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token, fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS, fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) { await releaseFailedLease(sb, (err as Error).message); throw err; }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}
async function qboGet(sb: SupabaseClient, path: string): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) throw new Error("QBO GET " + path + " failed (" + res.status + "): " + await res.text());
  return res.json();
}
async function qboPost(sb: SupabaseClient, path: string, body: any): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("QBO POST " + path + " failed (" + res.status + "): " + await res.text());
  return res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const startedAt = Date.now();
  const sb = getSB();
  let commit = false;
  try {
    if (req.method === "POST") { const b = await req.json().catch(() => ({})); commit = b && b.commit === true; }
    else { commit = new URL(req.url).searchParams.get("commit") === "true"; }
  } catch (_) {}

  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    await getAccessToken(sb);

    const { data: targets, error: tErr } = await sb.schema("ops")
      .from("customer_sales_reps")
      .select("qbo_customer_id, rep_code, is_primary, sales_reps:rep_code (name, is_active)")
      .eq("is_primary", true);
    if (tErr) throw new Error("read customer_sales_reps: " + tErr.message);

    const desired = new Map<string, string>();
    for (const t of targets ?? []) {
      const r: any = (t as any)?.sales_reps;
      if (r && r.is_active && r.name && t.qbo_customer_id) desired.set(t.qbo_customer_id, String(r.name).trim());
    }

    const summary = {
      total: desired.size,
      already_correct: 0, would_update: 0, updated: 0,
      skipped_no_field: [] as any[],
      errors: [] as any[],
    };

    let i = 0;
    for (const [custId, repName] of desired) {
      i++;
      try {
        const j = await qboGet(sb, "/customer/" + encodeURIComponent(custId));
        const cust = j?.Customer;
        if (!cust) { summary.errors.push({ custId, error: "customer not found in QBO" }); continue; }
        const cf = (cust.CustomField || []) as any[];
        const target = cf.find((f) => String(f?.Name || "").trim().toLowerCase() === CUSTOM_FIELD_NAME.toLowerCase());
        if (!target) {
          summary.skipped_no_field.push({ custId, customer: cust.DisplayName, reason: "no '" + CUSTOM_FIELD_NAME + "' custom field on this customer" });
          continue;
        }
        const currentValue = String(target.StringValue || "").trim();
        if (currentValue === repName) { summary.already_correct++; continue; }
        if (!commit) { summary.would_update++; continue; }

        const newCf = cf.map((f) => f === target ? { ...f, StringValue: repName } : f);
        await qboPost(sb, "/customer", {
          Id: cust.Id,
          SyncToken: cust.SyncToken,
          sparse: true,
          CustomField: newCf,
        });
        summary.updated++;
      } catch (e) {
        summary.errors.push({ custId, error: (e as Error).message });
      }
      if (i % 50 === 0) await sleep(200);
    }

    return jsonRes({
      ok: true, commit, realm_id: getRealm(),
      desired_total: desired.size,
      summary,
      setup_note: summary.skipped_no_field.length > 0
        ? "Some customers don't have the '" + CUSTOM_FIELD_NAME + "' custom field attached. Define it in QBO Web → Settings → Custom fields, mark it as 'All Customers', then re-run."
        : null,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("push-qbo-sales-rep FATAL:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
