// qbo-returned-payment v1 — book a returned/bounced customer payment in QBO.
//
// Home for brix-order's "Record returned payment" admin action. Lives here
// (apbg-billing) because QBO token management + refresh already live in this
// project; brix-order never calls QBO directly (same boundary as qbo-charge).
//
// What a QuickBooks Payments ACH return leaves behind: Intuit debits the money
// back and flags the invoice "Returned", but the ledger still shows the
// Payment applied — the invoice looks paid. The manual QBO ritual (void the
// payment, invoice the customer a return fee, re-send) is what this function
// automates:
//
// Modes (body.mode):
//   "preview" — read-only. Locate the Payment applied to the invoice, verify
//               ownership/amounts, and report exactly what "record" would do
//               (which payment gets voided, whether it spans other invoices,
//               what the fee invoice will look like). No writes.
//   "record"  — void the Payment (invoice reopens, full audit trail kept) and
//               create a separate fee invoice ("Returned Payment Fee" service
//               item, due on receipt). Returns both ids.
//
// Both modes require header x-internal-secret == INTERNAL_PAY_SECRET so only
// brix-order's admin function (server-side, superadmin-gated) can call this.
//
// Safety rails:
//   - If the applied Payment also covers OTHER invoices, "record" refuses and
//     returns needs_manual=true — voiding it would unpay unrelated invoices.
//   - The fee item/account are found by name and created once if missing
//     ("Returned Payment Fee" service item → "Returned Payment Fees" income
//     account).
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
const LEASE_POLL_MAX_ATTEMPTS = 40;

const FEE_ITEM_NAME = "Returned Payment Fee";
const FEE_ACCOUNT_NAME = "Returned Payment Fees";

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

// ── QBO token (same lease/refresh pattern as qbo-charge / push-qbo-item) ──
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
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-returned-payment@v1",
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
async function acctQuery(token: string, q: string): Promise<any> {
  return acctGet(token, "/query?query=" + encodeURIComponent(q));
}

/** Payments (ReceivePayment) whose lines link the given invoice. */
async function paymentsLinkedToInvoice(token: string, invoiceId: string, customerQboId: string): Promise<any[]> {
  // QBO SQL can't filter on LinkedTxn — pull the customer's recent payments
  // and filter client-side. 100 covers any realistic window.
  const j = await acctQuery(
    token,
    "select * from Payment where CustomerRef = '" + customerQboId + "' orderby TxnDate desc maxresults 100",
  );
  const payments: any[] = j?.QueryResponse?.Payment ?? [];
  return payments.filter((p) =>
    (p?.Line ?? []).some((l: any) =>
      (l?.LinkedTxn ?? []).some((t: any) => String(t?.TxnId) === invoiceId && t?.TxnType === "Invoice"),
    ),
  );
}

/** All invoice ids a payment's lines link to. */
function linkedInvoiceIds(payment: any): string[] {
  const ids = new Set<string>();
  for (const l of payment?.Line ?? []) {
    for (const t of l?.LinkedTxn ?? []) {
      if (t?.TxnType === "Invoice" && t?.TxnId) ids.add(String(t.TxnId));
    }
  }
  return Array.from(ids);
}

/** Find-or-create the "Returned Payment Fee" service item (+ income account). */
async function ensureFeeItem(token: string): Promise<{ id: string; name: string }> {
  const found = await acctQuery(token, "select Id, Name from Item where Name = '" + FEE_ITEM_NAME + "'");
  const item = found?.QueryResponse?.Item?.[0];
  if (item?.Id) return { id: String(item.Id), name: String(item.Name) };

  // Income account for the fee.
  let accountId: string | null = null;
  const accFound = await acctQuery(token, "select Id, Name from Account where Name = '" + FEE_ACCOUNT_NAME + "'");
  const acc = accFound?.QueryResponse?.Account?.[0];
  if (acc?.Id) {
    accountId = String(acc.Id);
  } else {
    const created = await acctPost(token, "/account", {
      Name: FEE_ACCOUNT_NAME,
      AccountType: "Income",
      AccountSubType: "ServiceFeeIncome",
    });
    accountId = String(created?.Account?.Id || "");
  }
  if (!accountId) throw new Error("could not resolve income account for fee item");

  const createdItem = await acctPost(token, "/item", {
    Name: FEE_ITEM_NAME,
    Type: "Service",
    IncomeAccountRef: { value: accountId },
  });
  const id = String(createdItem?.Item?.Id || "");
  if (!id) throw new Error("could not create fee item");
  return { id, name: FEE_ITEM_NAME };
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
    const mode = body?.mode === "record" ? "record" : "preview";
    const customerQboId = String(body?.customer_qbo_id || "").trim();
    const invoiceId = String(body?.qbo_invoice_id || "").trim();
    const feeAmount = Number(body?.fee_amount ?? 0);
    const returnReason = String(body?.return_reason || "returned by bank").slice(0, 120);
    if (!/^[0-9]+$/.test(customerQboId)) throw new Error("bad customer_qbo_id");
    if (!/^[0-9]+$/.test(invoiceId)) throw new Error("bad qbo_invoice_id");
    if (mode === "record" && feeAmount > 0 && !(feeAmount > 0 && feeAmount < 1000)) {
      throw new Error("fee_amount out of range");
    }

    const token = await getAccessToken(sb);

    // The invoice — verify ownership.
    const invJ = await acctGet(token, "/invoice/" + encodeURIComponent(invoiceId));
    const inv = invJ?.Invoice;
    if (!inv?.Id) throw new Error("invoice not found in QBO: " + invoiceId);
    if (String(inv?.CustomerRef?.value) !== customerQboId) {
      throw new Error("invoice " + invoiceId + " is not this customer's");
    }
    const docNumber = String(inv?.DocNumber || invoiceId);
    const invoiceTotal = Number(inv?.TotalAmt ?? 0);
    const invoiceBalance = Number(inv?.Balance ?? 0);

    // The payment(s) applied to it.
    const linked = await paymentsLinkedToInvoice(token, invoiceId, customerQboId);
    if (linked.length === 0) {
      return jsonRes({
        ok: false, mode, error: "no payment is applied to invoice " + docNumber +
          " — nothing to void (already reopened, or never paid)",
        invoice: { id: invoiceId, doc_number: docNumber, total: invoiceTotal, balance: invoiceBalance },
      }, 409);
    }
    // Most recent applied payment is the returned one in every normal flow.
    const payment = linked[0];
    const paymentId = String(payment?.Id);
    const paymentTotal = Number(payment?.TotalAmt ?? 0);
    const paymentDate = String(payment?.TxnDate || "");
    const otherInvoices = linkedInvoiceIds(payment).filter((id) => id !== invoiceId);

    const plan = {
      invoice: { id: invoiceId, doc_number: docNumber, total: invoiceTotal, balance: invoiceBalance },
      payment: {
        id: paymentId, total: paymentTotal, txn_date: paymentDate,
        also_covers_invoices: otherInvoices,
        candidates: linked.length,
      },
      fee: feeAmount > 0 ? { amount: feeAmount, item: FEE_ITEM_NAME } : null,
    };

    if (otherInvoices.length > 0) {
      return jsonRes({
        ok: false, mode, needs_manual: true,
        error: "payment " + paymentId + " also covers other invoice(s) " + otherInvoices.join(", ") +
          " — voiding it would unpay those too. Handle this one in QBO directly.",
        plan,
      }, 409);
    }

    if (mode === "preview") {
      return jsonRes({ ok: true, mode, plan, duration_ms: Date.now() - startedAt });
    }

    // ---- record ----
    // 1. Void the payment (keeps the record at $0 — full audit trail; the
    //    invoice reopens). QBO voids Payment via operation=update + include=void.
    await acctPost(token, "/payment?operation=update&include=void", {
      Id: paymentId,
      SyncToken: String(payment?.SyncToken ?? "0"),
      sparse: true,
    });

    // 2. Create the fee invoice (due on receipt).
    let feeInvoice: { id: string; doc_number: string } | null = null;
    if (feeAmount > 0) {
      const feeItem = await ensureFeeItem(token);
      const created = await acctPost(token, "/invoice", {
        CustomerRef: { value: customerQboId },
        DueDate: new Date().toISOString().slice(0, 10),
        Line: [{
          Amount: feeAmount,
          DetailType: "SalesItemLineDetail",
          Description: "Returned payment fee — invoice #" + docNumber + " (" + returnReason + ")",
          SalesItemLineDetail: {
            ItemRef: { value: feeItem.id },
            Qty: 1,
            UnitPrice: feeAmount,
          },
        }],
        PrivateNote: "Auto-created by brix-order returned-payment workflow (payment " + paymentId + " voided)",
      });
      const fi = created?.Invoice;
      if (fi?.Id) feeInvoice = { id: String(fi.Id), doc_number: String(fi.DocNumber || fi.Id) };
    }

    return jsonRes({
      ok: true, mode, plan,
      voided_payment_id: paymentId,
      payment_total: paymentTotal,
      fee_invoice: feeInvoice,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("qbo-returned-payment FATAL:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
