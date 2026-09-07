// /api/repack — the repack sheet: cases of cans become 8-packs, and the stock
// ledger AND QuickBooks move together off one signed sheet.
//
// Called by public/repack.html (served at alamedapointbg.com/repack, and framed
// inside Refractor → Stock → Repacks). Gate: superadmin/admin — the same staff
// audience as the Stock page, because this writes an InventoryAdjustment into
// the live QuickBooks company.
//
//   GET                       → { settings, pairs[], bin[], recipe[], recent[] }
//   POST { action:'create', lines[], signed_by_name, signature_data?, notes? }
//        lines: {kind:'repack', qbo_item_id:<24P case>, qty:cases}   → cases become exactly 3 packs each
//               {kind:'to_bin', qbo_item_id:<24P case>, qty:cases}   → whole cases staged in the variety bin
//               {kind:'variety', qbo_item_id:'891', qty:packs}       → each pack pulls its recipe from the bin
//   POST { action:'retry',  id }        — re-push a sheet whose QBO write failed
//   POST { action:'void',   id, reason } — delete the QBO adjustment, reverse the ledger
//
// ORDER OF OPERATIONS, and why: the ledger write (ops.fn_repack_create, run
// under the CALLER's JWT so created_by/email are theirs) happens FIRST and is
// the record; the QuickBooks push is best-effort AFTER it. A QBO refusal
// (closed period, dead token, deactivated item) lands on the row as qbo_error
// and the page offers Retry — the sheet the warehouse signed is never lost to
// an accounting hiccup. ops.fn_repack_health() goes red if a sheet sits an
// hour without reaching QuickBooks, so a failed push cannot go quiet.
//
// EXACT EIGHTS + THE VARIETY BIN (Sky, 2026-09-04): a case is 24 cans = exactly 3
// packs, never an uneven pack. Variety 8-packs are 2 x Cola + 1 x each other
// flavour, built from cases staged in the variety bin; the bin counts cans
// (ops.repack_bin), the ledger and QuickBooks count whole cases.
//
// THE BIN DEDUCTS (Sky, 2026-09-04, 20260904j): "when we move cases to variety
// bin i still want that to be deducted from inventory". A case moved into the
// bin leaves the ledger (→ Adjustment Counter) and QuickBooks (QtyDiff −N)
// the moment it goes in; the variety draw then moves nothing on either book,
// and the variety packs made post +M. Before 20260904j the move was
// ledger-only and a case left the books when its 24th can was drawn.
//
// The QBO entity is InventoryAdjustment: one AdjustAccountRef (from
// ops.repack_settings — 1150040010 "Ecommerce Repackaging" per Sky,
// 2026-09-04, the account the hand-keyed 8/24 repack used; was 353 Inventory
// Shrinkage for the first two sheets; one edit to change), one
// ItemAdjustmentLineDetail per line, QtyDiff negative for the cases consumed
// or binned and positive for the packs produced. DocNumber = the RP number so
// the two records name each other. The account each sheet was posted with is
// stamped on the row (qbo_account_id); when it differs from the setting the
// page offers "Move to <account>" → action `repoint`, which rewrites the
// adjustment's AdjustAccountRef in QuickBooks (a full-entity update with the
// current SyncToken — QuickBooks has no sparse update for this entity).

import { requireAuth } from './lib/auth.mjs';
import { qboRequest, qboQuery } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

// PostgREST on the ops schema. `bearer` is the caller's JWT for the RPCs (so
// auth.uid() / fn_is_staff() are the real person) and the service key for the
// bookkeeping PATCHes that stamp the QuickBooks result onto the row.
async function ops(method, path, body, bearer) {
  const key = bearer || SERVICE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: bearer ? SUPABASE_ANON_KEY : SERVICE_KEY,
      Authorization: `Bearer ${key}`,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: method === 'PATCH' ? 'return=representation' : 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || j.hint || j.error || text; } catch { /* keep text */ }
    throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${String(msg).slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

const RECENT_SELECT =
  'id,repack_number,repack_date,created_at,cans_in,cans_out,notes,qbo_required,variety_packs,cases_to_bin,' +
  'signed_by_name,signed_by_email,qbo_txn_id,qbo_doc_number,qbo_pushed_at,qbo_error,qbo_attempts,qbo_account_id,' +
  'voided_at,void_reason,signature_data,' +
  'lines:repack_order_lines(line_no,kind,qbo_item_id,item_name,qty,cans,unit,cases_posted)';

async function loadSettings() {
  const rows = await ops('GET', 'repack_settings?select=*&id=eq.1');
  if (!rows || !rows[0]) throw new Error('ops.repack_settings row 1 is missing');
  return rows[0];
}

async function loadPairs(settings) {
  const pairs = await ops('GET', 'repack_pairs?select=*&active=is.true&order=sort_order');
  const ids = [...new Set(pairs.flatMap((p) => [p.pack_qbo_item_id, p.case_qbo_item_id]).filter(Boolean))];
  const inList = ids.map((i) => `"${i}"`).join(',');
  const [items, onHand] = await Promise.all([
    ops('GET', `qbo_items?select=qbo_item_id,name,qty_on_hand,active&qbo_item_id=in.(${inList})`),
    ops('GET', `v_inventory_on_hand?select=qbo_item_id,on_hand&location_id=eq.${settings.location_id}&qbo_item_id=in.(${inList})`),
  ]);
  const item = Object.fromEntries((items || []).map((i) => [i.qbo_item_id, i]));
  const oh = Object.fromEntries((onHand || []).map((r) => [r.qbo_item_id, Number(r.on_hand)]));
  return pairs.map((p) => ({
    label: p.label,
    sort_order: p.sort_order,
    pack: {
      qbo_item_id: p.pack_qbo_item_id,
      name: item[p.pack_qbo_item_id]?.name || p.pack_qbo_item_id,
      active: item[p.pack_qbo_item_id]?.active !== false,
      on_hand: oh[p.pack_qbo_item_id] ?? 0,
      qbo_qty: item[p.pack_qbo_item_id]?.qty_on_hand ?? null,
    },
    case: p.case_qbo_item_id ? {
      qbo_item_id: p.case_qbo_item_id,
      name: item[p.case_qbo_item_id]?.name || p.case_qbo_item_id,
      active: item[p.case_qbo_item_id]?.active !== false,
      on_hand: oh[p.case_qbo_item_id] ?? 0,
      qbo_qty: item[p.case_qbo_item_id]?.qty_on_hand ?? null,
    } : null,
  }));
}

async function loadBin() {
  const [bin, recipe] = await Promise.all([
    ops('GET', 'v_repack_bin?select=*'),
    ops('GET', 'repack_variety_recipe?select=pack_qbo_item_id,case_qbo_item_id,cans'),
  ]);
  return { bin: bin || [], recipe: recipe || [] };
}

async function loadRecent(limit = 40) {
  return ops('GET', `repack_orders?select=${RECENT_SELECT}&order=created_at.desc&limit=${limit}`);
}

async function loadOne(id) {
  const rows = await ops('GET', `repack_orders?select=${RECENT_SELECT}&id=eq.${id}`);
  return rows && rows[0];
}

// ── QuickBooks ────────────────────────────────────────────────────────────────
function qboFault(e) {
  // qboRequest throws "QBO API error: <status> <body>"; the Fault message is
  // the part a human can act on.
  const s = String(e && e.message || e);
  try {
    const i = s.indexOf('{');
    if (i >= 0) {
      const j = JSON.parse(s.slice(i));
      const f = j?.Fault?.Error?.[0] || j?.fault?.error?.[0];
      if (f) return [f.Message, f.Detail].filter(Boolean).join(' — ').slice(0, 600);
    }
  } catch { /* fall through */ }
  return s.slice(0, 600);
}

/** QtyDiff one repack line contributes to the QuickBooks adjustment (exported for tests). */
export function lineQtyDiff(l) {
  const qty = Number(l.qty || 0);
  if (l.kind === 'consume' || l.kind === 'to_bin') return -qty;
  if (l.kind === 'produce' || l.kind === 'variety_produce') return qty;
  return 0;   // variety_draw: already off the books
}

export function buildAdjustment(order, settings) {
  const lines = [...(order.lines || [])].sort((a, b) => a.line_no - b.line_no);
  return {
    AdjustAccountRef: { value: String(settings.qbo_adjust_account_id) },
    TxnDate: order.repack_date,
    DocNumber: String(order.repack_number).slice(0, 21),
    PrivateNote: (`Repack ${order.repack_number} — ${order.signed_by_name}; ${order.cans_in / 24} case(s) → ${order.cans_out / 8} flavour 8-pack(s)`
      + (Number(order.variety_packs) > 0 ? `; ${order.variety_packs} variety 8-pack(s) from the bin` : '')
      + (Number(order.cases_to_bin) > 0 ? `; ${order.cases_to_bin} case(s) moved into the variety bin` : '')
      + (order.notes ? ' · ' + order.notes : '')).slice(0, 4000),
    // consume: -cases · to_bin: -cases (they leave the books on the way INTO
    // the bin, 20260904j) · produce / variety_produce: +packs · variety_draw:
    // nothing — those cases were deducted when they were binned.
    Line: lines
      .map((l) => ({ item: String(l.qbo_item_id), diff: lineQtyDiff(l) }))
      .filter((x) => x.diff !== 0)
      .map((x) => ({
        DetailType: 'ItemAdjustmentLineDetail',
        ItemAdjustmentLineDetail: { ItemRef: { value: x.item }, QtyDiff: x.diff },
      })),
  };
}

// After a successful adjustment, pull the affected items' live QtyOnHand into
// the mirror so Stock → On-Hand agrees with QuickBooks NOW instead of after the
// 09:45 UTC items sync — a sheet moving the ledger and the mirror lagging a day
// would read as drift on every item on it. Best effort: the adjustment already
// landed; a failed refresh only delays the green light.
async function refreshMirrorQty(itemIds) {
  if (!itemIds.length) return { refreshed: 0 };
  const inList = itemIds.map((i) => `'${String(i).replace(/'/g, '')}'`).join(',');
  const q = await qboQuery(`select Id, QtyOnHand from Item where Id in (${inList})`);
  const rows = q?.QueryResponse?.Item || [];
  const now = new Date().toISOString();
  await Promise.all(rows.map((it) =>
    ops('PATCH', `qbo_items?qbo_item_id=eq.${it.Id}`, { qty_on_hand: it.QtyOnHand, synced_at: now })));
  return { refreshed: rows.length };
}

async function pushToQbo(order, settings) {
  if (order.qbo_required === false) return { pushed: false, not_needed: true };
  const payload = buildAdjustment(order, settings);
  if (!payload.Line.length) {
    // Nothing on the sheet moves a quantity (cannot happen with the 20260904j
    // rules — every kind but variety_draw carries a QtyDiff — but a sheet must
    // never sit red for an empty adjustment). Say so on the row so health reads it.
    await ops('PATCH', `repack_orders?id=eq.${order.id}`, { qbo_required: false }).catch(() => {});
    return { pushed: false, not_needed: true };
  }
  try {
    const res = await qboRequest('POST', '/inventoryadjustment?minorversion=70', payload);
    const adj = res?.InventoryAdjustment;
    if (!adj?.Id) throw new Error('QuickBooks returned no InventoryAdjustment id');
    await ops('PATCH', `repack_orders?id=eq.${order.id}`, {
      qbo_txn_id: String(adj.Id), qbo_doc_number: adj.DocNumber || order.repack_number,
      qbo_account_id: String(settings.qbo_adjust_account_id),
      qbo_pushed_at: new Date().toISOString(), qbo_error: null, qbo_attempts: (order.qbo_attempts || 0) + 1,
    });
    let mirror = null;
    try { mirror = await refreshMirrorQty([...new Set(payload.Line.map((l) => l.ItemAdjustmentLineDetail.ItemRef.value))]); }
    catch (e) { mirror = { error: String(e.message || e).slice(0, 200) }; }
    return { pushed: true, qbo_txn_id: String(adj.Id), doc_number: adj.DocNumber || order.repack_number, mirror };
  } catch (e) {
    const msg = qboFault(e);
    await ops('PATCH', `repack_orders?id=eq.${order.id}`, {
      qbo_error: msg, qbo_attempts: (order.qbo_attempts || 0) + 1,
    }).catch(() => {});
    return { pushed: false, error: msg };
  }
}

// Move an already-posted adjustment onto the account in settings. QuickBooks
// has no sparse update for InventoryAdjustment, so this is the current entity
// read back, AdjustAccountRef swapped, and the whole thing POSTed with its
// SyncToken. Lines are untouched — the quantities were right; only the P&L
// line they landed on changes.
async function repointQboAdjustment(order, settings) {
  const cur = await qboRequest('GET', `/inventoryadjustment/${encodeURIComponent(order.qbo_txn_id)}?minorversion=70`);
  const adj = cur?.InventoryAdjustment;
  if (!adj?.Id) throw new Error(`QuickBooks adjustment ${order.qbo_txn_id} not found`);
  const target = String(settings.qbo_adjust_account_id);
  if (String(adj.AdjustAccountRef?.value) === target) {
    await ops('PATCH', `repack_orders?id=eq.${order.id}`, { qbo_account_id: target }).catch(() => {});
    return { moved: false, already: true, qbo_txn_id: String(adj.Id) };
  }
  const payload = { ...adj, AdjustAccountRef: { value: target } };
  delete payload.MetaData; delete payload.domain; delete payload.sparse;
  const res = await qboRequest('POST', '/inventoryadjustment?minorversion=70', payload);
  const out = res?.InventoryAdjustment;
  if (!out?.Id) throw new Error('QuickBooks returned no InventoryAdjustment after the update');
  await ops('PATCH', `repack_orders?id=eq.${order.id}`, { qbo_account_id: target, qbo_error: null });
  return { moved: true, qbo_txn_id: String(out.Id), from: String(adj.AdjustAccountRef?.value ?? ''), to: target };
}

// Deleting an InventoryAdjustment needs its current SyncToken.
async function deleteQboAdjustment(txnId) {
  const cur = await qboRequest('GET', `/inventoryadjustment/${encodeURIComponent(txnId)}?minorversion=70`);
  const adj = cur?.InventoryAdjustment;
  if (!adj?.Id) throw new Error(`QuickBooks adjustment ${txnId} not found`);
  await qboRequest('POST', '/inventoryadjustment?operation=delete&minorversion=70', { Id: adj.Id, SyncToken: adj.SyncToken });
  return adj.Id;
}

// ── handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on this site' }, 500);

  if (req.method === 'GET') {
    try {
      const settings = await loadSettings();
      const [pairs, recent, binInfo] = await Promise.all([loadPairs(settings), loadRecent(), loadBin()]);
      return json({
        bin: binInfo.bin, recipe: binInfo.recipe,
        settings: {
          qbo_adjust_account_id: settings.qbo_adjust_account_id,
          qbo_adjust_account_name: settings.qbo_adjust_account_name,
          cans_per_case: settings.cans_per_case,
          cans_per_pack: settings.cans_per_pack,
          default_packs_per_case: settings.default_packs_per_case,
          location_id: settings.location_id,
          bin_location_id: settings.bin_location_id,
        },
        pairs, recent,
        me: { email: auth.user?.email || null, name: auth.user?.user_metadata?.full_name || auth.user?.user_metadata?.name || null },
      });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }

  if (req.method !== 'POST') return json({ error: 'GET or POST' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const action = String(body.action || 'create');

  if (action === 'create') {
    const lines = Array.isArray(body.lines) ? body.lines
      .map((l) => ({ kind: String(l.kind || ''), qbo_item_id: String(l.qbo_item_id || ''), qty: Number(l.qty) }))
      .filter((l) => l.qbo_item_id && Number.isFinite(l.qty) && l.qty > 0) : [];
    if (!lines.length) return json({ error: 'Enter at least one case repacked, one case moved to the bin, or one variety pack made.' }, 400);
    const sig = body.signature_data ? String(body.signature_data) : null;
    if (sig && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(sig)) return json({ error: 'The signature did not come through as an image.' }, 400);
    if (sig && sig.length > 400000) return json({ error: 'The signature image is too large.' }, 400);

    let created;
    try {
      created = await ops('POST', 'rpc/fn_repack_create', {
        p_lines: lines,
        p_signed_by_name: String(body.signed_by_name || '').trim(),
        p_signature_data: sig,
        p_notes: body.notes ? String(body.notes).slice(0, 2000) : null,
        // Sky (2026-09-04): the sheet carries the date the repack was DONE, not
        // the day it was typed — and repack_date is what becomes the QuickBooks
        // adjustment's TxnDate below. null falls back to today in the RPC; a
        // future date is refused there, so a bad value cannot reach QuickBooks.
        p_repack_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.repack_date || '')) ? String(body.repack_date) : null,
      }, auth.jwt);
    } catch (e) {
      return json({ error: e.message.replace(/^POST rpc\/fn_repack_create → \d+: /, '') }, 400);
    }

    // Ledger is written. Now QuickBooks — failure is recorded, never fatal.
    let order, settings, qbo;
    try {
      [order, settings] = await Promise.all([loadOne(created.id), loadSettings()]);
      qbo = await pushToQbo(order, settings);
    } catch (e) {
      qbo = { pushed: false, error: String(e.message || e).slice(0, 400) };
    }
    return json({ ok: true, repack: created, qbo, order: await loadOne(created.id).catch(() => order) });
  }

  if (action === 'retry') {
    const id = String(body.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'id is required' }, 400);
    const order = await loadOne(id);
    if (!order) return json({ error: 'Repack not found' }, 404);
    if (order.voided_at) return json({ error: `${order.repack_number} is voided.` }, 409);
    if (order.qbo_txn_id) return json({ ok: true, qbo: { pushed: true, qbo_txn_id: order.qbo_txn_id, already: true }, order });
    if (order.qbo_required === false) return json({ ok: true, qbo: { pushed: false, not_needed: true }, order });
    const settings = await loadSettings();
    const qbo = await pushToQbo(order, settings);
    return json({ ok: true, qbo, order: await loadOne(id) });
  }

  if (action === 'repoint') {
    // Every live, posted sheet whose adjustment sits on a different account
    // than settings — moved one at a time, each result reported; a refusal on
    // one does not stop the next.
    const settings = await loadSettings();
    const rows = await ops('GET', `repack_orders?select=${RECENT_SELECT}&voided_at=is.null&qbo_txn_id=not.is.null&order=created_at`);
    const target = String(settings.qbo_adjust_account_id);
    const todo = (rows || []).filter((r) => String(r.qbo_account_id ?? '') !== target);
    const results = [];
    for (const order of todo) {
      try { results.push({ repack_number: order.repack_number, ...(await repointQboAdjustment(order, settings)) }); }
      catch (e) { results.push({ repack_number: order.repack_number, error: qboFault(e) }); }
    }
    return json({ ok: true, account: { id: target, name: settings.qbo_adjust_account_name }, results, recent: await loadRecent() });
  }

  if (action === 'void') {
    const id = String(body.id || '');
    const reason = String(body.reason || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'id is required' }, 400);
    if (!reason) return json({ error: 'A reason is required to void a repack.' }, 400);
    const order = await loadOne(id);
    if (!order) return json({ error: 'Repack not found' }, 404);
    if (order.voided_at) return json({ error: `${order.repack_number} is already voided.` }, 409);

    // QuickBooks first: if the adjustment cannot be deleted the sheet stays
    // live on both sides, which is at least consistent.
    let qboDeleted = null;
    if (order.qbo_txn_id) {
      try { qboDeleted = await deleteQboAdjustment(order.qbo_txn_id); }
      catch (e) { return json({ error: `QuickBooks would not delete adjustment ${order.qbo_txn_id}: ${qboFault(e)}` }, 502); }
    }
    try {
      const r = await ops('POST', 'rpc/fn_repack_void', { p_id: id, p_reason: reason, p_qbo_cleared: true }, auth.jwt);
      let mirror = null;
      if (qboDeleted) {
        try { mirror = await refreshMirrorQty([...new Set(payload.Line.map((l) => l.ItemAdjustmentLineDetail.ItemRef.value))]); } catch { /* best effort */ }
      }
      return json({ ok: true, voided: r, qbo_deleted: qboDeleted, mirror, order: await loadOne(id) });
    } catch (e) {
      return json({ error: e.message.replace(/^POST rpc\/fn_repack_void → \d+: /, ''), qbo_deleted: qboDeleted }, 400);
    }
  }

  return json({ error: `Unknown action ${action}` }, 400);
}

export const config = { path: '/api/repack' };
