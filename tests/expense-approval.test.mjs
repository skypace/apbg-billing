// The approval ladder: drivers/office $500, techs $800, managers $2,500,
// anything above that is Sky's. Techs route to Anthony V, drivers to Joel,
// office to Marco.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  limitFor, canApprove, chainAbove, routeForApproval, LIMITS_BY_JOB,
} from '../netlify/functions/lib/expense-approval.mjs';

const PEOPLE = [
  { email: 'skypace@brixbev.com', full_name: 'Sky Pace', job: 'owner', approval_limit: null, approver_email: null },
  { email: 'marco@brixbev.com', full_name: 'Marco', job: 'manager', approval_limit: 2500, approver_email: 'skypace@brixbev.com' },
  { email: 'joel@brixbev.com', full_name: 'Joel', job: 'manager', approval_limit: 2500, approver_email: 'skypace@brixbev.com' },
  { email: 'anthonyv@brixbev.com', full_name: 'Anthony V', job: 'manager', approval_limit: 2500, approver_email: 'skypace@brixbev.com' },
  { email: 'driver@brixbev.com', full_name: 'Kyle', job: 'driver', approval_limit: 500, approver_email: 'joel@brixbev.com' },
  { email: 'tech@brixbev.com', full_name: 'Eric', job: 'tech', approval_limit: 800, approver_email: 'anthonyv@brixbev.com' },
  { email: 'office@brixbev.com', full_name: 'Office', job: 'office', approval_limit: 500, approver_email: 'marco@brixbev.com' },
];
const route = (amount, submitterEmail) => routeForApproval({ amount, submitterEmail, people: PEOPLE });

test('the published limits are the ones in the table', () => {
  assert.deepEqual(LIMITS_BY_JOB, { driver: 500, office: 500, tech: 800, manager: 2500, owner: null });
});

test('a driver under $500 auto-approves; over it goes to Joel', () => {
  assert.equal(route(420, 'driver@brixbev.com').autoApprove, true);
  const over = route(600, 'driver@brixbev.com');
  assert.equal(over.autoApprove, false);
  assert.equal(over.approver.email, 'joel@brixbev.com');
});

test('a tech gets $800, not $500, and routes to Anthony V', () => {
  assert.equal(route(750, 'tech@brixbev.com').autoApprove, true);
  assert.equal(route(900, 'tech@brixbev.com').approver.email, 'anthonyv@brixbev.com');
});

test('office routes to Marco', () => {
  assert.equal(route(900, 'office@brixbev.com').approver.email, 'marco@brixbev.com');
});

test('above $2,500 escalates past the manager to Sky', () => {
  const r = route(3000, 'tech@brixbev.com');
  assert.equal(r.approver.email, 'skypace@brixbev.com',
    'a manager capped at 2500 cannot take a 3000 expense — it must walk up');
});

// The rule that stops "approve up to $2,500" becoming a self-service allowance
test('a manager cannot self-approve above their own limit — it goes to Sky', () => {
  const r = route(2400, 'marco@brixbev.com');
  assert.equal(r.autoApprove, true, '2400 is inside Marco\'s own limit');
  const over = route(2600, 'marco@brixbev.com');
  assert.equal(over.autoApprove, false);
  assert.equal(over.approver.email, 'skypace@brixbev.com');
});

test('the owner approves anything', () => {
  assert.equal(route(50000, 'skypace@brixbev.com').autoApprove, true);
  assert.equal(limitFor(PEOPLE[0]), null);
});

// unknown is not zero — the bill-rules lesson, applied to money
test('an unreadable amount never auto-approves', () => {
  for (const bad of [null, undefined, NaN, 'abc']) {
    const r = route(bad, 'driver@brixbev.com');
    assert.equal(r.autoApprove, false, `${String(bad)} must not auto-approve`);
    assert.match(r.reason, /could not be read/);
  }
});

test('someone not on the roster approves nothing and is routed to an owner', () => {
  const r = route(10, 'stranger@example.com');
  assert.equal(r.autoApprove, false);
  assert.equal(r.approver.email, 'skypace@brixbev.com');
  assert.equal(limitFor(null), 0);
});

test('a NULL limit on a non-owner is treated as zero, not unlimited', () => {
  // a data fault must not become a blank cheque
  assert.equal(limitFor({ email: 'x', job: 'manager', approval_limit: null }), 0);
  assert.equal(limitFor({ email: 'x', job: 'owner', approval_limit: null }), null);
});

test('an inactive person approves nothing', () => {
  assert.equal(limitFor({ email: 'x', job: 'owner', approval_limit: null, active: false }), 0);
  assert.equal(canApprove({ email: 'x', job: 'manager', approval_limit: 2500, active: false }, 10), false);
});

test('a cycle in the approver chain terminates', () => {
  const looped = [
    { email: 'a@x.com', job: 'manager', approval_limit: 100, approver_email: 'b@x.com' },
    { email: 'b@x.com', job: 'manager', approval_limit: 100, approver_email: 'a@x.com' },
  ];
  const chain = chainAbove('a@x.com', looped);
  assert.ok(chain.length <= 2, 'a → b → a must not loop forever');
  const r = routeForApproval({ amount: 5000, submitterEmail: 'a@x.com', people: looped });
  assert.equal(r.gap, true, 'nobody can approve it, and that is reported rather than hidden');
  assert.equal(r.autoApprove, false);
});

test('a routing gap is never resolved by auto-approving', () => {
  const orphan = [{ email: 'lonely@x.com', job: 'driver', approval_limit: 500, approver_email: null }];
  const r = routeForApproval({ amount: 900, submitterEmail: 'lonely@x.com', people: orphan });
  assert.equal(r.autoApprove, false);
  assert.equal(r.gap, true);
  assert.match(r.reason, /Set an approver/);
});

test('the boundary is inclusive — exactly at the limit still auto-approves', () => {
  assert.equal(route(500, 'driver@brixbev.com').autoApprove, true);
  assert.equal(route(500.01, 'driver@brixbev.com').autoApprove, false);
  assert.equal(route(2500, 'marco@brixbev.com').autoApprove, true);
});
