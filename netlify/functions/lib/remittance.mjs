// remittance.mjs — the remittance advice a vendor gets when we pay them.
//
// One email per payment GROUP (one vendor, one payment, N bills): what was
// paid, by which method, under which reference, and exactly which bills the
// money covers — so the vendor's AR desk can apply one deposit across several
// invoices without calling us. Sent when the money has actually MOVED:
// immediately for manual rails (the human already sent it), at Stripe
// SETTLEMENT for bank transfers (an in-flight payout is not yet a payment).
//
// Failure posture: sending is best-effort and NEVER throws — a Resend outage
// must not fail a payment that already happened. The outcome is stamped on the
// group (remittance_sent_at/_to or remittance_error) so the pay-run UI can
// show it and offer a resend.

import { sendEmail } from '../email-helpers.mjs';
import { patchGroup } from './vendor-payments-lib.mjs';

const REPLY_TO = process.env.REMIT_REPLY_TO || 'service@brixbev.com';

/** Everything in this email comes off OCR'd documents and SF free text —
 *  escape it all. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const RAIL_HUMAN = {
  stripe_payout: 'Bank transfer',
  venmo_manual: 'Venmo',
  zelle_manual: 'Zelle',
  check_manual: 'Check',
  qbo_billpay: 'Bill Pay',
};

function fmtDate(d) {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '—';
}

/** Pure builder — subject/html/text from the group + its bills, so the
 *  document a vendor receives is testable without email plumbing. */
export function buildRemittanceEmail({ group, vendorName, bills, paidDate }) {
  const railLabel = RAIL_HUMAN[group.rail] || 'Payment';
  const refLine = group.rail === 'check_manual' && group.reference
    ? `Check #${group.reference}`
    : group.reference || (group.external_payout_id ? `Ref ${group.external_payout_id}` : null);
  const total = money(group.total_amount);
  const date = fmtDate(paidDate || group.updated_at || group.created_at);

  // Credit memos render as negative lines — the vendor sees exactly which
  // credit offset which bills, and the total is the money that moved.
  const rowsHtml = (bills || []).map((b) => {
    const credit = b.is_credit === true;
    return `
        <tr${credit ? ' style="color:#047857"' : ''}>
          <td style="padding:7px 10px;border-bottom:1px solid #EDF1F6">${credit ? 'Credit ' : ''}${esc(b.bill_number || '—')}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #EDF1F6">${esc(fmtDate(b.receipt_date))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #EDF1F6">${esc(b.job_number || '—')}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #EDF1F6;text-align:right;font-variant-numeric:tabular-nums">${credit ? `−${money(b.total_amount)}` : money(b.total_amount)}</td>
        </tr>`;
  }).join('');

  const html = `<div style="font-family:'DM Sans',-apple-system,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:#1F4E79;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9FD0E8;font-weight:700">Brix Beverage · Accounts payable</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">Remittance advice — ${total}</div>
    </div>
    <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px;font-size:14px;color:#0F172A;line-height:1.55">
      <p style="margin:0 0 12px">A payment of <b>${total}</b> to <b>${esc(vendorName)}</b> was sent on <b>${esc(date)}</b>
        by <b>${esc(railLabel)}</b>${refLine ? ` (${esc(refLine)})` : ''}. It covers the following ${(bills || []).some((b) => b.is_credit) ? 'bills and credits' : bills.length === 1 ? 'bill' : `${bills.length} bills`}:</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead>
          <tr style="text-align:left;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:.06em">
            <th style="padding:6px 10px;border-bottom:2px solid #E4E9F0">Invoice / bill #</th>
            <th style="padding:6px 10px;border-bottom:2px solid #E4E9F0">Bill date</th>
            <th style="padding:6px 10px;border-bottom:2px solid #E4E9F0">Job</th>
            <th style="padding:6px 10px;border-bottom:2px solid #E4E9F0;text-align:right">Amount</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}
        <tr>
          <td colspan="3" style="padding:9px 10px;font-weight:800;text-align:right">Total paid</td>
          <td style="padding:9px 10px;font-weight:800;text-align:right;font-variant-numeric:tabular-nums">${total}</td>
        </tr>
        </tbody>
      </table>
      <p style="margin:14px 0 0;color:#64748B;font-size:12px">Please apply this payment against the invoices listed above.
        Questions about this remittance? Just reply to this email.</p>
    </div></div>`;

  const textLines = [
    `Remittance advice from Brix Beverage`,
    `Payment: ${total} to ${vendorName} on ${date} by ${railLabel}${refLine ? ` (${refLine})` : ''}`,
    '',
    ...(bills || []).map((b) =>
      `  ${b.is_credit ? 'Credit' : 'Bill'} ${b.bill_number || '—'} · ${fmtDate(b.receipt_date)} · job ${b.job_number || '—'} · ${b.is_credit ? '-' : ''}${money(b.total_amount)}`),
    '',
    `Total paid: ${total}`,
    'Please apply this payment against the invoices listed above. Reply with any questions.',
  ];

  return {
    subject: `Remittance advice — ${total} from Brix Beverage${bills.length > 1 ? ` (${bills.length} bills)` : ''}`,
    html,
    text: textLines.join('\n'),
  };
}

/** Send the advice and stamp the outcome on the group. Never throws.
 *  Returns { sent, to, error }. */
export async function sendRemittanceAdvice({ group, vendor, bills, to, paidDate }) {
  // Explicit override > the recipient chosen at pay time > the vendor's
  // contact email — the same ladder whichever path (record now, webhook at
  // settlement, or a manual resend) triggers the send.
  const recipient = String(to || group?.remit_to || vendor?.contact_email || '').trim();
  if (!recipient) {
    const error = 'no recipient — the vendor has no contact email on file';
    try { await patchGroup(group.id, { remittance_error: error }); } catch { /* stamped best-effort */ }
    return { sent: false, to: null, error };
  }
  try {
    const msg = buildRemittanceEmail({ group, vendorName: vendor?.display_name || 'your company', bills, paidDate });
    await sendEmail({ to: recipient, replyTo: REPLY_TO, ...msg });
    await patchGroup(group.id, {
      remittance_sent_at: new Date().toISOString(),
      remittance_sent_to: recipient,
      remittance_error: null,
    });
    return { sent: true, to: recipient, error: null };
  } catch (e) {
    const error = String(e?.message || e).slice(0, 300);
    try { await patchGroup(group.id, { remittance_error: error }); } catch { /* stamped best-effort */ }
    return { sent: false, to: recipient, error };
  }
}
