// qbo-fix-duplicate-payments — ONE-OFF surgery for the payments booked twice.
//
// Between 2026-08-27 and 2026-09-08 a race between brix-order's inline charge
// path and its payment_intent.succeeded webhook booked 14 Stripe payments into
// QuickBooks TWICE ($6,512.92). The race itself is closed by
// qbo-record-external-payment v4; this cleans up what it already made.
//
//   POST  header x-internal-secret == INTERNAL_PAY_SECRET
//   body: { mode?: 'preview' | 'apply' }   // default 'preview' — writes NOTHING
//
// ── The shape of every pair, verified across all 14 ──
// The EARLIER id is real: it carries the invoice applications. The LATER id is
// the phantom: by the time it was created the invoices were already settled, so
// it applied to nothing and landed as a full UnappliedAmt — a customer credit
// that does not exist. Deleting it therefore cannot un-apply anything.
//
// ⚠ THE DEPOSIT COMES FIRST. Our own orders.payments row stored whichever id was
// written last — the phantom, in all 14 — so the Stripe payout reconciler linked
// the bank Deposit to the PHANTOM and left the real payment unswept in
// Undeposited Funds. Delete before repointing and QBO either refuses or you
// orphan a deposit line. So: repoint every affected deposit, THEN delete.
//
// ⚠ Deposits are updated ONCE EACH, not once per payment. Deposit 174017 alone
// funds seven phantoms, and a full-entity update bumps SyncToken — doing it per
// payment would make every write after the first stale.
//
// ⚠ A Deposit update is a FULL-ENTITY POST: every line must go back exactly as
// it came, including the negative Merchant Processing Fees lines and their
// Id/LineNum. Only the one LinkedTxn TxnId is mutated. Rebuilding the line list
// from anything but the live read is how a deposit stops footing.
//
// ── The guards, which matter more than the happy path ──
// Nothing is trusted from the mirror at write time; every decision is re-read
// from QuickBooks. A payment is only deleted when, LIVE:
//   1. it is one of a pair flagged by ops.v_payment_duplicates,
//   2. it has ZERO Invoice applications, and
//   3. its twin exists, is the same customer, and the same amount to the cent.
// Get the pair backwards anywhere and (2) refuses rather than destroying the
// applied payment. Already-deleted payments are reported, not errors — this is
// safe to re-run, and half a run is not a broken book.

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 3600;
const REFRESH_MIN_REMAINING_SECONDS = 300;
const LEASE_SECONDS = 20;
const LEASE_POLL_INTERVAL_MS = 750;
const LEASE_POLL_MAX_ATTEMPTS = 40;

// The window the deposits are looked for in. The duplicates all fall inside it;
// widening it costs a bigger read, narrowing it can miss a deposit and then the
// delete is refused rather than done wrongly.
const DEPOSIT_WINDOW_FROM = "2026-08-01";
// ⚠ A TRUNCATED deposit read is the one way this function could do real damage:
// a phantom whose deposit was never read looks free-floating, gets deleted, and
// orphans a line on a deposit nobody was looking at. So the read is capped well
// above the real count (43 since 2026-08-01) and hitting the cap ABORTS the
// apply rather than proceeding on a partial picture.
const DEPOSIT_MAX = 500;

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
  // ⚠ schema 'ops' explicitly — the JS client defaults to public and our tables
  // are not there; a silent no-op read is the documented trap in this codebase.
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
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-fix-duplicate-payments",
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

async function acctGet(token: string, path: string): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) throw new Error("QBO acct GET " + path + " (" + res.status + "): " + (await res.text()).slice(0, 400));
  return res.json();
}
async function acctPost(token: string, path: string, body: any): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("QBO acct POST " + path + " (" + res.status + "): " + (await res.text()).slice(0, 400));
  return res.json();
}
async function acctQuery(token: string, sql: string): Promise<any[]> {
  const j = await acctGet(token, "/query?query=" + encodeURIComponent(sql));
  const qr = j?.QueryResponse ?? {};
  for (const k of Object.keys(qr)) if (Array.isArray(qr[k])) return qr[k];
  return [];
}

interface LivePayment {
  id: string;
  syncToken: string;
  total: number;
  unapplied: number;
  customer: string | null;
  ref: string | null;
  invoiceIds: string[];
}

/** A payment as QBO has it RIGHT NOW. null = it is not there (already deleted). */
async function readPayment(token: string, id: string): Promise<LivePayment | null> {
  try {
    const j = await acctGet(token, "/payment/" + encodeURIComponent(id));
    const p = j?.Payment;
    if (!p) return null;
    return {
      id: String(p.Id),
      syncToken: String(p.SyncToken ?? "0"),
      total: Number(p.TotalAmt ?? 0),
      unapplied: Number(p.UnappliedAmt ?? 0),
      customer: p.CustomerRef?.value ? String(p.CustomerRef.value) : null,
      ref: p.PaymentRefNum ?? null,
      invoiceIds: (p.Line ?? []).flatMap((l: any) =>
        (l.LinkedTxn ?? []).filter((t: any) => t.TxnType === "Invoice").map((t: any) => String(t.TxnId))),
    };
  } catch (err) {
    // A deleted payment reads 404 — that is a fact about the book, not a fault.
    if (/\(404\)/.test((err as Error).message)) return null;
    throw err;
  }
}

interface Pair { phantom: string; real: string; customer: string; amount: number; ref: string | null }
interface DepositPlan {
  deposit_id: string;
  txn_date: string;
  total: number;
  swaps: Array<{ from: string; to: string; amount: number }>;
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
    const mode: string = body.mode === "apply" ? "apply" : "preview";

    const sb = getSB();
    const token = await getAccessToken(sb);

    // ── 1. Candidate pairs from the detector, then re-proved against QBO ──
    const { data: dupRows, error: dupErr } = await sb.from("v_payment_duplicates").select("*");
    if (dupErr) throw new Error("could not read ops.v_payment_duplicates: " + dupErr.message);

    const pairs: Pair[] = [];
    const refused: Array<{ payment: string; reason: string }> = [];
    const seen = new Set<string>();

    for (const row of (dupRows ?? []) as any[]) {
      const a = String(row.qbo_payment_id);
      const b = String(row.twin_qbo_payment_id);
      const key = [a, b].sort().join(":");
      if (seen.has(key)) continue;   // the view flags BOTH twins; one pair each
      seen.add(key);

      const [pa, pb] = await Promise.all([readPayment(token, a), readPayment(token, b)]);
      if (!pa && !pb) {
        refused.push({ payment: a + " / " + b, reason: "neither payment is in QuickBooks any more" });
        continue;
      }
      if (!pa || !pb) {
        refused.push({ payment: a + " / " + b, reason: "one of the pair is already deleted — nothing left to reconcile" });
        continue;
      }
      // ⚠ The phantom is the one applied to NOTHING — never "the higher id".
      // That the later id is always the phantom is a pattern in this incident,
      // and a pattern is not a licence to delete somebody's payment.
      const phantom = pa.invoiceIds.length === 0 ? pa : pb.invoiceIds.length === 0 ? pb : null;
      if (!phantom) {
        refused.push({ payment: a + " / " + b, reason: "both payments are applied to invoices — not a phantom pair, leave it alone" });
        continue;
      }
      const real = phantom === pa ? pb : pa;
      if (real.invoiceIds.length === 0) {
        refused.push({ payment: a + " / " + b, reason: "neither payment is applied to anything — a human should look at this one" });
        continue;
      }
      if (phantom.customer !== real.customer) {
        refused.push({ payment: phantom.id, reason: "the two payments are for different customers" });
        continue;
      }
      if (Math.abs(phantom.total - real.total) >= 0.005) {
        refused.push({ payment: phantom.id, reason: "the two payments are different amounts" });
        continue;
      }

      pairs.push({
        phantom: phantom.id, real: real.id,
        customer: String(phantom.customer), amount: phantom.total, ref: phantom.ref,
      });
    }

    // ── 2. Which deposits fund a phantom, and what each would become ──
    // Deposit lines cannot be queried by LinkedTxn, so the window is read and
    // inspected. Grouped BY DEPOSIT, so one update covers all seven on 174017.
    const byPhantom = new Map(pairs.map((p) => [p.phantom, p]));
    const depositPlans: DepositPlan[] = [];
    let depositsRead = 0;
    let depositReadTruncated = false;
    if (pairs.length > 0) {
      const deposits = await acctQuery(
        token,
        "select * from Deposit where TxnDate >= '" + DEPOSIT_WINDOW_FROM + "' maxresults " + DEPOSIT_MAX,
      );
      depositsRead = deposits.length;
      depositReadTruncated = deposits.length >= DEPOSIT_MAX;
      for (const d of deposits) {
        const swaps: Array<{ from: string; to: string; amount: number }> = [];
        for (const line of d.Line ?? []) {
          for (const lt of line.LinkedTxn ?? []) {
            if (lt.TxnType !== "Payment") continue;
            const hit = byPhantom.get(String(lt.TxnId));
            if (hit) swaps.push({ from: hit.phantom, to: hit.real, amount: Number(line.Amount ?? 0) });
          }
        }
        if (swaps.length > 0) {
          depositPlans.push({ deposit_id: String(d.Id), txn_date: d.TxnDate, total: Number(d.TotalAmt ?? 0), swaps });
        }
      }
    }

    const plan = {
      pairs: pairs.map((p) => ({
        delete_payment: p.phantom,
        keep_payment: p.real,
        customer_qbo_id: p.customer,
        amount: p.amount,
        stripe_ref: p.ref,
        in_deposit: depositPlans.find((d) => d.swaps.some((s) => s.from === p.phantom))?.deposit_id ?? null,
      })),
      deposits_to_repoint: depositPlans,
      deposits_read: depositsRead,
      total_amount: Number(pairs.reduce((s, p) => s + p.amount, 0).toFixed(2)),
      refused,
    };

    if (mode === "preview") {
      return jsonRes({ ok: true, mode: "preview", wrote_nothing: true, deposit_read_truncated: depositReadTruncated, ...plan });
    }

    if (depositReadTruncated) {
      return jsonRes({
        ok: false,
        error: "the deposit read hit its " + DEPOSIT_MAX + "-row cap, so which deposits fund these payments cannot be proved — nothing was changed. Raise DEPOSIT_MAX or narrow DEPOSIT_WINDOW_FROM and run the preview again.",
        ...plan,
      }, 409);
    }

    // ── 3. Repoint the deposits FIRST (one full-entity update each) ──
    const depositResults: Array<{ deposit_id: string; ok: boolean; swapped?: number; error?: string }> = [];
    const repointed = new Set<string>();
    for (const dp of depositPlans) {
      try {
        const fresh = (await acctGet(token, "/deposit/" + encodeURIComponent(dp.deposit_id)))?.Deposit;
        if (!fresh) throw new Error("deposit not found");
        let swapped = 0;
        for (const line of fresh.Line ?? []) {
          for (const lt of line.LinkedTxn ?? []) {
            if (lt.TxnType !== "Payment") continue;
            const hit = byPhantom.get(String(lt.TxnId));
            if (hit) { lt.TxnId = hit.real; swapped += 1; }
          }
        }
        if (swapped === 0) { depositResults.push({ deposit_id: dp.deposit_id, ok: true, swapped: 0 }); continue; }
        await acctPost(token, "/deposit", fresh);   // full entity, SyncToken carried
        for (const s of dp.swaps) repointed.add(s.from);
        depositResults.push({ deposit_id: dp.deposit_id, ok: true, swapped });
      } catch (err) {
        depositResults.push({ deposit_id: dp.deposit_id, ok: false, error: (err as Error).message });
      }
    }

    // ── 4. Delete the phantoms — never one whose deposit did not move ──
    const deleteResults: Array<{ payment_id: string; ok: boolean; error?: string }> = [];
    for (const p of pairs) {
      const needsDeposit = depositPlans.some((d) => d.swaps.some((s) => s.from === p.phantom));
      if (needsDeposit && !repointed.has(p.phantom)) {
        deleteResults.push({
          payment_id: p.phantom, ok: false,
          error: "its deposit could not be repointed — left in place on purpose",
        });
        continue;
      }
      try {
        const live = await readPayment(token, p.phantom);
        if (!live) { deleteResults.push({ payment_id: p.phantom, ok: true }); continue; }   // already gone
        if (live.invoiceIds.length > 0) {
          deleteResults.push({ payment_id: p.phantom, ok: false, error: "it is applied to invoices now — refusing to delete" });
          continue;
        }
        await acctPost(token, "/payment?operation=delete", { Id: live.id, SyncToken: live.syncToken });
        deleteResults.push({ payment_id: p.phantom, ok: true });
      } catch (err) {
        deleteResults.push({ payment_id: p.phantom, ok: false, error: (err as Error).message });
      }
    }

    // ── 5. Take the deleted phantoms out of the mirror ──
    // The nightly sync reconciles deletions itself, but only from a fully paged
    // window — and until it runs the portal would keep showing the credit.
    const gone = deleteResults.filter((r) => r.ok).map((r) => r.payment_id);
    let mirrorRemoved = 0;
    if (gone.length > 0) {
      const { error } = await sb.from("qbo_payments").delete().in("qbo_payment_id", gone);
      if (!error) mirrorRemoved = gone.length;
    }

    return jsonRes({
      ok: deleteResults.every((r) => r.ok) && depositResults.every((r) => r.ok),
      mode: "apply",
      deposits: depositResults,
      deleted: deleteResults,
      deleted_count: gone.length,
      mirror_rows_removed: mirrorRemoved,
      still_to_do: deleteResults.filter((r) => !r.ok),
      refused,
    });
  } catch (err) {
    return jsonRes({ ok: false, error: (err as Error).message }, 500);
  }
});
