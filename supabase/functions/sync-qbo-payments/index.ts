// sync-qbo-payments — mirror QuickBooks customer PAYMENTS into ops.
//
// Why this exists: nothing in this database held customer payments. ops
// mirrored Invoice / SalesReceipt / CreditMemo / RefundReceipt, and
// ops.vendor_payments is AP (money we pay OUT). So "how much of the cheque a
// customer sent is still sitting on their account" could only be answered
// inside QuickBooks — which is exactly what brix-order needs to show them.
//
//   POST  header x-internal-secret == INTERNAL_PAY_SECRET
//   body/query:
//     days?     number  window in days back from today (default 180)
//     dry_run?  boolean read + report, write nothing
//
// Writes ops.qbo_payments (upsert on qbo_payment_id) and ops.qbo_payment_lines
// (deleted and rewritten per payment). Logs ops.sync_log source='qbo_payments'.
//
// ⚠ UnappliedAmt IS NOT QUERYABLE (QBO 400, code 4001 "property 'UnappliedAmt'
//   is not queryable" — verified 2026-09-08, same class as POStatus on
//   PurchaseOrder). Every payment in the window is mirrored and the filtering
//   happens in SQL. Do NOT add `where UnappliedAmt > 0` to the QBO query; it
//   fails the whole request, and the failure looks like "no unapplied payments".
//
// ⚠ PaymentRefNum is capped at 21 chars by QBO, so a Stripe intent is stored
//   truncated. Match on the truncation.
//
// ⚠ DELETIONS ARE RECONCILED, and that is load-bearing: 14 double-booked
//   payments are due to be deleted in QuickBooks, and if the mirror kept them
//   the portal would go on showing customers credit that no longer exists. A
//   payment inside a FULLY PAGED window that QBO no longer returns is removed
//   here. If the budget runs out mid-window the run is marked incomplete and
//   deletes NOTHING — half a window is not evidence that anything was deleted.

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 3600;
const REFRESH_MIN_REMAINING_SECONDS = 300;
const LEASE_SECONDS = 20;
const LEASE_POLL_INTERVAL_MS = 750;
const LEASE_POLL_MAX_ATTEMPTS = 40;

const PAGE_SIZE = 100;
// Supabase kills an edge function at 150s with no chance to log. Start the
// clock before the FIRST network call and check it per page, not per run.
const BUDGET_MS = 110_000;
const FETCH_TIMEOUT_MS = 25_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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
    { auth: { persistSession: false }, db: { schema: "ops" } },
  );
}
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

// ── QBO token (same lease/refresh pattern as qbo-record-external-payment) ────
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
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(),
    p_access_token: a,
    p_access_expires: new Date(Date.now() + exp * 1000).toISOString(),
    p_refresh_token: r,
    p_refresh_expires: new Date(Date.now() + (rExp ?? REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    p_refreshed_by: "sync-qbo-payments@v1",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
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
      const seed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) {
        await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: "no refresh token" });
        throw new Error("no refresh token available");
      }
      try {
        const fresh = await intuitRefresh(seed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS, fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) {
        await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: (err as Error).message.slice(0, 500) });
        throw err;
      }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}

async function acctQuery(token: string, sql: string): Promise<any[]> {
  const url = accountingBase() + "/v3/company/" + getRealm() +
    "/query?query=" + encodeURIComponent(sql) + "&minorversion=70";
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("QBO query (" + res.status + "): " + (await res.text()).slice(0, 400));
  const j = await res.json();
  const qr = j?.QueryResponse ?? {};
  for (const k of Object.keys(qr)) if (Array.isArray(qr[k])) return qr[k];
  return [];
}

interface PaymentRow {
  qbo_payment_id: string;
  customer_ref_id: string;
  txn_date: string;
  total_amount: number;
  unapplied_amount: number;
  payment_ref_num: string | null;
  payment_method_ref_id: string | null;
  payment_method_name: string | null;
  deposit_account_ref_id: string | null;
  private_note: string | null;
  qbo_created_at: string | null;
  qbo_updated_at: string | null;
  synced_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const startedAt = Date.now();
  const sb = getSB();
  let logId: number | null = null;

  try {
    const secret = Deno.env.get("INTERNAL_PAY_SECRET") || "";
    if (!secret || req.headers.get("x-internal-secret") !== secret) {
      return jsonRes({ ok: false, error: "unauthorized" }, 401);
    }

    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const days = Math.min(2000, Math.max(1, Number(body.days ?? url.searchParams.get("days") ?? 180)));
    const dryRun = body.dry_run === true || url.searchParams.get("dry_run") === "1";

    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

    // Open the run row first so a hard kill still leaves a trace of the attempt.
    if (!dryRun) {
      const { data } = await sb.from("sync_log")
        .insert({ source: "qbo_payments", sync_type: "payments", status: "running", started_at: new Date().toISOString() })
        .select("id").maybeSingle();
      logId = (data as any)?.id ?? null;
    }

    const token = await getAccessToken(sb);

    // Page by Id so the ordering cannot shuffle underneath a deep walk.
    const seen = new Set<string>();
    const payments: PaymentRow[] = [];
    const lineRows: Array<Record<string, unknown>> = [];
    let start = 1;
    let complete = false;
    let pages = 0;

    while (true) {
      if (Date.now() - startedAt > BUDGET_MS) break;
      const sql =
        "select * from Payment where TxnDate >= '" + since + "'" +
        " order by Id startposition " + start + " maxresults " + PAGE_SIZE;
      const rows = await acctQuery(token, sql);
      pages++;
      for (const p of rows) {
        const id = String(p.Id);
        if (seen.has(id)) continue;
        seen.add(id);
        payments.push({
          qbo_payment_id: id,
          customer_ref_id: String(p.CustomerRef?.value ?? ""),
          txn_date: String(p.TxnDate ?? "").slice(0, 10),
          total_amount: num(p.TotalAmt),
          // The whole point of the mirror. QBO omits the field when it is 0.
          unapplied_amount: num(p.UnappliedAmt),
          payment_ref_num: p.PaymentRefNum ? String(p.PaymentRefNum) : null,
          payment_method_ref_id: p.PaymentMethodRef?.value ? String(p.PaymentMethodRef.value) : null,
          payment_method_name: p.PaymentMethodRef?.name ? String(p.PaymentMethodRef.name) : null,
          deposit_account_ref_id: p.DepositToAccountRef?.value ? String(p.DepositToAccountRef.value) : null,
          private_note: p.PrivateNote ? String(p.PrivateNote).slice(0, 2000) : null,
          qbo_created_at: p.MetaData?.CreateTime ?? null,
          qbo_updated_at: p.MetaData?.LastUpdatedTime ?? null,
          synced_at: new Date().toISOString(),
        });
        // line_num from POSITION — QBO sends no line number on a Payment, and a
        // NULL in the upsert key is what stacked 125k phantom rows onto
        // ops.qbo_inventory_adjustment_lines. Never let it be null.
        const lines = Array.isArray(p.Line) ? p.Line : [];
        lines.forEach((l: any, i: number) => {
          const linked = Array.isArray(l.LinkedTxn) ? l.LinkedTxn : [];
          const inv = linked.find((t: any) => t?.TxnType === "Invoice") ?? linked[0] ?? null;
          lineRows.push({
            qbo_payment_id: id,
            line_num: i,
            qbo_invoice_id: inv?.TxnId ? String(inv.TxnId) : null,
            linked_txn_type: inv?.TxnType ? String(inv.TxnType) : null,
            amount: num(l.Amount),
          });
        });
      }
      if (rows.length < PAGE_SIZE) { complete = true; break; }
      start += PAGE_SIZE;
    }

    if (dryRun) {
      return jsonRes({
        ok: true, dry_run: true, since, pages, complete,
        payments: payments.length,
        with_unapplied: payments.filter((p) => p.unapplied_amount > 0).length,
        unapplied_total: Number(payments.reduce((s, p) => s + p.unapplied_amount, 0).toFixed(2)),
        elapsed_ms: Date.now() - startedAt,
      });
    }

    // Upsert payments in chunks, then rewrite each payment's lines.
    let written = 0;
    for (let i = 0; i < payments.length; i += 200) {
      const chunk = payments.slice(i, i + 200);
      const { error } = await sb.from("qbo_payments").upsert(chunk, { onConflict: "qbo_payment_id" });
      if (error) throw new Error("upsert payments: " + error.message);
      written += chunk.length;
    }

    // Resolve surrogate ids for the line rows, then delete-and-rewrite.
    let linesWritten = 0;
    if (payments.length > 0) {
      const ids = payments.map((p) => p.qbo_payment_id);
      const idMap = new Map<string, number>();
      for (let i = 0; i < ids.length; i += 500) {
        const { data, error } = await sb.from("qbo_payments")
          .select("id,qbo_payment_id").in("qbo_payment_id", ids.slice(i, i + 500));
        if (error) throw new Error("read payment ids: " + error.message);
        for (const r of data ?? []) idMap.set(String((r as any).qbo_payment_id), Number((r as any).id));
      }
      for (let i = 0; i < ids.length; i += 500) {
        const { error } = await sb.from("qbo_payment_lines").delete().in("qbo_payment_id", ids.slice(i, i + 500));
        if (error) throw new Error("clear payment lines: " + error.message);
      }
      const withFk = lineRows
        .map((l) => ({ ...l, payment_id: idMap.get(String(l.qbo_payment_id)) }))
        .filter((l) => l.payment_id != null);
      for (let i = 0; i < withFk.length; i += 500) {
        const { error } = await sb.from("qbo_payment_lines").insert(withFk.slice(i, i + 500));
        if (error) throw new Error("insert payment lines: " + error.message);
        linesWritten += Math.min(500, withFk.length - i);
      }
    }

    // Deletions — only from a window we actually finished paging.
    let deleted = 0;
    if (complete) {
      const { data: existing, error } = await sb.from("qbo_payments")
        .select("qbo_payment_id").gte("txn_date", since);
      if (error) throw new Error("read existing: " + error.message);
      const gone = (existing ?? [])
        .map((r) => String((r as any).qbo_payment_id))
        .filter((id) => !seen.has(id));
      for (let i = 0; i < gone.length; i += 200) {
        const { error: delErr } = await sb.from("qbo_payments").delete().in("qbo_payment_id", gone.slice(i, i + 200));
        if (delErr) throw new Error("delete removed: " + delErr.message);
      }
      deleted = gone.length;
    }

    const unappliedTotal = Number(
      payments.filter((p) => p.unapplied_amount > 0).reduce((s, p) => s + p.unapplied_amount, 0).toFixed(2),
    );
    const result = {
      since, pages, complete, payments: written, lines: linesWritten, deleted,
      with_unapplied: payments.filter((p) => p.unapplied_amount > 0).length,
      unapplied_total: unappliedTotal,
      elapsed_ms: Date.now() - startedAt,
    };

    if (logId != null) {
      await sb.from("sync_log").update({
        status: "success", completed_at: new Date().toISOString(),
        records_synced: written, metadata: result,
      }).eq("id", logId);
    }
    return jsonRes({ ok: true, ...result });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    try {
      if (logId != null) {
        await sb.from("sync_log").update({
          status: "error", completed_at: new Date().toISOString(),
          error_message: message.slice(0, 1000),
        }).eq("id", logId);
      } else {
        await sb.from("sync_log").insert({
          source: "qbo_payments", sync_type: "payments", status: "error",
          started_at: new Date(startedAt).toISOString(), completed_at: new Date().toISOString(),
          error_message: message.slice(0, 1000),
        });
      }
    } catch { /* logging must never mask the real error */ }
    return jsonRes({ ok: false, error: message }, 500);
  }
});
