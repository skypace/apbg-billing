// /api/stripe-payout-webhook — Stripe tells us a vendor payout landed (or
// didn't), and the books close themselves (Vendor Portal Phase 3).
//
// Global Payouts statuses: processing → posted | failed | returned | canceled.
//   posted             → ledger 'settled' + QBO BillPayment booked
//   failed / returned  → ledger 'failed' + REPORT_TO email (money came back;
//                        a human decides whether to re-send or pay another way)
//   canceled           → ledger 'failed' (reason 'canceled')
//   processing         → no-op (the ledger already says 'initiated')
//
// Verification: manual HMAC-SHA256 over `<timestamp>.<raw body>` against
// STRIPE_PAYOUT_WEBHOOK_SECRET, constant-time compared, 5-minute tolerance —
// this repo's functions carry no npm deps, so no stripe-node constructEvent.
// Unsigned/unverifiable requests are refused (401) rather than trusted: an
// endpoint that books QuickBooks payments must never take an anonymous word
// for it. Dark until the secret is set.
//
// Thin v2 events carry only the object reference, so the payout is re-fetched
// from Stripe — the API, never the request body, is the source of truth for
// the status we act on.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sendEmail, SITE_URL } from './email-helpers.mjs';
import { stripeV2, stripeConfigured } from './lib/stripe-payouts.mjs';
import {
  ops, recordQboBillPayment, recordQboBillPaymentMulti, patchLedger, ledgerByPayoutId,
  markExpensePaid, groupByPayoutId, patchGroup, paymentsInGroup,
} from './lib/vendor-payments-lib.mjs';
import { sendRemittanceAdvice } from './lib/remittance.mjs';

const SECRET = process.env.STRIPE_PAYOUT_WEBHOOK_SECRET || '';
const REPORT_TO = process.env.REPORT_TO || process.env.COMPLIANCE_ALERT_TO || 'service@brixbev.com';
const TOLERANCE_SEC = 300;

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

/** Stripe-Signature: t=…,v1=…[,v1=…] — any v1 matching wins (secret rolls). */
export function verifySignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, reason: 'no secret configured' };
  if (!header) return { ok: false, reason: 'missing Stripe-Signature header' };
  let ts = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const [k, v] = part.split('=');
    if (k?.trim() === 't') ts = v?.trim();
    else if (k?.trim() === 'v1' && v) sigs.push(v.trim());
  }
  if (!ts || sigs.length === 0) return { ok: false, reason: 'malformed signature header' };
  if (Math.abs(nowSec - Number(ts)) > TOLERANCE_SEC) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const expBuf = Buffer.from(expected, 'utf8');
  for (const s of sigs) {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length === expBuf.length && timingSafeEqual(buf, expBuf)) return { ok: true };
  }
  return { ok: false, reason: 'no matching v1 signature' };
}

/** Pull the payout id out of a v1-shaped or v2 thin event. */
export function payoutIdFrom(event) {
  return event?.related_object?.id
    || event?.data?.object?.id
    || event?.data?.id
    || null;
}

async function alert(subject, lines) {
  try {
    await sendEmail({
      to: REPORT_TO,
      subject,
      html: `<div style="font-family:'DM Sans',-apple-system,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#B91C1C;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:700">⚠ Vendor payout needs attention</div>
        <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:16px 20px;font-size:14px">
          ${lines.map((l) => `<p style="margin:0 0 8px">${l}</p>`).join('')}
          <p style="margin:14px 0 0"><a href="${SITE_URL}/expense/vendors" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px">Open Brixpense → Vendors →</a></p>
        </div></div>`,
      text: lines.join('\n'),
    });
  } catch (e) {
    console.error('[stripe-payout-webhook] alert email failed:', e.message);
  }
}

/** A pay-run batch settling (or failing): one payout covered N bills, so one
 *  multi-line QBO BillPayment closes them all, every bill gets stamped, and
 *  the vendor gets ONE remittance advice — sent HERE, at settlement, because
 *  an in-flight payout is not yet a payment. Same posture as the single path:
 *  the money moved either way, so a failed QBO booking settles the ledger and
 *  alerts a human instead of silently reading as unpaid. */
async function settleGroup(group, status, failureText, payoutId) {
  const rows = await paymentsInGroup(group.id);
  const expenseIds = rows.map((r) => r.expense_request_id).filter(Boolean);
  let bills = [];
  if (expenseIds.length) {
    bills = await ops('GET',
      'expense_requests?select=id,vendor_id,vendor_name,total_amount,bill_number,job_number,receipt_date'
      + `&id=in.(${expenseIds.join(',')})`) || [];
  }

  if (status === 'posted') {
    let billPaymentId = null, bookError = null;
    try {
      const qboVendorId = bills[0]?.vendor_id;
      if (!qboVendorId) throw new Error('no QBO vendor id on the batch expenses');
      billPaymentId = await recordQboBillPaymentMulti({
        qboVendorId,
        lines: rows.filter((r) => r.qbo_bill_id).map((r) => ({ qboBillId: r.qbo_bill_id, amount: r.amount })),
        memo: `Stripe payout ${payoutId} · Brixpense pay run of ${rows.length} bill(s)`,
      });
    } catch (e) {
      bookError = String(e.message || e).slice(0, 400);
      console.error('[stripe-payout-webhook] batch QBO BillPayment failed:', bookError);
    }

    const stampErrors = [];
    for (const r of rows) {
      await patchLedger(r.id, {
        status: 'settled',
        qbo_billpayment_id: billPaymentId,
        failure_reason: bookError ? `paid, but QBO BillPayment failed: ${bookError}` : null,
      });
      if (r.expense_request_id) {
        const err = await markExpensePaid(r.expense_request_id, {
          rail: r.rail, qboBillPaymentId: billPaymentId, reference: r.reference,
        });
        if (err) stampErrors.push(err);
      }
    }
    await patchGroup(group.id, {
      status: 'settled',
      qbo_billpayment_id: billPaymentId,
      failure_reason: bookError ? `paid, but QBO BillPayment failed: ${bookError}` : null,
    });

    const vendors = await ops('GET', `vendors?select=id,display_name,contact_email&id=eq.${group.vendor_id}&limit=1`);
    const remit = await sendRemittanceAdvice({
      group: { ...group, status: 'settled', qbo_billpayment_id: billPaymentId },
      vendor: vendors && vendors[0], bills,
    });
    if (!remit.sent) console.error('[stripe-payout-webhook] remittance not sent:', remit.error);

    if (bookError) {
      await alert(`Vendors paid, but QuickBooks did not record it — ${payoutId}`, [
        `Stripe payout <b>${payoutId}</b> POSTED (money left the account) for $${group.total_amount} across ${rows.length} bills.`,
        `Booking the QuickBooks BillPayment failed: <b>${bookError}</b>`,
        'The bills still read UNPAID in QuickBooks — record ONE payment covering them there by hand.',
      ]);
    }
    if (stampErrors.length) console.error('[stripe-payout-webhook] bills paid but not stamped:', stampErrors.join(' | '));
    return json({
      ok: true, status, group_id: group.id, bills: rows.length,
      qbo_billpayment_id: billPaymentId, book_error: bookError, remittance: remit,
    });
  }

  // failed | returned | canceled — the whole batch came back.
  const reason = String(failureText || status).slice(0, 400);
  for (const r of rows) await patchLedger(r.id, { status: 'failed', failure_reason: reason });
  await patchGroup(group.id, { status: 'failed', failure_reason: reason });
  await alert(`Vendor pay run ${status} — $${group.total_amount}`, [
    `Stripe payout <b>${payoutId}</b> came back <b>${status}</b>${failureText ? `: ${failureText}` : ''}.`,
    `$${group.total_amount} across ${rows.length} bills. The funds returned to the Stripe balance and every bill is still unpaid.`,
    'Re-run the payment from Brixpense once the cause is fixed, or pay another way and record it.',
  ]);
  return json({ ok: true, status, group_id: group.id, bills: rows.length });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!SECRET) {
    console.warn('[stripe-payout-webhook] refused: STRIPE_PAYOUT_WEBHOOK_SECRET not set');
    return json({ error: 'Webhook not configured' }, 503);
  }

  const raw = await req.text();
  const check = verifySignature(raw, req.headers.get('stripe-signature'), SECRET);
  if (!check.ok) {
    console.warn('[stripe-payout-webhook] signature rejected:', check.reason);
    return json({ error: 'Invalid signature' }, 401);
  }

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const type = String(event?.type || '');
  if (!/outbound_payment/.test(type)) {
    return json({ ok: true, ignored: type || 'unknown' });
  }

  const payoutId = payoutIdFrom(event);
  if (!payoutId) return json({ ok: true, ignored: 'no payout id on event' });

  const ledger = await ledgerByPayoutId(payoutId);
  let group = null;
  if (!ledger) {
    // A pay-run batch carries its payout id on the GROUP (its per-bill rows
    // share one payout, and the ledger's per-row index is unique).
    group = await groupByPayoutId(payoutId);
    if (!group) {
      // A payout we didn't initiate (Dashboard-sent, or another integration).
      console.log(`[stripe-payout-webhook] ${type} for unknown payout ${payoutId} — ignoring`);
      return json({ ok: true, ignored: 'payout not in ledger' });
    }
  }
  if (ledger && (ledger.status === 'settled' || ledger.status === 'recorded')) {
    return json({ ok: true, already: ledger.status });   // replays are safe
  }
  if (group && (group.status === 'settled' || group.status === 'recorded')) {
    return json({ ok: true, already: group.status });    // replays are safe
  }

  // Re-fetch: the API is the authority on status, not the delivered body.
  let status = null, failureText = null;
  if (stripeConfigured()) {
    try {
      const p = await stripeV2('GET', `/v2/money_management/outbound_payments/${payoutId}`);
      status = p?.status || null;
      failureText = p?.status_details?.failed?.reason || p?.status_details?.returned?.reason || null;
    } catch (e) {
      console.error('[stripe-payout-webhook] payout re-fetch failed:', e.message);
    }
  }
  if (!status) status = type.split('.').pop();   // fall back to the event name

  if (status === 'processing' || status === 'scheduled') {
    return json({ ok: true, status, note: 'still in flight' });
  }

  if (group) return await settleGroup(group, status, failureText, payoutId);

  if (status === 'posted') {
    let billPaymentId = null, bookError = null;
    if (ledger.qbo_bill_id) {
      try {
        const rows = await ops('GET', `expense_requests?select=vendor_id&id=eq.${ledger.expense_request_id}&limit=1`);
        const qboVendorId = rows?.[0]?.vendor_id;
        if (!qboVendorId) throw new Error('expense row has no QBO vendor id');
        billPaymentId = await recordQboBillPayment({
          qboVendorId,
          qboBillId: ledger.qbo_bill_id,
          amount: ledger.amount,
          memo: `Stripe payout ${payoutId} · Brixpense vendor payment`,
        });
      } catch (e) {
        bookError = String(e.message || e).slice(0, 400);
        console.error('[stripe-payout-webhook] QBO BillPayment failed:', bookError);
      }
    }
    // The money DID move — settle the ledger either way; a failed booking is
    // reported, never silently dropped (it would read as unpaid in QBO).
    await patchLedger(ledger.id, {
      status: 'settled',
      qbo_billpayment_id: billPaymentId,
      failure_reason: bookError ? `paid, but QBO BillPayment failed: ${bookError}` : null,
    });
    // Settled means the money landed — stamp the bill so it leaves the aging
    // total. Deliberately keyed on SETTLEMENT, not on the earlier 'initiated'
    // row: an in-flight payout is honestly still owed, and the ledger's
    // duplicate guard is what stops it being paid twice meanwhile.
    let stampError = null;
    if (ledger.expense_request_id) {
      stampError = await markExpensePaid(ledger.expense_request_id, {
        rail: ledger.rail, qboBillPaymentId: billPaymentId, reference: ledger.reference,
      });
      if (stampError) console.error('[stripe-payout-webhook] bill paid but not stamped:', stampError);
    }
    if (bookError) {
      await alert(`Vendor paid, but QuickBooks did not record it — ${payoutId}`, [
        `Stripe payout <b>${payoutId}</b> POSTED (money left the account) for $${ledger.amount}.`,
        `Booking the QuickBooks BillPayment failed: <b>${bookError}</b>`,
        'The bill still reads UNPAID in QuickBooks — record the payment there by hand.',
      ]);
    }
    return json({ ok: true, status, ledger_id: ledger.id, qbo_billpayment_id: billPaymentId, book_error: bookError, stamp_error: stampError });
  }

  // failed | returned | canceled — funds came back.
  const reason = failureText || status;
  await patchLedger(ledger.id, { status: 'failed', failure_reason: String(reason).slice(0, 400) });
  await alert(`Vendor payout ${status} — $${ledger.amount}`, [
    `Stripe payout <b>${payoutId}</b> came back <b>${status}</b>${failureText ? `: ${failureText}` : ''}.`,
    `Amount $${ledger.amount}. The funds returned to the Stripe balance and the bill is still unpaid.`,
    'Re-send from Brixpense once the cause is fixed, or pay another way and record it.',
  ]);
  return json({ ok: true, status, ledger_id: ledger.id });
}

export const config = { path: '/api/stripe-payout-webhook' };
