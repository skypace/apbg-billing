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
import { ops, recordQboBillPayment, patchLedger, ledgerByPayoutId, markExpensePaid } from './lib/vendor-payments-lib.mjs';

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
  if (!ledger) {
    // A payout we didn't initiate (Dashboard-sent, or another integration).
    console.log(`[stripe-payout-webhook] ${type} for unknown payout ${payoutId} — ignoring`);
    return json({ ok: true, ignored: 'payout not in ledger' });
  }
  if (ledger.status === 'settled' || ledger.status === 'recorded') {
    return json({ ok: true, already: ledger.status });   // replays are safe
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
