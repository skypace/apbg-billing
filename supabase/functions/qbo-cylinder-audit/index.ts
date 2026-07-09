// qbo-cylinder-audit v1 — create the $0 "CR-ADJ-<n>" cylinder audit
// adjustment invoice in QBO.
//
// Home for brix-order's driver Cylinder Audit PWA. Lives here (apbg-billing)
// because QBO token management + refresh already live in this project;
// brix-order never calls QBO directly (same boundary as qbo-charge /
// qbo-returned-payment).
//
// Why an invoice at all: the customer's live cylinder balance in brix-order
// (orders.v_cylinder_inventory) and the monthly BTRF roll-forward are both
// derived from QBO invoice lines — deliveries are lines on the cylinder
// items (CO8011 / CO8010 / CO8081 / CO8061 / BR80* / NI80*), pickups are
// lines on the PU* items. So when a driver's physical count disagrees with
// the system, a $0 invoice carrying those same items for the delta is the
// one write that reconciles everything downstream with no new count logic.
//
// Modes (body.mode):
//   "preview" — read-only. Echo the exact invoice payload "create" would
//               POST. No writes.
//   "create"  — POST the invoice to QBO with the explicit DocNumber
//               (CR-ADJ-<n>, allocated by brix-order's audit sequence), then
//               immediately upsert the header + lines into the ops mirror
//               (ops.qbo_invoices / ops.qbo_invoice_lines, same row shapes
//               and conflict keys as sync-qbo) so the portal's cylinder
//               count reflects the adjustment instantly instead of after
//               the next sync run. The periodic sync harmlessly re-upserts
//               the same rows later.
//
// Caller contract: brix-order's audit-submit function resolves the QBO item
// ids from the ops.qbo_items mirror and passes only the non-zero deltas.
// Lines are UnitPrice 0. Direction is normally encoded by the item (delivery
// item = count up, PU* pickup item = count down), matching how
// orders.v_cylinder_inventory classifies lines; when a bucket has no PU*
// pickup item in QBO the caller may instead send the delivery item with a
// NEGATIVE Qty, which nets identically in the count views.
//
// Requires header x-internal-secret == INTERNAL_PAY_SECRET so only
// brix-order's server-side, driver-gated function can call this.
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

const MAX_LINES = 12;
const MAX_QTY = 999;

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
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-cylinder-audit@v1",
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

// ── ops mirror upsert (same row shapes + conflict keys as sync-qbo) ──
function mirrorHeaderRow(txn: any) {
  return {
    qbo_invoice_id: txn.Id, txn_type: "Invoice",
    doc_number: txn.DocNumber || null,
    txn_date: txn.TxnDate, due_date: txn.DueDate || null,
    customer_ref_id: txn.CustomerRef?.value || null,
    customer_name:   txn.CustomerRef?.name  || null,
    total_amount: parseFloat(txn.TotalAmt) || 0,
    balance:      parseFloat(txn.Balance) || 0,
    status: parseFloat(txn.Balance) === 0 ? "paid" : "open",
    department: txn.DepartmentRef?.name || null,
    memo: txn.PrivateNote || null,
    sf_job_id: null,
    synced_at: new Date().toISOString(),
    qbo_updated_at: txn.MetaData?.LastUpdatedTime || null,
  };
}
function mirrorLineRows(txn: any, invRowId: number): any[] {
  const out: any[] = [];
  let idx = 0;
  for (const l of (txn.Line || [])) {
    if (l.DetailType !== "SalesItemLineDetail") continue;
    const d = l.SalesItemLineDetail || {};
    idx++;
    out.push({
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
  return out;
}
async function upsertMirror(txn: any): Promise<{ mirrored: boolean; error: string | null }> {
  try {
    const ops = getOpsSB();
    const { error: hErr } = await ops.from("qbo_invoices")
      .upsert([mirrorHeaderRow(txn)], { onConflict: "qbo_invoice_id,txn_type" });
    if (hErr) throw new Error("mirror header upsert: " + hErr.message);
    const { data: rows, error: rErr } = await ops.from("qbo_invoices")
      .select("id").eq("qbo_invoice_id", String(txn.Id)).eq("txn_type", "Invoice").limit(1);
    if (rErr || !rows || rows.length === 0) throw new Error("mirror header re-read failed" + (rErr ? ": " + rErr.message : ""));
    const invRowId = (rows[0] as any).id as number;
    const lines = mirrorLineRows(txn, invRowId);
    if (lines.length > 0) {
      const { error: lErr } = await ops.from("qbo_invoice_lines")
        .upsert(lines, { onConflict: "invoice_id,line_num" });
      if (lErr) throw new Error("mirror lines upsert: " + lErr.message);
    }
    return { mirrored: true, error: null };
  } catch (err) {
    // Non-fatal: the periodic sync-qbo run picks the invoice up within the
    // hour. The caller surfaces this so the driver UI can set expectations.
    console.error("qbo-cylinder-audit mirror upsert failed:", err);
    return { mirrored: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface AuditLine {
  qbo_item_id: string;
  item_name: string;
  qty: number;
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
    const docNumber = String(body?.doc_number || "").trim();
    const txnDate = String(body?.txn_date || "").trim() || new Date().toISOString().slice(0, 10);
    const privateNote = String(body?.private_note || "Tank rental audit adjustment — created by brix-order cylinder audit").slice(0, 4000);
    const rawLines: any[] = Array.isArray(body?.lines) ? body.lines : [];

    if (!/^[0-9]+$/.test(customerQboId)) throw new Error("bad customer_qbo_id");
    // DocNumber is allocated by brix-order's audit sequence; QBO caps it at 21 chars.
    if (!/^CR-ADJ-[0-9]{1,10}$/.test(docNumber)) throw new Error("bad doc_number (expected CR-ADJ-<n>)");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) throw new Error("bad txn_date");
    if (rawLines.length === 0) throw new Error("lines required");
    if (rawLines.length > MAX_LINES) throw new Error("too many lines");

    const lines: AuditLine[] = rawLines.map((l, i) => {
      const itemId = String(l?.qbo_item_id || "").trim();
      const itemName = String(l?.item_name || "").trim();
      const qty = Number(l?.qty);
      const description = String(l?.description || "").slice(0, 4000);
      if (!/^[0-9]+$/.test(itemId)) throw new Error("line " + (i + 1) + ": bad qbo_item_id");
      if (!itemName) throw new Error("line " + (i + 1) + ": item_name required");
      if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > MAX_QTY) throw new Error("line " + (i + 1) + ": bad qty");
      return { qbo_item_id: itemId, item_name: itemName, qty, description };
    });

    const invoicePayload = {
      CustomerRef: { value: customerQboId },
      DocNumber: docNumber.slice(0, 21),
      TxnDate: txnDate,
      DueDate: txnDate,
      // Every line is $0 — the adjustment carries count, not money. Direction
      // is the item: delivery item = count up, PU* pickup item = count down.
      Line: lines.map((l) => ({
        Amount: 0,
        DetailType: "SalesItemLineDetail",
        Description: l.description,
        SalesItemLineDetail: {
          ItemRef: { value: l.qbo_item_id },
          Qty: l.qty,
          UnitPrice: 0,
        },
      })),
      PrivateNote: privateNote,
    };

    if (mode === "preview") {
      return jsonRes({ ok: true, mode, plan: invoicePayload, duration_ms: Date.now() - startedAt });
    }

    const token = await getAccessToken(sb);

    // Verify the customer exists before writing (clearer error than QBO's 400).
    const custJ = await acctGet(token, "/customer/" + encodeURIComponent(customerQboId));
    if (!custJ?.Customer?.Id) throw new Error("customer not found in QBO: " + customerQboId);

    const created = await acctPost(token, "/invoice", invoicePayload);
    const inv = created?.Invoice;
    if (!inv?.Id) throw new Error("QBO returned no invoice: " + JSON.stringify(created).slice(0, 500));

    const mirror = await upsertMirror(inv);

    return jsonRes({
      ok: true,
      mode,
      invoice: {
        id: String(inv.Id),
        // Falls back to the QBO-assigned number if custom transaction
        // numbers are off on the realm (freshpet-invoice precedent).
        doc_number: String(inv.DocNumber || inv.Id),
        txn_date: String(inv.TxnDate || txnDate),
        total: Number(inv.TotalAmt ?? 0),
      },
      mirrored: mirror.mirrored,
      mirror_error: mirror.error,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("qbo-cylinder-audit FATAL:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
