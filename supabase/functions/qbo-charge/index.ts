// qbo-charge v1 — QuickBooks Payments charge + Accounting Payment recording.
//
// Home for the brix-order /pay live charge. Lives here (apbg-billing) because
// QBO token management + refresh already live in this project; brix-order never
// calls QBO directly. Deploys to the shared Supabase project.
//
// Modes (body.mode):
//   "preflight" — verify the cached token actually carries the QBO PAYMENTS
//                 scope, WITHOUT charging. Does a GET against the Payments v4
//                 API for a bogus charge id and interprets the status:
//                   404 → authorized (scope present, id just not found)
//                   401/403 → token lacks the payment scope / merchant access
//                 No internal secret required (reveals only a boolean).
//   "vault"     — turn a single-use Intuit token into a REUSABLE card-on-file
//                 (or bank-on-file) under the QBO customer, returning the stored
//                 method id + display-safe brand/last4. Used by brix-order's
//                 payments-add-method so autopay can charge later with no
//                 customer present. No PAN/bank number ever leaves QBO.
//   "dry_run"   — read the requested invoices from QBO, verify they belong to
//                 the customer + are open, compute the total. No charge.
//   "charge"    — dry_run + POST a Payments v4 echeck (ACH) or charge (card)
//                 using EITHER a single-use token (customer present, e.g. /pay)
//                 OR a stored method id (card_on_file / bank_account_on_file —
//                 autopay, no customer present), THEN record an Accounting
//                 Payment linking the invoice(s) so QBO reconciles.
//
// "dry_run" and "charge" require header x-internal-secret == INTERNAL_PAY_SECRET
// so only brix-order's pay-invoices function (server-side) can move money.
//
// verify_jwt=false; security is the internal secret + QBO OAuth.
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
  "Access-Control-Allow-Headers": "*, authorization, content-type, apikey, x-internal-secret",
};

function getRealm(): string { return Deno.env.get("QBO_REALM_ID") || ""; }
function isSandbox(): boolean { return (Deno.env.get("QBO_ENVIRONMENT") ?? "production") === "sandbox"; }
function accountingBase(): string {
  return isSandbox() ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}
function paymentsBase(): string {
  return isSandbox() ? "https://sandbox.api.intuit.com" : "https://api.intuit.com";
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
function reqId(): string { return crypto.randomUUID().replace(/-/g, "").slice(0, 32); }

// ── QBO token (same lease/refresh pattern as push-qbo-item) ──
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
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-charge@v1",
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
  const url = accountingBase() + "/v3/company/" + getRealm() + path + "?minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("QBO acct POST " + path + " (" + res.status + "): " + await res.text());
  return res.json();
}

// ── QBO Payments (v4) ──
async function paymentsGet(token: string, path: string): Promise<Response> {
  return fetch(paymentsBase() + "/quickbooks/v4/payments" + path, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Request-Id": reqId() },
  });
}
async function paymentsPost(token: string, path: string, body: any): Promise<any> {
  const res = await fetch(paymentsBase() + "/quickbooks/v4/payments" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token, Accept: "application/json",
      "Content-Type": "application/json", "Request-Id": reqId(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("QBO Payments POST " + path + " (" + res.status + "): " + JSON.stringify(data));
  return data;
}
// Customer-scoped Payments endpoints (card/bank vaulting lives under /customers).
async function customersPost(token: string, path: string, body: any): Promise<any> {
  const res = await fetch(paymentsBase() + "/quickbooks/v4/customers" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token, Accept: "application/json",
      "Content-Type": "application/json", "Request-Id": reqId(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("QBO Payments customers POST " + path + " (" + res.status + "): " + JSON.stringify(data));
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST required" }, 405);

  const startedAt = Date.now();
  const sb = getSB();
  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "").trim();

    // ---- preflight: verify the token has the Payments scope (no charge) ----
    if (mode === "preflight") {
      const token = await getAccessToken(sb);
      const res = await paymentsGet(token, "/charges/preflight-nonexistent-000");
      const status = res.status;
      await res.body?.cancel().catch(() => {});
      const scopeOk = status === 404; // authorized but not found = scope present
      return jsonRes({
        ok: true, mode, payment_scope: scopeOk, http_status: status,
        environment: isSandbox() ? "sandbox" : "production",
        note: scopeOk
          ? "Token carries the QBO Payments scope — charges can run."
          : "Token did NOT authorize the Payments API (status " + status + "). The OAuth grant likely lacks com.intuit.quickbooks.payment.",
        duration_ms: Date.now() - startedAt,
      });
    }

    // ---- money modes: require the internal secret ----
    const secret = Deno.env.get("INTERNAL_PAY_SECRET") || "";
    const provided = req.headers.get("x-internal-secret") || "";
    if (!secret || provided !== secret) return jsonRes({ ok: false, error: "unauthorized" }, 401);

    // ---- vault: turn a single-use token into a reusable card/bank-on-file ----
    // Used by brix-order's payments-add-method so autopay can charge a saved
    // method later with no customer present. Returns the stored method id +
    // display-safe brand/last4 (no PAN ever leaves QBO).
    if (mode === "vault") {
      const custId = String(body?.customer_qbo_id || "").trim();
      if (!/^[0-9]+$/.test(custId)) throw new Error("bad customer_qbo_id");
      const vaultToken = String(body?.token || "").trim();
      if (!vaultToken) throw new Error("token (single-use) required for vault");
      const vtype = body?.type === "ach" ? "ach" : "card";
      const vtoken = await getAccessToken(sb);
      if (vtype === "card") {
        const card = await customersPost(vtoken, "/" + custId + "/cards/createFromToken", { value: vaultToken });
        const num = String(card?.number ?? "").replace(/[^0-9]/g, "");
        return jsonRes({
          ok: true, mode, qbo_method_id: String(card?.id || ""),
          brand: card?.cardType ?? null, last4: num ? num.slice(-4) : null,
          exp_month: card?.expMonth != null ? Number(card.expMonth) : null,
          exp_year: card?.expYear != null ? Number(card.expYear) : null,
          duration_ms: Date.now() - startedAt,
        });
      }
      const ba = await customersPost(vtoken, "/" + custId + "/bank-accounts/createFromToken", { value: vaultToken });
      const num = String(ba?.accountNumber ?? "").replace(/[^0-9]/g, "");
      return jsonRes({
        ok: true, mode, qbo_method_id: String(ba?.id || ""),
        brand: ba?.name ?? "Bank account", last4: num ? num.slice(-4) : null,
        exp_month: null, exp_year: null, duration_ms: Date.now() - startedAt,
      });
    }

    const customerQboId = String(body?.customer_qbo_id || "").trim();
    const invoiceIds: string[] = Array.isArray(body?.invoice_ids) ? body.invoice_ids.map((x: any) => String(x)) : [];
    const type = body?.type === "card" ? "card" : "ach";
    if (!customerQboId) throw new Error("customer_qbo_id required");
    if (invoiceIds.length === 0) throw new Error("invoice_ids required");
    if (!/^[0-9]+$/.test(customerQboId)) throw new Error("bad customer_qbo_id");
    if (!invoiceIds.every((id) => /^[0-9]+$/.test(id))) throw new Error("bad invoice id");

    const token = await getAccessToken(sb);

    // Read each invoice from QBO (source of truth) — verify owner + open, sum balances.
    const lines: { id: string; balance: number }[] = [];
    for (const id of invoiceIds) {
      const j = await acctGet(token, "/invoice/" + encodeURIComponent(id));
      const inv = j?.Invoice;
      if (!inv?.Id) throw new Error("invoice not found in QBO: " + id);
      if (String(inv?.CustomerRef?.value) !== customerQboId) throw new Error("invoice " + id + " is not this customer's");
      const bal = Number(inv?.Balance ?? 0);
      if (!(bal > 0)) throw new Error("invoice " + id + " has no open balance");
      lines.push({ id, balance: Number(bal.toFixed(2)) });
    }
    const total = Number(lines.reduce((s, l) => s + l.balance, 0).toFixed(2));

    if (mode === "dry_run") {
      return jsonRes({ ok: true, mode, type, customer_qbo_id: customerQboId, lines, total, duration_ms: Date.now() - startedAt });
    }

    if (mode === "charge") {
      // Either a single-use token (customer present, e.g. /pay) OR a stored
      // method id (autopay: card_on_file / bank_account_on_file, no customer present).
      const payToken = String(body?.token || "").trim();
      const cardOnFile = String(body?.card_on_file || "").trim();
      const bankOnFile = String(body?.bank_account_on_file || "").trim();
      if (!payToken && !cardOnFile && !bankOnFile) {
        throw new Error("a single-use token or a stored method (card_on_file / bank_account_on_file) is required for charge");
      }
      const amountStr = total.toFixed(2);

      // 1. Move the money via Payments v4.
      let chargeId: string;
      if (type === "card") {
        const chargeBody: any = payToken
          ? { amount: amountStr, currency: "USD", token: payToken, context: { mobile: "false", isEcommerce: "true" } }
          : { amount: amountStr, currency: "USD", cardOnFile, context: { mobile: "false", isEcommerce: "true" } };
        const charged = await paymentsPost(token, "/charges", chargeBody);
        chargeId = String(charged?.id || "");
        if (!chargeId || charged?.status === "DECLINED") throw new Error("card charge not approved: " + JSON.stringify(charged).slice(0, 300));
      } else {
        const echeckBody: any = payToken
          ? { amount: amountStr, token: payToken, paymentMode: "WEB" }
          : { amount: amountStr, bankAccountOnFile: bankOnFile, paymentMode: "WEB" };
        const ec = await paymentsPost(token, "/echecks", echeckBody);
        chargeId = String(ec?.id || "");
        if (!chargeId) throw new Error("echeck not accepted: " + JSON.stringify(ec).slice(0, 300));
      }

      // 2. Record the Accounting Payment so the invoice(s) reconcile.
      let qboPaymentId: string | null = null;
      try {
        const payment = await acctPost(token, "/payment", {
          TotalAmt: total,
          CustomerRef: { value: customerQboId },
          Line: lines.map((l) => ({
            Amount: l.balance,
            LinkedTxn: [{ TxnId: l.id, TxnType: "Invoice" }],
          })),
          PrivateNote: "Brix Order online payment (charge " + chargeId + ")",
        });
        qboPaymentId = String(payment?.Payment?.Id || "") || null;
      } catch (recErr) {
        // Money moved but ledger record failed — surface loudly for repair; never re-charge.
        return jsonRes({
          ok: false, mode, charged: true, qbo_charge_id: chargeId, qbo_payment_id: null,
          total, error: "charge succeeded but recording the QBO payment failed — needs manual reconcile",
          detail: (recErr as Error).message, duration_ms: Date.now() - startedAt,
        }, 502);
      }

      return jsonRes({
        ok: true, mode, type, total, qbo_charge_id: chargeId, qbo_payment_id: qboPaymentId,
        status: "succeeded", duration_ms: Date.now() - startedAt,
      });
    }

    return jsonRes({ ok: false, error: "unknown mode: " + mode }, 400);
  } catch (err) {
    console.error("qbo-charge FATAL:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
