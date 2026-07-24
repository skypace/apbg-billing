// sf-expense-autopost-background.mjs — post Service Fusion expense drafts to QBO
// as bills against the SF "vendor on record" (purchased_from), and email a
// confirmation per expense — or a "needs attention" alert when it can't.
//
// Background: the edge function `sf-receipt-sync` lands each SF job expense in
// Brixpense as a DRAFT (ops.expense_requests, tag='Service Fusion'), carrying
// vendor_name from the SF expense's `purchased_from` field. Historically those
// drafts just sat there — nothing created the QBO bill unless a human opened
// each one and clicked submit. This closes that loop.
//
// For each unposted SF-expense draft:
//   • blank vendor            → hold, "needs attention" email (fix Purchased From in SF), dedup
//   • vendor not in QuickBooks → hold, "needs attention" email, dedup
//   • vendor matched          → create the QBO bill (same logic as the manual
//                               expense-request-link-bill path), stamp
//                               status=posted / qbo_bill_id / vendor_id, and
//                               email a confirmation (job #, vendor, amount,
//                               QBO bill ID, account)
//
// Modes:  ?mode=preview  → dry run: no QBO writes, no DB writes; emails ONE
//                          digest of what WOULD happen. Safe to click anytime.
//         ?mode=post     → real: creates bills + per-expense emails.
// Auth:   superadmin Bearer (Master Control buttons) OR x-sf-autopost-secret
//         (= SUPABASE_SERVICE_ROLE_KEY prefix) for a future cron. Live posting
//         additionally requires SF_AUTOPOST_ENABLED=true (belt-and-suspenders
//         so a stray call can't book bills before it's trusted).
//
// Reuses qbo-helpers (same QBO auth as the AP tool). Writes ops.expense_requests
// + ops.sync_log (registered under brix-expense:app-and-functions in the manifest).

import { requireAuth } from './lib/auth.mjs';
import { qboRequest } from './qbo-helpers.mjs';
import { findQBOVendor } from './lib/qbo-vendor-match.mjs';
import { attachReceiptsToQBO } from './lib/qbo-attach.mjs';
import { brixpenseEmail, kvRow, kvTable, esc, money } from './lib/brixpense-email.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';

const REPORT_TO = process.env.SF_EXPENSE_REPORT_TO || 'whitney@alamedasoda.com';
const DEFAULT_COGS_ACCOUNT_ID = '101'; // Service COGS — same fallback as expense-request-link-bill
const LOOKBACK_DAYS = Number(process.env.SF_AUTOPOST_LOOKBACK_DAYS || 90);
const MAX_PER_RUN = 50;
// Forward-only cutoff: only auto-post/alert on expenses whose SF date (receipt_date)
// is on/after this. Scopes automation to the "vendor-on-record habit corrected"
// era and skips the historical blank-vendor backfill the nightly crawl lands
// (which would otherwise flood the alert inbox AND risk duplicate bills for
// expenses already keyed by hand). Blank/older receipt_date is skipped when set.
const MIN_RECEIPT_DATE = (process.env.SF_AUTOPOST_MIN_RECEIPT_DATE || '').trim();

function round(n) { return Math.round(Number(n || 0) * 100) / 100; }
// esc/money/brixpenseEmail/kvRow/kvTable come from lib/brixpense-email.mjs.

function srHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ops', 'Content-Profile': 'ops', ...extra };
}
async function opsGet(q) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: srHeaders() });
  if (!res.ok) throw new Error(`ops read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function opsPatch(q, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    method: 'PATCH', headers: srHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
async function logRun(started, status, records, metadata, errorMessage = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST', headers: srHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ source: 'sf', sync_type: 'sf-expense-autopost', status, records_synced: records, started_at: started, completed_at: new Date().toISOString(), error_message: errorMessage, metadata }),
    });
  } catch { /* best-effort */ }
}

// QBO vendor matching lives in lib/qbo-vendor-match.mjs (normalization +
// suffix-stripping + typo tolerance; ambiguous → null so we never post to the
// wrong vendor). The old per-word LIKE matcher missed real vendors over typos,
// trailing LLC, and plural/singular drift — verified live 2026-07-24.

function buildBillPayload(r, vendor, accountId) {
  const lineItems = Array.isArray(r.line_items) ? r.line_items : [];
  const lines = lineItems.length > 0
    ? lineItems.map((li, idx) => ({
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round((li.qty || li.quantity || 1) * (li.unit_price || li.unitCost || 0)) || round(li.amount || 0),
        Description: li.description || `Line ${idx + 1}`,
        AccountBasedExpenseLineDetail: { AccountRef: { value: r.cogs_account_id || accountId }, BillableStatus: 'NotBillable' },
      }))
    : [{
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round(r.total_amount),
        Description: r.memo || r.vendor_name || 'Service Fusion expense',
        AccountBasedExpenseLineDetail: { AccountRef: { value: r.cogs_account_id || accountId }, BillableStatus: 'NotBillable' },
      }];
  const memo = [
    `BRIXpense expense ${r.id}`, r.tag ? `tag:${r.tag}` : null, r.customer_name ? `cust:${r.customer_name}` : null,
    r.job_number ? `job:${r.job_number}` : null, r.memo || null,
  ].filter(Boolean).join(' | ').substring(0, 4000);
  const payload = { VendorRef: { value: vendor.Id }, Line: lines, PrivateNote: memo };
  if (r.receipt_date) payload.TxnDate = r.receipt_date;
  return payload;
}

async function emailConfirmation(r, vendor, billId, accountId) {
  const inner = `<p style="margin:0 0 14px;color:#fff;font-size:16px;font-weight:700">Bill entered in QuickBooks ✓</p>
    ${kvTable([
      kvRow('Vendor', `<b style="color:#fff">${esc(vendor.DisplayName)}</b> <span style="color:#64748B">(QBO id ${esc(vendor.Id)})</span>`),
      kvRow('Amount', `<b style="color:#4ADE80">${money(r.total_amount)}</b>`),
      kvRow('Service Fusion job', `${esc(r.job_number || '')}${r.customer_name ? ' — ' + esc(r.customer_name) : ''}`),
      kvRow('What it was for', esc((r.line_items && r.line_items[0] && r.line_items[0].description) || r.memo || '—')),
      kvRow('QBO Bill ID', `<b style="color:#fff">${esc(billId)}</b>`),
      kvRow('Account', esc(r.cogs_account_label || accountId)),
      kvRow('Brixpense ID', esc(r.id)),
    ].join(''))}`;
  await sendEmail({
    to: REPORT_TO,
    subject: `✅ Brixpense — QBO bill posted: ${vendor.DisplayName} ${money(r.total_amount)} (SF job ${r.job_number})`,
    html: brixpenseEmail('#22C55E', 'Bill posted', inner),
  });
}
async function emailNeedsAttention(r, reason) {
  const inner = `<p style="margin:0 0 6px;color:#fff;font-size:16px;font-weight:700">This expense needs attention</p>
    <p style="margin:0 0 14px;color:#CBD5E1">${esc(reason.long)}</p>
    ${kvTable([
      kvRow('Service Fusion job', `<b style="color:#fff">${esc(r.job_number || '')}</b>${r.customer_name ? ' — ' + esc(r.customer_name) : ''}`),
      kvRow('What it was for', esc((r.line_items && r.line_items[0] && r.line_items[0].description) || r.memo || '—')),
      kvRow('Vendor on record (SF)', r.vendor_name ? `<b style="color:#fff">${esc(r.vendor_name)}</b>` : '<i style="color:#FBBF24">blank — fill in “Purchased From” on the SF job expense</i>'),
      kvRow('Amount', money(r.total_amount)),
      kvRow('Brixpense ID', esc(r.id)),
    ].join(''))}
    <p style="color:#64748B;font-size:12px;margin-top:14px">Fix at the source — add the vendor to the SF expense’s “Purchased From,” or create the vendor in QuickBooks — and the next run posts it automatically. No repeat alerts for this one unless it changes.</p>`;
  await sendEmail({
    to: REPORT_TO,
    subject: `⚠ Brixpense — SF expense can't post: ${r.job_number || r.id} (${reason.short})`,
    html: brixpenseEmail('#F59E0B', 'Needs attention', inner),
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const mode = (url.searchParams.get('mode') || 'preview').toLowerCase();
  const isPost = mode === 'post';
  const isList = mode === 'list';

  // auth: cron secret OR superadmin bearer. list mode also accepts a one-off
  // read-only secret header (SF_AUTOPOST_LIST_SECRET) so the backlog can be
  // pulled when the Supabase MCP (used to mint a JWT) is unavailable.
  const cronSecret = req.headers.get('x-sf-autopost-secret') || '';
  const isCron = !!cronSecret && (
    cronSecret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32) ||
    (!!process.env.SF_AUTOPOST_CRON_SECRET && cronSecret === process.env.SF_AUTOPOST_CRON_SECRET)
  );
  const listSecret = req.headers.get('x-list-secret') || '';
  const listSecretOk = isList && listSecret && process.env.SF_AUTOPOST_LIST_SECRET && listSecret === process.env.SF_AUTOPOST_LIST_SECRET;
  if (!isCron && !listSecretOk) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }
  if (isPost && process.env.SF_AUTOPOST_ENABLED !== 'true') {
    return new Response(JSON.stringify({ error: 'Live posting is disabled. Set SF_AUTOPOST_ENABLED=true to allow ?mode=post. (Preview always works.)' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const started = new Date().toISOString();
  const sinceDate = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  try {
    const sel = 'id,vendor_name,vendor_id,total_amount,line_items,cogs_account_id,cogs_account_label,customer_name,job_number,receipt_date,memo,tag,request_type,status,qbo_bill_id,autopost_notified_at';
    // Forward-only cutoff: receipt_date >= MIN_RECEIPT_DATE excludes the historical
    // backfill (and PostgREST gte drops NULL receipt_date rows — exactly what we want).
    // Archived rows are always out of scope.
    const cutoff = MIN_RECEIPT_DATE ? `&receipt_date=gte.${MIN_RECEIPT_DATE}` : '';
    const rows = await opsGet(`expense_requests?tag=eq.Service%20Fusion&request_type=eq.expense&status=eq.draft&qbo_bill_id=is.null&archived_at=is.null&created_at=gte.${sinceDate}${cutoff}&order=created_at.asc&limit=${MAX_PER_RUN}&select=${sel}`);

    // Auto-archive the historical backfill (post mode only): pre-cutoff SF drafts
    // are already handled in QBO by hand (or intentionally skipped) — QBO is the
    // source of truth for them. Archiving keeps the SF Expenses tab clean as the
    // nightly crawl backfills old jobs; the row (and its sf_expense_id dedup key)
    // is kept, so the sync can never re-land an archived expense. Best-effort.
    let autoArchived = 0;
    if (isPost && MIN_RECEIPT_DATE) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/expense_requests?tag=eq.Service%20Fusion&request_type=eq.expense&status=eq.draft&qbo_bill_id=is.null&archived_at=is.null&receipt_date=lt.${MIN_RECEIPT_DATE}&select=id`, {
          method: 'PATCH',
          headers: srHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
          body: JSON.stringify({ archived_at: new Date().toISOString(), archived_by: 'autopost (historical, pre-cutoff — see QBO)' }),
        });
        if (res.ok) autoArchived = (await res.json()).length;
      } catch { /* non-fatal */ }
    }

    // LIST mode: read-only reconcile table — each unposted expense + whether its
    // SF "purchased_from" vendor already exists in QuickBooks. No emails, no writes.
    if (isList) {
      const items = [];
      for (const r of rows) {
        const descr = (r.line_items && r.line_items[0] && r.line_items[0].description) || r.memo || null;
        const v = r.vendor_name && String(r.vendor_name).trim() ? await findQBOVendor(r.vendor_name) : null;
        items.push({
          brixpense_id: r.id,
          job_number: r.job_number,
          customer_name: r.customer_name,
          what_for: descr,
          vendor_on_record_sf: r.vendor_name || null,
          amount: Number(r.total_amount) || 0,
          qbo_vendor_match: v ? { id: v.Id, name: v.DisplayName } : null,
          status: !r.vendor_name ? 'NO_VENDOR_IN_SF' : (v ? 'READY_TO_POST' : 'VENDOR_NOT_IN_QBO'),
        });
      }
      await logRun(started, 'success', 0, { mode: 'list', scanned: rows.length });
      return new Response(JSON.stringify({ ok: true, count: items.length, items }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const posted = [];
    const needVendor = [];   // blank purchased_from
    const noMatch = [];      // vendor present, no QBO vendor
    const qboErr = [];       // QBO rejected the bill

    for (const r of rows) {
      if (!r.vendor_name || !String(r.vendor_name).trim()) {
        needVendor.push(r);
        if (isPost && !r.autopost_notified_at) { await emailNeedsAttention(r, { short: 'no vendor in SF', long: 'This Service Fusion job expense has no "Purchased From" vendor recorded, so there is nothing to bill in QuickBooks.' }); await opsPatch(`expense_requests?id=eq.${r.id}`, { autopost_notified_at: new Date().toISOString(), autopost_error: 'blank purchased_from' }); }
        continue;
      }
      const vendor = await findQBOVendor(r.vendor_name);
      if (!vendor) {
        noMatch.push(r);
        if (isPost && !r.autopost_notified_at) { await emailNeedsAttention(r, { short: 'vendor not in QBO', long: `The vendor "${esc(r.vendor_name)}" on this Service Fusion expense doesn't match any vendor in QuickBooks. Add/rename the vendor in QBO (or fix the SF "Purchased From"), then it will post.` }); await opsPatch(`expense_requests?id=eq.${r.id}`, { autopost_notified_at: new Date().toISOString(), autopost_error: `no QBO vendor match: ${r.vendor_name}` }); }
        continue;
      }
      if (!isPost) { posted.push({ r, vendor }); continue; } // preview: would post

      // real post
      try {
        const payload = buildBillPayload(r, vendor, DEFAULT_COGS_ACCOUNT_ID);
        const res = await qboRequest('POST', '/bill', payload);
        const billId = res?.Bill?.Id;
        if (!billId) throw new Error('QBO returned no Bill.Id');
        await opsPatch(`expense_requests?id=eq.${r.id}`, {
          status: 'posted', qbo_bill_id: String(billId), vendor_id: String(vendor.Id),
          posted_at: new Date().toISOString(), autopost_error: null,
        });
        // Push the SF receipt image(s) onto the QBO bill so the reviewer sees
        // them in QuickBooks. Best-effort — never unwinds the posted bill.
        try { await attachReceiptsToQBO('Bill', billId, r.id); } catch { /* non-fatal */ }
        await emailConfirmation(r, vendor, billId, DEFAULT_COGS_ACCOUNT_ID);
        await opsPatch(`expense_requests?id=eq.${r.id}`, { autopost_bill_emailed_at: new Date().toISOString() });
        posted.push({ r, vendor, billId });
      } catch (e) {
        qboErr.push({ r, error: String(e?.message || e) });
        if (!r.autopost_notified_at) { await emailNeedsAttention(r, { short: 'QBO error', long: `QuickBooks rejected the bill for "${esc(r.vendor_name)}": ${esc(String(e?.message || e).slice(0, 300))}` }); await opsPatch(`expense_requests?id=eq.${r.id}`, { autopost_notified_at: new Date().toISOString(), autopost_error: String(e?.message || e).slice(0, 500) }); }
      }
    }

    // Preview: one branded digest email of what WOULD happen.
    if (!isPost) {
      const li = (arr, f) => arr.map(f).map((x) => `<li style="margin:2px 0">${x}</li>`).join('') || '<li style="color:#64748B"><i>none</i></li>';
      const inner = `<p style="margin:0 0 4px;color:#fff;font-size:16px;font-weight:700">Preview — dry run, nothing posted</p>
        <p style="margin:0 0 14px;color:#CBD5E1">${rows.length} unposted Service Fusion expense${rows.length === 1 ? '' : 's'} in the last ${LOOKBACK_DAYS} days.</p>
        <h3 style="color:#4ADE80;margin:14px 0 4px;font-size:14px">✅ Would post to QuickBooks (${posted.length})</h3>
        <ul style="margin:0;padding-left:18px;color:#E2E8F0">${li(posted, (p) => `<b>${esc(p.vendor.DisplayName)}</b> — ${money(p.r.total_amount)} — SF job ${esc(p.r.job_number || '')}`)}</ul>
        <h3 style="color:#FBBF24;margin:14px 0 4px;font-size:14px">⚠ No vendor in Service Fusion (${needVendor.length})</h3>
        <ul style="margin:0;padding-left:18px;color:#E2E8F0">${li(needVendor, (r) => `SF job ${esc(r.job_number || '')} — ${money(r.total_amount)} — <i style="color:#94A3B8">blank Purchased From</i>`)}</ul>
        <h3 style="color:#FBBF24;margin:14px 0 4px;font-size:14px">⚠ Vendor not in QuickBooks (${noMatch.length})</h3>
        <ul style="margin:0;padding-left:18px;color:#E2E8F0">${li(noMatch, (r) => `"<b>${esc(r.vendor_name)}</b>" — ${money(r.total_amount)} — SF job ${esc(r.job_number || '')}`)}</ul>
        <p style="color:#64748B;font-size:12px;margin-top:14px">This is a dry run. Use “Post now” in Master Control to create the bills and send a confirmation for each.</p>`;
      await sendEmail({
        to: REPORT_TO,
        subject: `Brixpense — SF expense auto-post PREVIEW (${posted.length} ready, ${needVendor.length + noMatch.length} need attention)`,
        html: brixpenseEmail('#3B82F6', 'Preview', inner),
      });
    }

    const summary = { mode, scanned: rows.length, posted: posted.length, need_vendor: needVendor.length, no_qbo_match: noMatch.length, qbo_error: qboErr.length, auto_archived: autoArchived };
    await logRun(started, 'success', posted.length, summary);
    return new Response(JSON.stringify({ ok: true, ...summary }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[sf-expense-autopost]', e);
    await logRun(started, 'error', 0, { mode }, String(e?.message || e).slice(0, 500));
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
