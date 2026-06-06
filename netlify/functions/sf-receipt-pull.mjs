// SF receipt → Brixpense, the reliable + debuggable way.
//
// SYNCHRONOUS Netlify function (NOT background) so it returns its full result
// to the caller — no invisible background runtime. Reuses the SF auth that
// already works in this runtime (single token owner — no rotation conflict),
// scans recent completed/invoiced SF jobs, and lands each receipt as a
// Brixpense review-DRAFT via landSfJobExpense. NOTHING posts to QBO.
//
// Auth: cronKey==CRON_SECRET (for pg_cron) or a superadmin JWT.
// Debug: ?sfJob=<id> processes a single SF job and returns the detail.
// Driven by Supabase pg_cron once verified.

import { sfRequest } from './sf-helpers.mjs';
import { landSfJobExpense } from './lib/sf-expense.mjs';
import { requireAuth } from './lib/auth.mjs';

const SUBMITTER = {
  id: '2da634b7-623d-4f73-b667-cf87975fcdb6',
  email: 'skypace@brixbev.com',
  user_metadata: { name: 'Service Fusion (system)' },
};

const MAX_PAGES = 3;
const TIME_BUDGET_MS = 22000;
const SWEEP_START_DATE = process.env.SF_SWEEP_START_DATE || '2026-06-03';

const isDone = (s) => {
  const t = String(s || '').toLowerCase();
  return t.includes('complet') || t.includes('invoic');
};

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const hdrs = event.headers || {};
  const key = qs.cronKey || hdrs['x-cron-key'] || hdrs['X-Cron-Key'] || '';
  const cronOk = !!(key && process.env.CRON_SECRET && key === process.env.CRON_SECRET);
  if (!cronOk) {
    const a = await requireAuth(event);
    if (!a.ok) return a.response;
  }

  const start = Date.now();
  const startMs = Date.parse(`${SWEEP_START_DATE}T00:00:00Z`) || 0;
  const scanFloor = startMs - 7 * 86400000;
  const out = { ok: true, scanned: 0, doneJobs: 0, drafts: 0, attached: 0, perJob: [], errors: [] };

  try {
    // Debug: find a job by its SF number and dump its RAW expense objects so
    // we can see exactly where (and whether) the receipt is stored.
    if (qs.find) {
      try {
        const res = await sfRequest('GET', `/jobs?filters[number]=${encodeURIComponent(qs.find)}&per-page=5&expand=expenses`);
        const jobs = res.items || res.data || [];
        const dump = [];
        for (const j of jobs) {
          let exps = Array.isArray(j.expenses) ? j.expenses : null;
          if (exps === null) {
            try { const full = await sfRequest('GET', `/jobs/${j.id}?expand=expenses`); exps = Array.isArray(full.expenses) ? full.expenses : []; }
            catch { exps = []; }
          }
          dump.push({ id: j.id, number: j.number, status: j.status, expenseCount: exps.length, expenses: exps });
        }
        return { statusCode: 200, body: JSON.stringify({ find: qs.find, jobs: dump }, null, 2) };
      } catch (e) {
        return { statusCode: 200, body: JSON.stringify({ find: qs.find, error: String(e.message).slice(0, 300) }) };
      }
    }

    // Single-job debug path.
    if (qs.sfJob) {
      const r = await landSfJobExpense({ sfJobId: qs.sfJob, resqCode: qs.resqCode || null, submitter: SUBMITTER });
      out.perJob.push({ job: qs.sfJob, r });
      out.drafts += r.landed || 0;
      out.attached += r.attached || 0;
      out.ms = Date.now() - start;
      return { statusCode: 200, body: JSON.stringify(out) };
    }

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - start > TIME_BUDGET_MS) { out.timedOut = true; break; }
      let jobs;
      try {
        const res = await sfRequest('GET', `/jobs?per-page=100&sort=-created_at&page=${page}`);
        jobs = res.items || res.data || [];
      } catch (e) { out.errors.push(`list p${page}: ${String(e.message).slice(0, 160)}`); break; }
      if (!jobs.length) break;
      out.scanned += jobs.length;
      const allOld = jobs.every((j) => j.created_at && new Date(j.created_at).getTime() < scanFloor);

      for (const job of jobs) {
        if (Date.now() - start > TIME_BUDGET_MS) { out.timedOut = true; break; }
        if (job.created_at && new Date(job.created_at).getTime() < scanFloor) continue;
        if (!isDone(job.status)) continue;
        out.doneJobs++;
        try {
          const r = await landSfJobExpense({ sfJobId: job.id, resqCode: null, submitter: SUBMITTER });
          if (r.ok) { out.drafts += r.landed || 0; out.attached += r.attached || 0; }
          if (out.perJob.length < 8) out.perJob.push({ job: job.number || job.id, status: job.status, r });
        } catch (e) { out.errors.push(`job ${job.id}: ${String(e.message).slice(0, 160)}`); }
      }
      if (allOld) break;
    }
  } catch (e) {
    out.ok = false;
    out.crash = String(e && e.message ? e.message : e).slice(0, 400);
  }
  out.ms = Date.now() - start;
  return { statusCode: 200, body: JSON.stringify(out) };
}
