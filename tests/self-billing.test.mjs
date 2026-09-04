// Raising Origins' invoice on their behalf: matching, numbering, and the
// document model. Written against the REAL live data — the three Origins
// expenses arrive spelled three different ways.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesProfile, ilike, formatInvoiceNumber, invoiceLines,
  buildInvoiceModel, recipientsFor, canRaise,
} from '../netlify/functions/lib/self-billing.mjs';

const ORIGINS = {
  active: true,
  code: 'ORIGINS',
  vendor_patterns: ['origins%', '%origins craft soda%'],
  qbo_vendor_id: '1428',
  seller_name: 'Origins Craft Soda',
  seller_addr1: '1660 Chicago Ave',
  seller_city_state_zip: 'Riverside, CA 92507',
  seller_email: 'stephen.boss@originscraftsoda.com',
  number_prefix: 'BX', number_separator: '-', number_pad: 4, next_number: 12,
  send_to: ['stephen.boss@originscraftsoda.com'],
  footer_note: 'Prepared by APBG on behalf of Origins Craft Soda, by agreement.',
};
const COMPANY = {
  company_name: 'Brix Beverage Dba Alameda Point Beverage Group',
  company_addr1: '1951 Monarch St', company_addr2: 'Suite 200',
  company_city_state_zip: 'Alameda, CA 94501', company_email: 'service@brixbev.com',
};

test('the number starts at BX-0012', () => {
  assert.equal(formatInvoiceNumber(ORIGINS, 12), 'BX-0012');
  assert.equal(formatInvoiceNumber(ORIGINS, 13), 'BX-0013');
  assert.equal(formatInvoiceNumber(ORIGINS, 9999), 'BX-9999');
  assert.equal(formatInvoiceNumber(ORIGINS, 10000), 'BX-10000', 'must not truncate past the pad');
});

// All three spellings are real rows in ops.expense_requests today
test('every spelling Origins actually arrives under is matched', () => {
  for (const vendor_name of ['Origins', 'ORIGINS CRAFT SODA', 'ORIGINS CRAFT SODA COMPANY']) {
    assert.equal(matchesProfile(ORIGINS, { vendor_name }), true, `${vendor_name} should match`);
  }
});

test('an unrelated vendor is not claimed', () => {
  for (const vendor_name of ['Desert Beverage', 'PRO MECHANICAL', 'ARTURO SANTIAGO', '']) {
    assert.equal(matchesProfile(ORIGINS, { vendor_name }), false, `${vendor_name} must not match`);
  }
});

// The failure that would be worst: a half-configured profile invoicing everyone
test('a profile with no patterns and no vendor id claims nothing', () => {
  const empty = { ...ORIGINS, vendor_patterns: [], qbo_vendor_id: null };
  assert.equal(matchesProfile(empty, { vendor_name: 'Origins' }), false);
  assert.equal(matchesProfile(empty, { vendor_name: 'anyone at all' }), false);
});

test('an inactive profile claims nothing', () => {
  assert.equal(matchesProfile({ ...ORIGINS, active: false }, { vendor_name: 'Origins' }), false);
});

test('the QBO vendor id matches even when the name does not', () => {
  assert.equal(matchesProfile(ORIGINS, { vendor_name: 'Totally Different Ltd', qbo_vendor_id: '1428' }), true);
});

test('ilike is anchored — a pattern must match the whole name', () => {
  assert.equal(ilike('origins craft soda', 'origins%'), true);
  assert.equal(ilike('not origins', 'origins%'), false, 'a leading % is required to match a suffix');
  assert.equal(ilike('origins craft soda', '%craft%'), true);
});

test('the expense line items become the invoice lines', () => {
  const lines = invoiceLines({
    total_amount: 300,
    line_items: [{ qty: 1, amount: 300, unit_price: 300, description: 'Origins Craft soda Repair leaking line ' }],
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, 'Origins Craft soda Repair leaking line');
  assert.equal(lines[0].lineTotal, 300);
});

test('an expense with no lines still invoices, naming the job', () => {
  const lines = invoiceLines({ total_amount: 600, job_number: '1094627586', line_items: [] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].description, /job 1094627586/);
  assert.equal(lines[0].lineTotal, 600);
});

test('the invoice runs FROM Origins TO Alameda Point, with both real addresses', () => {
  const m = buildInvoiceModel({
    profile: ORIGINS, company: COMPANY, invoiceNumber: 'BX-0012',
    expense: { total_amount: 300, receipt_date: '2026-09-01', job_number: '1095928076',
               line_items: [{ qty: 1, amount: 300, unit_price: 300, description: 'Repair leaking line' }] },
  });
  assert.equal(m.seller.name, 'Origins Craft Soda');
  assert.equal(m.seller.addr1, '1660 Chicago Ave');
  assert.equal(m.seller.city_state_zip, 'Riverside, CA 92507');
  assert.match(m.buyer.name, /Alameda Point Beverage Group/);
  assert.equal(m.buyer.addr1, '1951 Monarch St');
  assert.equal(m.total, 300);
  assert.equal(m.invoiceNumber, 'BX-0012');
  assert.equal(m.lineMismatch, null);
});

// The invoice we send must equal the bill we pay
test('the total is the expense total, and a line disagreement is surfaced not silently fixed', () => {
  const m = buildInvoiceModel({
    profile: ORIGINS, company: COMPANY, invoiceNumber: 'BX-0012',
    expense: { total_amount: 300, line_items: [{ qty: 1, amount: 250, unit_price: 250, description: 'Partial' }] },
  });
  assert.equal(m.total, 300, 'the expense total wins');
  assert.deepEqual(m.lineMismatch, { lineSum: 250, total: 300 });
});

test('the buyer falls back to the company record so our address has one home', () => {
  const m = buildInvoiceModel({ profile: ORIGINS, company: COMPANY, invoiceNumber: 'BX-0012',
    expense: { total_amount: 100, line_items: [] } });
  assert.equal(m.buyer.addr2, 'Suite 200');
  const overridden = buildInvoiceModel({
    profile: { ...ORIGINS, buyer_name: 'Alameda Soda', buyer_addr1: 'Somewhere else' },
    company: COMPANY, invoiceNumber: 'BX-0012', expense: { total_amount: 100, line_items: [] },
  });
  assert.equal(overridden.buyer.name, 'Alameda Soda');
});

test('recipients are deduped and cc never repeats to', () => {
  const r = recipientsFor({
    send_to: ['Stephen.Boss@originscraftsoda.com', 'stephen.boss@originscraftsoda.com', 'not-an-email'],
    send_cc: ['stephen.boss@originscraftsoda.com', 'ap@brixbev.com'],
  });
  assert.deepEqual(r.to, ['stephen.boss@originscraftsoda.com']);
  assert.deepEqual(r.cc, ['ap@brixbev.com']);
});

test('one invoice per expense — a second raise is refused', () => {
  const expense = { total_amount: 300 };
  assert.equal(canRaise(expense, null).ok, true);
  const blocked = canRaise(expense, { invoice_number: 'BX-0012', voided_at: null });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /BX-0012 already covers/);
  // ...unless the first was voided
  assert.equal(canRaise(expense, { invoice_number: 'BX-0012', voided_at: '2026-09-03' }).ok, true);
});

test('an unreadable or zero amount is not invoiced', () => {
  for (const total_amount of [null, undefined, 0, -50, 'abc']) {
    assert.equal(canRaise({ total_amount }, null).ok, false, `${String(total_amount)} must be refused`);
  }
});
