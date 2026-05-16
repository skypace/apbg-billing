// /api/qbo-pos-import — accept a list of QBO PO ids and upsert them + their
// lines into the shadow tables. Triggered by the operator clicking
// "Import N selected" on the picker modal. Re-running on the same ids
// refreshes the snapshot (line items, total, status) from QBO.

import { createClient } from '@supabase/supabase-js';
import { qboQuery } from './qbo-helpers.mjs';

const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

function escapeQbo(v) {
  return String(v).replace(/'/g, "\\'");
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized — Bearer token required' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) return json({ error: 'ids[] required (QBO PurchaseOrder ids)' }, 400);
  if (ids.length > 500) return json({ error: 'Max 500 ids per import call' }, 400);

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  // Stamp imported_by from the caller's user.id when we can resolve it.
  let importedBy = null;
  try {
    const { data: { user } } = await sb.auth.getUser();
    importedBy = user?.id || null;
  } catch {}

  // QBO IN-clause caps at ~1000 chars per id list — chunk to be safe.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

  const fetched = [];
  for (const ch of chunks) {
    const inList = ch.map((id) => `'${escapeQbo(id)}'`).join(',');
    try {
      const res = await qboQuery(`SELECT * FROM PurchaseOrder WHERE Id IN (${inList}) MAXRESULTS 500`);
      const rows = res?.QueryResponse?.PurchaseOrder || [];
      fetched.push(...rows);
    } catch (e) {
      console.error('qbo-pos-import: QBO fetch chunk failed', e);
      return json({ error: `QBO fetch failed: ${e?.message || e}` }, 502);
    }
  }

  const now = new Date().toISOString();
  const imported = [];
  const skipped = [];
  for (const po of fetched) {
    const linkedBills = (po.LinkedTxn || []).filter((t) => t.TxnType === 'Bill');
    const status = po.POStatus || (linkedBills.length > 0 ? 'PartiallyBilled' : 'Open');

    const headerRow = {
      qbo_id: po.Id,
      doc_number: po.DocNumber || null,
      qbo_vendor_id: po.VendorRef?.value || null,
      vendor_name: po.VendorRef?.name || null,
      txn_date: po.TxnDate || null,
      po_status: status,
      total_amt: po.TotalAmt ?? null,
      memo: po.Memo || po.PrivateNote || null,
      sync_token: po.SyncToken || null,
      raw: po,
      imported_by: importedBy,
      last_synced_at: now,
    };

    const { error: upsertErr } = await sb
      .from('qbo_purchase_orders')
      .upsert(headerRow, { onConflict: 'qbo_id' });
    if (upsertErr) {
      console.error('qbo-pos-import: header upsert failed', po.Id, upsertErr);
      skipped.push({ qbo_id: po.Id, reason: upsertErr.message });
      continue;
    }

    // Replace lines wholesale on each import — simplest way to keep them in
    // sync with QBO. Cheap because PO line counts are small.
    const { error: delErr } = await sb.from('qbo_purchase_order_lines').delete().eq('qbo_po_id', po.Id);
    if (delErr) {
      console.error('qbo-pos-import: line delete failed', po.Id, delErr);
      skipped.push({ qbo_id: po.Id, reason: `line delete: ${delErr.message}` });
      continue;
    }

    const lineRows = (po.Line || [])
      .filter((l) => l.DetailType === 'ItemBasedExpenseLineDetail' || l.DetailType === 'AccountBasedExpenseLineDetail')
      .map((l, i) => {
        const ib = l.ItemBasedExpenseLineDetail;
        return {
          qbo_po_id: po.Id,
          line_num: l.LineNum || i + 1,
          qbo_item_id: ib?.ItemRef?.value || null,
          description: l.Description || null,
          qty: ib?.Qty ?? null,
          unit_cost: ib?.UnitPrice ?? null,
          amount: l.Amount ?? null,
        };
      });

    if (lineRows.length > 0) {
      const { error: insErr } = await sb.from('qbo_purchase_order_lines').insert(lineRows);
      if (insErr) {
        console.error('qbo-pos-import: line insert failed', po.Id, insErr);
        skipped.push({ qbo_id: po.Id, reason: `line insert: ${insErr.message}` });
        continue;
      }
    }

    imported.push({ qbo_id: po.Id, doc_number: po.DocNumber || null, lines: lineRows.length });
  }

  const missing = ids.filter((id) => !fetched.some((p) => p.Id === id));

  return json({
    requested: ids.length,
    imported: imported.length,
    skipped: skipped.length,
    missing: missing.length,
    details: { imported, skipped, missing },
  });
}

export const config = { path: '/api/qbo-pos-import' };
