// The pure rules behind the QuickBooks time mirror
// (netlify/functions/qbo-time-sync.mjs).
//
// Each of these is a way to be wrong SILENTLY, which is the only kind that
// matters here: hours land in a payroll-grade table that a cost-per-job will
// be built on, and a number that is merely plausible is indistinguishable from
// a correct one on a dashboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalHours, timeRow, windowStart } from '../netlify/functions/qbo-time-sync.mjs';

// A real entry, copied from the live API on 2026-09-07 (Kyle McGee, 2026-08-15).
const LIVE = {
  Id: '1073746004', TxnDate: '2026-08-15', NameOf: 'Employee',
  EmployeeRef: { value: '400000001', name: 'Kyle W. McGee' },
  CustomerRef: { value: '14', name: '1100 GROUP' },
  ItemRef: { value: '388', name: 'Sales' },
  BillableStatus: 'NotBillable', Taxable: false,
  HourlyRate: 0, CostRate: 23.68, Hours: 3, Minutes: 56, Seconds: 0,
  SyncToken: '0', MetaData: { CreateTime: '2026-08-25T17:39:40-07:00', LastUpdatedTime: '2026-08-25T17:39:40-07:00' },
};

test('QBO splits a duration three ways and we store decimal hours once', () => {
  assert.equal(decimalHours(LIVE), 3.9333);
  assert.equal(decimalHours({ Hours: 8 }), 8);
  assert.equal(decimalHours({ Minutes: 30 }), 0.5);
  assert.equal(decimalHours({ Hours: 1, Minutes: 30, Seconds: 36 }), 1.51);
  // A missing triple is zero hours, not NaN — NaN would poison every sum
  // downstream and render as an empty cell rather than an error.
  assert.equal(decimalHours({}), 0);
  assert.equal(decimalHours(null), 0);
});

test('a zero rate is UNKNOWN, not free labour', () => {
  // Every live entry carries HourlyRate 0. Storing 0 would let a consumer
  // compute a labour cost of $0 and present it as fact; null makes it fall
  // back to the roster wage and say which it used.
  const r = timeRow(LIVE);
  assert.equal(r.hourly_rate, null);
  assert.equal(r.cost_rate, 23.68);
  assert.equal(timeRow({ ...LIVE, CostRate: 0 }).cost_rate, null);
  assert.equal(timeRow({ ...LIVE, CostRate: null }).cost_rate, null);
});

test('the customer reference is mirrored but never promoted', () => {
  // It is a stuck default in QuickBooks Time today — five distinct values
  // across 649 entries, one constant per person. Keep it so the day it is
  // fixed it starts working; never let it become the join key by accident.
  const r = timeRow(LIVE);
  assert.equal(r.customer_qbo_id, '14');
  assert.equal(r.customer_name, '1100 GROUP');
  // The row carries no job/customer-derived cost field of any kind.
  assert.ok(!('job_id' in r) && !('attributed_cost' in r));
});

test('identity and provenance survive the mirror', () => {
  const r = timeRow(LIVE, 'STAMP');
  assert.equal(r.qbo_id, '1073746004');
  assert.equal(r.txn_date, '2026-08-15');
  assert.equal(r.employee_qbo_id, '400000001');
  assert.equal(r.employee_name, 'Kyle W. McGee');
  assert.equal(r.hours, 3.9333);
  assert.equal(r.synced_at, 'STAMP');
  // qbo_created_at is what the health check watches: entries appear at payroll
  // close, ~14 days after the work, so the WORK date can never be the signal.
  assert.equal(r.qbo_created_at, '2026-08-25T17:39:40-07:00');
});

test('the lookback is wide enough to catch a fortnight-old day that only just appeared', () => {
  const now = new Date('2026-09-07T00:00:00Z');
  assert.equal(windowStart(6, now), '2026-03-07');
  // Measured lag is 9–20 days. Anything under a month would miss entries that
  // land after the window has moved past their work date.
  const oneMonth = new Date(windowStart(1, now));
  assert.ok((now - oneMonth) / 86400000 >= 28);
});

test('a description is bounded — it reaches a table a dashboard reads', () => {
  const long = timeRow({ ...LIVE, Description: 'x'.repeat(900) });
  assert.equal(long.description.length, 500);
  assert.equal(timeRow({ ...LIVE, Description: '' }).description, null);
});
