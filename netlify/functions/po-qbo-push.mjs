// /api/po-qbo-push — the purchase order's two-way street with QuickBooks.
//
// ASK (Sky, 2026-09-04): "can i make changes to pos then and push them back so
// its like a two way street?"
//
//   POST { action:'create', po_id }             — a native PO into QuickBooks
//   POST { action:'update', po_id, force? }     — local edits onto the PO
//                                                 QuickBooks already has
//   POST { action:'pull',   po_id, discard_local? } — re-read from QuickBooks
//
// THE CONFLICT RULE: every QuickBooks entity carries a SyncToken that changes
// on every write. The mirror stores the token it last saw; an update sends
// that token back. If QuickBooks' token has moved on, somebody edited the PO
// there since our last pull, and this returns 409 with both versions rather
// than letting the last writer win silently. The caller then pulls (dropping
// the local edit) or forces (overwriting QuickBooks) — a person decides.
// The 15-minute pull never overwrites a row marked qbo_dirty for the same
// reason from the other side.
//
// Edits themselves are made by ops.fn_po_update (RPC, under the caller's JWT);
// this function only moves them.

import { requireAuth } from './lib/auth.mjs';
import { ops, pushPoCreate, pushPoUpdate, pullPo } from './lib/qbo-purchasing-sync.mjs';

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

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  const bearer = bearerOf(req);
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on this site' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const action = String(body.action || '');
  const poId = String(body.po_id || '').trim();
  if (!poId) return json({ error: 'po_id required' }, 400);

  try {
    if (action === 'create') {
      const r = await pushPoCreate(poId, bearer);
      return json({ ok: true, no_change: !!r.no_change, qbo_purchase_order_id: r.qbo_purchase_order_id,
        message: r.no_change ? 'Already in QuickBooks as PurchaseOrder #' + r.qbo_purchase_order_id : 'Created in QuickBooks as PurchaseOrder #' + r.qbo_purchase_order_id });
    }
    if (action === 'update') {
      const r = await pushPoUpdate(poId, { force: body.force === true }, bearer);
      if (r.conflict) return json({ ok: false, conflict: true, message: r.message, remote_sync_token: r.remote_sync_token, local_sync_token: r.local_sync_token }, 409);
      return json({ ok: true, qbo_purchase_order_id: r.qbo_purchase_order_id, sync_token: r.sync_token, message: 'QuickBooks updated (version ' + r.sync_token + ')' });
    }
    if (action === 'pull') {
      const rows = await ops('GET', `purchase_orders?select=id,po_number,qbo_purchase_order_id,qbo_dirty&id=eq.${poId}`);
      const po = rows?.[0];
      if (!po) return json({ error: 'purchase order not found' }, 404);
      if (!po.qbo_purchase_order_id) return json({ error: po.po_number + ' is not in QuickBooks yet — push it first' }, 400);
      if (po.qbo_dirty && body.discard_local !== true) {
        return json({ ok: false, conflict: true, message: po.po_number + ' has edits here that were never pushed. Reloading from QuickBooks discards them — confirm to continue.' }, 409);
      }
      if (po.qbo_dirty) {
        await ops('PATCH', `purchase_orders?id=eq.${poId}`, { qbo_dirty: false }, null, 'return=minimal');
      }
      const r = await pullPo(po.qbo_purchase_order_id);
      return json({ ok: true, result: r, message: 'Reloaded ' + po.po_number + ' from QuickBooks (' + (r?.action || 'ok') + ')' });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}
