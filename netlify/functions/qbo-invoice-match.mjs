import { qboQuery } from './qbo-helpers.mjs';

/**
 * Scan an invoice's DocNumber, notes, and line descriptions for a job
 * number. Mirrors the logic in approve-bill.mjs — Service Fusion writes
 * job IDs into DescriptionOnly lines, so we must scan every line.
 */
export function invoiceContainsJob(inv, jobStr) {
  if (!jobStr) return false;
  if (inv.DocNumber && inv.DocNumber.includes(jobStr)) return true;
  if (inv.PrivateNote && inv.PrivateNote.includes(jobStr)) return true;
  if (inv.CustomerMemo?.value && inv.CustomerMemo.value.includes(jobStr)) return true;
  if (Array.isArray(inv.Line)) {
    for (const line of inv.Line) {
      const desc = line.Description || '';
      if (desc.includes(jobStr)) return true;
    }
  }
  return false;
}

/**
 * Search QBO for an invoice that references the given job number.
 * Strategy: try the selected customer first, then broaden to all
 * invoices in the last 6 months. Returns the first matching Invoice
 * object or null.
 */
export async function findMatchingInvoice(jobNumber, customerId) {
  const jobStr = String(jobNumber || '').trim();
  if (!jobStr) return null;

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const dateFilter = sixMonthsAgo.toISOString().slice(0, 10);

  const queries = [];
  if (customerId) {
    queries.push(
      `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' ORDERBY TxnDate DESC MAXRESULTS 200`,
    );
  }
  queries.push(
    `SELECT * FROM Invoice WHERE TxnDate >= '${dateFilter}' ORDERBY TxnDate DESC MAXRESULTS 500`,
  );

  for (const q of queries) {
    try {
      const result = await qboQuery(q);
      const invoices = result.QueryResponse?.Invoice || [];
      for (const inv of invoices) {
        if (invoiceContainsJob(inv, jobStr)) return inv;
      }
    } catch (e) {
      console.warn('qbo-invoice-match: query failed:', e?.message);
    }
  }
  return null;
}

export function computeMargin(invoiceTotal, billTotal) {
  const iTot = Number(invoiceTotal) || 0;
  const bTot = Number(billTotal) || 0;
  const margin = iTot - bTot;
  const marginPct = iTot > 0 ? (margin / iTot) * 100 : 0;
  return {
    margin: Math.round(margin * 100) / 100,
    marginPct: Math.round(marginPct * 100) / 100,
  };
}

export function summarizeInvoice(inv) {
  if (!inv) return null;
  return {
    id: inv.Id,
    number: inv.DocNumber || inv.Id,
    customerName: inv.CustomerRef?.name || null,
    total: Number(inv.TotalAmt) || 0,
  };
}
