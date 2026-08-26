// Ask QuickBooks which of our posted bills have actually been paid.
//
// Brixpense only knows about payments IT made. A cheque written in QuickBooks,
// a QBO Bill Pay run, a card the bookkeeper keyed — none of that reaches us,
// so the bill sits in ops.v_ap_aging forever and keeps offering a Pay button
// for money that already left. QuickBooks holds that fact and nothing we
// mirror carries it (ops.qbo_expense_lines is line-level, no header balance).
//
// Two batched queries per run, both bounded by our own unpaid list:
//   1. Bill        — Balance is the answer. 0 means paid.
//   2. BillPayment — only for the bills that came back paid, to get the REAL
//                    payment date. Stamping "now" on a bill paid in June would
//                    quietly corrupt every future aging or history read, and a
//                    second batched query is cheap insurance against that.

import { qboQuery } from '../qbo-helpers.mjs';
import { ops } from './vendor-onboard-lib.mjs';

// QBO caps a query IN list; keep batches well under any practical limit and
// short enough that one bad id cannot poison a large batch.
export const BATCH = 30;

export function chunk(arr, n = BATCH) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** QBO ids are digits. Anything else never reaches a query string. */
export function safeIds(ids) {
  return [...new Set((ids || []).map((v) => String(v || '').trim()))]
    .filter((v) => /^\d+$/.test(v));
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** Balance for each bill id we asked about. A bill QBO does not return is
 *  ABSENT from the map — the caller must treat that as "gone", never "paid". */
export async function fetchBillBalances(ids) {
  const out = new Map();
  for (const group of chunk(safeIds(ids))) {
    if (!group.length) continue;
    const res = await qboQuery(
      `SELECT Id, Balance, TotalAmt, DocNumber, TxnDate FROM Bill WHERE Id IN (${group.map((i) => `'${i}'`).join(',')})`,
    );
    for (const b of asArray(res?.QueryResponse?.Bill)) {
      // Balance can legitimately be 0, so an `|| null` here would read every
      // paid bill as unknown — exactly backwards. Only undefined/null is unknown.
      const bal = b?.Balance;
      out.set(String(b.Id), {
        balance: bal === undefined || bal === null ? null : Number(bal),
        total: b?.TotalAmt === undefined ? null : Number(b.TotalAmt),
        docNumber: b?.DocNumber ?? null,
      });
    }
  }
  return out;
}

/** Latest BillPayment date per bill id, from the payments that link to them.
 *  Best effort: a failure here costs a precise date, never the paid finding. */
export async function fetchPaymentDates(billIds) {
  const out = new Map();
  const ids = safeIds(billIds);
  if (!ids.length) return out;
  try {
    for (const group of chunk(ids)) {
      const res = await qboQuery(
        `SELECT Id, TxnDate, Line FROM BillPayment WHERE Line.LinkedTxn.TxnId IN (${group.map((i) => `'${i}'`).join(',')})`,
      );
      for (const p of asArray(res?.QueryResponse?.BillPayment)) {
        for (const line of asArray(p?.Line)) {
          for (const lt of asArray(line?.LinkedTxn)) {
            if (lt?.TxnType !== 'Bill' || !lt?.TxnId) continue;
            const key = String(lt.TxnId);
            const prev = out.get(key);
            // Several payments can settle one bill; the LAST one is when it
            // actually became paid.
            if (!prev || String(p.TxnDate) > String(prev.date)) {
              out.set(key, { date: p.TxnDate, billPaymentId: String(p.Id) });
            }
          }
        }
      }
    }
  } catch {
    /* a missing date is survivable; a missed payment is not */
  }
  return out;
}

/** Decide what to write for one bill, given what QBO said.
 *  Pure — the whole decision table lives here so it can be tested without QBO.
 *
 *  paid     → balance is exactly 0
 *  partial  → 0 < balance < total: still owed, so NOT paid. Recording it as
 *             paid would drop a real payable out of the aging view.
 *  missing  → QBO did not return the bill. Deleted or voided there. We know it
 *             is gone; we do NOT know it was paid, so paid_at stays null.
 */
export function decide(row, seen, payment) {
  const now = new Date().toISOString();
  if (!seen) {
    return { outcome: 'missing', patch: { qbo_balance: null, qbo_checked_at: now } };
  }
  const balance = seen.balance;
  if (balance === null) {
    return { outcome: 'unknown', patch: { qbo_balance: null, qbo_checked_at: now } };
  }
  if (balance > 0) {
    return { outcome: balance < Number(seen.total ?? Infinity) ? 'partial' : 'open',
             patch: { qbo_balance: balance, qbo_checked_at: now } };
  }
  return {
    outcome: 'paid',
    patch: {
      qbo_balance: 0,
      qbo_checked_at: now,
      paid_at: payment?.date ? `${payment.date}T12:00:00Z` : now,
      payment_method: 'quickbooks',
      ...(payment?.billPaymentId ? { qbo_billpayment_id: payment.billPaymentId } : {}),
    },
  };
}

// A cap so one run can never become an unbounded QBO crawl if the unpaid list
// grows unexpectedly. The rest are picked up next run — ordering by
// qbo_checked_at NULLS FIRST puts the never-checked at the front.
const MAX_PER_RUN = 300;

/** The whole run. Shared by the manual endpoint and the daily cron so the two
 *  cannot drift — the cron is a schedule, not a second implementation. */
export async function runBillPaidSync() {
  const startedAt = new Date().toISOString();
  const out = { checked: 0, paid: 0, partial: 0, still_open: 0, missing: 0, errors: [] };

  try {
    // Bills ONLY (as_bill=true). A posted Purchase was paid at posting and its
    // qbo_bill_id is a Purchase id — the Bill query below can never find it,
    // so including them flagged every posted Purchase as "QuickBooks no longer
    // returns this" (20 false positives / $21.6k on 2026-08-26).
    const rows = await ops('GET',
      'expense_requests?select=id,qbo_bill_id,vendor_name,total_amount'
      + '&qbo_bill_id=not.is.null&paid_at=is.null&archived_at=is.null&as_bill=eq.true'
      + `&order=qbo_checked_at.asc.nullsfirst&limit=${MAX_PER_RUN}`);

    const live = (rows || []).filter((r) => r.qbo_bill_id);
    if (live.length) {
      const balances = await fetchBillBalances(live.map((r) => r.qbo_bill_id));

      // Only bills that came back at zero need a payment date looked up.
      const paidIds = live
        .map((r) => String(r.qbo_bill_id))
        .filter((id) => balances.get(id)?.balance === 0);
      const payments = await fetchPaymentDates(paidIds);

      for (const r of live) {
        const id = String(r.qbo_bill_id);
        const { outcome, patch } = decide(r, balances.get(id), payments.get(id));
        try {
          await ops('PATCH', `expense_requests?id=eq.${r.id}`, patch);
          out.checked += 1;
          if (outcome === 'paid') out.paid += 1;
          else if (outcome === 'partial') out.partial += 1;
          else if (outcome === 'missing') out.missing += 1;
          else out.still_open += 1;
        } catch (e) {
          out.errors.push(`${r.vendor_name || r.id}: ${String(e.message || e).slice(0, 120)}`);
        }
      }
    }
  } catch (e) {
    out.errors.push(String(e.message || e).slice(0, 300));
  }

  // The watcher reads this row. Wrapped because a logging hiccup must not fail
  // a run — but note ops.sync_log.source carries a CHECK allow-list and
  // 'brixpense' is on it (migration 20260823060546). A source that is NOT on
  // that list is rejected SILENTLY, which is how two other monitors sat
  // permanently green. Extend the list in the same change that adds a writer.
  try {
    await ops('POST', 'sync_log', {
      source: 'brixpense',
      sync_type: 'bill_paid_sync',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status: out.errors.length ? 'error' : 'success',
      records_synced: out.checked,
      error_message: out.errors.length ? out.errors.join(' | ').slice(0, 400) : null,
      metadata: {
        paid: out.paid, partial: out.partial,
        still_open: out.still_open, missing: out.missing,
      },
    });
  } catch { /* never fail a run over its own log row */ }

  return out;
}
