// Scheduled sweep: land expense RECEIPTS from ALL Service Fusion
// completed/invoiced jobs into Brixpense as reviewable drafts — not just the
// ResQ-linked ones. Delegates the per-job work to landSfJobExpense (the same
// helper the ResQ sync uses), which scans each receipt, lands a DRAFT
// pre-filled from the scan, attaches the image, dedups by sf_expense_id, and
// gates to the start date. NOTHING posts to QBO — Brixpense posts on submit.
// Idempotent + capped; a truncated run simply continues next time. Every 6h.

import { sfRequest } from './sf-helpers.mjs';
import { landSfJobExpense } from './lib/sf-expense.mjs';
import { requireScheduled } from './lib/auth.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_PAGES = 6;            // up to 600 most-recent jobs examined per run
const MAX_JOBS = 150;           // cap jobs processed per run (idempotent — next run continues)
const SWEEP_START_DATE = process.env.SF_SWEEP_START_DATE || '2026-06-03';

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

// A valid submitted_by (NOT NULL fk): env → latest Service Fusion row → auth-admin by email.
async function resolveSubmitter() {
  if (process.env.SF_SWEEP_SUBMITTER_ID) return { id: process.env.SF_SWEEP_SUBMITTER_ID, user_metadata: { name: 'Service Fusion' } };
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/expense_requests?tag=eq.Service%20Fusion&select=submitted_by,submitter_email&order=created_at.desc&limit=1`,
      { headers: { ...sbHeaders(), Accept: 'application/json' } },
    );
    if (r.ok) { const rows = await r.json(); if (rows[0]?.submitted_by) return { id: rows[0].submitted_by, email: rows[0].submitter_email, user_metadata: { name: 'Service Fusion' } }; }
  } catch { /* fall through */ }
  const email = (process.env.SF_SWEEP_SUBMITTER_EMAIL || 'skypace@brixbev.com').toLowerCase();
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (r.ok) { const b = await r.json(); const u = (b.users || []).find((x) => (x.email || '').toLowerCase() === email); if (u?.id) return { id: u.id, email: u.email, user_metadata: { name: 'Service Fusion' } }; }
  } catch { /* fall through */ }
  return null;
}

async function sweep() {
  if (!SERVICE_KEY) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set' };
  const submitter = await resolveSubmitter();
  if (!submitter) return { ok: false, error: 'could not resolve a submitter user id' };

  const startMs = Date.parse(`${SWEEP_START_DATE}T00:00:00Z`) || 0;
  const scanFloor = startMs - 7 * 86400000; // buffer: a recently-touched older job may carry a fresh expense
  let scanned = 0, jobsProcessed = 0, drafts = 0, attached = 0;

  for (let page = 1; page <= MAX_PAGES && jobsProcessed < MAX_JOBS; page++) {
    let jobs;
    try {
      const res = await sfRequest('GET', `/jobs?per-page=100&sort=-created_at&page=${page}`);
      jobs = res.items || res.data || [];
    } catch { break; }
    if (!jobs.length) break;
    scanned += jobs.length;

    const allTooOld = jobs.every((j) => j.created_at && new Date(j.created_at).getTime() < scanFloor);

    for (const job of jobs) {
      if (jobsProcessed >= MAX_JOBS) break;
      if (job.created_at && new Date(job.created_at).getTime() < scanFloor) continue;
      if (!isDoneStatus(job.status)) continue;
      jobsProcessed++;
      try {
        const r = await landSfJobExpense({ sfJobId: job.id, resqCode: null, submitter });
        if (r.ok) { drafts += r.landed || 0; attached += r.attached || 0; }
      } catch { /* non-fatal — next job */ }
    }
    if (allTooOld) break;
  }

  return { ok: true, scanned, jobsProcessed, drafts, attached };
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
        records_synced: result.drafts || 0, metadata: result,
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
