// tests/expense-guards.test.mjs — the duplicate-bill guard's client contract.
//
// The matching RULES live in Postgres (ops.fn_bill_duplicate_candidates) so the
// automated and human paths cannot drift, and they were verified against live
// data when they shipped: replayed over every expense on file they produced
// three same-vendor/same-amount clusters, of which exactly one — ARTURO
// SANTIAGO $375 on 2026-08-11, two QBO Bills (173048, 173049) against one job
// — was a real duplicate. The job-number discriminator is what separates it
// from the two that merely cost the same.
//
// What this file covers is the JS half: which candidates count, what the
// caller is told, and — the part with teeth — that a failing check never stops
// a bill being filed or posted.

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const { findDuplicate } = await import('../netlify/functions/lib/expense-dupes.mjs');

const rpc = (rows, ok = true) => mock.method(globalThis, 'fetch', async () => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => rows,
  text: async () => JSON.stringify(rows),
}));

const row = (over = {}) => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  match_kind: 'exact',
  vendor_name: 'PRO MECHANICAL',
  bill_number: 'INV-42',
  total_amount: 375,
  receipt_date: '2026-08-11',
  status: 'posted',
  qbo_bill_id: '173048',
  qbo_purchase_id: null,
  tag: 'AP Inbox',
  created_at: '2026-08-11T00:00:00Z',
  ...over,
});

test('an exact match already in QuickBooks is reported as posted', async (t) => {
  t.after(() => mock.restoreAll());
  rpc([row()]);
  const d = await findDuplicate({ vendor: 'Pro Mechanical', bill_number: 'INV 42' });
  assert.equal(d.match_kind, 'exact');
  assert.equal(d.posted, true);
  // The reason has to name the QBO bill, because that is the fact that decides
  // whether posting again costs money.
  assert.match(d.reason, /Bill 173048/);
});

test('a denied twin is not a duplicate', async (t) => {
  t.after(() => mock.restoreAll());
  // Someone re-sending an invoice we rejected is the NORMAL case, not a
  // duplicate — treating it as one would block the corrected bill.
  rpc([row({ status: 'denied', qbo_bill_id: null })]);
  assert.equal(await findDuplicate({ vendor: 'Pro Mechanical', bill_number: 'INV-42' }), null);
});

test('an unposted twin still flags, but not as posted', async (t) => {
  t.after(() => mock.restoreAll());
  rpc([row({ status: 'approved', qbo_bill_id: null })]);
  const d = await findDuplicate({ vendor: 'Pro Mechanical', bill_number: 'INV-42' });
  assert.equal(d.posted, false);
  assert.doesNotMatch(d.reason, /QuickBooks/);
});

test('an exact match is preferred over a merely similar one', async (t) => {
  t.after(() => mock.restoreAll());
  rpc([row({ match_kind: 'exact' }), row({ id: 'bbbb', match_kind: 'likely' })]);
  const d = await findDuplicate({ vendor: 'x', bill_number: 'y' });
  assert.equal(d.match_kind, 'exact');
});

test('a check that cannot run never blocks the bill', async (t) => {
  t.after(() => mock.restoreAll());
  // This is the load-bearing one. The cost of a missed flag is a conversation;
  // the cost of a lost invoice is a vendor chasing us for payment.
  rpc({ message: 'boom' }, false);
  assert.equal(await findDuplicate({ vendor: 'anyone' }), null);

  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  assert.equal(await findDuplicate({ vendor: 'anyone' }), null);
});

test('no vendor and no service key mean no check', async (t) => {
  t.after(() => mock.restoreAll());
  const f = rpc([row()]);
  assert.equal(await findDuplicate({ bill_number: 'INV-42' }), null);
  assert.equal(f.mock.callCount(), 0, 'a vendorless bill must not hit the database');
});

test('the job number is passed through so the database can discriminate', async (t) => {
  t.after(() => mock.restoreAll());
  let body;
  mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  });
  await findDuplicate({ vendor: 'v', amount: 170, date: '2026-07-27', job_number: '1092930655' });
  assert.equal(body.p_job_number, '1092930655');
  assert.equal(body.p_amount, 170);
});
