// vendor-funding-lib.mjs — the Stripe funding float and the QBO Transfer that
// books it (Vendor Portal Phase 3b).
//
// THE BOOKKEEPING MODEL (Sky, 2026-08-20). The Stripe financial account is
// mirrored in QuickBooks as a BANK account, "Stripe Vendor Funding":
//
//   Chase 72  ──QBO Transfer──▶  Stripe Vendor Funding  ──BillPayment──▶ vendor
//
// Money in is a Transfer (the Chase bank feed shows the debit and you MATCH
// it). Every vendor payment is a BillPayment drawn on the funding account, so
// the register itemizes per vendor per bill. The funding account's QBO balance
// should therefore equal the live Stripe balance — that equality is the whole
// control, and drift means something real (money moved without booking, or a
// top-up nobody entered).
//
// WHY WE OWN THE TOP-UP. Stripe cannot auto-pull on a low balance: pulling
// from a verified bank account is US-only and explicitly manual per transfer
// ("it isn't an automated, regular transaction"), takes 2–6 business days, and
// is capped 50k/txn · 50k/day · 100k/week. So a threshold top-up has to be
// ours — and it ships OFF (`auto_top_up: false`), because money movement
// starts with a human here, same rule as the 2026-08-14 Brixpense full gate.
//
// Deliberately NOT used: Stripe's native recurring transfer from the payments
// balance. brix-order books Stripe payouts as QBO Deposits into Chase 72
// (sessions 1.80–1.83); diverting that revenue into the financial account
// would strand those Undeposited-Funds payments and break that reconciler.
//
// Env: STRIPE_PAYOUTS_KEY (needs Money Management → Inbound transfers: write
//      on top of the three Phase 3 scopes), STRIPE_FUNDING_BANK_ACCOUNT_ID
//      (the VERIFIED bank account id from Stripe → Settings → Global Payouts),
//      QBO_VENDOR_PAY_BANK_ACCOUNT_ID (the Stripe Vendor Funding QBO account),
//      QBO_FUNDING_SOURCE_ACCOUNT_ID (default 72, Chase Business Checking).

import { ops } from './vendor-onboard-lib.mjs';
import { qboRequest } from '../qbo-helpers.mjs';
import { stripeV2, getFinancialAccount } from './stripe-payouts.mjs';

export { ops, getFinancialAccount };

// Stripe's own published pull limits — we refuse over them locally so the
// operator gets a sentence instead of a Stripe error.
export const STRIPE_PULL_MAX_PER_TXN = 50_000;
export const SETTLEMENT_DAYS = '2–6 business days';

const DEFAULTS = { floor: 2500, target: 10000, auto_top_up: false, max_per_day: 10000 };

export function fundingBankAccountId() {
  return process.env.STRIPE_FUNDING_BANK_ACCOUNT_ID || '';
}

/** Config lives on ops.expense_settings key 'vendor_funding' (no new table).
 *  A missing/garbled row degrades to DEFAULTS — never to "unlimited". */
export async function readConfig() {
  try {
    const rows = await ops('GET', 'expense_settings?key=eq.vendor_funding&select=value');
    const v = rows && rows[0] && rows[0].value;
    if (!v || typeof v !== 'object') return { ...DEFAULTS };
    return {
      floor: Number(v.floor) >= 0 ? Number(v.floor) : DEFAULTS.floor,
      target: Number(v.target) > 0 ? Number(v.target) : DEFAULTS.target,
      auto_top_up: v.auto_top_up === true,
      max_per_day: Number(v.max_per_day) > 0 ? Number(v.max_per_day) : DEFAULTS.max_per_day,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeConfig(patch) {
  const current = await readConfig();
  const next = {
    floor: patch.floor === undefined ? current.floor : Math.max(0, Number(patch.floor) || 0),
    target: patch.target === undefined ? current.target : Math.max(1, Number(patch.target) || 1),
    auto_top_up: patch.auto_top_up === undefined ? current.auto_top_up : patch.auto_top_up === true,
    max_per_day: patch.max_per_day === undefined ? current.max_per_day
      : Math.min(STRIPE_PULL_MAX_PER_TXN, Math.max(1, Number(patch.max_per_day) || 1)),
  };
  if (next.target <= next.floor) throw new Error('The top-up target must be higher than the floor.');
  await ops('POST', 'expense_settings', { key: 'vendor_funding', value: next },
    { Prefer: 'resolution=merge-duplicates' });
  return next;
}

// ── Stripe side ─────────────────────────────────────────────────────────────

const centsToDollars = (c) => Math.round(Number(c || 0)) / 100;

/** Stripe status vocabularies differ per object; normalise to our four. */
function normaliseStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (['succeeded', 'posted', 'settled', 'available', 'credited'].includes(s)) return 'settled';
  if (['failed', 'returned'].includes(s)) return 'failed';
  if (['canceled', 'cancelled'].includes(s)) return 'canceled';
  return 'pending';
}

function amountOf(obj) {
  const a = obj?.amount;
  if (a && typeof a === 'object') return centsToDollars(a.value);
  return centsToDollars(a);
}

/** Every funding event Stripe knows about, newest first, normalised.
 *  Reads BOTH objects: our pulls are InboundTransfers, while a Dashboard
 *  top-up or a pushed ACH/wire lands as a ReceivedCredit — both must book. */
export async function listFundingEvents({ limit = 50 } = {}) {
  const out = [];
  for (const [path, kind] of [
    ['/v2/money_management/inbound_transfers', 'inbound_transfer'],
    ['/v2/money_management/received_credits', 'received_credit'],
  ]) {
    try {
      const res = await stripeV2('GET', `${path}?limit=${Math.min(100, limit)}`);
      for (const o of res?.data || []) {
        if (!o?.id) continue;
        out.push({
          stripe_object_id: o.id,
          kind,
          amount: amountOf(o),
          currency: String(o?.amount?.currency || 'usd').toUpperCase(),
          status: normaliseStatus(o.status),
          stripe_created_at: o.created || o.created_at || null,
          failure_reason: o?.status_details?.failed?.reason
            || o?.status_details?.returned?.reason
            || o?.failure_reason || null,
        });
      }
    } catch (e) {
      // One object type unavailable (preview surface, or the key lacks the
      // scope) must not blind us to the other.
      console.warn(`[vendor-funding] listing ${kind} failed: ${e.message}`);
    }
  }
  return out.filter((e) => e.amount > 0)
    .sort((a, b) => String(b.stripe_created_at || '').localeCompare(String(a.stripe_created_at || '')));
}

/** Pull money from the verified bank account into the financial account.
 *  Amount in DOLLARS. Stripe settles it in 2–6 business days. */
export async function createInboundTransfer({ amount, description }) {
  const bank = fundingBankAccountId();
  if (!bank) {
    throw new Error('No verified Stripe bank account configured — add + verify one in Stripe → Settings → Global Payouts, then set STRIPE_FUNDING_BANK_ACCOUNT_ID on this site.');
  }
  if (!(Number(amount) > 0)) throw new Error('Amount must be positive.');
  if (Number(amount) > STRIPE_PULL_MAX_PER_TXN) {
    throw new Error(`Stripe caps a single pull at $${STRIPE_PULL_MAX_PER_TXN.toLocaleString()}.`);
  }
  const fa = await getFinancialAccount();
  const res = await stripeV2('POST', '/v2/money_management/inbound_transfers', {
    to: { financial_account: fa.id, currency: 'usd' },
    from: { payment_method: bank, currency: 'usd' },
    amount: { value: Math.round(Number(amount) * 100), currency: 'usd' },
    ...(description ? { description: String(description).slice(0, 100) } : {}),
  });
  if (!res?.id) throw new Error('Stripe did not return an inbound transfer id');
  return { id: res.id, status: normaliseStatus(res.status), financial_account: fa.id };
}

// ── QuickBooks side ─────────────────────────────────────────────────────────

/** Chase → Stripe Vendor Funding, as a real QBO Transfer. Returns its id.
 *  Refuses rather than guessing when the funding account isn't configured —
 *  booking this against Chase would make the transfer a no-op (same account
 *  both sides) and quietly break the reconciliation the account exists for. */
export async function recordQboTransfer({ amount, date, memo }) {
  const to = process.env.QBO_VENDOR_PAY_BANK_ACCOUNT_ID || '';
  const from = process.env.QBO_FUNDING_SOURCE_ACCOUNT_ID || '72';
  if (!to) {
    throw new Error('QBO_VENDOR_PAY_BANK_ACCOUNT_ID is not set — create the "Stripe Vendor Funding" bank account in QuickBooks and set its id, otherwise this transfer has nowhere to land.');
  }
  if (String(to) === String(from)) {
    throw new Error(`QBO_VENDOR_PAY_BANK_ACCOUNT_ID (${to}) is the same account as the funding source — point it at the Stripe Vendor Funding account, not Chase.`);
  }
  const payload = {
    Amount: Number(amount),
    FromAccountRef: { value: String(from) },
    ToAccountRef: { value: String(to) },
    ...(date ? { TxnDate: String(date).slice(0, 10) } : {}),
    ...(memo ? { PrivateNote: String(memo).slice(0, 4000) } : {}),
  };
  const res = await qboRequest('POST', '/transfer', payload);
  const id = res?.Transfer?.Id;
  if (!id) throw new Error('QBO did not return a Transfer id');
  return String(id);
}

// ── Ledger ──────────────────────────────────────────────────────────────────

export async function insertEvent(row) {
  const created = await ops('POST', 'vendor_funding_events', row, { Prefer: 'return=representation' });
  return created && created[0];
}

export async function patchEvent(id, patch) {
  await ops('PATCH', `vendor_funding_events?id=eq.${id}`, patch);
}

export async function eventByStripeId(stripeObjectId) {
  const rows = await ops('GET',
    `vendor_funding_events?select=*&stripe_object_id=eq.${encodeURIComponent(stripeObjectId)}&limit=1`);
  return rows && rows[0];
}

export async function recentEvents(limit = 20) {
  return await ops('GET',
    `vendor_funding_events?select=*&order=created_at.desc&limit=${Math.min(100, Number(limit) || 20)}`);
}

/** Settled funding QuickBooks hasn't been told about yet. */
export async function unbookedEvents() {
  return await ops('GET',
    'vendor_funding_events?select=*&status=eq.settled&qbo_transfer_id=is.null&order=created_at.asc&limit=50');
}

/** Dollars we ourselves pulled today — the cap guard. Excludes failures and
 *  anything initiated outside the app (a Dashboard top-up isn't our budget). */
export async function pulledToday() {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const rows = await ops('GET',
    `vendor_funding_events?select=amount&kind=eq.inbound_transfer&source=eq.app`
    + `&status=in.(pending,settled)&created_at=gte.${since.toISOString()}`);
  return (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0);
}

// ── The reconciler ──────────────────────────────────────────────────────────

/** Pull Stripe's funding events into the ledger and book the settled ones to
 *  QuickBooks. Shared by the `sync` action and the daily cron.
 *
 *  Ordering matters: an event is INSERTED before it is booked, and the QBO
 *  Transfer id is stamped immediately after the write. A crash between the two
 *  leaves the row unbooked (visible, retried, and red after 24h) — never
 *  double-booked, because a second pass finds the row already carrying an id. */
export async function syncFunding({ actor = 'sync' } = {}) {
  const result = { seen: 0, inserted: 0, updated: 0, booked: 0, errors: [] };
  const events = await listFundingEvents({ limit: 50 });
  result.seen = events.length;

  for (const e of events) {
    try {
      const existing = await eventByStripeId(e.stripe_object_id);
      if (!existing) {
        // Anything we didn't initiate arrived from the Dashboard or a bank push.
        await insertEvent({
          stripe_object_id: e.stripe_object_id,
          kind: e.kind,
          source: e.kind === 'inbound_transfer' ? 'dashboard' : 'external',
          amount: e.amount,
          currency: e.currency,
          status: e.status,
          stripe_created_at: e.stripe_created_at,
          failure_reason: e.failure_reason,
          initiated_by: `${actor} (discovered in Stripe)`,
        });
        result.inserted++;
      } else if (existing.status !== e.status) {
        await patchEvent(existing.id, {
          status: e.status,
          failure_reason: e.failure_reason || existing.failure_reason,
        });
        result.updated++;
      }
    } catch (err) {
      result.errors.push(`${e.stripe_object_id}: ${String(err.message || err).slice(0, 140)}`);
    }
  }

  // A `pending:` placeholder means we inserted the row and then never got a
  // Stripe id back onto it (a crash between the two writes). After a day it is
  // stale bookkeeping noise, not a real pending transfer: retire it as
  // canceled — deliberately NOT failed, because the pull may well have gone
  // through and the sync above will have filed the real object separately.
  try {
    const stale = await ops('GET',
      'vendor_funding_events?select=id,amount&stripe_object_id=like.pending:*'
      + `&created_at=lt.${new Date(Date.now() - 86_400_000).toISOString()}&status=eq.pending&limit=20`);
    for (const row of stale || []) {
      await patchEvent(row.id, {
        status: 'canceled',
        failure_reason: 'never received a Stripe transfer id — check Stripe for a $' + row.amount + ' pull on this date',
      });
      result.retired = (result.retired || 0) + 1;
    }
  } catch { /* housekeeping only — never fails a run */ }

  // Book every settled event QuickBooks hasn't seen. A booking failure is
  // recorded on the row and retried next run — the money is already in Stripe,
  // so the honest state is "funded, not yet booked", not "didn't happen".
  for (const row of (await unbookedEvents()) || []) {
    try {
      const transferId = await recordQboTransfer({
        amount: row.amount,
        date: (row.stripe_created_at || row.created_at || '').slice(0, 10) || undefined,
        memo: `Stripe vendor funding — ${row.kind === 'inbound_transfer' ? 'pull from bank' : 'deposit into Stripe'} ${row.stripe_object_id}`,
      });
      await patchEvent(row.id, {
        qbo_transfer_id: transferId,
        qbo_booked_at: new Date().toISOString(),
        book_error: null,
      });
      result.booked++;
    } catch (err) {
      const msg = String(err.message || err).slice(0, 400);
      result.errors.push(`book ${row.stripe_object_id}: ${msg.slice(0, 140)}`);
      try { await patchEvent(row.id, { book_error: msg }); } catch { /* the >24h red rule still catches it */ }
    }
  }
  return result;
}
