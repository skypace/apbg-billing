// sync-qbo edge function — APBG-BILLING Supabase project
// version 44 (2026-06-15): FIX line-sync regression. `mode=fast` no longer
//   force-skips invoice lines. Previously the nightly cron (jobid 2) ran
//   `?mode=fast`, which set skipLines=true, so the scheduled sync upserted
//   HEADERS into ops.qbo_invoices but never fetched the per-invoice LINE
//   detail. Lines for the rolling window were only ever filled by the
//   `refresh-lines-rolling` cron — which has been returning 401 on every run
//   (it called the function with no Authorization header) — and by the
//   `backfill-invoice-lines` cron whose offset had marched past the end of the
//   table. Net effect: invoices from ~Apr 2026 onward accumulated headers with
//   no lines. The nightly incremental run now fetches + upserts lines for every
//   invoice it touches (header + lines together). Cost stays bounded because
//   syncOneType only reads an invoice when its lines are missing (or its
//   payment URL is missing) — repeat runs skip already-lined invoices. Line
//   skipping is now an explicit opt-in via `?skip_lines=true` only; the
//   historical `mode=full` header-sweep already passes that flag explicitly so
//   its behavior is unchanged. (Companion migration repairs the two broken
//   line crons.)
// version 42 (2026-05-28): extend SF job-id extraction beyond memo/CustomerMemo
//   to also scan the FIRST 5 description-only lines on the invoice. Brix's
//   FreeFlow invoicing automation places the Service Fusion job id (and order
//   metadata) in the top 3-4 "empty" line items at the top of the invoice as
//   DescriptionOnly entries rather than in PrivateNote / CustomerMemo. Pattern
//   stays Job #?\d{8,12} or SF[-\s]?\d{8,12}; in line descriptions we also
//   accept a bare 8-12 digit token. refresh-lines + lines + incremental sync
//   all persist sf_job_id during their per-invoice reads.
// version 41 (2026-05-28): extract Service Fusion job id from QBO PrivateNote /
//   CustomerMemo via regex (Job #?\d{8,12} | SF[-\s]?\d{8,12}) and persist to
//   ops.qbo_invoices.sf_job_id on every header upsert. NULL when the memo
//   carries no job reference. Surfaces to brix-order /invoices/:id so
//   customers can cross-reference an invoice with its delivery/service job.
// version 40 (2026-05-28): populate ops.qbo_invoices.invoice_payment_url with
//   Invoice.InvoiceLink (QBO-hosted "Pay now" URL) on every per-invoice read.
//   Read path now passes ?include=invoiceLink&minorversion=70 for Invoice-type
//   txns; for SalesReceipt / CreditMemo / RefundReceipt the field is N/A and
//   left NULL. We no longer short-circuit the per-invoice read when lines are
//   already present *and* the URL is missing — that gate now requires both
//   conditions to be satisfied before skipping, so back-pressure refills the
//   URL on the next scheduled run without forcing a full refetch_lines pass.
//   Surfaces to brix-order via orders.v_invoices_all.
// version 39 (2026-05-17): UPSERT line writes + mode=refresh-lines for chunked
//   historical refetch without an empty-cache window.
//   v38's delete-then-insert had two problems: (1) brief window where cache
//   showed $0 revenue for an invoice, (2) if 150s idle timeout killed the
//   function mid-loop, some invoices lost their lines entirely.
//   v39: schema migration 20260518b added UNIQUE(invoice_id, line_num); now we
//   UPSERT lines on that key. No empty window, no risk of orphaning lines.
//   New mode `refresh-lines` iterates a date+id-range window and refetches each
//   invoice's lines, designed for parallel slicing.
// version 38: smarter line-fetch skip + ?types= filter
// version 37: polymorphic sales-txn sync (Invoice, SalesReceipt, CreditMemo,
//   RefundReceipt). Sign-flip credits/refunds. Parse Discount line type.
// version 36: createClient { db: { schema: 'ops' } } so client targets ops.*

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_MINOR_VERSION_INVOICE_LINK = "70";
const PAGE_SIZE = 1000;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 3600;
const REFRESH_MIN_REMAINING_SECONDS = 300;
const LEASE_SECONDS = 20;
const LEASE_POLL_INTERVAL_MS = 750;
const LEASE_POLL_MAX_ATTEMPTS = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

interface TxnConfig { qboEntity: string; sign: 1 | -1; readPath: string; hasInvoiceLink: boolean; }
const TXN_CONFIGS: Record<string, TxnConfig> = {
  Invoice:       { qboEntity: "Invoice",       sign:  1, readPath: "invoice",       hasInvoiceLink: true  },
  SalesReceipt:  { qboEntity: "SalesReceipt",  sign:  1, readPath: "salesreceipt",  hasInvoiceLink: false },
  CreditMemo:    { qboEntity: "CreditMemo",    sign: -1, readPath: "creditmemo",    hasInvoiceLink: false },
  RefundReceipt: { qboEntity: "RefundReceipt", sign: -1, readPath: "refundreceipt", hasInvoiceLink: false },
};
const ALL_TXN_TYPES = Object.keys(TXN_CONFIGS);

const REVENUE_LINE_MAP_FALLBACK: Record<string, string> = {
  "120": "BIB - 3 Gallon", "121": "BIB - 5 Gallon", "273": "BIB - Delivery Fees",
  "123": "Gas - CO2",      "124": "Gas - Mixed/Nitro", "272": "Gas - Hazmat Fees",
  "32": "Equipment Sales", "33": "Equipment Rental",   "278": "Packaged Beverage",
  "35": "Service - General","253": "Service - Reman",  "255": "Service - Freshpet",
  "303": "Service - PM Contract", "306": "Shopify Sales", "312": "Shopify Shipping",
  "230": "Shipping Income","229": "Markup",            "10": "Shipping and Delivery",
};

function getRealm(): string { return Deno.env.get("QBO_REALM_ID") || "9130352144155116"; }
function getSB(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { db: { schema: "ops" } });
}
function jsonRes(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function refreshSalesLines(sb: SupabaseClient) {
  try { const { error } = await sb.rpc("refresh_sales_lines"); return { ok: !error, error: error?.message }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function loadRevenueMap(sb: SupabaseClient): Promise<Record<string, string>> {
  try {
    const { data } = await sb.from("revenue_account_map").select("qbo_income_account_id, revenue_line");
    if (!data || data.length === 0) return REVENUE_LINE_MAP_FALLBACK;
    const m: Record<string, string> = {};
    for (const r of data as any[]) m[r.qbo_income_account_id] = r.revenue_line;
    return m;
  } catch (_e) { return REVENUE_LINE_MAP_FALLBACK; }
}

// ── Token rotation (unchanged) ──
interface ClaimResult { cached_access_token: string | null; cached_refresh_token: string | null; must_refresh: boolean; lease_acquired: boolean; reason: string; }
async function claimRefresh(sb: SupabaseClient): Promise<ClaimResult> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh",
    { p_realm_id: getRealm(), p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS, p_lease_seconds: LEASE_SECONDS });
  if (error) throw new Error("claim_refresh: " + error.message);
  return (Array.isArray(data) ? data[0] : data) as ClaimResult;
}
async function persistTokens(sb: SupabaseClient, a: string, r: string, e: number, x: number | null) {
  const aE = new Date(Date.now() + e * 1000).toISOString();
  const rE = x ? new Date(Date.now() + x * 1000).toISOString() : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist",
    { p_realm_id: getRealm(), p_access_token: a, p_access_expires: aE, p_refresh_token: r, p_refresh_expires: rE, p_refreshed_by: "sync-qbo@v40" });
  if (error) throw new Error("persist: " + error.message);
}
async function releaseFailedLease(sb: SupabaseClient, m: string) {
  await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: m.slice(0, 500) });
}
async function intuitRefresh(rt: string) {
  const cid = Deno.env.get("QBO_CLIENT_ID") || ""; const csec = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!cid || !csec) throw new Error("missing QBO creds");
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: "Basic " + btoa(cid + ":" + csec) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("intuit: " + JSON.stringify(data));
  return data;
}
async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let i = 0; i < LEASE_POLL_MAX_ATTEMPTS; i++) {
    const c = await claimRefresh(sb);
    if (!c.must_refresh && c.cached_access_token) return c.cached_access_token;
    if (c.lease_acquired) {
      const seed = c.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) { await releaseFailedLease(sb, "no refresh token"); throw new Error("no refresh token"); }
      try {
        const fresh = await intuitRefresh(seed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS, fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) { await releaseFailedLease(sb, (err as Error).message); throw err; }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out on QBO refresh lease");
}

async function qboQ(sb: SupabaseClient, q: string): Promise<any> {
  const realm = getRealm();
  let token = await getAccessToken(sb);
  const url = QBO_BASE + "/" + realm + "/query?query=" + encodeURIComponent(q);
  let res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (res.status === 401) {
    await sb.rpc("qbo_token_release_failed", { p_realm_id: realm, p_error: "401 query" });
    token = await getAccessToken(sb);
    res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  }
  return res.json();
}
async function qboRead(sb: SupabaseClient, p: string, id: string, opts: { include?: string; minorVersion?: string } = {}): Promise<any> {
  const realm = getRealm();
  let token = await getAccessToken(sb);
  const params = new URLSearchParams();
  if (opts.include) params.set("include", opts.include);
  if (opts.minorVersion) params.set("minorversion", opts.minorVersion);
  const qs = params.toString();
  const url = QBO_BASE + "/" + realm + "/" + p + "/" + id + (qs ? "?" + qs : "");
  let res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (res.status === 401) {
    await sb.rpc("qbo_token_release_failed", { p_realm_id: realm, p_error: "401 read " + p });
    token = await getAccessToken(sb);
    res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  }
  return res.json();
}
async function qboReport(sb: SupabaseClient, n: string, p: Record<string, string>) {
  const realm = getRealm();
  let token = await getAccessToken(sb);
  const url = QBO_BASE + "/" + realm + "/reports/" + n + "?" + new URLSearchParams(p).toString();
  let res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (res.status === 401) {
    await sb.rpc("qbo_token_release_failed", { p_realm_id: realm, p_error: "401 report " + n });
    token = await getAccessToken(sb);
    res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  }
  return res.json();
}

// Change Data Capture: GET /cdc returns every entity of the requested types
// changed since `changedSince` — in ONE call, with full Line detail — so we can
// upsert headers + lines without per-invoice reads. The cheap replacement for
// the brute-force line-sweep crons.
async function cdcGet(sb: SupabaseClient, entities: string, changedSince: string): Promise<any> {
  const realm = getRealm();
  let token = await getAccessToken(sb);
  const u = QBO_BASE + "/" + realm + "/cdc?entities=" + encodeURIComponent(entities)
    + "&changedSince=" + encodeURIComponent(changedSince) + "&minorversion=70";
  let res = await fetch(u, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (res.status === 401) {
    await sb.rpc("qbo_token_release_failed", { p_realm_id: realm, p_error: "401 cdc" });
    token = await getAccessToken(sb);
    res = await fetch(u, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  }
  if (!res.ok) throw new Error("QBO CDC (" + res.status + "): " + (await res.text()).slice(0, 300));
  return res.json();
}

// readSalesTxn — wraps qboRead with the right include/minorversion combo per
// txn type. Invoice gets ?include=invoiceLink so the response carries the
// hosted payment URL; other txn types use the plain read path.
async function readSalesTxn(sb: SupabaseClient, cfg: TxnConfig, id: string): Promise<any> {
  if (cfg.hasInvoiceLink) {
    return qboRead(sb, cfg.readPath, id, { include: "invoiceLink", minorVersion: QBO_MINOR_VERSION_INVOICE_LINK });
  }
  return qboRead(sb, cfg.readPath, id);
}

// extractSfJobId — best-effort extraction of a Service Fusion job id from a
// QBO invoice. Two passes:
//
//   1. PrivateNote / CustomerMemo, prefix required ("Job #...", "SF-...").
//   2. First 5 description-only lines at the top of the invoice. Brix's
//      FreeFlow invoicing automation places the SF job id (and ancillary
//      order metadata) into the first 3-4 lines as DescriptionOnly entries.
//      In a line description we ALSO accept a bare 8-12 digit token, since
//      line descriptions don't carry phone numbers or other digit noise.
//
// Returns the first match or null.
const SF_JOB_ID_RE = /(?:Job\s*#?|SF[-\s]?)(\d{8,12})\b/i;
const BARE_JOB_ID_RE = /\b(\d{8,12})\b/;
function extractSfJobId(txn: any): string | null {
  // Pass 1: memo fields, prefix required.
  for (const c of [txn.PrivateNote, txn.CustomerMemo?.value]) {
    if (!c) continue;
    const m = String(c).match(SF_JOB_ID_RE);
    if (m && m[1]) return m[1];
  }

  // Pass 2: the top description-only / "empty" lines on the invoice. Skip
  // real item lines (SalesItemLineDetail with an ItemRef). Scan up to 5
  // candidate lines before giving up so we don't drift into product
  // descriptions.
  const lines = Array.isArray(txn.Line) ? txn.Line : [];
  let scanned = 0;
  for (const l of lines) {
    if (scanned >= 5) break;
    const hasItem =
      l?.DetailType === "SalesItemLineDetail" && l?.SalesItemLineDetail?.ItemRef?.value;
    if (hasItem) continue;
    const desc = l?.Description;
    if (!desc) continue;
    scanned++;
    const prefixed = String(desc).match(SF_JOB_ID_RE);
    if (prefixed && prefixed[1]) return prefixed[1];
    const bare = String(desc).match(BARE_JOB_ID_RE);
    if (bare && bare[1]) return bare[1];
  }
  return null;
}

// updateInvoiceSfJobId — writes the extracted SF job id back to the header
// row. Called from the per-invoice read paths (refresh-lines, lines, and the
// secondary read in syncOneType) so existing invoices get backfilled without
// requiring a full bulk re-sync.
async function updateInvoiceSfJobId(sb: SupabaseClient, invRowId: number, jobId: string | null) {
  const { error } = await sb.from("qbo_invoices")
    .update({ sf_job_id: jobId }).eq("id", invRowId);
  if (error) console.error(`update sf_job_id id=${invRowId}: ${error.message}`);
}

function headerRow(txn: any, txnType: string, sign: 1 | -1) {
  return {
    qbo_invoice_id: txn.Id, txn_type: txnType,
    doc_number: txn.DocNumber || null,
    txn_date: txn.TxnDate, due_date: txn.DueDate || null,
    customer_ref_id: txn.CustomerRef?.value || null,
    customer_name:   txn.CustomerRef?.name  || null,
    total_amount: (parseFloat(txn.TotalAmt) || 0) * sign,
    balance:      (parseFloat(txn.Balance) || 0) * sign,
    status: parseFloat(txn.Balance) === 0 ? "paid" : "open",
    department: txn.DepartmentRef?.name || null,
    memo: txn.PrivateNote || null,
    sf_job_id: extractSfJobId(txn),
    synced_at: new Date().toISOString(),
    qbo_updated_at: txn.MetaData?.LastUpdatedTime || null,
    // InvoiceLink only comes back when the read includes ?include=invoiceLink;
    // the bulk SELECT * query never returns it, so on the initial header upsert
    // this is left undefined (i.e. column not touched) and gets filled in by
    // the per-invoice read below.
  };
}
function lineRowsFromTxn(txn: any, invRowId: number, sign: 1 | -1, revMap: Record<string, string>): any[] {
  const out: any[] = [];
  let idx = 0;
  for (const l of (txn.Line || [])) {
    const dt = l.DetailType;
    let acctId = "", acctName: string | null = null;
    let itemRefId: string | null = null, itemName: string | null = null;
    let qty: number | null = null, unitPrice: number | null = null;
    let lineSign: 1 | -1 = sign;

    if (dt === "SalesItemLineDetail") {
      const d = l.SalesItemLineDetail || {};
      acctId = d.ItemAccountRef?.value || "";
      acctName = d.ItemAccountRef?.name || null;
      itemRefId = d.ItemRef?.value || null;
      itemName  = d.ItemRef?.name  || null;
      qty = d.Qty ?? null; unitPrice = d.UnitPrice ?? null;
    } else if (dt === "DiscountLineDetail") {
      const d = l.DiscountLineDetail || {};
      acctId = d.DiscountAccountRef?.value || "";
      acctName = d.DiscountAccountRef?.name || "Discounts";
      lineSign = (sign * -1) as 1 | -1;
    } else if (dt === "GroupLineDetail") {
      // Group/bundle item — expand its child lines. Each child has its own
      // SalesItemLineDetail. The parent line's Amount is the sum and gets
      // skipped; the children get individually emitted.
      const group = l.GroupLineDetail || {};
      for (const child of (group.Line || [])) {
        const cd = child.DetailType;
        if (cd !== "SalesItemLineDetail") continue;
        const cdd = child.SalesItemLineDetail || {};
        idx++;
        out.push({
          invoice_id: invRowId, line_num: idx,
          description: child.Description || null,
          quantity: cdd.Qty ?? null,
          unit_price: cdd.UnitPrice ?? null,
          amount: (parseFloat(child.Amount) || 0) * sign,
          item_ref_id: cdd.ItemRef?.value || null,
          item_name:   cdd.ItemRef?.name  || null,
          account_ref_id: cdd.ItemAccountRef?.value || "",
          account_name:   cdd.ItemAccountRef?.name  || null,
          revenue_line: cdd.ItemAccountRef?.value ? (revMap[cdd.ItemAccountRef.value] || null) : null,
          department: txn.DepartmentRef?.name || null,
        });
      }
      continue;
    } else { continue; }

    idx++;
    const raw = parseFloat(l.Amount) || 0;
    out.push({
      invoice_id: invRowId, line_num: idx,
      description: l.Description || null,
      quantity: qty, unit_price: unitPrice,
      amount: raw * lineSign,
      item_ref_id: itemRefId, item_name: itemName,
      account_ref_id: acctId, account_name: acctName,
      revenue_line: acctId ? (revMap[acctId] || null) : null,
      department: txn.DepartmentRef?.name || null,
    });
  }
  return out;
}

async function writeLines(sb: SupabaseClient, invRowId: number, lines: any[]) {
  if (lines.length === 0) return 0;
  // UPSERT on (invoice_id, line_num). Removes the empty-window risk; safe if
  // killed mid-flight.
  const { error } = await sb.from("qbo_invoice_lines")
    .upsert(lines, { onConflict: "invoice_id,line_num" });
  if (error) throw new Error("upsert lines: " + error.message);
  // Remove any orphan lines with line_num greater than what we wrote (in case
  // QBO removed a line since the previous sync).
  const maxLineNum = Math.max(...lines.map((l) => l.line_num));
  await sb.from("qbo_invoice_lines").delete().eq("invoice_id", invRowId).gt("line_num", maxLineNum);
  return lines.length;
}

// updateInvoicePaymentUrl — writes Invoice.InvoiceLink back to the header row.
// Only meaningful for txn_type=Invoice; the column stays NULL for everything
// else. We always write (even when InvoiceLink is null) so QBO toggling
// e-invoicing off retracts the URL on the next sync.
async function updateInvoicePaymentUrl(sb: SupabaseClient, invRowId: number, url: string | null) {
  const { error } = await sb.from("qbo_invoices")
    .update({ invoice_payment_url: url }).eq("id", invRowId);
  if (error) console.error(`update invoice_payment_url id=${invRowId}: ${error.message}`);
}

async function syncOneType(
  sb: SupabaseClient, txnType: string, startDate: string, endDate: string,
  skipLines: boolean, refetchExistingLines: boolean, revMap: Record<string, string>,
) {
  const cfg = TXN_CONFIGS[txnType];
  let headers = 0, lines = 0, errors = 0;
  let startPos = 1;
  while (true) {
    const q = `SELECT * FROM ${cfg.qboEntity} WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' STARTPOSITION ${startPos} MAXRESULTS ${PAGE_SIZE}`;
    const result = await qboQ(sb, q);
    const list = result?.QueryResponse?.[cfg.qboEntity] || [];
    if (list.length === 0) break;
    const headerRows = list.map((txn: any) => headerRow(txn, txnType, cfg.sign));
    await sb.from("qbo_invoices").upsert(headerRows, { onConflict: "qbo_invoice_id,txn_type" });
    if (!skipLines) {
      const qboIds = list.map((t: any) => t.Id);
      const { data: invRows } = await sb.from("qbo_invoices")
        .select("id, qbo_invoice_id, invoice_payment_url").in("qbo_invoice_id", qboIds).eq("txn_type", txnType);
      const invByQboId = new Map<string, { id: number; invoice_payment_url: string | null }>();
      for (const r of (invRows as any[]) || []) invByQboId.set(r.qbo_invoice_id, { id: r.id, invoice_payment_url: r.invoice_payment_url });
      for (const txn of list) {
        try {
          const row = invByQboId.get(txn.Id);
          if (!row) continue;
          const invDbId = row.id;
          const needsUrl = cfg.hasInvoiceLink && !row.invoice_payment_url;
          if (!refetchExistingLines && !needsUrl) {
            const { count } = await sb.from("qbo_invoice_lines").select("id", { count: "exact", head: true }).eq("invoice_id", invDbId);
            if ((count || 0) > 0) continue;
          }
          const full = await readSalesTxn(sb, cfg, txn.Id);
          const body = full?.[cfg.qboEntity] || txn;
          const lineRows = lineRowsFromTxn(body, invDbId, cfg.sign, revMap);
          lines += await writeLines(sb, invDbId, lineRows);
          if (cfg.hasInvoiceLink) {
            await updateInvoicePaymentUrl(sb, invDbId, body.InvoiceLink || null);
          }
          await updateInvoiceSfJobId(sb, invDbId, extractSfJobId(body));
          await sleep(80);
        } catch (e: any) {
          errors++;
          console.error(`${txnType} ${txn.Id}: ${e.message}`);
        }
      }
    }
    headers += list.length;
    if (list.length < PAGE_SIZE) break;
    startPos += PAGE_SIZE;
  }
  return { headers, lines, errors };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "incremental";
  const sb = getSB();

  if (mode === "refresh-mv") {
    const r = await refreshSalesLines(sb);
    return jsonRes({ status: r.ok ? "success" : "error", refresh: r });
  }
  if (mode === "whoami") return jsonRes({ version: 45, txn_types_supported: ALL_TXN_TYPES, modes: ["incremental","full","fast","lines","refresh-lines","cdc","refresh-mv"] });

  // === refresh-lines mode ===
  // Reads a slice of qbo_invoices by date+offset and refetches their lines via
  // upsert. Designed for parallel use: fire N calls with offsets 0, batch, 2*batch...
  // Each call is bounded; safe under the 150s timeout. v40 also refreshes
  // invoice_payment_url for Invoice-type rows.
  if (mode === "refresh-lines") {
    const start = url.searchParams.get("start") || "2026-01-01";
    const end = url.searchParams.get("end") || new Date().toISOString().split("T")[0];
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const batch = parseInt(url.searchParams.get("batch") || "100");
    const revMap = await loadRevenueMap(sb);
    const { data: rows } = await sb.from("qbo_invoices")
      .select("id, qbo_invoice_id, txn_type")
      .gte("txn_date", start).lte("txn_date", end)
      .order("id")
      .range(offset, offset + batch - 1);
    let processed = 0, linesWritten = 0, urlsWritten = 0, jobsWritten = 0, errors = 0;
    for (const r of (rows || []) as any[]) {
      const cfg = TXN_CONFIGS[r.txn_type] || TXN_CONFIGS.Invoice;
      try {
        const full = await readSalesTxn(sb, cfg, r.qbo_invoice_id);
        const body = full?.[cfg.qboEntity];
        if (!body) continue;
        const lineRows = lineRowsFromTxn(body, r.id, cfg.sign, revMap);
        linesWritten += await writeLines(sb, r.id, lineRows);
        if (cfg.hasInvoiceLink) {
          await updateInvoicePaymentUrl(sb, r.id, body.InvoiceLink || null);
          if (body.InvoiceLink) urlsWritten++;
        }
        const jobId = extractSfJobId(body);
        await updateInvoiceSfJobId(sb, r.id, jobId);
        if (jobId) jobsWritten++;
        processed++;
        await sleep(80);
      } catch (e: any) {
        errors++;
        console.error(`refresh-lines ${r.qbo_invoice_id} (${r.txn_type}): ${e.message}`);
      }
    }
    const mvResult = await refreshSalesLines(sb);
    return jsonRes({
      status: "success", mode: "refresh-lines",
      start, end, offset, batch,
      rows_returned: rows?.length || 0, processed,
      lines_written: linesWritten, urls_written: urlsWritten, jobs_written: jobsWritten,
      errors,
      next_offset: offset + batch, mv_refresh: mvResult,
    });
  }

  if (mode === "lines") {
    const batchSize = parseInt(url.searchParams.get("batch") || "50");
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const revMap = await loadRevenueMap(sb);
    const { data: allInvs } = await sb.from("qbo_invoices")
      .select("id, qbo_invoice_id, txn_type, invoice_payment_url")
      .range(offset, offset + batchSize - 1);
    let processed = 0, linesAdded = 0;
    for (const inv of (allInvs || []) as any[]) {
      const cfg = TXN_CONFIGS[inv.txn_type] || TXN_CONFIGS.Invoice;
      const needsUrl = cfg.hasInvoiceLink && !inv.invoice_payment_url;
      const { count } = await sb.from("qbo_invoice_lines")
        .select("id", { count: "exact", head: true }).eq("invoice_id", inv.id);
      if ((count || 0) > 0 && !needsUrl) continue;
      try {
        const full = await readSalesTxn(sb, cfg, inv.qbo_invoice_id);
        const body = full?.[cfg.qboEntity];
        if (!body) continue;
        const rows = lineRowsFromTxn(body, inv.id, cfg.sign, revMap);
        linesAdded += await writeLines(sb, inv.id, rows);
        if (cfg.hasInvoiceLink) {
          await updateInvoicePaymentUrl(sb, inv.id, body.InvoiceLink || null);
        }
        await updateInvoiceSfJobId(sb, inv.id, extractSfJobId(body));
        processed++;
        await sleep(80);
      } catch (e: any) {
        console.error(`Line read ${inv.qbo_invoice_id} (${inv.txn_type}): ${e.message}`);
      }
    }
    const mvResult = await refreshSalesLines(sb);
    await sb.from("sync_log").insert({
      source: "qbo", sync_type: "lines_backfill", status: "success",
      records_synced: linesAdded, completed_at: new Date().toISOString(),
      metadata: { offset, batch: batchSize, processed, mv_refresh: mvResult },
    });
    return jsonRes({
      status: "success", mode: "lines",
      invoices_checked: allInvs?.length || 0, invoices_processed: processed,
      lines_added: linesAdded, next_offset: offset + batchSize, mv_refresh: mvResult,
    });
  }

  // === cdc mode (Change Data Capture backstop) ===
  // Pull ONLY the sales txns changed since the last run — one CDC call returns
  // them WITH line detail — and upsert header + lines from that payload (no
  // per-invoice reads). Catches new invoices + any change the webhook missed,
  // at a handful of API calls per run. Replaces the line-sweep polling crons.
  if (mode === "cdc") {
    const lookbackMin = parseInt(url.searchParams.get("lookback_min") || "45");
    // changedSince = last successful cdc run minus a 5-min overlap; else lookback.
    const { data: lastRows } = await sb.from("sync_log")
      .select("completed_at").eq("sync_type", "cdc").eq("status", "success")
      .order("completed_at", { ascending: false }).limit(1);
    const lastTs = (lastRows as any[])?.[0]?.completed_at;
    let since = lastTs
      ? new Date(new Date(lastTs).getTime() - 5 * 60 * 1000)
      : new Date(Date.now() - lookbackMin * 60 * 1000);
    const minSince = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000); // CDC max 30d
    if (since < minSince) since = minSince;
    const sinceIso = since.toISOString();

    try {
      const revMap = await loadRevenueMap(sb);
      const entities = ["Invoice", "CreditMemo", "SalesReceipt", "RefundReceipt"];
      const cdc = await cdcGet(sb, entities.join(","), sinceIso);
      const qrs: any[] = cdc?.CDCResponse?.[0]?.QueryResponse || [];
      const perType: Record<string, any> = {};
      let totalHeaders = 0, totalLines = 0, totalErrors = 0, totalDeleted = 0;

      for (const qr of qrs) {
        for (const txnType of entities) {
          const list = qr[txnType];
          if (!Array.isArray(list) || list.length === 0) continue;
          const cfg = TXN_CONFIGS[txnType];

          // Deleted entities come back flagged; prune them, upsert the rest.
          const live = list.filter((t: any) => !(t.status === "Deleted" || t.Deleted));
          const dead = list.filter((t: any) => (t.status === "Deleted" || t.Deleted));

          if (live.length > 0) {
            const headerRows = live.map((txn: any) => headerRow(txn, txnType, cfg.sign));
            await sb.from("qbo_invoices").upsert(headerRows, { onConflict: "qbo_invoice_id,txn_type" });
          }
          const ids = list.map((t: any) => String(t.Id));
          const { data: invRows } = await sb.from("qbo_invoices")
            .select("id, qbo_invoice_id").in("qbo_invoice_id", ids).eq("txn_type", txnType);
          const idMap = new Map<string, number>();
          for (const r of (invRows as any[]) || []) idMap.set(r.qbo_invoice_id, r.id);

          let h = 0, ln = 0, err = 0, del = 0;
          for (const txn of live) {
            try {
              const rid = idMap.get(String(txn.Id));
              if (!rid) continue;
              // CDC payload already carries Line detail — no extra read.
              const lineRows = lineRowsFromTxn(txn, rid, cfg.sign, revMap);
              ln += await writeLines(sb, rid, lineRows);
              await updateInvoiceSfJobId(sb, rid, extractSfJobId(txn));
              h++;
            } catch (e: any) { err++; console.error(`cdc ${txnType} ${txn.Id}: ${e.message}`); }
          }
          for (const txn of dead) {
            const rid = idMap.get(String(txn.Id));
            if (!rid) continue;
            await sb.from("qbo_invoice_lines").delete().eq("invoice_id", rid);
            await sb.from("qbo_invoices").delete().eq("id", rid);
            del++;
          }
          perType[txnType] = { changed: list.length, processed: h, lines: ln, deleted: del, errors: err };
          totalHeaders += h; totalLines += ln; totalErrors += err; totalDeleted += del;
        }
      }

      const mvResult = await refreshSalesLines(sb);
      await sb.from("sync_log").insert({
        source: "qbo", sync_type: "cdc", status: "success",
        records_synced: totalHeaders, completed_at: new Date().toISOString(),
        metadata: { changed_since: sinceIso, per_type: perType, lines: totalLines, deleted: totalDeleted, errors: totalErrors },
      });
      return jsonRes({
        status: "success", mode: "cdc", changed_since: sinceIso,
        per_type: perType, total_headers: totalHeaders, total_lines: totalLines,
        deleted: totalDeleted, errors: totalErrors, mv_refresh: mvResult,
      });
    } catch (err: any) {
      await sb.from("sync_log").insert({
        source: "qbo", sync_type: "cdc", status: "error",
        error_message: (err?.message || String(err)).slice(0, 500), completed_at: new Date().toISOString(),
      }).then(() => {}, () => {});
      return jsonRes({ status: "error", mode: "cdc", changed_since: sinceIso, message: err?.message || String(err) }, 500);
    }
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  let startDate = url.searchParams.get("start") || (now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-01");
  let endDate = url.searchParams.get("end") || now.toISOString().split("T")[0];
  if (mode === "full") startDate = "2025-01-01";
  // Line skipping is an explicit opt-in only. `mode=fast` used to imply
  // skip_lines=true, which left the nightly scheduled sync header-only and is
  // the root cause of the missing-lines regression (recent invoices got
  // headers but no line detail). The current-month window is small and
  // syncOneType only issues a per-invoice read when lines (or the payment URL)
  // are missing, so fetching lines here is cheap on repeat runs. Historical
  // header-only sweeps must now pass `?skip_lines=true` explicitly (the
  // `mode=full` cron/manual invocations already do).
  const skipLines = url.searchParams.get("skip_lines") === "true";
  const refetchExistingLines = url.searchParams.get("refetch_lines") === "true";
  const requestedTypes = (url.searchParams.get("types") || ALL_TXN_TYPES.join(","))
    .split(",").map(s => s.trim()).filter(s => ALL_TXN_TYPES.includes(s));
  const types = requestedTypes.length > 0 ? requestedTypes : ALL_TXN_TYPES;

  try {
    await getAccessToken(sb);
    const revMap = await loadRevenueMap(sb);
    const perTypeResults: Record<string, any> = {};
    let totalHeaders = 0;
    for (const t of types) {
      const r = await syncOneType(sb, t, startDate, endDate, skipLines, refetchExistingLines, revMap);
      perTypeResults[t] = r;
      totalHeaders += r.headers;
    }
    await sb.from("sync_log").insert({
      source: "qbo", sync_type: skipLines ? "headers_only" : "invoices",
      status: "success", records_synced: totalHeaders,
      completed_at: new Date().toISOString(),
      metadata: { start_date: startDate, end_date: endDate, mode, skip_lines: skipLines, types, per_type: perTypeResults },
    });

    let plCount = 0;
    if (requestedTypes.length === 0 || requestedTypes.length === ALL_TXN_TYPES.length) {
      const startD = new Date(startDate);
      const endD = new Date(endDate);
      const cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
      while (cur <= endD) {
        const ms = cur.toISOString().split("T")[0];
        const me = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).toISOString().split("T")[0];
        const report = await qboReport(sb, "ProfitAndLoss", { start_date: ms, end_date: me, accounting_method: "Accrual" });
        const plRows: any[] = [];
        function extract(section: any, accountType: string) {
          if (!section?.Row) return;
          for (const row of section.Row) {
            if (row.type === "Data" && row.ColData) {
              const name = row.ColData[0]?.value;
              const id = row.ColData[0]?.id;
              const amt = parseFloat(row.ColData[1]?.value) || 0;
              if (name && id) plRows.push({
                period: ms, account_id: id, account_name: name,
                account_type: accountType, amount: amt,
                entity: "combined", snapshot_at: new Date().toISOString(),
              });
            }
            if (row.Rows) extract(row.Rows, accountType);
          }
        }
        for (const section of (report?.Rows?.Row || [])) {
          const h = section.Header?.ColData?.[0]?.value || "";
          let t = "Other";
          if (h === "Income") t = "Income";
          else if (h === "Cost of Goods Sold") t = "Cost of Goods Sold";
          else if (h === "Expenses") t = "Expense";
          if (section.Rows) extract(section.Rows, t);
        }
        if (plRows.length > 0) {
          await sb.from("pl_snapshots").delete().eq("period", ms).eq("entity", "combined");
          await sb.from("pl_snapshots").insert(plRows);
        }
        plCount += plRows.length;
        cur.setMonth(cur.getMonth() + 1);
      }
      await sb.from("sync_log").insert({
        source: "qbo", sync_type: "pl_snapshots", status: "success",
        records_synced: plCount, completed_at: new Date().toISOString(),
      });
    }
    const mvResult = await refreshSalesLines(sb);
    return jsonRes({
      status: "success", mode, types, skip_lines: skipLines,
      total_headers: totalHeaders, per_type: perTypeResults,
      pl_rows: plCount, mv_refresh: mvResult,
    });
  } catch (err: any) {
    console.error("FATAL:", err);
    try {
      await sb.from("sync_log").insert({
        source: "qbo", sync_type: "fatal", status: "error",
        records_synced: 0, error_message: err.message,
        completed_at: new Date().toISOString(),
      });
    } catch (_e) { /* */ }
    return jsonRes({ status: "error", message: err.message }, 500);
  }
});
