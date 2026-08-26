// /api/vendor-pay-run — pay SEVERAL posted bills in one action (SUPERADMIN
// ONLY, the same gate as vendor-pay: money out is the tightest gate in
// Brixpense). One vendor per payment, one payment per vendor: N selected bills
// become ONE Stripe payout or ONE recorded manual payment, ONE multi-line QBO
// BillPayment, and ONE remittance-advice email listing every bill covered.
//
// POST { action, ... }:
//   list
//     → every payable bill (posted to QBO, unpaid, un-archived, no live
//       payment) grouped by vendor, with the registry vendor's rail readiness
//       and the Stripe balance — the pay-run screen renders straight off this.
//   pay_stripe { expense_request_ids[], remit_to? }
//     → one vendor's bills → ledger rows FIRST (the per-bill unique index is
//       the duplicate guard — no money moves unless every row inserts) → ONE
//       OutboundPayment for the total. stripe-payout-webhook settles it, books
//       the multi-line BillPayment, stamps every bill, and sends the
//       remittance advice — at settlement, when the money actually moved.
//   record { expense_request_ids[], rail, reference?, notes?, remit_to? }
//     → the money already moved by hand (check/venmo/zelle) or QBO Bill Pay
//       already booked its own payment. Ledger rows first (same guard), then
//       ONE multi-line QBO BillPayment (skipped for qbo_billpay — double-pay),
//       every bill stamped paid, remittance advice sent now.
//   remit { group_id, to? }
//     → (re)send the remittance advice for a settled/recorded group — the
//       vendor lost it, or the first send failed / had no address.
//
// Failure posture: ledger writes precede money and bookings, so a duplicate
// aborts BEFORE anything real happens; a QBO refusal after a manual batch
// leaves rows 'failed' with the reason (nothing half-booked — the BillPayment
// is one atomic QBO write); a remittance failure never fails a payment (it is
// stamped on the group for a resend).

import { requireAuth } from './lib/auth.mjs';
import {
  stripeConfigured, getFinancialAccount, recipientStatus, createOutboundPayment,
} from './lib/stripe-payouts.mjs';
import {
  ops, recordQboBillPaymentMulti, insertLedger, patchLedger, liveLedgerForBill,
  markExpensePaid, insertGroup, patchGroup, groupById, paymentsInGroup,
} from './lib/vendor-payments-lib.mjs';
import { sendRemittanceAdvice } from './lib/remittance.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });
const MANUAL_RAILS = new Set(['venmo_manual', 'zelle_manual', 'check_manual', 'qbo_billpay']);
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_BILLS_PER_RUN = 40;   // one QBO BillPayment holds all lines — keep it human-checkable

const BILL_SELECT = 'id,vendor_name,vendor_id,total_amount,bill_number,job_number,receipt_date,due_date,qbo_bill_id,status,paid_at,archived_at';

const chunk = (arr, n = 40) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Registry vendors keyed by QBO vendor id (the key expense rows carry). */
async function vendorMapFor(qboIds) {
  const map = new Map();
  for (const group of chunk([...new Set(qboIds.filter(Boolean))])) {
    if (!group.length) continue;
    const rows = await ops('GET',
      `vendors?select=id,qbo_vendor_id,display_name,legal_name,contact_email,payment_method_pref,payment_handle,stripe_recipient_id`
      + `&qbo_vendor_id=in.(${group.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})&archived_at=is.null`);
    for (const v of rows || []) map.set(String(v.qbo_vendor_id), v);
  }
  return map;
}

/** Live payments keyed by qbo_bill_id, for the given bills. */
async function livePaymentsFor(qboBillIds) {
  const map = new Map();
  for (const group of chunk([...new Set(qboBillIds.filter(Boolean))])) {
    if (!group.length) continue;
    const rows = await ops('GET',
      `vendor_payments?select=id,qbo_bill_id,rail,status,amount,group_id,created_at`
      + `&qbo_bill_id=in.(${group.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`
      + '&status=in.(initiated,settled,recorded)');
    for (const p of rows || []) map.set(String(p.qbo_bill_id), p);
  }
  return map;
}

// ── list — everything payable, grouped by vendor ─────────────────────────────
async function handleList() {
  const bills = await ops('GET',
    `expense_requests?select=${BILL_SELECT}`
    + '&qbo_bill_id=not.is.null&as_bill=eq.true&paid_at=is.null&archived_at=is.null'
    + '&status=in.(approved,posted)&order=receipt_date.asc.nullslast&limit=400') || [];

  const [vendorMap, liveMap] = await Promise.all([
    vendorMapFor(bills.map((b) => b.vendor_id)),
    livePaymentsFor(bills.map((b) => b.qbo_bill_id)),
  ]);

  let stripe = { configured: stripeConfigured(), balance_cents: null };
  if (stripe.configured) {
    try { stripe.balance_cents = (await getFinancialAccount()).availableCents; }
    catch (e) { stripe.error = String(e.message || e).slice(0, 200); }
  }

  const groups = new Map();
  for (const b of bills) {
    const key = String(b.vendor_id ?? '') || `unlinked:${b.vendor_name || '—'}`;
    if (!groups.has(key)) {
      const v = vendorMap.get(String(b.vendor_id ?? '')) || null;
      groups.set(key, {
        qbo_vendor_id: b.vendor_id ?? null,
        vendor_name: v?.display_name || b.vendor_name || '(no vendor)',
        vendor: v && {
          id: v.id, display_name: v.display_name, contact_email: v.contact_email,
          payment_method_pref: v.payment_method_pref, stripe_recipient_id: v.stripe_recipient_id,
        },
        bills: [], in_flight: [], total: 0,
      });
    }
    const g = groups.get(key);
    const live = liveMap.get(String(b.qbo_bill_id));
    const row = {
      id: b.id, bill_number: b.bill_number, job_number: b.job_number,
      receipt_date: b.receipt_date, due_date: b.due_date,
      amount: Number(b.total_amount), qbo_bill_id: b.qbo_bill_id,
    };
    if (live) g.in_flight.push({ ...row, payment_status: live.status, payment_rail: live.rail });
    else { g.bills.push(row); g.total = Number((g.total + row.amount).toFixed(2)); }
  }

  const out = [...groups.values()]
    .filter((g) => g.bills.length || g.in_flight.length)
    .sort((a, b) => b.total - a.total);
  return json({ ok: true, stripe, vendors: out });
}

// ── shared validation for pay_stripe / record ────────────────────────────────
async function loadBatch(expenseIds) {
  const ids = [...new Set((expenseIds || []).map(String))];
  const problems = [];
  if (!ids.length) return { problems: ['No bills selected.'] };
  if (ids.length > MAX_BILLS_PER_RUN) return { problems: [`At most ${MAX_BILLS_PER_RUN} bills per payment.`] };
  if (ids.some((id) => !UUID_RE.test(id))) return { problems: ['Malformed expense id in the selection.'] };

  const bills = [];
  for (const group of chunk(ids)) {
    const rows = await ops('GET',
      `expense_requests?select=${BILL_SELECT}&id=in.(${group.join(',')})`);
    bills.push(...(rows || []));
  }
  if (bills.length !== ids.length) problems.push('Some selected bills no longer exist.');

  for (const b of bills) {
    const tag = b.bill_number ? `bill #${b.bill_number}` : (b.vendor_name || b.id);
    if (!b.qbo_bill_id) problems.push(`${tag}: not posted to QuickBooks yet.`);
    if (!['approved', 'posted'].includes(b.status)) problems.push(`${tag}: status '${b.status}' is not payable.`);
    if (b.paid_at) problems.push(`${tag}: already marked paid.`);
    if (b.archived_at) problems.push(`${tag}: archived.`);
    if (!(Number(b.total_amount) > 0)) problems.push(`${tag}: no positive amount.`);
  }

  const vendorIds = [...new Set(bills.map((b) => String(b.vendor_id ?? '')))];
  if (vendorIds.length > 1) {
    problems.push('One payment covers ONE vendor — the selection spans '
      + `${vendorIds.length} different vendors. Pay each vendor separately.`);
  }

  let vendor = null;
  if (vendorIds.length === 1 && vendorIds[0]) {
    vendor = (await vendorMapFor([vendorIds[0]])).get(vendorIds[0]) || null;
  }
  if (!vendor) problems.push('No vendor in the registry is linked to this QBO vendor — add/link it in Brixpense → Vendors first.');

  const liveMap = await livePaymentsFor(bills.map((b) => b.qbo_bill_id));
  for (const b of bills) {
    const live = liveMap.get(String(b.qbo_bill_id));
    if (live) problems.push(`Bill ${b.bill_number || b.qbo_bill_id} already has a ${live.status} payment (${live.rail}) — refusing a duplicate.`);
  }

  const total = Number(bills.reduce((s, b) => s + Number(b.total_amount), 0).toFixed(2));
  return { bills, vendor, total, problems };
}

/** Insert the group + one ledger row per bill BEFORE any money moves. Rolls
 *  the batch to 'failed' and reports if any row collides with the per-bill
 *  duplicate guard — a race with a single-bill Pay click elsewhere. */
async function openLedger({ bills, vendor, rail, total, actorEmail, reference, notes, remitTo }) {
  const group = await insertGroup({
    vendor_id: vendor.id,
    rail,
    total_amount: total,
    bill_count: bills.length,
    status: 'initiated',
    reference: reference ? String(reference).slice(0, 120) : null,
    initiated_by: actorEmail,
    notes: notes ? String(notes).slice(0, 400) : null,
    remit_to: remitTo ? String(remitTo).slice(0, 200) : null,
  });

  const rows = [];
  for (const b of bills) {
    try {
      rows.push(await insertLedger({
        vendor_id: vendor.id,
        expense_request_id: b.id,
        qbo_bill_id: b.qbo_bill_id,
        group_id: group.id,
        rail,
        amount: Number(b.total_amount),
        status: 'initiated',
        initiated_by: actorEmail,
        notes: b.bill_number ? `Bill #${b.bill_number}` : null,
      }));
    } catch (e) {
      const dup = /duplicate|unique/i.test(String(e.message || e));
      const reason = dup
        ? `batch aborted — bill ${b.bill_number || b.qbo_bill_id} already had a live payment`
        : `batch aborted — ledger write failed: ${String(e.message || e).slice(0, 200)}`;
      for (const r of rows) await patchLedger(r.id, { status: 'failed', failure_reason: reason });
      await patchGroup(group.id, { status: 'failed', failure_reason: reason });
      return { error: json({ error: `${reason}. Nothing was paid.` }, dup ? 409 : 502) };
    }
  }
  return { group, rows };
}

async function failBatch(group, rows, reason) {
  const r = String(reason).slice(0, 400);
  for (const row of rows) await patchLedger(row.id, { status: 'failed', failure_reason: r });
  await patchGroup(group.id, { status: 'failed', failure_reason: r });
}

// ── pay_stripe — one payout for the vendor's selected bills ──────────────────
async function handlePayStripe(body, actorEmail) {
  const { bills, vendor, total, problems } = await loadBatch(body.expense_request_ids);
  if (problems.length) return json({ error: problems.join(' ') }, 409);
  if (!stripeConfigured()) return json({ error: 'Stripe payouts are not configured on this site yet (STRIPE_PAYOUTS_KEY).' }, 501);
  if (!vendor.stripe_recipient_id) {
    return json({ error: 'This vendor is not set up for Stripe payouts yet — use "Set up bank payouts" on their vendor page, or record a manual payment.' }, 409);
  }

  let fa, st;
  try {
    [fa, st] = await Promise.all([getFinancialAccount(), recipientStatus(vendor.stripe_recipient_id)]);
  } catch (e) {
    return json({ error: `Stripe check failed: ${String(e.message || e).slice(0, 200)}` }, 502);
  }
  if (!st.ready) return json({ error: 'This vendor has not finished Stripe bank setup.' }, 409);
  const totalCents = Math.round(total * 100);
  if (fa.availableCents < totalCents) {
    const bal = fa.availableCents / 100;
    return json({
      error: `The Stripe payout balance ($${bal.toFixed(2)}) can't cover $${total.toFixed(2)} — short $${(total - bal).toFixed(2)}.`
        + ' Top up from Brixpense → Vendors → Stripe vendor funding first.',
      short_by: Number((total - bal).toFixed(2)),
    }, 409);
  }

  // The remittance recipient can be chosen at pay time; it rides the group so
  // the webhook sends the advice to the right address at settlement.
  const opened = await openLedger({
    bills, vendor, rail: 'stripe_payout', total, actorEmail,
    notes: body.notes, remitTo: body.remit_to,
  });
  if (opened.error) return opened.error;
  const { group, rows } = opened;

  try {
    const payout = await createOutboundPayment({
      financialAccountId: fa.id,
      recipientId: vendor.stripe_recipient_id,
      payoutMethodId: st.payout_method_id,
      amountCents: totalCents,
      description: `Brix Beverage · ${bills.length === 1 ? `bill ${bills[0].bill_number || bills[0].qbo_bill_id}` : `${bills.length} bills`}`,
    });
    await patchGroup(group.id, { external_payout_id: payout.id });
    return json({
      ok: true, group_id: group.id, payout_id: payout.id, payout_status: payout.status,
      bills: bills.length, total,
      note: 'Payout sent to Stripe. On settlement, QuickBooks records ONE payment covering every bill and the vendor gets the remittance advice automatically.',
    });
  } catch (e) {
    await failBatch(group, rows, `Stripe payout failed: ${String(e.message || e)}`);
    return json({ error: `Stripe payout failed: ${String(e.message || e).slice(0, 300)}. Nothing was paid.` }, 502);
  }
}

// ── record — money already moved by hand; book once, stamp all, remit now ────
async function handleRecord(body, actorEmail) {
  const rail = String(body.rail || '');
  if (!MANUAL_RAILS.has(rail)) return json({ error: `rail must be one of ${[...MANUAL_RAILS].join(', ')}` }, 400);
  const { bills, vendor, total, problems } = await loadBatch(body.expense_request_ids);
  if (problems.length) return json({ error: problems.join(' ') }, 409);

  const opened = await openLedger({
    bills, vendor, rail, total, actorEmail,
    reference: body.reference, notes: body.notes, remitTo: body.remit_to,
  });
  if (opened.error) return opened.error;
  const { group, rows } = opened;

  // qbo_billpay already posted its own payment inside QuickBooks — booking a
  // second BillPayment would pay the bills twice. Ledger + stamps only.
  let billPaymentId = null;
  if (rail !== 'qbo_billpay') {
    try {
      billPaymentId = await recordQboBillPaymentMulti({
        qboVendorId: bills[0].vendor_id,
        lines: bills.map((b) => ({ qboBillId: b.qbo_bill_id, amount: Number(b.total_amount) })),
        memo: `Paid via ${rail.replace('_manual', '')}${body.reference ? ` · ref ${String(body.reference).slice(0, 60)}` : ''}`
          + ` · pay run of ${bills.length} bill(s) recorded in Brixpense by ${actorEmail}`,
      });
    } catch (e) {
      // One atomic QBO write — a refusal means NOTHING was booked.
      await failBatch(group, rows, `QBO BillPayment failed: ${String(e.message || e)}`);
      return json({ error: `QuickBooks refused the payment: ${String(e.message || e).slice(0, 300)}. Nothing was recorded.` }, 502);
    }
  }

  const stampErrors = [];
  for (const [i, b] of bills.entries()) {
    await patchLedger(rows[i].id, { status: 'recorded', qbo_billpayment_id: billPaymentId, reference: body.reference ? String(body.reference).slice(0, 120) : null });
    const err = await markExpensePaid(b.id, { rail, qboBillPaymentId: billPaymentId, reference: body.reference });
    if (err) stampErrors.push(`${b.bill_number || b.id}: ${err}`);
  }
  await patchGroup(group.id, { status: 'recorded', qbo_billpayment_id: billPaymentId });

  const remit = await sendRemittanceAdvice({
    group: { ...group, status: 'recorded', qbo_billpayment_id: billPaymentId, reference: body.reference || group.reference },
    vendor, bills, to: body.remit_to,
  });

  if (stampErrors.length) console.error('[vendor-pay-run] paid but not stamped:', stampErrors.join(' | '));
  return json({
    ok: true, group_id: group.id, qbo_billpayment_id: billPaymentId,
    bills: bills.length, total,
    remittance: remit,
    stamp_errors: stampErrors.length ? stampErrors : undefined,
  });
}

// ── remit — (re)send the advice for a finished group ─────────────────────────
async function handleRemit(body) {
  const groupId = String(body.group_id || '');
  if (!UUID_RE.test(groupId)) return json({ error: 'group_id is required' }, 400);
  const group = await groupById(groupId);
  if (!group) return json({ error: 'Payment group not found' }, 404);
  if (!['settled', 'recorded'].includes(group.status)) {
    return json({ error: `This payment is '${group.status}' — the remittance advice goes out once the money has actually moved.` }, 409);
  }
  const vendors = await ops('GET', `vendors?select=id,display_name,contact_email&id=eq.${group.vendor_id}&limit=1`);
  const vendor = vendors && vendors[0];
  const rows = await paymentsInGroup(groupId);
  const expenseIds = rows.map((r) => r.expense_request_id).filter(Boolean);
  const bills = [];
  for (const g of chunk(expenseIds)) {
    if (!g.length) continue;
    bills.push(...(await ops('GET', `expense_requests?select=${BILL_SELECT}&id=in.(${g.join(',')})`) || []));
  }
  const remit = await sendRemittanceAdvice({ group, vendor, bills, to: body.to });
  return remit.sent
    ? json({ ok: true, sent_to: remit.to })
    : json({ error: remit.error || 'Could not send the remittance advice.' }, 502);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin']);
  if (!auth.ok) return auth.response;
  const actorEmail = auth.user?.email || 'superadmin';

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  try {
    if (body.action === 'list') return await handleList();
    if (body.action === 'pay_stripe') return await handlePayStripe(body, actorEmail);
    if (body.action === 'record') return await handleRecord(body, actorEmail);
    if (body.action === 'remit') return await handleRemit(body);
  } catch (e) {
    console.error('[vendor-pay-run]', body.action, 'failed:', e.message);
    return json({ error: String(e.message || e).slice(0, 400) }, 502);
  }
  return json({ error: 'Unknown action — expected list, pay_stripe, record, or remit' }, 400);
}

export const config = { path: '/api/vendor-pay-run' };
