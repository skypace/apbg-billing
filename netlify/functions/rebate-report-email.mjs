// rebate-report-email — sends the branded "Your Alameda Soda rebate is ready"
// report for a rebate settlement to recipients the operator chooses.
//
// POST { settlement_id, to: ["a@b.com", ...], note? }   (staff bearer)
//
// The body of the email IS the contract's data report: per the Starbird master
// agreement the volume detail goes to the customer (by Jan 31), they approve,
// and the check is issued within 30 days. Sending here stamps
// report_sent_at / report_sent_to on the settlement — re-sends allowed.
//
// From: rebates@alamedapointbg.com (REBATE_EMAIL_FROM overrides). Replies come
// back to the same box, so the customer's approval lands where it belongs.

import { requireAuth } from './lib/auth.mjs';
import { sendEmail } from './email-helpers.mjs';
import { ops } from './lib/vendor-onboard-lib.mjs';

const FROM = process.env.REBATE_EMAIL_FROM || 'Alameda Soda Rebates <rebates@alamedapointbg.com>';
const NAVY = '#1F4E79';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

function storeRows(rule) {
  const growth = rule.rule_type === 'volume_growth';
  const cadence = rule.rule_type === 'ordering_cadence';
  return (rule.stores || []).map((s) => `
    <tr style="border-bottom:1px solid #e2e8f0;${s.qualified ? '' : 'color:#94a3b8;'}">
      <td style="padding:6px 10px;">${esc(s.store)}</td>
      <td style="padding:6px 10px;text-align:right;">${num(s.cur_units)}</td>
      ${growth ? `<td style="padding:6px 10px;text-align:right;">${num(s.prior_units)}</td>
      <td style="padding:6px 10px;text-align:right;">${s.growth_pct == null ? '—' : esc(s.growth_pct) + '%'}</td>` : ''}
      ${cadence ? `<td style="padding:6px 10px;text-align:right;">${esc(s.windows_met)}/${esc(s.windows_total)}</td>` : ''}
      <td style="padding:6px 10px;">${s.qualified ? '✓ Earned' : esc(s.reason || 'Not earned')}</td>
      <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;">${s.qualified ? usd(s.amount) : '—'}</td>
    </tr>`).join('');
}

function ruleSection(rule) {
  const growth = rule.rule_type === 'volume_growth';
  const cadence = rule.rule_type === 'ordering_cadence';
  return `
  <h3 style="margin:28px 0 4px;font-size:15px;color:${NAVY};">${esc(rule.label)}</h3>
  <p style="margin:0 0 10px;font-size:13px;color:#64748b;">Rebate earned on this program: <b style="color:#0f172a;">${usd(rule.total)}</b></p>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <tr style="background:#f1f5f9;color:#334155;text-align:left;">
      <th style="padding:6px 10px;">Location</th>
      <th style="padding:6px 10px;text-align:right;">Cases</th>
      ${growth ? '<th style="padding:6px 10px;text-align:right;">Prior year</th><th style="padding:6px 10px;text-align:right;">Growth</th>' : ''}
      ${cadence ? '<th style="padding:6px 10px;text-align:right;">Months on cadence</th>' : ''}
      <th style="padding:6px 10px;">Status</th>
      <th style="padding:6px 10px;text-align:right;">Rebate</th>
    </tr>
    ${storeRows(rule)}
  </table>`;
}

function renderHtml({ settlement, program, note }) {
  const d = settlement.detail || {};
  const rules = Array.isArray(d.rules) ? d.rules : [];
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:720px;margin:0 auto;padding:24px 12px;">
    <div style="background:${NAVY};border-radius:12px 12px 0 0;padding:22px 28px;">
      <div style="color:#fff;font-size:20px;font-weight:700;">Alameda Soda <span style="opacity:.75;font-weight:400;">· Alameda Point Beverage Group</span></div>
      <div style="color:#bfdbfe;font-size:13px;margin-top:2px;">Beverage rebate program</div>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:28px;">
      <h1 style="margin:0 0 6px;font-size:22px;color:${NAVY};">Your Alameda Soda rebate is ready</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#475569;">
        ${esc(program.name)} · calendar year <b>${esc(settlement.period_year)}</b> · reference <b>${esc(settlement.reference)}</b>
      </p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:6px;">
        <div style="font-size:13px;color:#166534;">Total rebate earned</div>
        <div style="font-size:30px;font-weight:700;color:#166534;">${usd(settlement.total_amount)}</div>
      </div>
      ${note ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 16px;margin:14px 0;font-size:14px;color:#1e40af;">${esc(note)}</div>` : ''}
      ${rules.map(ruleSection).join('')}
      <p style="margin:26px 0 0;font-size:13px;color:#475569;">
        This report covers ${esc(d.period_start)} through ${esc(d.period_end)}, calculated from invoiced volume across
        ${esc(d.stores_in_family)} locations. Per your agreement, a rebate check will be issued within
        <b>30 days of your approval</b> of this data — just reply to this email to approve, or with any questions.
      </p>
      <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;">
        Alameda Point Beverage Group · 1951 Monarch St, Hangar 200, Alameda CA 94501 · rebates@alamedapointbg.com
      </p>
    </div>
  </div></body></html>`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const settlementId = String(body.settlement_id || '');
  const note = body.note ? String(body.note).slice(0, 2000) : null;
  const to = Array.isArray(body.to) ? body.to.map((e) => String(e).trim()).filter(Boolean) : [];
  if (!settlementId) return Response.json({ error: 'settlement_id required' }, { status: 400 });
  if (!to.length || to.length > 10) return Response.json({ error: 'give 1–10 recipient emails' }, { status: 400 });
  const bad = to.filter((e) => !EMAIL_RE.test(e));
  if (bad.length) return Response.json({ error: `invalid email: ${bad.join(', ')}` }, { status: 400 });

  const [settlement] = await ops('GET', `rebate_settlements?id=eq.${settlementId}&select=*&limit=1`);
  if (!settlement) return Response.json({ error: 'settlement not found' }, { status: 404 });
  if (settlement.status === 'void') return Response.json({ error: 'settlement is void — nothing to report' }, { status: 409 });
  const [program] = await ops('GET', `rebate_programs?id=eq.${settlement.program_id}&select=*&limit=1`);
  if (!program) return Response.json({ error: 'program not found' }, { status: 404 });

  const html = renderHtml({ settlement, program, note });
  const subject = `Your Alameda Soda rebate is ready — ${settlement.reference} (${usd(settlement.total_amount)})`;
  const sent = await sendEmail({
    to, subject, html, from: FROM,
    replyTo: 'rebates@alamedapointbg.com',
  });
  if (!sent) return Response.json({ error: 'email send failed (no email service configured?)' }, { status: 502 });

  const already = Array.isArray(settlement.report_sent_to) ? settlement.report_sent_to : [];
  const merged = [...new Set([...already, ...to.map((e) => e.toLowerCase())])];
  await ops('PATCH', `rebate_settlements?id=eq.${settlementId}`, {
    report_sent_at: new Date().toISOString(),
    report_sent_to: merged,
  }, { Prefer: 'return=minimal' });

  return Response.json({ ok: true, sent_to: to, reference: settlement.reference });
}
