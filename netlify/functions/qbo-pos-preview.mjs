// /.netlify/functions/qbo-pos-preview — list QBO PurchaseOrders for the
// "Pull from QBO" picker.
//
// Filter policy (per operator request):
//   - hide POs with POStatus === 'Closed'
//   - hide POs that have ANY LinkedTxn of TxnType='Bill' — even if QBO
//     still lists them as Open. A linked Bill means inventory was received
//     against that PO, so the qty no longer counts toward On Order.
//   - operator can override with ?include_all=true to see everything
//     (for audit / re-import scenarios).
//
// Each row is annotated with already_imported (shadow row exists) and
// brix_native (linked to ops.purchase_orders) so the UI can disable rows
// that shouldn't be picked again.

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

/** Count Bill LinkedTxn rows. Any non-zero count means this PO has been
 *  partially or fully received via a Bill in QBO and should not contribute
 *  to On Order. */
function countLinkedBills(po) {
  return (po.LinkedTxn || []).filter((t) => t.TxnType === 'Bill').length;
}

function deriveStatus(po, linkedBillCount) {
  // Surface 'PartiallyBilled' whenever ANY bill is linked, regardless of
  // what POStatus claims — QBO sometimes leaves POStatus='Open' even after
  // a Bill is posted, which is what was confusing the importer before.
  if (linkedBillCount > 0) return 'PartiallyBilled';
  if (typeof po.POStatus === 'string' && po.POStatus.length > 0) return po.POStatus;
  return 'Open';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized — Bearer token required' }, 401);

  // ?include_all=true bypasses the closed/billed filter (for audit / re-import).
  const url = new URL(req.url);
  const includeAll = url.searchParams.get('include_all') === 'true';

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

  // Track totals BEFORE filtering so the response can tell the UI how many
  // were hidden (useful for the "Show closed + billed too" toggle).
  let hiddenClosed = 0;
  let hiddenBilled = 0;

  const items = qboPos
    .map((po) => {
      const linkedBillCount = countLinkedBills(po);
      const status = deriveStatus(po, linkedBillCount);
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
      const importRow = alreadyMap.get(po.Id);
      return {
        qbo_id: po.Id,
        doc_number: po.DocNumber || null,
        vendor_id: po.VendorRef?.value || null,
        vendor_name: po.VendorRef?.name || null,
        txn_date: po.TxnDate || null,
        total_amt: po.TotalAmt ?? null,
        status,
        po_status_raw: po.POStatus || null,
        has_linked_bills: linkedBillCount > 0,
        linked_bill_count: linkedBillCount,
        memo: po.Memo || po.PrivateNote || null,
        line_count: lines.length,
        lines,
        already_imported: !!importRow,
        imported_at: importRow?.imported_at || null,
        last_synced_at: importRow?.last_synced_at || null,
        brix_native: brixLinkedSet.has(po.Id),
      };
    })
    .filter((item) => {
      if (includeAll) return true;
      // Hide Closed POs — nothing to import, just clutter
      if (item.po_status_raw === 'Closed') { hiddenClosed += 1; return false; }
      // Hide PO if any Bill is linked — the qty has been received
      if (item.has_linked_bills) { hiddenBilled += 1; return false; }
      return true;
    });

  items.sort((a, b) => {
    const aPick = a.status === 'Open' && !a.already_imported && !a.brix_native ? 0 : 1;
    const bPick = b.status === 'Open' && !b.already_imported && !b.brix_native ? 0 : 1;
    if (aPick !== bPick) return aPick - bPick;
    return String(b.txn_date || '').localeCompare(String(a.txn_date || ''));
  });

  return json({
    count: items.length,
    open_pickable: items.filter((i) => i.status === 'Open' && !i.already_imported && !i.brix_native).length,
    hidden: { closed: hiddenClosed, billed: hiddenBilled, total: hiddenClosed + hiddenBilled },
    include_all: includeAll,
    items,
  });
}
