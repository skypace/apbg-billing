// ============================================================
// sf-expense-reconcile-background.mjs — the weekly "did we see everything?"
//
// The sweeps and the invoiced-email hook are how expenses ARRIVE; this is how
// we PROVE none were missed. Every Monday it re-reads every SF expense on
// Invoiced jobs updated in the last N days (default 30), computes the same
// dedup key the lander uses, and checks each one exists in ops.expense_requests.
// Anything missing is landed on the spot via the edge function's ?landJob=
// (idempotent, drafts only — the manual-post gate holds), and a digest email
// reports what was found. Silent when clean — a weekly "all good" email trains
// people to delete it.
//
// This exists because every landing path is best-effort: a sweep can hit its
// time budget, SF can hang, an email can be filtered. Twelve expenses (~$9k)
// sat invisible for weeks before this — found only because an operator asked
// where one was. A reconciler turns that into a Monday-morning email.
//
// Key-drift warning: candidateKey() below MUST match expenseKey() in
// supabase/functions/sf-receipt-sync/index.ts — same fields, same order, same
// normalisation. If the lander's key changes shape, change this one in the
// same commit or every reconcile will "find" everything missing.
//
// Auth: cron secret (x-sf-autopost-secret) OR superadmin Bearer — same pattern
// as sf-expense-ocr-background. Scheduled by pg_cron (job 'sf-expense-reconcile',
// Mondays 16:00 UTC), background function so SF paging fits the budget.
// Watched by ops.fn_sf_reconcile_health() (red when no success in 8 days).
// ============================================================
import { sfRequest } from './sf-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { requireAuth } from './lib/auth.mjs';
import { brixpenseEmail, esc, money } from './lib/brixpense-email.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const REPORT_TO = process.env.SF_RECONCILE_ALERT_TO || process.env.SF_EXPENSE_REPORT_TO || 'service@brixbev.com';
const WINDOW_DAYS = Math.max(7, parseInt(process.env.SF_RECONCILE_WINDOW_DAYS || '30', 10) || 30);
const START_DATE = process.env.SF_SWEEP_START_DATE || '2026-06-03';
const MAX_PAGES = 12;            // 12 × 50 jobs ≈ well past 30 days of updates
const MAX_LAND_JOBS = 10;        // repair cap per run — the rest lists in the email
const RECEIPT_SYNC_URL = process.env.SF_RECEIPT_SYNC_URL || `${SUPABASE_URL}/functions/v1/sf-receipt-sync`;

function srHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ops', 'Content-Profile': 'ops', ...extra };
}

// ── Ports of the lander's gates (sf-receipt-sync/index.ts) ─────────────────
// SF writes the UNIX EPOCH, not null, into dates it has no value for.
const EPOCH_PREFIX = '1970-01-01';
function realDateMs(v) {
  if (!v) return null;
  const s = String(v);
  if (s.startsWith(EPOCH_PREFIX)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
function newestRealDate(ex) {
  const all = [ex.updated_at, ex.created_at, ex.date].map(realDateMs).filter((v) => v !== null);
  return all.length ? Math.max(...all) : null;
}
// ~97% of SF "expenses" are blank rows on ordinary delivery jobs.
function isEmptyExpense(ex) {
  const vendor = String(ex.purchased_from ?? ex.vendor_name ?? ex.vendor ?? '').trim();
  const amt = Number(ex.amount ?? ex.total ?? 0) || 0;
  const notes = String(ex.notes ?? '').trim();
  const category = String(ex.category ?? '').trim();
  return !vendor && amt === 0 && !notes && !category;
}
// MUST mirror expenseKey() in the edge function — see the header warning.
function candidateKey(jobId, ex) {
  if (ex.id) return String(ex.id);
  const v = (ex.purchased_from || ex.vendor_name || ex.vendor || '').toString().trim().toLowerCase();
  const amt = Number(ex.amount ?? ex.total ?? 0) || 0;
  return `sfjob:${jobId}:${v}:${amt}:${ex.created_at || ex.date || ''}`;
}

async function existingKeys(keys) {
  // PostgREST in.() lists cap out on URL length — chunk the lookups.
  const found = new Set();
  for (let i = 0; i < keys.length; i += 60) {
    const chunk = keys.slice(i, i + 60);
    const list = chunk.map((k) => `"${k.replace(/"/g, '')}"`).join(',');
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/expense_requests?select=sf_expense_id&sf_expense_id=in.(${encodeURIComponent(list)})`,
      { headers: srHeaders() },
    );
    if (!res.ok) throw new Error(`expense_requests lookup ${res.status}`);
    for (const r of await res.json()) found.add(r.sf_expense_id);
  }
  return found;
}

async function logRun(status, records, metadata, errorMessage = null, startedAt) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: srHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        source: 'sf-reconcile', sync_type: 'reconcile', status,
        records_synced: records, started_at: startedAt,
        completed_at: new Date().toISOString(),
        error_message: errorMessage, metadata,
      }),
    });
  } catch { /* the run result must not depend on the log write */ }
}

export default async (req) => {
  const cronSecret = req.headers.get('x-sf-autopost-secret') || '';
  const isCron = !!cronSecret && (
    cronSecret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32) ||
    (!!process.env.SF_AUTOPOST_CRON_SECRET && cronSecret === process.env.SF_AUTOPOST_CRON_SECRET)
  );
  if (!isCron) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }

  const startedAt = new Date().toISOString();
  const cutoffMs = Date.now() - WINDOW_DAYS * 86400000;
  const startMs = Date.parse(START_DATE + 'T00:00:00Z') || 0;

  const stats = { jobsScanned: 0, pages: 0, expensesSeen: 0, blank: 0, preCutoff: 0, candidates: 0, missing: 0, landed: 0, landFailed: 0 };
  const missing = [];   // { key, jobId, jobNumber, vendor, amount, created }

  try {
    // Page by -updated_at (the same signal the fresh sweep rides): a job whose
    // updated_at is older than the window means every job after it is too.
    outer:
    for (let page = 1; page <= MAX_PAGES; page++) {
      const d = await sfRequest('GET', `/jobs?filters[status]=Invoiced&sort=-updated_at&per-page=50&expand=expenses&page=${page}`);
      const jobs = d?.items || [];
      if (!jobs.length) break;
      stats.pages++;
      for (const job of jobs) {
        const updMs = realDateMs(job.updated_at) ?? realDateMs(job.created_at) ?? 0;
        if (updMs && updMs < cutoffMs) break outer;
        stats.jobsScanned++;
        for (const ex of (Array.isArray(job.expenses) ? job.expenses : [])) {
          stats.expensesSeen++;
          if (isEmptyExpense(ex)) { stats.blank++; continue; }
          const exDate = newestRealDate(ex);
          if (exDate && exDate < startMs) { stats.preCutoff++; continue; }
          stats.candidates++;
          missing.push({
            key: candidateKey(job.id, ex),
            jobId: String(job.id),
            jobNumber: String(job.number || job.id),
            vendor: ex.purchased_from || ex.vendor_name || ex.vendor || '(blank vendor)',
            amount: Number(ex.amount ?? ex.total ?? 0) || 0,
            created: String(ex.created_at || '').slice(0, 10),
          });
        }
      }
    }

    // Which of those are on file?
    const have = await existingKeys(missing.map((m) => m.key));
    const stranded = missing.filter((m) => !have.has(m.key));
    stats.missing = stranded.length;

    // Repair on the spot: land each stranded job via the edge function.
    // Idempotent (sf_expense_id dedup) and drafts-only — the gate holds.
    const jobsToLand = [...new Set(stranded.map((m) => m.jobId))].slice(0, MAX_LAND_JOBS);
    const landResults = {};
    for (const jid of jobsToLand) {
      try {
        const r = await fetch(`${RECEIPT_SYNC_URL}?landJob=${encodeURIComponent(jid)}`, { signal: AbortSignal.timeout(45000) });
        const body = await r.json().catch(() => ({}));
        const landedHere = body?.result?.landed ?? 0;
        landResults[jid] = r.ok && !body.error ? `landed ${landedHere}` : `failed: ${String(body.error || r.status).slice(0, 80)}`;
        if (r.ok && !body.error) stats.landed += landedHere; else stats.landFailed++;
      } catch (e) {
        landResults[jid] = `failed: ${String(e?.message || e).slice(0, 80)}`;
        stats.landFailed++;
      }
    }

    // Email ONLY when something was stranded — silence is the healthy state.
    if (stranded.length) {
      const rows = stranded.slice(0, 25).map((m) =>
        `<tr><td style="padding:4px 8px;color:#F1F5F9">${esc(m.vendor)}</td>` +
        `<td style="padding:4px 8px;color:#F1F5F9;text-align:right">${money(m.amount)}</td>` +
        `<td style="padding:4px 8px;color:#94A3B8">SF ${esc(m.jobNumber)}</td>` +
        `<td style="padding:4px 8px;color:#94A3B8">${esc(m.created)}</td>` +
        `<td style="padding:4px 8px;color:#94A3B8">${esc(landResults[m.jobId] || 'not attempted (over cap)')}</td></tr>`,
      ).join('');
      const totalAmt = stranded.reduce((s, m) => s + m.amount, 0);
      const inner = `<p style="margin:0 0 6px;color:#fff;font-size:16px;font-weight:700">${stranded.length} SF expense${stranded.length === 1 ? '' : 's'} (${money(totalAmt)}) had not landed in Brixpense</p>
        <p style="margin:0 0 14px;color:#CBD5E1">Found by the weekly reconciliation over Invoiced jobs updated in the last ${WINDOW_DAYS} days. Anything marked "landed" is now a draft in SF Expenses waiting for review — nothing was posted to QuickBooks.</p>
        <table role="presentation" style="border-collapse:collapse;width:100%"><tr>
          <th style="padding:4px 8px;color:#64748B;text-align:left;font-size:12px">Vendor</th>
          <th style="padding:4px 8px;color:#64748B;text-align:right;font-size:12px">Amount</th>
          <th style="padding:4px 8px;color:#64748B;text-align:left;font-size:12px">Job</th>
          <th style="padding:4px 8px;color:#64748B;text-align:left;font-size:12px">Added</th>
          <th style="padding:4px 8px;color:#64748B;text-align:left;font-size:12px">Repair</th>
        </tr>${rows}</table>
        ${stranded.length > 25 ? `<p style="color:#94A3B8;font-size:12px">…and ${stranded.length - 25} more (see ops.sync_log source=sf-reconcile).</p>` : ''}
        <p style="color:#64748B;font-size:12px;margin-top:14px">Scanned ${stats.jobsScanned} jobs / ${stats.expensesSeen} expenses. A "failed" repair can be retried: sf-receipt-sync?landJob=&lt;job id&gt;.</p>`;
      await sendEmail({
        to: REPORT_TO,
        subject: `Brixpense reconciliation — ${stranded.length} SF expense${stranded.length === 1 ? '' : 's'} recovered (${money(totalAmt)})`,
        html: brixpenseEmail(stats.landFailed ? '#F59E0B' : '#3B82F6', 'Weekly reconciliation', inner),
      });
    }

    const metadata = { ...stats, window_days: WINDOW_DAYS, land_results: landResults, stranded: stranded.slice(0, 50) };
    await logRun('success', stats.landed, metadata, null, startedAt);
    return new Response(JSON.stringify({ ok: true, ...stats }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await logRun('error', 0, { ...stats, window_days: WINDOW_DAYS }, msg, startedAt);
    return new Response(JSON.stringify({ ok: false, error: msg, ...stats }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/sf-expense-reconcile-background' };
