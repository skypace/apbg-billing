import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, safeIds, chunk } from '../netlify/functions/lib/qbo-bill-status.mjs';

const row = { id: 'r1', qbo_bill_id: '173048', total_amount: 375 };

test('a zero balance is paid', () => {
  const { outcome, patch } = decide(row, { balance: 0, total: 375 }, null);
  assert.equal(outcome, 'paid');
  assert.equal(patch.qbo_balance, 0);
  assert.equal(patch.payment_method, 'quickbooks');
  assert.ok(patch.paid_at);
});

test('the real payment date wins over now — a bill paid in June is not paid today', () => {
  const { patch } = decide(row, { balance: 0, total: 375 },
    { date: '2026-06-11', billPaymentId: '9001' });
  assert.ok(patch.paid_at.startsWith('2026-06-11'));
  assert.equal(patch.qbo_billpayment_id, '9001');
});

test('a partial payment is NOT paid — it is still owed', () => {
  const { outcome, patch } = decide(row, { balance: 100, total: 375 }, null);
  assert.equal(outcome, 'partial');
  assert.equal(patch.qbo_balance, 100);
  assert.equal(patch.paid_at, undefined);
});

test('an untouched bill stays open', () => {
  const { outcome, patch } = decide(row, { balance: 375, total: 375 }, null);
  assert.equal(outcome, 'open');
  assert.equal(patch.paid_at, undefined);
});

test('a bill QuickBooks does not return is missing, never paid', () => {
  const { outcome, patch } = decide(row, undefined, null);
  assert.equal(outcome, 'missing');
  assert.equal(patch.qbo_balance, null);
  assert.equal(patch.paid_at, undefined);
  assert.ok(patch.qbo_checked_at);
});

test('an absent Balance field is unknown, not paid', () => {
  // The bug this pins: `balance || null` would read a real 0 as unknown, and a
  // truthiness test would read unknown as open. Only null/undefined is unknown.
  const { outcome, patch } = decide(row, { balance: null, total: 375 }, null);
  assert.equal(outcome, 'unknown');
  assert.equal(patch.paid_at, undefined);
});

test('only digit ids reach a query string', () => {
  assert.deepEqual(safeIds(['173048', "1' OR 1=1--", '', null, '173048', 'abc']), ['173048']);
});

test('ids are batched', () => {
  assert.equal(chunk(Array.from({ length: 65 }, (_, i) => String(i)), 30).length, 3);
});
