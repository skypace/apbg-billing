// qbo-record-external-payment — book a QBO Payment for a payment that already
// moved on an EXTERNAL rail (Stripe). Stripe moves the money; QuickBooks still
// needs a Payment record applied to the invoice(s) so the ledger reconciles and
// the invoice shows paid. This is the brix-order Stripe rail's "automatic in
// QBO" step (design: brix-order/docs/STRIPE-RAIL.md).
//
//   POST  header x-internal-secret == INTERNAL_PAY_SECRET
//   body: {
//     mode?: 'record' | 'preview',           // default 'record'
//     customer_qbo_id: string,
//     invoices: [{ qbo_invoice_id: string, amount: number }],
//     external_ref?: string,                  // Stripe pi_… (memo/PaymentRefNum)
//     memo?: string
//   }
//
// Creates ONE QBO Payment (ReceivePayment) whose lines link the given invoices
// (deposited to Undeposited Funds — Stripe payout/fee reconciliation is a
// separate accounting concern). It does NOT write the ops.qbo_invoices mirror
// (that would add a second writer to ops — sync-manifest); the caller
// (brix-order) nudges sync-qbo?mode=cdc after this returns so the portal
// reflects "paid".
//
// verify_jwt=false; security is the internal secret + QBO OAuth. Same
// lease/refresh pattern as qbo-charge / qbo-returned-payment.

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
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── QBO token (same lease/refresh pattern as qbo-charge / qbo-returned-payment) ──
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
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-record-external-payment@v1",
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
async function acctGet(token: string, path: string): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) throw new Error("QBO acct GET " + path + " (" + res.status + "): " + await res.text());
  return res.json();
}
async function acctPost(token: string, path: string, body: any): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("QBO acct POST " + path + " (" + res.status + "): " + await res.text());
  return res.json();
}

interface InvoiceInput { qbo_invoice_id: string; amount: number }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") return jsonRes({ ok: false, error: "POST only" }, 405);

    const secret = Deno.env.get("INTERNAL_PAY_SECRET") || "";
    if (!secret || req.headers.get("x-internal-secret") !== secret) {
      return jsonRes({ ok: false, error: "unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "record";
    const customerQboId = String(body.customer_qbo_id ?? "").trim();
    const invoices: InvoiceInput[] = Array.isArray(body.invoices) ? body.invoices : [];
    const externalRef = String(body.external_ref ?? "").trim();
    const memo = String(body.memo ?? "").trim();

    if (!customerQboId) return jsonRes({ ok: false, error: "customer_qbo_id required" }, 400);
    if (invoices.length === 0) return jsonRes({ ok: false, error: "invoices required" }, 400);
    for (const inv of invoices) {
      if (!inv.qbo_invoice_id || !(Number(inv.amount) > 0)) {
        return jsonRes({ ok: false, error: "each invoice needs qbo_invoice_id + positive amount" }, 400);
      }
    }
    const total = Number(invoices.reduce((s, i) => s + Number(i.amount), 0).toFixed(2));

    const sb = getSB();
    const token = await getAccessToken(sb);

    // Verify each invoice exists + belongs to the customer, and (preview) report
    // current balances.
    const resolved: Array<{ qbo_invoice_id: string; balance: number; amount: number }> = [];
    for (const inv of invoices) {
      const j = await acctGet(token, "/invoice/" + encodeURIComponent(inv.qbo_invoice_id));
      const invoice = j?.Invoice;
      if (!invoice) return jsonRes({ ok: false, error: "invoice " + inv.qbo_invoice_id + " not found in QBO" }, 404);
      if (String(invoice?.CustomerRef?.value) !== customerQboId) {
        return jsonRes({ ok: false, error: "invoice " + inv.qbo_invoice_id + " is not for customer " + customerQboId }, 409);
      }
      resolved.push({ qbo_invoice_id: inv.qbo_invoice_id, balance: Number(invoice?.Balance ?? 0), amount: Number(inv.amount) });
    }

    if (mode === "preview") {
      return jsonRes({ ok: true, mode: "preview", customer_qbo_id: customerQboId, total, invoices: resolved });
    }

    // Create the QBO Payment applying the amount(s) to the invoice line(s).
    const payment = {
      CustomerRef: { value: customerQboId },
      TotalAmt: total,
      ...(externalRef ? { PaymentRefNum: externalRef.slice(0, 21) } : {}),
      PrivateNote: (memo || "Stripe payment") + (externalRef ? " (" + externalRef + ")" : ""),
      Line: invoices.map((inv) => ({
        Amount: Number(inv.amount),
        LinkedTxn: [{ TxnId: String(inv.qbo_invoice_id), TxnType: "Invoice" }],
      })),
    };
    const created = await acctPost(token, "/payment", payment);
    const paymentId = created?.Payment?.Id ?? null;

    return jsonRes({ ok: true, qbo_payment_id: paymentId, total, invoices: resolved });
  } catch (err) {
    return jsonRes({ ok: false, error: (err as Error).message }, 500);
  }
});
