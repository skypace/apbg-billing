// service-margin-report.mjs — the monthly 3rd-party service margin report.
//
// WHAT IT ANSWERS. For every ResQ dispatch account (THE MELT RESQ, STARBIRD
// CHICKEN RESQ, and any future one — they are found by name, see
// lib/service-margin.mjs): what did we bill that chain last month, what did the
// subcontractors charge us for the same jobs, and what is wrong with the
// picture. Built because that question was being answered by hand, and the
// answer took a session of SQL each time.
//
// HOW IT RUNS.
//   Monthly, from pg_cron, on the 3rd at 15:00 UTC (8am PT) for the month that
//   just ended — the 3rd rather than the 1st because late vendor bills land in
//   the first days of the month and a report run at midnight on the 1st is a
//   report that will be wrong by lunchtime.
//   On demand, from a browser, by a superadmin: ?preview=1 renders it and
//   sends nothing, which is how you check a month before mailing it.
//
// ⚠ A REPORT WITH NOTHING IN IT IS STILL SENT. The temptation is to go quiet
// on a zero month (the compliance digest does, correctly — it is an alert).
// This is not an alert, it is a management number: silence would be
// indistinguishable from the cron having died, and the whole point is that
// somebody sees the margin every month without asking.
//
// Auth: x-sf-autopost-secret (the shared pg_cron secret every other scheduled
// apbg-billing function uses) OR a superadmin Bearer token.
//
// Query: ?month=YYYY-MM   (default: the month that just ended)
//        ?preview=1       render only, send nothing
//        ?to=a@b.com      recipient override (comma-separated)
//        ?format=json     the computed report as JSON, no HTML
//
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY/SENDGRID_API_KEY,
//      SERVICE_MARGIN_REPORT_TO (default service@brixbev.com),
//      SF_AUTOPOST_CRON_SECRET.

import { requireAuth } from './lib/auth.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import {
  buildServiceMarginReport, renderReportHtml, renderReportText,
  lastCompletedMonth, money, pct,
} from './lib/service-margin.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const REPORT_TO = process.env.SERVICE_MARGIN_REPORT_TO || 'service@brixbev.com';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

async function opsGet(qs) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${qs}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Accept-Profile': 'ops',
    },
  });
  if (!res.ok) {
    throw new Error(`ops read failed (${res.status}) on ${qs.slice(0, 80)}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

export default async (req) => {
  const cronSecret = req.headers.get('x-sf-autopost-secret') || '';
  const viaCron =
    !!process.env.SF_AUTOPOST_CRON_SECRET && cronSecret === process.env.SF_AUTOPOST_CRON_SECRET;

  if (!viaCron) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }

  const url = new URL(req.url);
  const month = url.searchParams.get('month') || lastCompletedMonth();
  const preview = url.searchParams.get('preview') === '1';
  const format = url.searchParams.get('format') || '';
  const toOverride = url.searchParams.get('to');

  let report;
  try {
    report = await buildServiceMarginReport({ month, opsGet });
  } catch (err) {
    // Fail loudly. A margin report that quietly returns nothing is worse than
    // one that errors — nobody chases a number they never noticed was missing.
    return new Response(
      JSON.stringify({ error: 'report build failed', detail: String(err?.message || err), month }),
      { status: 500, headers: JSON_HEADERS }
    );
  }

  if (format === 'json') {
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: JSON_HEADERS });
  }

  const html = renderReportHtml(report);

  if (preview) {
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const to = (toOverride || REPORT_TO).split(',').map((s) => s.trim()).filter(Boolean);
  const t = report.totals;
  const subject =
    `3rd-party service margin — ${report.label}: ${money(t.jobRevenue)} billed, ` +
    `${money(t.gp)} GP (${pct(t.margin)})`;

  let sent = false;
  let sendError = null;
  try {
    await sendEmail({ to, subject, html, text: renderReportText(report) });
    sent = true;
  } catch (err) {
    // The numbers are still worth returning to whoever asked; the caller (or
    // the pg_net failure scanner) surfaces the send failure.
    sendError = String(err?.message || err);
  }

  return new Response(
    JSON.stringify({
      ok: true, month: report.month, label: report.label, to, sent, sendError,
      totals: t,
      accounts: report.accounts.map((a) => ({
        name: a.name, invoices: a.invoiceCount, revenue: a.revenue,
        cost: a.cost, gp: a.gp, margin: a.margin,
        duplicates: a.duplicates.length, negativeJobs: a.negativeJobs.length,
        unbilledCost: a.unbilledTotal, draftBills: a.draftBills.length,
      })),
    }, null, 2),
    { status: sendError ? 502 : 200, headers: JSON_HEADERS }
  );
};

export const config = { path: '/api/service-margin-report' };
