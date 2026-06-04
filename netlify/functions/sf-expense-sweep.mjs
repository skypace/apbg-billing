// Scheduled sweep: pull expenses from ALL Service Fusion completed/invoiced
// jobs into Brixpense as review-drafts — not just the ResQ-linked ones.
//
// Each SF expense lands as a draft ops.expense_requests row (status='draft',
// as_bill, tag='Service Fusion') with its receipt image attached. NOTHING posts
// to QBO here — Brixpense posts the bill when the operator reviews + submits
// (same flow as the ResQ path).
//
// Deduped by ops.expense_requests.sf_expense_id, so re-runs never double-land.
// Everything is idempotent + capped, so a truncated run simply continues next
// time. Runs every 6 hours.

import { sfRequest, getSFAccessToken } from './sf-helpers.mjs';
import { postExpenseRow } from './expense-to-bill.mjs';
import { requireScheduled } from './lib/auth.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_PAGES = 6;            // up to 600 most-recent jobs examined per run
const MAX_DETAIL_FETCHES = 120; // cap per-job expense fetches when the list omits them
const MAX_LANDINGS = 150;       // cap rows landed per run (idempotent — next run continues)
// Only land expenses dated on/after this — start fresh, no historical backlog.
// Override with the SF_SWEEP_START_DATE env var (YYYY-MM-DD).
const SWEEP_START_DATE = process.env.SF_SWEEP_START_DATE || '2026-06-03';

const ACCOUNT_MAP = {
  equipment: { id: '42', name: 'Equipment Sales COGS' },
  service:   { id: '101', name: 'Service COGS' },
};
const DEFAULT_ACCOUNT = ACCOUNT_MAP.service;

const sbHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Accept-Profile': 'ops',
  'Content-Profile': 'ops',
});

const isDoneStatus = (s) => {
  const t = String(s || '').toLowerCase();
  return t.includes('complet') || t.includes('invoic');
};

// A valid submitted_by (NOT NULL fk) for system-landed rows:
// env → most-recent Service Fusion row's submitter → auth-admin lookup by email.
async function resolveSubmitter() {
  if (process.env.SF_SWEEP_SUBMITTER_ID) return process.env.SF_SWEEP_SUBMITTER_ID;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/expense_requests?tag=eq.Service%20Fusion&select=submitted_by&order=created_at.desc&limit=1`,
      { headers: { ...sbHeaders(), Accept: 'application/json' } },
    );
    if (r.ok) { const rows = await r.json(); if (rows[0]?.submitted_by) return rows[0].submitted_by; }
  } catch { /* fall through */ }
  const email = (process.env.SF_SWEEP_SUBMITTER_EMAIL || 'skypace@brixbev.com').toLowerCase();
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (r.ok) { const b = await r.json(); const u = (b.users || []).find((x) => (x.email || '').toLowerCase() === email); if (u?.id) return u.id; }
  } catch { /* fall through */ }
  return null;
}

async function loadLandedExpenseIds() {
  const ids = new Set();
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/expense_requests?sf_expense_id=not.is.null&select=sf_expense_id`,
      { headers: { ...sbHeaders(), Accept: 'application/json' } },
    );
    if (r.ok) { const rows = await r.json(); for (const x of rows) if (x.sf_expense_id) ids.add(String(x.sf_expense_id)); }
  } catch { /* best effort */ }
  return ids;
}

// Best-effort receipt fetch → upload to the expense-attachments bucket.
// Tries anon first; for SF-hosted URLs that 401/403, retries with the SF bearer.
async function fetchReceipt(url, sfJobId) {
  if (!url || !SERVICE_KEY) return null;
  try {
    let res = await fetch(url);
    if ((res.status === 401 || res.status === 403) && /servicefusion/i.test(url)) {
      const tok = await getSFAccessToken().catch(() => null);
      if (tok) res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    }
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const ext = ct.includes('pdf') ? 'pdf' : ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const fileName = `receipt-${Date.now()}.${ext}`;
    const path = `service-fusion/${sfJobId || 'misc'}/${fileName}`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/expense-attachments/${path}`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': ct, 'x-upsert': 'true' },
      body: buf,
    });
    if (!up.ok) return null;
    return { storage_path: path, file_name: fileName, file_type: ct, file_size: buf.length };
  } catch { return null; }
}

async function sweep() {
  if (!SERVICE_KEY) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set' };
  const submitter = await resolveSubmitter();
  if (!submitter) return { ok: false, error: 'could not resolve a submitter user id' };
  const landedIds = await loadLandedExpenseIds();

  const startMs = Date.parse(`${SWEEP_START_DATE}T00:00:00Z`) || 0;
  const scanFloor = startMs - 7 * 86400000; // buffer: a recently-touched older job may carry a fresh expense
  let scanned = 0, examined = 0, detailFetches = 0, landed = 0;

  for (let page = 1; page <= MAX_PAGES && landed < MAX_LANDINGS; page++) {
    let jobs;
    try {
      const res = await sfRequest('GET', `/jobs?per-page=100&sort=-created_at&expand=expenses&page=${page}`);
      jobs = res.items || res.data || [];
    } catch { break; }
    if (!jobs.length) break;
    scanned += jobs.length;

    const allTooOld = jobs.every((j) => j.created_at && new Date(j.created_at).getTime() < scanFloor);

    for (const job of jobs) {
      if (landed >= MAX_LANDINGS) break;
      if (job.created_at && new Date(job.created_at).getTime() < scanFloor) continue;
      if (!isDoneStatus(job.status)) continue;
      examined++;

      let expenses = Array.isArray(job.expenses) ? job.expenses : null;
      if (expenses === null) {
        if (detailFetches >= MAX_DETAIL_FETCHES) continue;
        detailFetches++;
        try {
          const full = await sfRequest('GET', `/jobs/${job.id}?expand=expenses`);
          expenses = Array.isArray(full.expenses) ? full.expenses : [];
        } catch { expenses = []; }
      }
      if (!expenses.length) continue;

      for (const ex of expenses) {
        if (landed >= MAX_LANDINGS) break;
        const exId = String(ex.id ?? '');
        if (!exId || landedIds.has(exId)) continue;
        const amount = Number(ex.amount) || 0;
        if (amount <= 0) continue;
        // Start date floor — only pull expenses dated on/after SWEEP_START_DATE.
        const exDate = ex.expense_date || ex.created_at || null;
        if (exDate && Date.parse(exDate) < startMs) continue;

        const acct = ACCOUNT_MAP[String(ex.category || '').toLowerCase()] || DEFAULT_ACCOUNT;
        const receiptUrl = ex.receipt_url || ex.receipt || null;
        const attachment = receiptUrl ? await fetchReceipt(receiptUrl, job.id) : null;

        const row = {
          request_type: 'expense',
          status: 'draft',
          as_bill: true,
          tag: 'Service Fusion',
          sf_expense_id: exId,
          submitted_by: submitter,
          submitter_name: 'Service Fusion',
          submitter_email: null,
          vendor_name: ex.vendor_name || ex.vendor || null,
          total_amount: amount,
          currency: 'USD',
          receipt_date: ex.expense_date || ex.created_at || null,
          line_items: [{
            description: ex.notes || ex.category || 'Service Fusion expense',
            qty: 1, unit_price: amount, amount,
          }],
          customer_name: job.customer_name || null,
          cogs_account_id: acct.id,
          cogs_account_label: acct.name,
          job_number: String(job.number || job.id),
          memo: [`SF Job #${job.number || job.id}`, ex.notes].filter(Boolean).join(' | ') || null,
          description: `Service Fusion job #${job.number || job.id} expense — review & submit`,
          qbo_bill_id: null,
          _attachment: attachment,
        };
        const r = await postExpenseRow(row);
        if (r.ok) { landed++; landedIds.add(exId); }
      }
    }
    if (allTooOld) break;
  }

  return { ok: true, scanned, examined, detailFetches, landed };
}

async function logRun(result) {
  if (!SERVICE_KEY) return;
  const now = new Date().toISOString();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify([{
        source: 'sf-expense-sweep', sync_type: 'expense-sweep',
        status: result.ok ? 'ok' : 'error', started_at: now, completed_at: now,
        records_synced: result.landed || 0, metadata: result,
      }]),
    });
  } catch { /* non-fatal */ }
}

export default async (req, context) => {
  const gate = requireScheduled(req, context);
  if (!gate.ok) return gate.response;
  console.log('[CRON] SF expense sweep starting…');
  const result = await sweep();
  await logRun(result);
  console.log('[CRON] SF expense sweep:', JSON.stringify(result));
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '0 */6 * * *' };
