// vendor-payments-lib.mjs — shared plumbing for the Vendor Portal Phase 3
// payments ledger: ops.vendor_payments writes (service role — RLS gives
// staff read-only) and the QBO BillPayment writeback that closes the books.
// Used by vendor-pay.mjs (the explicit human click) and
// stripe-payout-webhook.mjs (settlement).

import { ops } from './vendor-onboard-lib.mjs';
import { qboRequest } from '../qbo-helpers.mjs';

export { ops };

/** Build the QBO BillPayment payload for one vendor covering N bills — one
 *  Line per bill, each linked to its Bill. Pure and exported so the payload
 *  shape (the part QBO actually validates) is testable without QBO. */
export function buildBillPaymentPayload({ qboVendorId, lines, memo, bankAccountId }) {
  const bank = bankAccountId || process.env.QBO_VENDOR_PAY_BANK_ACCOUNT_ID || '72';
  const clean = (lines || [])
    .map((l) => ({ qboBillId: String(l.qboBillId || '').trim(), amount: Number(l.amount) }))
    .filter((l) => l.qboBillId && l.amount > 0);
  if (!clean.length) throw new Error('BillPayment needs at least one bill line');
  const seen = new Set();
  for (const l of clean) {
    if (seen.has(l.qboBillId)) throw new Error(`Duplicate bill ${l.qboBillId} in one BillPayment`);
    seen.add(l.qboBillId);
  }
  const total = clean.reduce((s, l) => s + l.amount, 0);
  return {
    VendorRef: { value: String(qboVendorId) },
    TotalAmt: Number(total.toFixed(2)),
    PayType: 'Check',
    CheckPayment: { BankAccountRef: { value: bank } },
    Line: clean.map((l) => ({
      Amount: Number(l.amount.toFixed(2)),
      LinkedTxn: [{ TxnId: l.qboBillId, TxnType: 'Bill' }],
    })),
    ...(memo ? { PrivateNote: String(memo).slice(0, 4000) } : {}),
  };
}

/** Book ONE QBO BillPayment covering several bills of one vendor, through the
 *  hardened billing token chain. Bank account defaults to Chase Business
 *  Checking (QBO 72 — the account the bank feed lives on, session 1.82);
 *  override with QBO_VENDOR_PAY_BANK_ACCOUNT_ID. Returns the BillPayment id. */
export async function recordQboBillPaymentMulti({ qboVendorId, lines, memo }) {
  const payload = buildBillPaymentPayload({ qboVendorId, lines, memo });
  const res = await qboRequest('POST', '/billpayment', payload);
  const id = res?.BillPayment?.Id;
  if (!id) throw new Error('QBO did not return a BillPayment id');
  return String(id);
}

/** Single-bill wrapper — every pre-pay-run caller. Delegates to the multi
 *  builder so the payload shape cannot drift between the two paths. */
export async function recordQboBillPayment({ qboVendorId, qboBillId, amount, memo }) {
  return recordQboBillPaymentMulti({ qboVendorId, lines: [{ qboBillId, amount }], memo });
}

export async function insertLedger(row) {
  const created = await ops('POST', 'vendor_payments', row, { Prefer: 'return=representation' });
  return created && created[0];
}

export async function patchLedger(id, patch) {
  await ops('PATCH', `vendor_payments?id=eq.${id}`, patch);
}

export async function ledgerByPayoutId(externalPayoutId) {
  const rows = await ops('GET',
    `vendor_payments?select=*&external_payout_id=eq.${encodeURIComponent(externalPayoutId)}&limit=1`);
  return rows && rows[0];
}

// ── Pay-run groups (20260826d) — one group per vendor per batch payment. ────
// The per-bill ledger rows stay the duplicate guard; the group carries what is
// singular about the payment: the one payout id / BillPayment id / check # and
// the remittance-advice send record.

export async function insertGroup(row) {
  const created = await ops('POST', 'vendor_payment_groups', row, { Prefer: 'return=representation' });
  return created && created[0];
}

export async function patchGroup(id, patch) {
  await ops('PATCH', `vendor_payment_groups?id=eq.${id}`, patch);
}

export async function groupById(id) {
  const rows = await ops('GET', `vendor_payment_groups?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows && rows[0];
}

export async function groupByPayoutId(externalPayoutId) {
  const rows = await ops('GET',
    `vendor_payment_groups?select=*&external_payout_id=eq.${encodeURIComponent(externalPayoutId)}&limit=1`);
  return rows && rows[0];
}

export async function paymentsInGroup(groupId) {
  return await ops('GET',
    `vendor_payments?select=*&group_id=eq.${encodeURIComponent(groupId)}&order=created_at.asc`) || [];
}

/** A LIVE payment already covers this QBO bill? (failed rows release it) */
export async function liveLedgerForBill(qboBillId) {
  const rows = await ops('GET',
    `vendor_payments?select=id,rail,status,amount,created_at&qbo_bill_id=eq.${encodeURIComponent(qboBillId)}`
    + '&status=in.(initiated,settled,recorded)&limit=1');
  return rows && rows[0];
}

/** Stamp the BILL itself as paid.
 *
 *  The ledger (ops.vendor_payments) is the payment's story; expense_requests
 *  is the bill's. Both need to know, because they answer different questions
 *  and different code reads each: the pay panel reads the ledger, while
 *  ops.v_ap_aging — what we owe and how late — keys on paid_at. Leave the bill
 *  unstamped and a paid bill sits in the aging total forever, so the one
 *  number the AP desk trusts only ever grows.
 *
 *  Non-fatal by design and NEVER silent: by the time this runs the money has
 *  already moved, so throwing here would unwind nothing and lose the ledger
 *  row. It returns the failure instead, and every caller reports it the same
 *  way a failed QBO booking is reported. */
export async function markExpensePaid(expenseId, { rail, qboBillPaymentId, reference, paidAt } = {}) {
  try {
    await ops('PATCH', `expense_requests?id=eq.${expenseId}`, {
      paid_at: paidAt || new Date().toISOString(),
      payment_method: rail || null,
      ...(qboBillPaymentId ? { qbo_billpayment_id: String(qboBillPaymentId) } : {}),
      ...(reference ? { payment_reference: String(reference).slice(0, 120) } : {}),
    });
    return null;
  } catch (e) {
    return String(e?.message || e).slice(0, 400);
  }
}
