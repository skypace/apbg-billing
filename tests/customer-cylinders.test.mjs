/**
 * The two cylinder rules that can silently rot.
 *
 * A cylinder balance is DERIVED — the last BTRF rental invoice's printed "New
 * Balance", plus every delivery and minus every pickup invoiced since — and the
 * arithmetic itself lives in SQL (`ops.fn_customer_cylinders`), shared by
 * Refractor, BrixSD and the customer portal. What lives in TypeScript is how
 * the rows are SUMMARISED and how a below-zero row is EXPLAINED, and both are
 * the kind of thing a later edit tidies into being wrong.
 *
 * The fixtures are real live shapes, not invented ones: THE MELT MAIN's chain
 * (tanks at the stores, none on its own record) and the two flavours of
 * negative row that exist across 66 customers today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise, oddReason } from '../.test-build/customerCylinders.mjs';

const row = (o) => ({
  qbo_customer_id: '1', customer_name: 'X', is_sub: false, label: '20LB CO2',
  on_hand: 0, balance_at_btrf: 0, deliveries_since: 0, pickups_since: 0,
  btrf_doc_number: null, btrf_date: null, last_activity: null,
  unit_price: 7.5, monthly_rent: 0, ...o,
});

test('the total counts what is OUT, never the sum of every row', () => {
  /* ⚠ Load-bearing. A chain with −6 at one store and 6 at another must not
     report zero out while twelve cylinders sit on somebody's floor. Live:
     THE MELT (STANFORD) is −6 while WEST HOLLYWOOD holds 16. */
  const s = summarise([
    row({ on_hand: 16, monthly_rent: 120, qbo_customer_id: '2' }),
    row({ on_hand: -6, qbo_customer_id: '3' }),
  ]);
  assert.equal(s.out, 16);
  assert.equal(s.odd, 1);
});

test('a settled gas adds nothing to the total but is still a row', () => {
  const s = summarise([row({ on_hand: 0 }), row({ on_hand: 3, monthly_rent: 45, label: '50LB CO2' })]);
  assert.equal(s.out, 3);
  assert.equal(s.rows.length, 2);
  assert.equal(s.odd, 0);
});

test('rent counts only what is out', () => {
  /* A negative row's monthly_rent is already floored at 0 in SQL; this is the
     second guard, because a future edit could stop flooring it there. */
  const s = summarise([
    row({ on_hand: 4, monthly_rent: 30 }),
    row({ on_hand: -2, monthly_rent: 99 }),
  ]);
  assert.equal(s.monthly, 30);
});

test('rent survives PostgREST returning numerics as strings', () => {
  /* ⚠ `numeric` comes back as a STRING over PostgREST, so a bare + would
     concatenate: "0" + "30.00" + "45.00" = "030.0045.00". */
  const s = summarise([
    row({ on_hand: 4, monthly_rent: '30.00' }),
    row({ on_hand: 3, monthly_rent: '45.00' }),
  ]);
  assert.equal(s.monthly, 75);
});

test('stores are counted apart from the account itself', () => {
  const s = summarise([
    row({ on_hand: 1, is_sub: false }),
    row({ on_hand: 3, is_sub: true, customer_name: 'THE MELT (BREA)' }),
    row({ on_hand: 2, is_sub: true, customer_name: 'THE MELT (LA JOLLA)' }),
  ]);
  assert.equal(s.atSubs, 2);
  assert.equal(s.out, 6);
});

test('an empty account summarises to nothing rather than throwing', () => {
  const s = summarise([]);
  assert.deepEqual([s.out, s.monthly, s.odd, s.atSubs, s.lastActivity], [0, 0, 0, 0, null]);
});

test('lastActivity is the newest across every row', () => {
  const s = summarise([
    row({ last_activity: '2026-05-11' }),
    row({ last_activity: '2026-08-24' }),
    row({ last_activity: null }),
  ]);
  assert.equal(s.lastActivity, '2026-08-24');
});

test('a positive row has no reason to explain', () => {
  assert.equal(oddReason(row({ on_hand: 4 })), null);
  assert.equal(oddReason(row({ on_hand: 0 })), null);
});

test('the two causes of a negative are NAMED APART', () => {
  /* ⚠ This is the whole point of returning btrf_doc_number: its ABSENCE is the
     diagnostic. 52 of the 74 negative rows live have no anchor — we have never
     rent-billed that gas, so the count has no floor and the fix is to put it on
     the rental programme. The other 22 went below a real printed balance, and
     the fix is to find the mis-keyed pickup. One shared message sends both to
     the same wrong place. */
  const anchored = oddReason(row({ on_hand: -2, btrf_doc_number: 'BTRF-0326-1785' }));
  const unanchored = oddReason(row({ on_hand: -1, btrf_doc_number: null }));

  assert.match(anchored, /more picked up than delivered since BTRF-0326-1785/);
  assert.match(unanchored, /never rent-billed/);
  assert.notEqual(anchored, unanchored);
});

test('a negative is described in magnitude, never as a minus sign', () => {
  /* "−6 tanks" is not something a technician can act on. */
  const why = oddReason(row({ on_hand: -6, btrf_doc_number: 'BTRF-0326-1785' }));
  assert.match(why, /^6 more/);
  assert.ok(!why.includes('-6') && !why.includes('−6'), why);
});
