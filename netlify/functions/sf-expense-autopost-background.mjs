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
import { qboRequest, qboQuery } from './qbo-helpers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';

const REPORT_TO = process.env.SF_EXPENSE_REPORT_TO || 'whitney@alamedasoda.com';
const DEFAULT_COGS_ACCOUNT_ID = '101'; // Service COGS — same fallback as expense-request-link-bill
const LOOKBACK_DAYS = Number(process.env.SF_AUTOPOST_LOOKBACK_DAYS || 90);
const MAX_PER_RUN = 50;

function round(n) { return Math.round(Number(n || 0) * 100) / 100; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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

// ── QBO vendor match + bill build — identical logic to expense-request-link-bill ──
async function findQBOVendor(name) {
  if (!name) return null;
  try {
    const safe = name.replace(/'/g, "\\'");
    const exact = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName = '${safe}'`);
    const v = exact.QueryResponse?.Vendor || [];
    if (v.length > 0) return v[0];
  } catch { /* fall through to fuzzy */ }
  try {
    const words = name.split(/\s+/).filter((w) => w.length > 2);
    for (const w of words.slice(0, 3)) {
      const clean = w.replace(/[^a-zA-Z0-9]/g, '');
      if (!clean) continue;
      const like = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${clean}%'`);
      const v2 = like.QueryResponse?.Vendor || [];
      if (v2.length === 1) return v2[0];
      if (v2.length > 1) {
        const best = v2.find((x) => x.DisplayName.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.DisplayName.toLowerCase()));
        if (best) return best;
      }
    }
  } catch { /* no match */ }
  return null;
}

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

// ── emails ──
async function emailConfirmation(r, vendor, billId, accountId) {
  await sendEmail({
    to: REPORT_TO,
    subject: `✅ QBO bill posted — ${vendor.DisplayName} ${money(r.total_amount)} (SF job ${r.job_number})`,
    html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:640px">
      <div style="background:#059669;color:#fff;padding:12px 18px;border-radius:10px 10px 0 0"><b>Expense posted to QuickBooks</b></div>
      <div style="border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px;padding:14px 18px;color:#111827;font-size:14px">
        <table style="border-collapse:collapse">
          <tr><td style="padding:3px 10px;color:#6B7280">Vendor</td><td style="padding:3px 10px"><b>${esc(vendor.DisplayName)}</b> (QBO id ${esc(vendor.Id)})</td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">Amount</td><td style="padding:3px 10px"><b>${money(r.total_amount)}</b></td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">SF job</td><td style="padding:3px 10px">${esc(r.job_number || '')}${r.customer_name ? ' — ' + esc(r.customer_name) : ''}</td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">QBO Bill ID</td><td style="padding:3px 10px"><b>${esc(billId)}</b></td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">Account</td><td style="padding:3px 10px">${esc(r.cogs_account_label || accountId)}</td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">Brixpense ID</td><td style="padding:3px 10px">${esc(r.id)}</td></tr>
        </table>
      </div></div>`,
  });
}
async function emailNeedsAttention(r, reason) {
  await sendEmail({
    to: REPORT_TO,
    subject: `⚠ SF expense can't post to QBO — ${r.job_number || r.id} (${reason.short})`,
    html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:640px">
      <div style="background:#B45309;color:#fff;padding:12px 18px;border-radius:10px 10px 0 0"><b>Service Fusion expense needs attention</b></div>
      <div style="border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px;padding:14px 18px;color:#111827;font-size:14px">
        <p style="margin:0 0 10px">${esc(reason.long)}</p>
        <table style="border-collapse:collapse">
          <tr><td style="padding:3px 10px;color:#6B7280">SF job</td><td style="padding:3px 10px"><b>${esc(r.job_number || '')}</b>${r.customer_name ? ' — ' + esc(r.customer_name) : ''}</td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">Vendor on record (SF)</td><td style="padding:3px 10px">${r.vendor_name ? esc(r.vendor_name) : '<i>blank — fill in "Purchased From" on the SF job expense</i>'}</td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">Amount</td><td style="padding:3px 10px">${money(r.total_amount)}</td></tr>
          <tr><td style="padding:3px 10px;color:#6B7280">Brixpense ID</td><td style="padding:3px 10px">${esc(r.id)}</td></tr>
        </table>
        <p style="color:#6B7280;font-size:12px;margin-top:12px">Fix at the source (SF "Purchased From", or add the vendor in QuickBooks) and the next run will post it. You won't get repeat alerts for this one unless it changes.</p>
      </div></div>`,
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const mode = (url.searchParams.get('mode') || 'preview').toLowerCase();
  const isPost = mode === 'post';

  // auth: cron secret OR superadmin bearer
  const cronSecret = req.headers.get('x-sf-autopost-secret') || '';
  const isCron = cronSecret && cronSecret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32);
  if (!isCron) {
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
    const rows = await opsGet(`expense_requests?tag=eq.Service%20Fusion&request_type=eq.expense&status=eq.draft&qbo_bill_id=is.null&created_at=gte.${sinceDate}&order=created_at.asc&limit=${MAX_PER_RUN}&select=${sel}`);

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
        await emailConfirmation(r, vendor, billId, DEFAULT_COGS_ACCOUNT_ID);
        await opsPatch(`expense_requests?id=eq.${r.id}`, { autopost_bill_emailed_at: new Date().toISOString() });
        posted.push({ r, vendor, billId });
      } catch (e) {
        qboErr.push({ r, error: String(e?.message || e) });
        if (!r.autopost_notified_at) { await emailNeedsAttention(r, { short: 'QBO error', long: `QuickBooks rejected the bill for "${esc(r.vendor_name)}": ${esc(String(e?.message || e).slice(0, 300))}` }); await opsPatch(`expense_requests?id=eq.${r.id}`, { autopost_notified_at: new Date().toISOString(), autopost_error: String(e?.message || e).slice(0, 500) }); }
      }
    }

    // Preview: one digest email of what WOULD happen.
    if (!isPost) {
      const li = (arr, f) => arr.map(f).map((x) => `<li>${x}</li>`).join('') || '<li><i>none</i></li>';
      await sendEmail({
        to: REPORT_TO,
        subject: `SF expense auto-post — PREVIEW (${posted.length} would post, ${needVendor.length + noMatch.length} need attention)`,
        html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:680px">
          <div style="background:#1F4E79;color:#fff;padding:12px 18px;border-radius:10px 10px 0 0"><b>SF expense auto-post — PREVIEW (dry run, nothing posted)</b></div>
          <div style="border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px;padding:14px 18px;color:#111827;font-size:14px">
          <p>${rows.length} unposted SF-expense drafts in the last ${LOOKBACK_DAYS} days.</p>
          <h3 style="color:#059669;margin:12px 0 4px">✅ Would post to QBO (${posted.length})</h3><ul>${li(posted, (p) => `${esc(p.vendor.DisplayName)} — ${money(p.r.total_amount)} — SF job ${esc(p.r.job_number || '')}`)}</ul>
          <h3 style="color:#B45309;margin:12px 0 4px">⚠ No vendor in SF (${needVendor.length})</h3><ul>${li(needVendor, (r) => `SF job ${esc(r.job_number || '')} — ${money(r.total_amount)} — <i>blank Purchased From</i>`)}</ul>
          <h3 style="color:#B45309;margin:12px 0 4px">⚠ Vendor not in QuickBooks (${noMatch.length})</h3><ul>${li(noMatch, (r) => `"${esc(r.vendor_name)}" — ${money(r.total_amount)} — SF job ${esc(r.job_number || '')}`)}</ul>
          <p style="color:#6B7280;font-size:12px;margin-top:12px">This is a dry run. Click "Post now" in Master Control to create the bills and send per-expense confirmations.</p>
        </div></div>`,
      });
    }

    const summary = { mode, scanned: rows.length, posted: posted.length, need_vendor: needVendor.length, no_qbo_match: noMatch.length, qbo_error: qboErr.length };
    await logRun(started, 'success', posted.length, summary);
    return new Response(JSON.stringify({ ok: true, ...summary }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[sf-expense-autopost]', e);
    await logRun(started, 'error', 0, { mode }, String(e?.message || e).slice(0, 500));
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
