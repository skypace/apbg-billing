// qbo-webhook v1 — Intuit QuickBooks webhook → live mirror refresh.
//
// Intuit POSTs an event notification whenever entities change (Invoice,
// Payment, …). We verify the HMAC signature, then for every affected invoice
// (directly, or via a changed Payment's LinkedTxn) we re-read it from QBO and
// update ops.qbo_invoices' balance/status in real time — so brix-order's portal
// flips an invoice to Paid within seconds of a payment, instead of waiting for
// the nightly sync.
//
// Security: Intuit signs the raw body with the Webhook Verifier Token
// (header `intuit-signature`, HMAC-SHA256, base64). verify_jwt MUST be false on
// this function (Intuit can't send a Supabase JWT); the signature IS the auth.
//
// New writer to ops.qbo_invoices — registered in architecture/sync-manifest.json.
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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*, authorization, content-type, intuit-signature",
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
    { auth: { persistSession: false }, db: { schema: "ops" } },
  );
}
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function reqId(): string { return crypto.randomUUID().replace(/-/g, "").slice(0, 32); }

// ── Intuit signature check (HMAC-SHA256 of raw body, base64) ──
async function signatureValid(rawBody: string, header: string | null): Promise<boolean> {
  const token = Deno.env.get("QBO_WEBHOOK_VERIFIER_TOKEN") || "";
  if (!token || !header) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computed === header;
}

// ── QBO token (same lease/refresh pattern as qbo-charge) ──
async function claimRefresh(sb: SupabaseClient): Promise<any> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(), p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS, p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return Array.isArray(data) ? data[0] : data;
}
async function persistTokens(sb: SupabaseClient, a: string, r: string, exp: number, rExp: number | null) {
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: a, p_access_expires: new Date(Date.now() + exp * 1000).toISOString(),
    p_refresh_token: r, p_refresh_expires: new Date(Date.now() + (rExp ?? REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    p_refreshed_by: "qbo-webhook@v1",
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
      "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
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
async function acctGet(token: string, path: string): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + path + "?minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json", "Request-Id": reqId() } });
  if (!res.ok) throw new Error("QBO acct GET " + path + " (" + res.status + "): " + (await res.text()).slice(0, 300));
  return res.json();
}

// Update one invoice's mirror row from QBO truth (balance/status drive Paid).
async function refreshInvoice(sb: SupabaseClient, token: string, invoiceId: string): Promise<boolean> {
  const j = await acctGet(token, "/invoice/" + encodeURIComponent(invoiceId));
  const inv = j?.Invoice;
  if (!inv?.Id) return false;
  const balance = parseFloat(inv.Balance) || 0;
  const { error } = await sb.from("qbo_invoices").update({
    balance,
    total_amount: parseFloat(inv.TotalAmt) || 0,
    status: balance === 0 ? "paid" : "open",
    qbo_updated_at: inv.MetaData?.LastUpdatedTime || null,
    synced_at: new Date().toISOString(),
  }).eq("qbo_invoice_id", String(inv.Id));
  if (error) throw new Error("update qbo_invoices " + inv.Id + ": " + error.message);
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST required" }, 405);

  const startedAt = Date.now();
  const sb = getSB();
  const raw = await req.text();

  // Auth = Intuit's HMAC signature over the raw body.
  if (!(await signatureValid(raw, req.headers.get("intuit-signature")))) {
    return jsonRes({ ok: false, error: "invalid signature" }, 401);
  }

  try {
    const body = JSON.parse(raw || "{}");
    const notifications: any[] = body?.eventNotifications ?? [];

    // Collect invoice ids to refresh: direct Invoice changes + invoices linked
    // to changed Payments.
    const invoiceIds = new Set<string>();
    const paymentIds = new Set<string>();
    const deleteInvoiceIds = new Set<string>();
    for (const n of notifications) {
      if (getRealm() && String(n?.realmId) !== getRealm()) continue;
      for (const e of n?.dataChangeEvent?.entities ?? []) {
        const op = String(e?.operation || "");
        if (e?.name === "Invoice" && e?.id) {
          if (op === "Delete" || op === "Merge") deleteInvoiceIds.add(String(e.id));
          else invoiceIds.add(String(e.id));
        } else if (e?.name === "Payment" && e?.id) paymentIds.add(String(e.id));
      }
    }

    if (invoiceIds.size === 0 && paymentIds.size === 0 && deleteInvoiceIds.size === 0) {
      return jsonRes({ ok: true, refreshed: 0, note: "no invoice/payment entities", duration_ms: Date.now() - startedAt });
    }

    const token = await getAccessToken(sb);

    // Expand changed Payments → the invoices they apply to.
    for (const pid of paymentIds) {
      try {
        const pj = await acctGet(token, "/payment/" + encodeURIComponent(pid));
        for (const line of pj?.Payment?.Line ?? []) {
          for (const lt of line?.LinkedTxn ?? []) {
            if (lt?.TxnType === "Invoice" && lt?.TxnId) invoiceIds.add(String(lt.TxnId));
          }
        }
      } catch (e) { console.error("payment expand " + pid + ": " + (e as Error).message); }
    }

    let refreshed = 0;
    for (const id of invoiceIds) {
      try { if (await refreshInvoice(sb, token, id)) refreshed++; }
      catch (e) { console.error("refresh invoice " + id + ": " + (e as Error).message); }
    }

    // Deleted/merged in QBO → prune the mirror row so it stops ghosting in the portal.
    let deleted = 0;
    if (deleteInvoiceIds.size > 0) {
      const ids = [...deleteInvoiceIds];
      const { data: rows } = await sb.from("qbo_invoices").select("id").in("qbo_invoice_id", ids);
      const bigints = (rows ?? []).map((r: any) => r.id);
      if (bigints.length > 0) {
        await sb.from("qbo_invoice_lines").delete().in("invoice_id", bigints);
        const { count } = await sb.from("qbo_invoices").delete({ count: "exact" }).in("id", bigints);
        deleted = count ?? bigints.length;
      }
    }

    await sb.from("sync_log").insert({
      source: "qbo", sync_type: "webhook", status: "success",
      records_synced: refreshed + deleted, completed_at: new Date().toISOString(),
      metadata: { invoices: invoiceIds.size, payments: paymentIds.size, deleted },
    });

    return jsonRes({ ok: true, refreshed, deleted, invoices: invoiceIds.size, payments: paymentIds.size, duration_ms: Date.now() - startedAt });
  } catch (err) {
    console.error("qbo-webhook FATAL:", err);
    await sb.from("sync_log").insert({
      source: "qbo", sync_type: "webhook", status: "error",
      error_message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      completed_at: new Date().toISOString(),
    }).then(() => {}, () => {});
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
