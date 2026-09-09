/**
 * Cylinders on the Refractor customer page.
 *
 * Ask (Sky, 2026-09-09): "We need to make sure cylinder count is on the
 * dispatch just echo'd and on refractor as well so that both sides can see
 * whats happening with customer cylinders."
 *
 * ⚠ A CYLINDER BALANCE IS DERIVED, NOT STORED, so "echo it" cannot mean copying
 * a number. There is no tank table anywhere in this estate: the count is the
 * last `BTRF-*` rental invoice's printed "New Balance", plus every delivery and
 * minus every pickup invoiced since, classified off the QuickBooks item name.
 * What is shared is the ARITHMETIC, and it lives once — `ops.fn_customer_cylinders`
 * (`20260909f`) — read here, by BrixSD's customer page and by the customer
 * portal. There is deliberately no maths in this file.
 *
 * ⚠ NO CHAIN LOGIC HERE EITHER. The equipment card resolves sub-customers
 * itself because it queries a VIEW; this is a function, and it rolls the chain
 * up server-side off the same `ops.qbo_customers.parent_ref_id` link. Doing it
 * again in TypeScript would be a second definition of which customers count.
 */
import { sbrpc } from './rpc';

/** One gas at one customer. `on_hand` is the answer; the three numbers under
 *  it are the working, so a figure computed from hundreds of invoice lines can
 *  be checked rather than merely trusted. */
export type CylinderRow = {
  qbo_customer_id: string;
  customer_name: string | null;
  is_sub: boolean;
  label: string;
  on_hand: number;
  balance_at_btrf: number;
  deliveries_since: number;
  pickups_since: number;
  /** ⚠ Its ABSENCE is the diagnostic: no rental invoice for this gas means the
   *  count started from an assumed zero and has no floor. 52 of the 74 negative
   *  rows fleet-wide are that case, and it wants different work from the rest. */
  btrf_doc_number: string | null;
  btrf_date: string | null;
  last_activity: string | null;
  unit_price: number | string | null;
  monthly_rent: number | string | null;
};

export type CustomerCylinders = {
  rows: CylinderRow[];
  /** Tanks genuinely out. ⚠ Never the sum of every row — see `summarise`. */
  out: number;
  monthly: number;
  /** Rows whose count is below zero: a records problem, not a quantity. */
  odd: number;
  atSubs: number;
  lastActivity: string | null;
};

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0);

/**
 * ⚠ THE TOTAL COUNTS ONLY WHAT IS OUT, and that is load-bearing rather than
 * fussy. Summing every row lets a negative cancel real tanks — a chain with
 * −6 at one store and 6 at another would report zero out while twelve
 * cylinders are on somebody's floor.
 */
export function summarise(rows: CylinderRow[]): CustomerCylinders {
  const held = rows.filter((r) => r.on_hand > 0);
  return {
    rows,
    out: held.reduce((n, r) => n + r.on_hand, 0),
    monthly: held.reduce((n, r) => n + num(r.monthly_rent), 0),
    odd: rows.filter((r) => r.on_hand < 0).length,
    atSubs: rows.filter((r) => r.is_sub).length,
    lastActivity: rows.reduce<string | null>(
      (n, r) => (r.last_activity && (!n || r.last_activity > n) ? r.last_activity : n), null),
  };
}

/**
 * Why a row is below zero, in the words that decide what somebody does about
 * it. ⚠ The two cases are NOT collapsed: one is a gas we have never put on the
 * rental programme, the other is a pickup keyed below a real printed balance,
 * and sending both to the same place is how neither gets fixed.
 */
export function oddReason(r: CylinderRow): string | null {
  if (r.on_hand >= 0) return null;
  const n = Math.abs(r.on_hand);
  return r.btrf_doc_number
    ? `${n} more picked up than delivered since ${r.btrf_doc_number}`
    : `${n} picked up and never rent-billed — no rental invoice for this gas`;
}

/** ⚠ Digits only. The id goes to a SECURITY DEFINER function that answers for
 *  whichever customer it is handed; a value that is not a QuickBooks id is a
 *  question we should not be asking. Same guard, same reason, as the equipment
 *  card's `numericId`. */
const numericId = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^[0-9]+$/.test(s) ? s : null;
};

export async function fetchCustomerCylinders(qboCustomerId: string): Promise<CustomerCylinders> {
  const self = numericId(qboCustomerId);
  if (!self) throw new Error(`Not a QuickBooks customer id: ${qboCustomerId}`);
  const rows = await sbrpc<CylinderRow[]>('fn_customer_cylinders', {
    p_qbo_customer_id: self,
    p_include_subs: true,
  });
  return summarise(Array.isArray(rows) ? rows : []);
}
