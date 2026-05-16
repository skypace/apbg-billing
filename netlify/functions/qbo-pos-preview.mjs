// /api/qbo-pos-preview — list open QBO PurchaseOrders for the
// "Pull from QBO" picker. Marks each PO as already-imported (shadow table) or
// already-managed-in-BRIX (ops.purchase_orders.qbo_purchase_order_id set), so
// the UI can disable / hide rows the operator shouldn't pick again.

import { createClient } from '@supabase/supabase-js';
import { qboQuery } from './qbo-helpers.mjs';

const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

// Pull POs in pages of 1000 (QBO max). Most realms have <500 PO history so
// one page is usually enough.
async function fetchAllPurchaseOrders() {
  const all = [];
  let startPos = 1;
  const pageSize = 1000;
  while (true) {
    const res = await qboQuery(
      `SELECT * FROM PurchaseOrder ORDER BY MetaData.LastUpdatedTime DESC STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`
    );
    const rows = res?.QueryResponse?.PurchaseOrder || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    startPos += pageSize;
  }
  return all;
}

// QBO PurchaseOrder exposes POStatus on the entity ("Open" / "Closed") but it's
// not always populated in the query response — the source-of-truth is whether
// every line has a fully-linked Bill. For the picker we keep it simple: treat
// LinkedTxn containing any Bill as "partial or fully received", and rely on
// POStatus where present.
function deriveStatus(po) {
  if (typeof po.POStatus === 'string' && po.POStatus.length > 0) return po.POStatus;
  const linkedBills = (po.LinkedTxn || []).filter((t) => t.TxnType === 'Bill');
  return linkedBills.length > 0 ? 'PartiallyBilled' : 'Open';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  // Bearer-only auth — matches the Brixpense submitter endpoints. Any
  // logged-in employee with @brixbev.com can see the picker; the actual
  // import endpoint adds role-based gates.
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized — Bearer token required' }, 401);

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  let qboPos = [];
  try {
    qboPos = await fetchAllPurchaseOrders();
  } catch (e) {
    console.error('qbo-pos-preview: QBO query failed', e);
    return json({ error: e?.message || 'QBO query failed' }, 502);
  }

  // Cross-reference with what's already in BRIX so the UI can show status
  // chips. Two separate sources we care about:
  //   1. ops.qbo_purchase_orders — previously imported via this picker
  //   2. ops.purchase_orders.qbo_purchase_order_id — BRIX-native POs that
  //      have been pushed to QBO (those already count in fn_items_master's
  //      brix_on_order CTE, so re-importing would be redundant)
  const ids = qboPos.map((p) => p.Id);
  const [{ data: already, error: e1 }, { data: brixLinked, error: e2 }] = await Promise.all([
    sb.from('qbo_purchase_orders').select('qbo_id, imported_at, last_synced_at').in('qbo_id', ids),
    sb.from('purchase_orders').select('qbo_purchase_order_id').not('qbo_purchase_order_id', 'is', null).in('qbo_purchase_order_id', ids),
  ]);
  if (e1 || e2) {
    console.error('qbo-pos-preview: cross-reference query failed', e1, e2);
    return json({ error: 'Cross-reference query failed' }, 500);
  }
  const alreadyMap = new Map((already || []).map((r) => [r.qbo_id, r]));
  const brixLinkedSet = new Set((brixLinked || []).map((r) => r.qbo_purchase_order_id));

  const items = qboPos.map((po) => {
    const lines = (po.Line || [])
      .filter((l) => l.DetailType === 'ItemBasedExpenseLineDetail' || l.DetailType === 'AccountBasedExpenseLineDetail')
      .map((l, i) => {
        const ib = l.ItemBasedExpenseLineDetail;
        const ab = l.AccountBasedExpenseLineDetail;
        return {
          line_num: l.LineNum || i + 1,
          description: l.Description || '',
          amount: l.Amount ?? null,
          qbo_item_id: ib?.ItemRef?.value || null,
          qbo_item_name: ib?.ItemRef?.name || null,
          qty: ib?.Qty ?? null,
          unit_cost: ib?.UnitPrice ?? null,
          account_id: ab?.AccountRef?.value || null,
          account_name: ab?.AccountRef?.name || null,
        };
      });
    const status = deriveStatus(po);
    const importRow = alreadyMap.get(po.Id);
    return {
      qbo_id: po.Id,
      doc_number: po.DocNumber || null,
      vendor_id: po.VendorRef?.value || null,
      vendor_name: po.VendorRef?.name || null,
      txn_date: po.TxnDate || null,
      total_amt: po.TotalAmt ?? null,
      status,
      memo: po.Memo || po.PrivateNote || null,
      line_count: lines.length,
      lines,
      already_imported: !!importRow,
      imported_at: importRow?.imported_at || null,
      last_synced_at: importRow?.last_synced_at || null,
      brix_native: brixLinkedSet.has(po.Id),
    };
  });

  // Sort: open + not-yet-imported first (the ones the picker is for), then
  // newest first within each bucket.
  items.sort((a, b) => {
    const aPick = a.status === 'Open' && !a.already_imported && !a.brix_native ? 0 : 1;
    const bPick = b.status === 'Open' && !b.already_imported && !b.brix_native ? 0 : 1;
    if (aPick !== bPick) return aPick - bPick;
    return String(b.txn_date || '').localeCompare(String(a.txn_date || ''));
  });

  return json({
    count: items.length,
    open_pickable: items.filter((i) => i.status === 'Open' && !i.already_imported && !i.brix_native).length,
    items,
  });
}

export const config = { path: '/api/qbo-pos-preview' };
