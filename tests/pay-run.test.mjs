// pay-run.test.mjs — the pure pieces of the pay run: the multi-line QBO
// BillPayment payload (what QuickBooks actually validates) and the remittance
// advice document a vendor receives. Run via `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBillPaymentPayload } from '../netlify/functions/lib/vendor-payments-lib.mjs';
import { buildRemittanceEmail, esc } from '../netlify/functions/lib/remittance.mjs';

// ── buildBillPaymentPayload ──────────────────────────────────────────────────

test('one BillPayment covers several bills: one Line per bill, TotalAmt is the sum', () => {
  const p = buildBillPaymentPayload({
    qboVendorId: 1922,
    lines: [
      { qboBillId: '173048', amount: 375 },
      { qboBillId: '172953', amount: 256.59 },
      { qboBillId: '173000', amount: 317.59 },
    ],
    memo: 'pay run test',
    bankAccountId: '72',
  });
  assert.equal(p.VendorRef.value, '1922');
  assert.equal(p.TotalAmt, 949.18);
  assert.equal(p.Line.length, 3);
  assert.deepEqual(p.Line[1].LinkedTxn, [{ TxnId: '172953', TxnType: 'Bill' }]);
  assert.equal(p.Line[1].Amount, 256.59);
  assert.equal(p.CheckPayment.BankAccountRef.value, '72');
  assert.equal(p.PayType, 'Check');
  assert.equal(p.PrivateNote, 'pay run test');
});

test('floating-point bill amounts do not leak float noise into TotalAmt', () => {
  // 0.1 + 0.2 territory: three amounts whose naive sum is 331.62000000000006.
  const p = buildBillPaymentPayload({
    qboVendorId: '1', bankAccountId: '72',
    lines: [
      { qboBillId: 'a1', amount: 110.54 },
      { qboBillId: 'a2', amount: 110.54 },
      { qboBillId: 'a3', amount: 110.54 },
    ],
  });
  assert.equal(p.TotalAmt, 331.62);
});

test('the same bill twice in one payment is refused — that is a double-pay', () => {
  assert.throws(
    () => buildBillPaymentPayload({
      qboVendorId: '1', bankAccountId: '72',
      lines: [{ qboBillId: '9', amount: 10 }, { qboBillId: '9', amount: 10 }],
    }),
    /duplicate bill/i,
  );
});

test('no usable lines is refused, and zero/negative/blank lines are dropped first', () => {
  assert.throws(
    () => buildBillPaymentPayload({
      qboVendorId: '1', bankAccountId: '72',
      lines: [{ qboBillId: '', amount: 10 }, { qboBillId: '9', amount: 0 }, { qboBillId: '8', amount: -5 }],
    }),
    /at least one bill line/i,
  );
});

test('single-line payload keeps the exact shape the single-bill rail always sent', () => {
  const p = buildBillPaymentPayload({
    qboVendorId: '42', bankAccountId: '72',
    lines: [{ qboBillId: '168463', amount: 99.5 }],
  });
  assert.equal(p.TotalAmt, 99.5);
  assert.deepEqual(p.Line, [{ Amount: 99.5, LinkedTxn: [{ TxnId: '168463', TxnType: 'Bill' }] }]);
});

// ── remittance advice ────────────────────────────────────────────────────────

const GROUP = {
  id: 'g1', rail: 'check_manual', total_amount: 949.18, reference: '10442',
  external_payout_id: null, created_at: '2026-08-26T20:00:00Z', updated_at: '2026-08-26T20:00:00Z',
};
const BILLS = [
  { bill_number: 'INV-1001', receipt_date: '2026-08-01', job_number: '1094476063', total_amount: 375 },
  { bill_number: null, receipt_date: null, job_number: null, total_amount: 574.18 },
];

test('remittance advice lists every bill, the total, and the check number', () => {
  const msg = buildRemittanceEmail({ group: GROUP, vendorName: 'PRO MECHANICAL', bills: BILLS });
  assert.match(msg.subject, /\$949\.18/);
  assert.match(msg.subject, /2 bills/);
  assert.match(msg.html, /Check #10442/);
  assert.match(msg.html, /INV-1001/);
  assert.match(msg.html, /1094476063/);
  assert.match(msg.html, /\$574\.18/);
  assert.match(msg.text, /INV-1001/);
  assert.match(msg.text, /Total paid: \$949\.18/);
  // A bill with no number/date/job renders placeholders, not "undefined".
  assert.ok(!msg.html.includes('undefined'));
  assert.ok(!msg.text.includes('undefined'));
});

test('vendor names and bill numbers off OCR are HTML-escaped', () => {
  const msg = buildRemittanceEmail({
    group: GROUP,
    vendorName: 'Acme <script>alert(1)</script> & Sons',
    bills: [{ bill_number: '<img src=x>', receipt_date: '2026-08-01', job_number: null, total_amount: 10 }],
  });
  assert.ok(!msg.html.includes('<script>'));
  assert.ok(!msg.html.includes('<img src=x>'));
  assert.match(msg.html, /&lt;script&gt;/);
  assert.match(msg.html, /Acme .* &amp; Sons/);
});

test('a Stripe payment shows the payout reference, not "Check #"', () => {
  const msg = buildRemittanceEmail({
    group: { ...GROUP, rail: 'stripe_payout', reference: null, external_payout_id: 'obp_test_123' },
    vendorName: 'Vendor', bills: BILLS,
  });
  assert.match(msg.html, /Bank transfer/);
  assert.match(msg.html, /Ref obp_test_123/);
  assert.ok(!msg.html.includes('Check #'));
});

test('esc covers the five HTML metacharacters', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
});
