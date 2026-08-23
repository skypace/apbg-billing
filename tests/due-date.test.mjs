// The due-date logic exists three times — in Postgres (ops.fn_due_date_from_terms),
// in the Netlify functions (lib/due-date.mjs) and in the browser (app-expense
// src/lib/dueDate.ts). This pins the two JS copies to one table of cases, and
// the SQL copy is verified against the same table when the migration is applied.
//
// The `2/10 Net 30` case is here because the first version of all three got it
// wrong in the same way: it read the discount percent as the term and made
// every discount-terms bill due two days after the invoice date.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dueDateFromTerms, resolveDueDate } from '../netlify/functions/lib/due-date.mjs';

const INVOICE = '2026-08-01';

const CASES = [
  ['Net 30',          '2026-08-31'],
  ['net30',           '2026-08-31'],
  ['NET 30',          '2026-08-31'],
  ['Net 45',          '2026-09-15'],
  ['30 days',         '2026-08-31'],
  ['15',              '2026-08-16'],
  ['Due on receipt',  '2026-08-01'],
  ['Due upon receipt','2026-08-01'],
  ['COD',             '2026-08-01'],
  ['Prepaid',         '2026-08-01'],
  ['Net 30 EOM',      '2026-09-30'],
  ['EOM',             '2026-08-31'],
  ['2/10 Net 30',     '2026-08-31'],   // discount percent must not win
  ['1% 15 Net 45',    '2026-09-15'],
  ['whenever',        null],
  ['',                null],
  ['Net 9999',        null],           // not a term, a typo
];

test('terms resolve to the same date in every copy', () => {
  for (const [terms, want] of CASES) {
    assert.equal(dueDateFromTerms(INVOICE, terms), want, `terms: ${JSON.stringify(terms)}`);
  }
});

test('no invoice date means no due date, whatever the terms say', () => {
  assert.equal(dueDateFromTerms(null, 'Net 30'), null);
  assert.equal(dueDateFromTerms('', 'Net 30'), null);
  assert.equal(dueDateFromTerms('not-a-date', 'Net 30'), null);
});

test('a printed due date beats one derived from terms', () => {
  // The vendor's own answer is the one that gets argued about, so it wins even
  // when it disagrees with their own stated terms.
  assert.deepEqual(
    resolveDueDate({ printed: '2026-09-15', invoiceDate: INVOICE, terms: 'Net 30' }),
    { due_date: '2026-09-15', due_date_source: 'printed' },
  );
  assert.deepEqual(
    resolveDueDate({ invoiceDate: INVOICE, terms: 'Net 30' }),
    { due_date: '2026-08-31', due_date_source: 'terms' },
  );
  assert.deepEqual(
    resolveDueDate({ invoiceDate: INVOICE, terms: 'call me' }),
    { due_date: null, due_date_source: null },
  );
});

test('a malformed printed date is ignored rather than stored', () => {
  // OCR occasionally returns "30 days" or "N/A" in a date field. Storing that
  // would make every aging query fail on one row.
  assert.deepEqual(
    resolveDueDate({ printed: '30 days', invoiceDate: INVOICE, terms: 'Net 30' }),
    { due_date: '2026-08-31', due_date_source: 'terms' },
  );
});

test('the browser copy is the same function as the server copy', () => {
  // Not an import — the client copy is TypeScript inside the Vite app. This
  // reads it and checks the parts that actually decide the answer, so the two
  // cannot silently diverge without this failing.
  const client = readFileSync(
    new URL('../app-expense/src/lib/dueDate.ts', import.meta.url), 'utf8',
  );
  for (const marker of [
    'due on receipt|due upon receipt|receipt|^cod$|cash on delivery|prepaid|^due now',
    'net\\s*(\\d{1,3})',
    'eom|end of month|prox',
    'n > 365',
  ]) {
    assert.ok(client.includes(marker), `client dueDate.ts lost: ${marker}`);
  }
});
