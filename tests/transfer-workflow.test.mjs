// The transfer process — the parts that can be wrong quietly.
//
// What is pinned here is deliberately narrow: the token rules (because a
// mistake there hands the ledger to whoever guesses a URL), the Service Fusion
// ticket's own words (because "20 cases of X" is the instruction a tech works
// from, and an attachment they cannot see is not one), the 422 retry ladder
// (SF only attaches an EXISTING category), and who hears about a transfer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mintReceiveToken, hashToken, receiveUrl, buildTransferSfJob,
  createTransferSfJob, sfJobLooksComplete, receivingRecipients,
} from '../netlify/functions/lib/transfer-workflow.mjs';
import { whatToBuild } from '../netlify/functions/lib/transfer-docs.mjs';

const SETTINGS = {
  sf_customer_name: 'BRIX BEVERAGE - SAMPLING',
  sf_job_category: 'Product Transfer Ticket',
  sf_job_status: 'Unscheduled',
  ops_email: 'service@brixbev.com',
};

const DOC = {
  fromLoc: { name: 'Brix Warehouse' },
  toLoc: { name: 'Natural Wave', contact_email: null },
  label: 'BOL-2026-00011',
  payload: {
    bolNumber: 'BOL-2026-00011',
    accent: '#1F4E79',
    specialInstructions: null,
    notes: null,
    lines: [
      { qty: 20, description: '3G6141 CABLE CAR LEMON LIME' },
      { qty: 2, description: '3G6121 HANGAR 25 COLA' },
    ],
  },
};

// ── the token ────────────────────────────────────────────────────────────────

test('a receive token is random, and only its hash is ever stored', () => {
  const a = mintReceiveToken(21);
  const b = mintReceiveToken(21);
  assert.notEqual(a.token, b.token, 'two links must never collide');
  assert.ok(a.token.length >= 40, 'a guessable token is not a gate');
  assert.equal(a.hash, hashToken(a.token));
  assert.notEqual(a.hash, a.token, 'the raw token must not be what we keep');
  // The whole point: the hash cannot be turned back into a working link, so a
  // database read (or a leaked backup) yields nothing that opens the page.
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test('the link expires, and the window is the setting', () => {
  const soon = mintReceiveToken(1);
  const days = (new Date(soon.expiresAt) - Date.now()) / 86400_000;
  assert.ok(days > 0.9 && days < 1.1, `expected ~1 day, got ${days}`);
});

test('the link goes through the branded gateway path, and the token is escaped', () => {
  const url = receiveUrl('a+b/c=', 'https://alamedapointbg.com/');
  assert.equal(url, 'https://alamedapointbg.com/billing/transfer-receive.html?t=a%2Bb%2Fc%3D');
  // /billing/* is already proxied to this site, so the receiving branch clicks
  // our own domain and no new gateway route is needed.
  assert.ok(url.includes('/billing/transfer-receive.html'));
});

// ── the ticket ───────────────────────────────────────────────────────────────

test('the SF ticket says what to build in words, not in an attachment', () => {
  const job = buildTransferSfJob(SETTINGS, DOC);
  assert.match(job.description, /BUILD THIS:/);
  assert.match(job.description, /20 cases of 3G6141 CABLE CAR LEMON LIME/);
  assert.match(job.description, /2 cases of 3G6121 HANGAR 25 COLA/);
  assert.match(job.description, /Pull from: Brix Warehouse/);
  assert.match(job.description, /Deliver to: Natural Wave/);
  // Completing the ticket is what advances the process, so the ticket has to
  // say so — the tech is the person who triggers the next email.
  assert.match(job.description, /Complete this ticket/);
  assert.equal(job.customer_name, 'BRIX BEVERAGE - SAMPLING');
  assert.equal(job.status, 'Unscheduled');
  assert.equal(job.category, 'Product Transfer Ticket');
  assert.equal(job.po_number, 'BOL-2026-00011');
});

test('whatToBuild rounds to whole units — a tech cannot pick 19.6 cases', () => {
  assert.deepEqual(whatToBuild([{ qty: 19.6, description: 'ROOT BEER' }]), ['20 cases of ROOT BEER']);
});

test('a category Service Fusion does not have loses the LABEL, never the ticket', async () => {
  const calls = [];
  // Stand in for SF: 422 on anything carrying `category`, accept otherwise.
  const post = async (body) => {
    calls.push({ ...body });
    if (body.category) throw new Error('SF 422: {"category":"Category can not be found by given value"}');
    return { id: 42, number: 'J-42', status: 'Unscheduled' };
  };
  const r = await createTransferSfJob(buildTransferSfJob(SETTINGS, DOC), post);
  assert.equal(r.job.id, 42, 'the ticket must still be created');
  assert.match(r.warning, /category/i, 'and somebody must be told which field was dropped');
  assert.equal(calls.length, 2, 'exactly one retry — not a loop');
  assert.equal(calls[1].category, undefined);
  assert.equal(calls[1].description, calls[0].description, 'the instruction survives the retry');
});

test('the 422 ladder drops the field SF NAMED, not the first one it has', async () => {
  const calls = [];
  const post = async (body) => {
    calls.push({ ...body });
    if (body.po_number) throw new Error('SF 422: PO Number is too long');
    return { id: 7, status: 'Unscheduled' };
  };
  const r = await createTransferSfJob(buildTransferSfJob(SETTINGS, DOC), post);
  assert.equal(r.job.id, 7);
  // The category is the field an operator has to fix in SF Settings, so
  // dropping it when SF complained about something else would send them
  // hunting the wrong setting.
  assert.equal(calls[1].category, 'Product Transfer Ticket', 'the category must survive');
  assert.equal(calls[1].po_number, undefined);
});

test('a non-422 failure is NOT retried away — an outage must be visible', async () => {
  let calls = 0;
  const post = async () => { calls += 1; throw new Error('SF 500: upstream exploded'); };
  await assert.rejects(() => createTransferSfJob(buildTransferSfJob(SETTINGS, DOC), post), /500/);
  assert.equal(calls, 1);
});

test('the tech finishing the ticket is what the poll looks for', () => {
  for (const s of ['Completed', 'completed - service', 'Invoiced', 'Closed', 'DONE']) {
    assert.equal(sfJobLooksComplete({ status: s }), true, s);
  }
  for (const s of ['Unscheduled', 'Scheduled', 'In Progress', '', undefined]) {
    assert.equal(sfJobLooksComplete({ status: s }), false, String(s));
  }
});

// ── who hears ────────────────────────────────────────────────────────────────

test('a receiving location with no address falls back to the office, never to nobody', () => {
  assert.deepEqual(receivingRecipients({ contact_email: null }, SETTINGS), ['service@brixbev.com']);
  assert.deepEqual(receivingRecipients(undefined, SETTINGS), ['service@brixbev.com']);
  assert.deepEqual(
    receivingRecipients({ contact_email: 'a@x.com; b@x.com , ' }, SETTINGS),
    ['a@x.com', 'b@x.com'],
  );
});
