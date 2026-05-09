// Supabase Edge Function: fleet-morning-digest
// ---------------------------------------------
// Compiles yesterday's flagged fleet activity and emails it via Resend.
// Runs daily at 13:00 UTC (≈ 06:00 PT during PDT, 05:00 during PST) via
// the cron defined in 20260509m_fleet_morning_digest_cron.sql.
//
// Sections (one per ops.v_*):
//   1. Ghost stops          — ops.v_fleet_stop_billing flag='billed_no_visit'
//   2. GPS without invoice  — ops.v_fleet_stop_billing flag='visit_no_bill'
//   3. Over-billed jobs     — ops.v_service_dwell_mismatch flag='over_billed'
//   4. Driver hot list      — ops.fleet_driver_events count > 5 in 24 h
//
// Recipients: pulled from the FLEET_DIGEST_RECIPIENTS secret (comma list).
// Defaults to skypace@brixbev.com if not set.
//
// Manual invocation for testing:
//   POST /functions/v1/fleet-morning-digest?dry=1   (returns HTML, doesn't send)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RECIPIENTS = (Deno.env.get('FLEET_DIGEST_RECIPIENTS') ?? 'skypace@brixbev.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const FROM = Deno.env.get('FLEET_DIGEST_FROM') ?? 'PACER Ops <ops@brixbev.com>';

const sb = createClient(SB_URL, SB_SERVICE_KEY, { db: { schema: 'ops' } });

interface BillingRow {
  qbo_customer_id: string;
  customer_name: string | null;
  activity_date: string;
  visit_count: number;
  invoice_count_pm1: number;
  invoice_amount_pm1: number;
  flag: string;
}
interface DwellRow {
  service_job_id: number;
  job_date: string;
  sf_customer_name: string | null;
  qbo_customer_name: string | null;
  tech_name: string | null;
  sf_duration_min: number;
  gps_dwell_min: number;
  delta_min: number;
  invoice_amount: number | null;
  flag: string;
}
interface EventCount {
  fc_driver_id: string;
  events_24h: number;
  driver_name: string | null;
}

function fmtMoney(n: unknown): string {
  const v = Number(n ?? 0);
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

async function loadGhostStops(yesterday: string): Promise<BillingRow[]> {
  const { data, error } = await sb.from('v_fleet_stop_billing').select('*')
    .eq('flag', 'billed_no_visit').eq('activity_date', yesterday);
  if (error) throw new Error('billed_no_visit: ' + error.message);
  return (data ?? []) as BillingRow[];
}
async function loadVisitNoBill(yesterday: string): Promise<BillingRow[]> {
  const { data, error } = await sb.from('v_fleet_stop_billing').select('*')
    .eq('flag', 'visit_no_bill').eq('activity_date', yesterday);
  if (error) throw new Error('visit_no_bill: ' + error.message);
  return (data ?? []) as BillingRow[];
}
async function loadOverBilled(yesterday: string): Promise<DwellRow[]> {
  const { data, error } = await sb.from('v_service_dwell_mismatch').select('*')
    .eq('flag', 'over_billed').eq('job_date', yesterday);
  if (error) throw new Error('over_billed: ' + error.message);
  return (data ?? []) as DwellRow[];
}
async function loadDriverHotList(): Promise<EventCount[]> {
  // Count fleet_driver_events per fc_driver_id over the last 24h.
  // Anything above 5 is unusual.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb.from('fleet_driver_events')
    .select('fc_driver_id').gte('event_at', since).not('fc_driver_id', 'is', null);
  if (error) throw new Error('driver events: ' + error.message);
  const counts = new Map<string, number>();
  for (const r of (data ?? [])) counts.set((r as any).fc_driver_id, (counts.get((r as any).fc_driver_id) ?? 0) + 1);
  const hot = Array.from(counts.entries()).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
  if (hot.length === 0) return [];

  const ids = hot.map(([id]) => id);
  const { data: drivers } = await sb.from('fleet_drivers').select('fc_person_id,first_name,last_name').in('fc_person_id', ids);
  const nameById = new Map<string, string>();
  for (const d of (drivers ?? [])) {
    const name = [(d as any).first_name, (d as any).last_name].filter(Boolean).join(' ') || (d as any).fc_person_id;
    nameById.set((d as any).fc_person_id, name);
  }
  return hot.map(([id, n]) => ({ fc_driver_id: id, events_24h: n, driver_name: nameById.get(id) ?? null }));
}

function buildHtml(opts: {
  yesterday: string;
  ghost: BillingRow[];
  visitNoBill: BillingRow[];
  overBilled: DwellRow[];
  hot: EventCount[];
}): string {
  const { yesterday, ghost, visitNoBill, overBilled, hot } = opts;
  const ghostTotal = ghost.reduce((s, r) => s + Number(r.invoice_amount_pm1 ?? 0), 0);

  const sectionStyle = 'margin: 24px 0;';
  const tableStyle = 'border-collapse: collapse; width: 100%; font-size: 13px;';
  const thStyle = 'text-align: left; border-bottom: 1px solid #ddd; padding: 6px 8px; background: #f7f7f7;';
  const tdStyle = 'padding: 6px 8px; border-bottom: 1px solid #f0f0f0;';

  let html = `<div style="font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto; color: #222;">`;
  html += `<h2 style="font-size: 18px; margin: 0 0 4px 0;">PACER fleet — ${yesterday}</h2>`;
  html += `<div style="font-size: 12px; color: #666; margin-bottom: 16px;">Daily reconciliation digest. ${ghost.length + visitNoBill.length + overBilled.length + hot.length === 0 ? 'No exceptions to flag — quiet day.' : `${ghost.length} ghost stop${ghost.length === 1 ? '' : 's'} · ${visitNoBill.length} visit-no-bill · ${overBilled.length} over-billed · ${hot.length} driver${hot.length === 1 ? '' : 's'} on hot list.`}</div>`;

  if (ghost.length > 0) {
    html += `<div style="${sectionStyle}"><h3 style="font-size: 14px; margin: 0 0 8px 0;">Ghost stops — billed but no GPS visit (${fmtMoney(ghostTotal)})</h3>`;
    html += `<table style="${tableStyle}"><thead><tr><th style="${thStyle}">Customer</th><th style="${thStyle}">Invoices ±1d</th><th style="${thStyle}" align="right">$ ±1d</th></tr></thead><tbody>`;
    for (const r of ghost.slice(0, 25)) {
      html += `<tr><td style="${tdStyle}">${escapeHtml(r.customer_name ?? r.qbo_customer_id)}</td><td style="${tdStyle}">${r.invoice_count_pm1}</td><td style="${tdStyle}" align="right">${fmtMoney(r.invoice_amount_pm1)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  if (visitNoBill.length > 0) {
    html += `<div style="${sectionStyle}"><h3 style="font-size: 14px; margin: 0 0 8px 0;">GPS visits without an invoice (${visitNoBill.length})</h3>`;
    html += `<table style="${tableStyle}"><thead><tr><th style="${thStyle}">Customer</th><th style="${thStyle}">Visits</th></tr></thead><tbody>`;
    for (const r of visitNoBill.slice(0, 25)) {
      html += `<tr><td style="${tdStyle}">${escapeHtml(r.customer_name ?? r.qbo_customer_id)}</td><td style="${tdStyle}">${r.visit_count}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  if (overBilled.length > 0) {
    html += `<div style="${sectionStyle}"><h3 style="font-size: 14px; margin: 0 0 8px 0;">Over-billed service jobs — SF time exceeds GPS dwell</h3>`;
    html += `<table style="${tableStyle}"><thead><tr><th style="${thStyle}">Customer</th><th style="${thStyle}">Tech</th><th style="${thStyle}" align="right">SF min</th><th style="${thStyle}" align="right">GPS min</th><th style="${thStyle}" align="right">Δ</th><th style="${thStyle}" align="right">$</th></tr></thead><tbody>`;
    for (const r of overBilled.slice(0, 25)) {
      html += `<tr><td style="${tdStyle}">${escapeHtml(r.qbo_customer_name ?? r.sf_customer_name ?? '—')}</td><td style="${tdStyle}">${escapeHtml(r.tech_name ?? '—')}</td><td style="${tdStyle}" align="right">${Math.round(r.sf_duration_min)}</td><td style="${tdStyle}" align="right">${Math.round(r.gps_dwell_min)}</td><td style="${tdStyle}" align="right">${Math.round(r.delta_min)}</td><td style="${tdStyle}" align="right">${fmtMoney(r.invoice_amount)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  if (hot.length > 0) {
    html += `<div style="${sectionStyle}"><h3 style="font-size: 14px; margin: 0 0 8px 0;">Driver hot list — ≥5 harsh events in 24 h</h3>`;
    html += `<table style="${tableStyle}"><thead><tr><th style="${thStyle}">Driver</th><th style="${thStyle}" align="right">Events 24 h</th></tr></thead><tbody>`;
    for (const r of hot) {
      html += `<tr><td style="${tdStyle}">${escapeHtml(r.driver_name ?? r.fc_driver_id)}</td><td style="${tdStyle}" align="right">${r.events_24h}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  html += `<div style="font-size: 11px; color: #999; margin-top: 24px;">Open dashboard → <a href="https://apbg-billing.netlify.app/sales-next/#fleet" style="color: #3a78d9;">Fleet</a></div>`;
  html += `</div>`;
  return html;
}

async function sendEmail(html: string, subject: string): Promise<void> {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY env var not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: RECIPIENTS, subject, html }),
  });
  if (!res.ok) throw new Error('resend: ' + res.status + ' ' + (await res.text()));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const dry = url.searchParams.get('dry') === '1' || url.searchParams.get('dry') === 'true';
  try {
    // "Yesterday" in PT — the day Sky just finished operating.
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const ymd = yesterday.toISOString().slice(0, 10);

    const [ghost, visitNoBill, overBilled, hot] = await Promise.all([
      loadGhostStops(ymd),
      loadVisitNoBill(ymd),
      loadOverBilled(ymd),
      loadDriverHotList(),
    ]);

    const html = buildHtml({ yesterday: ymd, ghost, visitNoBill, overBilled, hot });
    const total = ghost.length + visitNoBill.length + overBilled.length + hot.length;
    const subject = total === 0
      ? `PACER fleet ${ymd}: clean (no exceptions)`
      : `PACER fleet ${ymd}: ${total} exception${total === 1 ? '' : 's'}`;

    if (dry) {
      return new Response(JSON.stringify({ ok: true, dry: true, subject, counts: { ghost: ghost.length, visit_no_bill: visitNoBill.length, over_billed: overBilled.length, hot: hot.length }, html }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    await sendEmail(html, subject);
    return new Response(JSON.stringify({
      ok: true, sent_to: RECIPIENTS, subject,
      counts: { ghost: ghost.length, visit_no_bill: visitNoBill.length, over_billed: overBilled.length, hot: hot.length },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    const err = e as Error;
    console.error('fleet-morning-digest error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
});
