// qbo-return-order v1 — book a customer RETURN ORDER as a QBO Credit Memo.
//
// Home for brix-order's account-closure refund flow. Lives here (apbg-billing)
// because QBO token management + refresh already live in this project;
// brix-order never calls QBO directly (same boundary as qbo-charge /
// qbo-returned-payment / qbo-cylinder-audit).
//
// Why a credit memo: Service Fusion's jobs API hard-rejects negative money
// (products[].multiplier min 1, rate min 0 — verified live 2026-07-09), so a
// "negative order" cannot exist in SF. The financially-correct negative order
// lives in QBO as a CreditMemo carrying the same catalog items and quantities
// a positive order would — it reduces the customer's A/R (or can be refunded)
// and flows through statements/balances like any transaction. The physical
// pickup is dispatched as a separate $0 SF job by the caller.
//
// Modes (body.mode):
//   "preview" — read-only. Echo the exact CreditMemo payload "create" would POST.
//   "create"  — POST /creditmemo, then upsert the header + lines into the ops
//               mirror (ops.qbo_invoices txn_type='CreditMemo' — sync-qbo
//               already mirrors credit memos, so the periodic sync harmlessly
//               re-upserts the same rows later).
//
// Caller contract: brix-order's admin-account-closure resolves QBO item ids
// from orders.catalog (qbo_item_id) and passes positive qty + unit_price.
//
// Requires header x-internal-secret == INTERNAL_PAY_SECRET. verify_jwt=false;
// security is the internal secret + QBO OAuth.
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

const MAX_LINES = 25;
const MAX_QTY = 9999;
const MAX_UNIT_PRICE = 100000;

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
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-return-order@v1",
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

// ── ops mirror upsert (same row shapes + conflict keys as sync-qbo, which
//    already mirrors CreditMemo rows — this just makes it instant) ──
async function upsertMirror(txn: any): Promise<{ mirrored: boolean; error: string | null }> {
  try {
    const ops = getOpsSB();
    const header = {
      qbo_invoice_id: txn.Id, txn_type: "CreditMemo",
      doc_number: txn.DocNumber || null,
      txn_date: txn.TxnDate, due_date: null,
      customer_ref_id: txn.CustomerRef?.value || null,
      customer_name:   txn.CustomerRef?.name  || null,
      total_amount: parseFloat(txn.TotalAmt) || 0,
      balance: parseFloat(txn.RemainingCredit ?? txn.Balance ?? 0) || 0,
      status: "credit",
      department: txn.DepartmentRef?.name || null,
      memo: txn.PrivateNote || null,
      sf_job_id: null,
      synced_at: new Date().toISOString(),
      qbo_updated_at: txn.MetaData?.LastUpdatedTime || null,
    };
    const { error: hErr } = await ops.from("qbo_invoices")
      .upsert([header], { onConflict: "qbo_invoice_id,txn_type" });
    if (hErr) throw new Error("mirror header upsert: " + hErr.message);
    const { data: rows, error: rErr } = await ops.from("qbo_invoices")
      .select("id").eq("qbo_invoice_id", String(txn.Id)).eq("txn_type", "CreditMemo").limit(1);
    if (rErr || !rows || rows.length === 0) throw new Error("mirror header re-read failed" + (rErr ? ": " + rErr.message : ""));
    const invRowId = (rows[0] as any).id as number;
    const lines: any[] = [];
    let idx = 0;
    for (const l of (txn.Line || [])) {
      if (l.DetailType !== "SalesItemLineDetail") continue;
      const d = l.SalesItemLineDetail || {};
      idx++;
      lines.push({
        invoice_id: invRowId, line_num: idx,
        description: l.Description || null,
        quantity: d.Qty == null ? null : Number(d.Qty),
        unit_price: d.UnitPrice ?? null,
        amount: parseFloat(l.Amount) || 0,
        item_ref_id: d.ItemRef?.value || null,
        item_name:   d.ItemRef?.name  || null,
        account_ref_id: d.ItemAccountRef?.value || "",
        account_name:   d.ItemAccountRef?.name  || null,
        revenue_line: null,
        department: txn.DepartmentRef?.name || null,
      });
    }
    if (lines.length > 0) {
      const { error: lErr } = await ops.from("qbo_invoice_lines")
        .upsert(lines, { onConflict: "invoice_id,line_num" });
      if (lErr) throw new Error("mirror lines upsert: " + lErr.message);
    }
    return { mirrored: true, error: null };
  } catch (err) {
    // Non-fatal: the periodic sync-qbo run mirrors credit memos anyway.
    console.error("qbo-return-order mirror upsert failed:", err);
    return { mirrored: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface ReturnLine {
  qbo_item_id: string;
  item_name: string;
  qty: number;
  unit_price: number;
  description: string;
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
    const mode = body?.mode === "create" ? "create" : "preview";
    const customerQboId = String(body?.customer_qbo_id || "").trim();
    const privateNote = String(body?.private_note || "Return order — account closure refund (brix-order)").slice(0, 4000);
    const rawLines: any[] = Array.isArray(body?.lines) ? body.lines : [];

    if (!/^[0-9]+$/.test(customerQboId)) throw new Error("bad customer_qbo_id");
    if (rawLines.length === 0) throw new Error("lines required");
    if (rawLines.length > MAX_LINES) throw new Error("too many lines");

    const lines: ReturnLine[] = rawLines.map((l: any, i: number) => {
      const id = String(l?.qbo_item_id || "").trim();
      const qty = Number(l?.qty);
      const price = Number(l?.unit_price);
      if (!/^[0-9]+$/.test(id)) throw new Error(`line ${i + 1}: bad qbo_item_id`);
      if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) throw new Error(`line ${i + 1}: bad qty`);
      if (!Number.isFinite(price) || price < 0 || price > MAX_UNIT_PRICE) throw new Error(`line ${i + 1}: bad unit_price`);
      return {
        qbo_item_id: id,
        item_name: String(l?.item_name || "").slice(0, 200),
        qty,
        unit_price: Number(price.toFixed(2)),
        description: String(l?.description || "RETURN").slice(0, 400),
      };
    });

    const cmPayload = {
      CustomerRef: { value: customerQboId },
      TxnDate: new Date().toISOString().slice(0, 10),
      PrivateNote: privateNote,
      CustomerMemo: { value: "Return order — credit to your account" },
      Line: lines.map((l) => ({
        DetailType: "SalesItemLineDetail",
        Amount: Number((l.qty * l.unit_price).toFixed(2)),
        Description: l.description,
        SalesItemLineDetail: {
          ItemRef: { value: l.qbo_item_id },
          Qty: l.qty,
          UnitPrice: l.unit_price,
        },
      })),
    };
    const total = Number(lines.reduce((s, l) => s + l.qty * l.unit_price, 0).toFixed(2));

    if (mode === "preview") {
      return jsonRes({ ok: true, mode, payload: cmPayload, total, duration_ms: Date.now() - startedAt });
    }

    const token = await getAccessToken(sb);
    const created = (await acctPost(token, "/creditmemo", cmPayload))?.CreditMemo;
    if (!created?.Id) throw new Error("QBO returned no CreditMemo id");
    const mirror = await upsertMirror(created);

    return jsonRes({
      ok: true,
      mode,
      credit_memo: {
        id: String(created.Id),
        doc_number: created.DocNumber ?? null,
        total: parseFloat(created.TotalAmt) || total,
      },
      mirrored: mirror.mirrored,
      mirror_error: mirror.error,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("qbo-return-order failed:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
