// /api/vendor-pay — the Vendor Portal Phase 3 Pay button (SUPERADMIN ONLY,
// Phase 0 decision #2). No auto-pay exists anywhere: every ledger row starts
// from an explicit click here.
//
// POST { action, ... } — all actions superadmin-gated:
//   stripe_status { vendor_id }
//     → recipient readiness (capability + payout method) + financial-account
//       balance, so the UI can say exactly what's missing before a Pay.
//   stripe_setup { vendor_id }
//     → creates the v2 recipient Account when missing (persists
//       stripe_recipient_id — the ONLY Stripe datum we store), mints a
//       Stripe-hosted onboarding link (single-use, ~10-minute expiry) and
//       EMAILS it to the vendor: they give their bank details to STRIPE,
//       never to us. Re-click = fresh link.
//   preview { expense_request_id }
//     → the confirm payload: vendor, rail, amount, duplicate guard, readiness.
//   pay { expense_request_id }
//     → Stripe rail: duplicate guard → ledger 'initiated' → OutboundPayment.
//       The webhook settles it and books the QBO BillPayment.
//   record { expense_request_id, rail, reference?, notes? }
//     → manual rails (venmo/zelle/check sent by hand, or QBO Bill Pay):
//       books the QBO BillPayment (except qbo_billpay — Bill Pay already
//       posted its own payment) + ledger 'recorded', so the bill reads paid
//       everywhere without double-booking.
//
// Env: STRIPE_PAYOUTS_KEY (restricted key — dark until set),
//      QBO_VENDOR_PAY_BANK_ACCOUNT_ID (default 72, Chase Business Checking).

import { requireAuth } from './lib/auth.mjs';
import { sendEmail, SITE_URL } from './email-helpers.mjs';
import {
  stripeConfigured, getFinancialAccount, createRecipient,
  createOnboardingLink, recipientStatus, createOutboundPayment,
} from './lib/stripe-payouts.mjs';
import { ops, recordQboBillPayment, insertLedger, patchLedger, liveLedgerForBill, markExpensePaid } from './lib/vendor-payments-lib.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });
const MANUAL_RAILS = new Set(['venmo_manual', 'zelle_manual', 'check_manual', 'qbo_billpay']);
const UUID_RE = /^[0-9a-f-]{36}$/i;

async function loadVendor(vendorId) {
  const rows = await ops('GET', `vendors?select=*&id=eq.${vendorId}&limit=1`);
  return rows && rows[0];
}

async function loadExpense(expenseId) {
  const rows = await ops('GET',
    `expense_requests?select=id,vendor_name,vendor_id,total_amount,qbo_bill_id,status,as_bill,bill_number,job_number&id=eq.${expenseId}&limit=1`);
  return rows && rows[0];
}

/** Resolve the registry vendor for an expense: the expense carries the QBO
 *  vendor id; the registry links to it via vendors.qbo_vendor_id. */
async function vendorForExpense(expense) {
  if (!expense?.vendor_id) return null;
  const rows = await ops('GET',
    `vendors?select=*&qbo_vendor_id=eq.${encodeURIComponent(expense.vendor_id)}&archived_at=is.null&limit=1`);
  return rows && rows[0];
}

async function handleStripeStatus(vendor) {
  if (!stripeConfigured()) return json({ configured: false, ready: false });
  let fa = null;
  try { fa = await getFinancialAccount(); } catch (e) { return json({ configured: true, ready: false, error: e.message }, 502); }
  if (!vendor.stripe_recipient_id) {
    return json({ configured: true, ready: false, recipient: null, balance_cents: fa.availableCents });
  }
  const status = await recipientStatus(vendor.stripe_recipient_id);
  return json({
    configured: true,
    recipient: vendor.stripe_recipient_id,
    ready: status.ready,
    capability_status: status.capability_status,
    payout_methods: status.payout_methods,
    balance_cents: fa.availableCents,
  });
}

async function handleStripeSetup(vendor, actorEmail) {
  if (!vendor.contact_email) return json({ error: 'No contact email on file — the Stripe link goes out by email.' }, 400);

  let recipientId = vendor.stripe_recipient_id;
  if (!recipientId) {
    recipientId = await createRecipient({
      displayName: vendor.legal_name || vendor.display_name,
      contactEmail: vendor.contact_email,
    });
    await ops('PATCH', `vendors?id=eq.${vendor.id}`, { stripe_recipient_id: recipientId });
  }

  const link = await createOnboardingLink({
    recipientId,
    returnUrl: `${SITE_URL}/vendor-onboarding?stripe=done`,
    refreshUrl: `${SITE_URL}/vendor-onboarding?stripe=refresh`,
  });

  await sendEmail({
    to: vendor.contact_email,
    subject: `${vendor.display_name} — set up bank payouts from Brix Beverage`,
    html: `<div style="font-family:'DM Sans',-apple-system,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1F4E79;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
        <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9FD0E8;font-weight:700">Brix Beverage · Payments</div>
        <div style="font-size:20px;font-weight:800;margin-top:4px">Set up direct bank payouts</div>
      </div>
      <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px;font-size:14px;color:#0F172A;line-height:1.55">
        <p style="margin:0 0 12px">So we can pay ${vendor.display_name} by direct bank transfer, please add your bank details through our payment provider, <b>Stripe</b>. You enter them on Stripe's secure page — Brix Beverage never sees your account numbers.</p>
        <p style="margin:0 0 14px"><a href="${link}" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Add your bank details with Stripe →</a></p>
        <p style="margin:0;color:#64748B;font-size:12px">⏱ For security this link expires in about <b>10 minutes</b> and works once. If it has expired, just reply and we'll send a fresh one.</p>
      </div></div>`,
    text: `Set up direct bank payouts from Brix Beverage via Stripe (secure — we never see your account numbers): ${link}\nThis link expires in ~10 minutes; reply for a fresh one.`,
  });

  console.log(`[vendor-pay] stripe onboarding link sent to ${vendor.contact_email} by ${actorEmail}`);
  return json({ ok: true, recipient: recipientId, sent_to: vendor.contact_email, link_expires_minutes: 10, link });
}

async function buildPreview(expense) {
  const problems = [];
  if (!expense.qbo_bill_id) problems.push('This expense has no QBO bill yet — post it to QuickBooks first.');
  if (!['approved', 'posted'].includes(expense.status)) problems.push(`Expense status is '${expense.status}' — only approved/posted bills can be paid.`);
  const amount = Number(expense.total_amount);
  if (!(amount > 0)) problems.push('The expense has no positive amount.');

  const vendor = await vendorForExpense(expense);
  if (!vendor) problems.push('No vendor in the registry is linked to this QBO vendor — add/link it in Brixpense → Vendors first.');

  let dup = null;
  if (expense.qbo_bill_id) {
    dup = await liveLedgerForBill(expense.qbo_bill_id);
    if (dup) problems.push(`This bill already has a ${dup.status} payment on the ledger (${dup.rail}, $${dup.amount}) — refusing a duplicate.`);
  }

  let stripe = { configured: stripeConfigured(), ready: false };
  if (vendor && stripe.configured && vendor.stripe_recipient_id) {
    try {
      const [fa, st] = await Promise.all([getFinancialAccount(), recipientStatus(vendor.stripe_recipient_id)]);
      stripe = {
        configured: true, ready: st.ready, payout_method_id: st.payout_method_id,
        balance_cents: fa.availableCents,
        funded: fa.availableCents >= Math.round(amount * 100),
        financial_account: fa.id,
      };
    } catch (e) {
      stripe = { configured: true, ready: false, error: e.message };
    }
  }

  return { expense, vendor, amount, problems, dup, stripe };
}

async function handlePreview(expense) {
  const p = await buildPreview(expense);
  return json({
    ok: p.problems.length === 0,
    problems: p.problems,
    amount: p.amount,
    vendor: p.vendor ? {
      id: p.vendor.id, display_name: p.vendor.display_name,
      payment_method_pref: p.vendor.payment_method_pref,
      payment_handle: p.vendor.payment_handle,
      stripe_recipient_id: p.vendor.stripe_recipient_id,
    } : null,
    stripe: p.stripe,
  });
}

async function handlePay(expense, actorEmail) {
  const p = await buildPreview(expense);
  if (p.problems.length) return json({ error: p.problems.join(' ') }, 409);
  if (!p.stripe.configured) return json({ error: 'Stripe payouts are not configured on this site yet (STRIPE_PAYOUTS_KEY).' }, 501);
  if (!p.vendor.stripe_recipient_id || !p.stripe.ready) {
    return json({ error: 'This vendor is not set up for Stripe payouts yet — use "Set up bank payouts" first, or record a manual payment.' }, 409);
  }
  if (!p.stripe.funded) {
    const bal = (p.stripe.balance_cents || 0) / 100;
    return json({
      error: `The Stripe payout balance ($${bal.toFixed(2)}) can't cover $${p.amount.toFixed(2)} — short $${(p.amount - bal).toFixed(2)}.`
        + ' Top up from Brixpense → Vendors → Stripe vendor funding (or Stripe → Treasury → Add funds).'
        + ' A bank pull settles in 2–6 business days, so fund ahead of the bills you know are coming.',
      short_by: Number((p.amount - bal).toFixed(2)),
      balance: Number(bal.toFixed(2)),
    }, 409);
  }

  // Ledger first — the partial unique index is the real duplicate guard.
  let ledger;
  try {
    ledger = await insertLedger({
      vendor_id: p.vendor.id,
      expense_request_id: expense.id,
      qbo_bill_id: expense.qbo_bill_id,
      rail: 'stripe_payout',
      amount: p.amount,
      status: 'initiated',
      initiated_by: actorEmail,
      notes: expense.bill_number ? `Bill #${expense.bill_number}` : null,
    });
  } catch (e) {
    if (/duplicate|unique/i.test(e.message)) return json({ error: 'A live payment for this bill already exists on the ledger.' }, 409);
    throw e;
  }

  try {
    const payout = await createOutboundPayment({
      financialAccountId: p.stripe.financial_account,
      recipientId: p.vendor.stripe_recipient_id,
      payoutMethodId: p.stripe.payout_method_id,
      amountCents: Math.round(p.amount * 100),
      description: `Brix Beverage bill ${expense.bill_number || expense.qbo_bill_id}`,
    });
    await patchLedger(ledger.id, { external_payout_id: payout.id });
    return json({
      ok: true, ledger_id: ledger.id, payout_id: payout.id, payout_status: payout.status,
      note: 'Payout sent to Stripe. The webhook settles it and books the QuickBooks BillPayment automatically.',
    });
  } catch (e) {
    await patchLedger(ledger.id, { status: 'failed', failure_reason: String(e.message || e).slice(0, 400) });
    return json({ error: `Stripe payout failed: ${String(e.message || e).slice(0, 300)}` }, 502);
  }
}

async function handleRecord(expense, body, actorEmail) {
  const rail = String(body.rail || '');
  if (!MANUAL_RAILS.has(rail)) return json({ error: `rail must be one of ${[...MANUAL_RAILS].join(', ')}` }, 400);
  const p = await buildPreview(expense);
  if (p.problems.length) return json({ error: p.problems.join(' ') }, 409);

  // qbo_billpay: QBO Bill Pay already created its own payment in QuickBooks —
  // booking a second BillPayment would double-pay the bill. Ledger only.
  let billPaymentId = null;
  if (rail !== 'qbo_billpay') {
    billPaymentId = await recordQboBillPayment({
      qboVendorId: expense.vendor_id,
      qboBillId: expense.qbo_bill_id,
      amount: p.amount,
      memo: `Paid via ${rail.replace('_manual', '')}${body.reference ? ` · ref ${String(body.reference).slice(0, 60)}` : ''} · recorded in Brixpense by ${actorEmail}`,
    });
  }

  try {
    const ledger = await insertLedger({
      vendor_id: p.vendor.id,
      expense_request_id: expense.id,
      qbo_bill_id: expense.qbo_bill_id,
      rail,
      amount: p.amount,
      status: 'recorded',
      qbo_billpayment_id: billPaymentId,
      reference: body.reference ? String(body.reference).slice(0, 120) : null,
      initiated_by: actorEmail,
      notes: body.notes ? String(body.notes).slice(0, 400) : null,
    });
    // A manual rail means the money already left — stamp the bill so it drops
    // out of ops.v_ap_aging. Reported, never silent (see markExpensePaid).
    const stampError = await markExpensePaid(expense.id, {
      rail, qboBillPaymentId: billPaymentId, reference: body.reference,
    });
    if (stampError) console.error('[vendor-pay] bill paid but not stamped:', stampError);
    return json({ ok: true, ledger_id: ledger.id, qbo_billpayment_id: billPaymentId, stamp_error: stampError });
  } catch (e) {
    // BillPayment landed but the ledger insert collided — surface honestly.
    if (/duplicate|unique/i.test(e.message)) {
      return json({
        error: 'A live ledger row for this bill already existed.'
          + (billPaymentId ? ` ⚠ A QBO BillPayment (${billPaymentId}) WAS just booked — check QuickBooks for a double payment.` : ''),
      }, 409);
    }
    throw e;
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Superadmin ONLY — paying money out is the tightest gate in Brixpense.
  const auth = await requireAuth(req, ['superadmin']);
  if (!auth.ok) return auth.response;
  const actorEmail = auth.user?.email || 'superadmin';

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  try {
    if (body.action === 'stripe_status' || body.action === 'stripe_setup') {
      const vendorId = String(body.vendor_id || '');
      if (!UUID_RE.test(vendorId)) return json({ error: 'vendor_id is required' }, 400);
      const vendor = await loadVendor(vendorId);
      if (!vendor || vendor.archived_at) return json({ error: 'Vendor not found' }, 404);
      return body.action === 'stripe_status'
        ? await handleStripeStatus(vendor)
        : await handleStripeSetup(vendor, actorEmail);
    }

    if (body.action === 'preview' || body.action === 'pay' || body.action === 'record') {
      const expenseId = String(body.expense_request_id || '');
      if (!UUID_RE.test(expenseId)) return json({ error: 'expense_request_id is required' }, 400);
      const expense = await loadExpense(expenseId);
      if (!expense) return json({ error: 'Expense not found' }, 404);
      if (body.action === 'preview') return await handlePreview(expense);
      if (body.action === 'pay') return await handlePay(expense, actorEmail);
      return await handleRecord(expense, body, actorEmail);
    }
  } catch (e) {
    console.error('[vendor-pay]', body.action, 'failed:', e.message);
    return json({ error: String(e.message || e).slice(0, 400) }, 502);
  }
  return json({ error: 'Unknown action — expected stripe_status, stripe_setup, preview, pay, or record' }, 400);
}

export const config = { path: '/api/vendor-pay' };
