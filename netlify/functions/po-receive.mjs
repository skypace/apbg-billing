// /api/po-receive — receiving a purchase order creates the QuickBooks bill.
//
// ASK (Sky, 2026-09-04): "receive creates the bill. the bill can get matched
// to the invoice in brixpense."
//
//   POST { action:'create', po_id, lines:[{po_line_id, qty}],
//          vendor_invoice_number?, invoice_date?, notes? }
//   POST { action:'retry', receipt_id }      — a receipt whose bill failed
//
// ORDER OF OPERATIONS, and why:
//   1. ops.fn_po_receipt_record — under the CALLER's JWT. The stock ledger
//      moves here (through the same fn_receive_purchase_order_line__i that has
//      always written receipts) and ops.po_receipts gets its row. This is the
//      record; everything after it is bookkeeping that can be retried.
//   2. If the PO is not in QuickBooks yet (a native PO nobody pushed), it is
//      pushed first — a Bill can only link to a PO QuickBooks has.
//   3. POST /bill with every line LinkedTxn'd to the PO (and its line id when
//      we hold one) — QuickBooks marks the PO received/closed itself, so a PO
//      received here and one received inside QuickBooks end in the same state.
//   4. ops.fn_po_receipt_bill_landed — files the Brixpense row as POSTED with
//      the bill id: it is in the books; the vendor's invoice is what is still
//      to come, and Brixpense's duplicate gate (same vendor, same amount within
//      10 days) is what flags that invoice against this bill when it arrives.
//   5. Best-effort: mirror the bill's lines, refresh the items' QtyOnHand, and
//      re-read the PO so the mirror shows what QuickBooks now says.
// A failure at 3 stamps qbo_error on the receipt and returns 502 WITH the
// receipt id — the ledger already moved, the sheet is not lost, the PO shows a
// Retry, and fn_purchase_feed_health goes red after an hour unbilled.
//
// The purchase feed does not double-count this bill: v_purchase_ledger_pending
// excludes any Bill whose id is on a po_receipts row.

import { requireAuth } from './lib/auth.mjs';
import { qboRequest } from './qbo-helpers.mjs';
import {
  ops, rpc, loadPoForQbo, pushPoCreate, buildBillFromReceipt, afterBillLanded,
} from './lib/qbo-purchasing-sync.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  return m ? m[1] : null;
}

/** Steps 2–5 for one receipt row. Throws on a QuickBooks refusal after stamping the receipt. */
async function billReceipt(receipt, bearer) {
  let { po, vendorName, itemNames } = await loadPoForQbo(receipt.po_id);
  if (!po.qbo_purchase_order_id) {
    const pushed = await pushPoCreate(receipt.po_id, bearer);
    ({ po, vendorName, itemNames } = await loadPoForQbo(receipt.po_id));
    if (!po.qbo_purchase_order_id && pushed?.qbo_purchase_order_id) po.qbo_purchase_order_id = pushed.qbo_purchase_order_id;
  }
  // line ids may have landed only now (first push) — re-read them onto the receipt lines
  if (po.qbo_purchase_order_id) {
    const lines = await ops('GET', `purchase_order_lines?select=id,qbo_line_id&po_id=eq.${receipt.po_id}`);
    const byId = Object.fromEntries((lines || []).map((l) => [l.id, l.qbo_line_id]));
    receipt.lines = (receipt.lines || []).map((l) => ({ ...l, qbo_line_id: l.qbo_line_id || byId[l.po_line_id] || null }));
  }
  const payload = buildBillFromReceipt({ receipt, po, vendorName, itemNames });
  let bill;
  try {
    const r = await qboRequest('POST', '/bill', payload);
    bill = r?.Bill;
    if (!bill?.Id) throw new Error('QuickBooks returned no Bill id: ' + JSON.stringify(r).slice(0, 200));
  } catch (e) {
    await rpc('fn_po_receipt_bill_failed', { p_receipt_id: receipt.id, p_error: e.message }, bearer).catch(() => {});
    throw e;
  }
  const landed = await rpc('fn_po_receipt_bill_landed', {
    p_receipt_id: receipt.id, p_qbo_bill_id: String(bill.Id), p_doc_number: bill.DocNumber || null,
  }, bearer);
  const notes = await afterBillLanded(bill, po.qbo_purchase_order_id);
  return { qbo_bill_id: String(bill.Id), qbo_bill_doc_number: bill.DocNumber || null, expense_request_id: landed?.expense_request_id || null, notes };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  const bearer = bearerOf(req);
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on this site' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const action = String(body.action || 'create');

  if (action === 'create') {
    const poId = String(body.po_id || '').trim();
    const lines = (Array.isArray(body.lines) ? body.lines : [])
      .map((l) => ({ po_line_id: String(l.po_line_id || ''), qty: Number(l.qty) }))
      .filter((l) => l.po_line_id && Number.isFinite(l.qty) && l.qty > 0);
    if (!poId) return json({ error: 'po_id required' }, 400);
    if (!lines.length) return json({ error: 'Enter a quantity on at least one line.' }, 400);

    let receipt;
    try {
      const r = await rpc('fn_po_receipt_record', {
        p_po_id: poId, p_lines: lines,
        p_vendor_invoice_number: body.vendor_invoice_number ? String(body.vendor_invoice_number) : null,
        p_invoice_date: body.invoice_date ? String(body.invoice_date) : null,
        p_notes: body.notes ? String(body.notes) : null,
      }, bearer);
      const rows = await ops('GET', `po_receipts?select=*&id=eq.${r.receipt_id}`);
      receipt = rows?.[0];
      if (!receipt) throw new Error('receipt row not found after record');
      receipt.completes_po = r.completes_po;
    } catch (e) {
      return json({ error: e.message }, 400);
    }

    try {
      const billed = await billReceipt(receipt, bearer);
      return json({ ok: true, receipt_id: receipt.id, total: receipt.total_amount, completes_po: receipt.completes_po, ...billed });
    } catch (e) {
      return json({
        ok: false, receipt_id: receipt.id, total: receipt.total_amount, completes_po: receipt.completes_po,
        error: 'Stock was received into the ledger, but QuickBooks refused the bill: ' + e.message + ' — use Retry bill on the purchase order.',
      }, 502);
    }
  }

  if (action === 'retry') {
    const receiptId = String(body.receipt_id || '').trim();
    if (!receiptId) return json({ error: 'receipt_id required' }, 400);
    const rows = await ops('GET', `po_receipts?select=*&id=eq.${receiptId}`);
    const receipt = rows?.[0];
    if (!receipt) return json({ error: 'receipt not found' }, 404);
    if (receipt.qbo_bill_id) return json({ ok: true, no_change: true, receipt_id: receiptId, qbo_bill_id: receipt.qbo_bill_id, message: 'This receipt already has its bill.' });
    try {
      const billed = await billReceipt(receipt, bearer);
      return json({ ok: true, receipt_id: receiptId, total: receipt.total_amount, ...billed });
    } catch (e) {
      return json({ ok: false, receipt_id: receiptId, error: 'QuickBooks refused the bill again: ' + e.message }, 502);
    }
  }

  return json({ error: 'unknown action' }, 400);
}
