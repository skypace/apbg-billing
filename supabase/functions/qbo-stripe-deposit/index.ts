// qbo-stripe-deposit — group settled Stripe Payments into a QBO bank Deposit
// and book the Stripe processing fee, so the deposit nets to the payout that
// actually hit the bank (bank-feed match). Part 2/3 of the brix-order Stripe→QBO
// flow (design: brix-order/docs/STRIPE-RECONCILIATION.md):
//
//   charge  → QBO Payment (gross)  → Undeposited Funds   [qbo-record-external-payment]
//   payout  → QBO Deposit grouping those Payments        [THIS FUNCTION]
//             minus a "Merchant Processing Fees" expense line
//             net == the Stripe payout == the bank deposit
//
//   POST  header x-internal-secret == INTERNAL_PAY_SECRET
//   body: {
//     mode?: 'record' | 'preview',            // default 'record'
//     payout_id: string,                       // Stripe po_… (memo + idempotency)
//     deposit_date?: string,                   // YYYY-MM-DD (payout arrival)
//     bank_account_id?: string,                // QBO bank acct; else env/auto
//     fee_account_id?: string,                 // QBO expense acct; else find-or-create
//     lines: [{ qbo_payment_id: string, gross: number, fee: number }],
//     account_fees?: [{ amount: number, description?: string }]
//                                              // v3: Stripe's OWN account fees that
//                                              // rode this payout (monthly Financial
//                                              // Connections, Radar, …). `amount` is
//                                              // what Stripe TOOK (positive); each
//                                              // becomes its own negative line on the
//                                              // fee account carrying `description`.
//   }
//
// brix-order does all the Stripe work (it holds the Stripe key) and hands us the
// resolved QBO Payment ids + gross/fee per charge. We only touch QBO. Deposits
// are internal bookkeeping (reversible in QBO); auto-posting is still gated on
// the brix-order side (STRIPE_DEPOSIT_ENABLED) — this function itself just does
// what it's told.
//
// v2: LinkedTxn on deposit lines carries TxnLineId "0" — QBO's Deposit entity
// REQUIRES it when linking a Payment (400 "Required parameter
// LinkedTxn.TxnLineId is missing" otherwise; hit live on payout po_1Tv4sK…).
//
// v3 (2026-09-04): `account_fees`. Stripe deducts its subscription-style fees
// (e.g. "Connections Verification (2026-08-01 - 2026-08-31)", $4.50) from
// whichever payout is next, as a balance transaction of type `stripe_fee` with
// no source. Without a line for it the deposit cannot equal the bank credit, so
// the reconciler used to park every such payout as "refunds/adjustments" (live
// case: po_1UB2OM…, $1,034.88 payment − $5.00 − $4.50 = $1,025.38). They are
// booked to the SAME fee account as processing fees, one line each, with
// Stripe's own description as the line Description so a bookkeeper can tell a
// monthly fee from a per-charge fee on the deposit itself.
//
// Does NOT write the ops.qbo_invoices mirror (a deposit doesn't change invoice
// balances; nothing to reflect in the portal). verify_jwt=false; internal secret
// + QBO OAuth. Same lease/refresh pattern as qbo-record-external-payment.

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
function round2(n: number): number { return Number(n.toFixed(2)); }

// ── QBO token (same lease/refresh pattern as qbo-record-external-payment) ──
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
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-stripe-deposit@v3",
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
async function acctQuery(token: string, sql: string): Promise<any[]> {
  const j = await acctGet(token, "/query?query=" + encodeURIComponent(sql));
  const qr = j?.QueryResponse ?? {};
  // The result key is the entity name (Account / Deposit / …) — grab the first array.
  for (const k of Object.keys(qr)) if (Array.isArray(qr[k])) return qr[k];
  return [];
}

// Find the company's Undeposited Funds account (Payments must land here to be
// groupable into a Deposit).
async function findUndepositedFunds(token: string): Promise<string | null> {
  const rows = await acctQuery(token, "select Id, Name, AccountSubType from Account where AccountSubType = 'UndepositedFunds' and Active = true");
  return rows[0]?.Id ? String(rows[0].Id) : null;
}

async function resolveBankAccount(token: string, given?: string): Promise<string | null> {
  if (given) return given;
  const env = (Deno.env.get("QBO_STRIPE_BANK_ACCOUNT_ID") || "").trim();
  if (env) return env;
  // Try a bank account named like Stripe / clearing.
  const banks = await acctQuery(token, "select Id, Name from Account where AccountType = 'Bank' and Active = true");
  const named = banks.find((b) => /stripe|clearing|merchant/i.test(String(b.Name || "")));
  return named?.Id ? String(named.Id) : null;
}

async function listBankAccounts(token: string): Promise<Array<{ id: string; name: string }>> {
  const banks = await acctQuery(token, "select Id, Name from Account where AccountType = 'Bank' and Active = true");
  return banks.map((b) => ({ id: String(b.Id), name: String(b.Name || "") }));
}

const FEE_ACCOUNT_NAME = "Merchant Processing Fees";
async function resolveFeeAccount(token: string, given?: string): Promise<string> {
  if (given) return given;
  const env = (Deno.env.get("QBO_MERCHANT_FEE_ACCOUNT_ID") || "").trim();
  if (env) return env;
  const existing = await acctQuery(
    token,
    "select Id, Name from Account where Name = '" + FEE_ACCOUNT_NAME + "' and Active = true",
  );
  if (existing[0]?.Id) return String(existing[0].Id);
  const created = await acctPost(token, "/account", {
    Name: FEE_ACCOUNT_NAME,
    AccountType: "Expense",
    AccountSubType: "BankCharges",
  });
  const id = created?.Account?.Id;
  if (!id) throw new Error("failed to create fee account");
  return String(id);
}

interface DepLine { qbo_payment_id: string; gross: number; fee: number }
interface AccountFee { amount: number; description?: string }

// QBO caps Line.Description at 4000 chars; Stripe's descriptions are short, but
// a payload is untrusted input to a bookkeeping write, so bound it anyway.
function feeDescription(f: AccountFee): string {
  const d = String(f.description ?? "").trim();
  return ("Stripe account fee" + (d ? " — " + d : "")).slice(0, 4000);
}

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
    const payoutId = String(body.payout_id ?? "").trim();
    const depositDate = String(body.deposit_date ?? "").trim();
    const lines: DepLine[] = Array.isArray(body.lines) ? body.lines : [];
    const accountFees: AccountFee[] = Array.isArray(body.account_fees) ? body.account_fees : [];

    if (!payoutId) return jsonRes({ ok: false, error: "payout_id required" }, 400);

    const sb = getSB();
    const token = await getAccessToken(sb);

    if (mode === "preview") {
      // Report the QBO accounts we'd use so the admin can pick a bank.
      const [banks, undeposited] = await Promise.all([listBankAccounts(token), findUndepositedFunds(token)]);
      const bank = await resolveBankAccount(token, body.bank_account_id);
      return jsonRes({
        ok: true, mode: "preview", payout_id: payoutId,
        bank_accounts: banks, resolved_bank_account_id: bank,
        undeposited_funds_id: undeposited,
      });
    }

    if (lines.length === 0) return jsonRes({ ok: false, error: "lines required" }, 400);
    for (const l of lines) {
      if (!l.qbo_payment_id || !(Number(l.gross) > 0)) {
        return jsonRes({ ok: false, error: "each line needs qbo_payment_id + positive gross" }, 400);
      }
    }
    for (const f of accountFees) {
      // `amount` is what Stripe took. A zero or non-numeric entry is a caller
      // bug, not something to silently drop from a deposit that must foot.
      if (!Number.isFinite(Number(f.amount)) || Number(f.amount) === 0) {
        return jsonRes({ ok: false, error: "each account_fees entry needs a non-zero numeric amount" }, 400);
      }
    }

    const bankAccountId = await resolveBankAccount(token, body.bank_account_id);
    if (!bankAccountId) {
      return jsonRes({ ok: false, needs_manual: true, error: "could not resolve a QBO bank account for the deposit — pass bank_account_id or set QBO_STRIPE_BANK_ACCOUNT_ID" }, 409);
    }
    const feeAccountId = await resolveFeeAccount(token, body.fee_account_id);

    const grossTotal = round2(lines.reduce((s, l) => s + Number(l.gross), 0));
    const processingFees = round2(lines.reduce((s, l) => s + Number(l.fee || 0), 0));
    const accountFeeTotal = round2(accountFees.reduce((s, f) => s + Number(f.amount), 0));
    const feeTotal = round2(processingFees + accountFeeTotal);
    const net = round2(grossTotal - feeTotal);

    // Deposit lines: one LinkedTxn line per Payment (pulled from Undeposited
    // Funds), plus one negative expense line for the total processing fee,
    // plus one negative expense line PER account fee (each keeps Stripe's own
    // description). TxnLineId "0" is REQUIRED by QBO when linking a Payment to
    // a Deposit (400 "Required parameter LinkedTxn.TxnLineId is missing"
    // without it).
    const depLines: any[] = lines.map((l) => ({
      Amount: round2(Number(l.gross)),
      LinkedTxn: [{ TxnId: String(l.qbo_payment_id), TxnType: "Payment", TxnLineId: "0" }],
    }));
    if (processingFees > 0) {
      depLines.push({
        Amount: -processingFees,
        DetailType: "DepositLineDetail",
        Description: "Stripe processing fees",
        DepositLineDetail: { AccountRef: { value: feeAccountId } },
      });
    }
    for (const f of accountFees) {
      // A fee CREDIT from Stripe (negative amount) books as a positive line on
      // the same account, which is the correct offset.
      depLines.push({
        Amount: -round2(Number(f.amount)),
        DetailType: "DepositLineDetail",
        Description: feeDescription(f),
        DepositLineDetail: { AccountRef: { value: feeAccountId } },
      });
    }

    const deposit: any = {
      DepositToAccountRef: { value: bankAccountId },
      PrivateNote: "Stripe payout " + payoutId,
      Line: depLines,
    };
    if (depositDate) deposit.TxnDate = depositDate;

    const created = await acctPost(token, "/deposit", deposit);
    const depositId = created?.Deposit?.Id ?? null;

    return jsonRes({
      ok: true, qbo_deposit_id: depositId,
      gross: grossTotal, fees: feeTotal, processing_fees: processingFees, account_fees: accountFeeTotal, net,
      charge_count: lines.length, account_fee_count: accountFees.length,
      bank_account_id: bankAccountId, fee_account_id: feeAccountId,
    });
  } catch (err) {
    return jsonRes({ ok: false, error: (err as Error).message }, 500);
  }
});
