// QuickBooks ⇄ Refractor purchasing — the one implementation behind the
// 15-minute pull (pg_cron → /api/qbo-purchasing-sync), the Sync now button
// (same function under a staff bearer), PO push (po-qbo-push.mjs) and
// receiving (po-receive.mjs).
//
// WHY HERE AND NOT AN EDGE FUNCTION: the deployed sync-qbo / push-qbo-item edge
// functions have drifted from their repo copies more than once (brix-order
// 1.65, 1.120) — a repo-tracked Netlify module that qbo-helpers.mjs already
// gives a token chain to is the copy that gets reviewed. pg_cron only knocks.
//
// THE RULES THIS FILE HOLDS (the pure parts are exported for tests):
//   • cdcWindow(): what "since" means. CDC reaches back 30 days at most, so the
//     window is clamped to 29; a first run (nothing logged yet) is a FULL pull
//     of open POs + bills since the purchase feed's apply_from, not a CDC call.
//   • billLineRows(): a Bill / VendorCredit → ops.qbo_expense_lines rows in the
//     SAME shape sync-qbo-expenses writes (same line_key rule, same conflict
//     key), plus the two linked-PO columns the purchase feed reads off
//     LinkedTxn. The two writers must stay interchangeable on every column.
//   • itemRow() / vendorRow(): the same mappings sync-qbo-items / syncVendors
//     use, so a row refreshed here is indistinguishable from the nightly one.
//   • linesFromPo(): a QuickBooks PurchaseOrder → the ItemBased lines we
//     understand; everything else (account lines, subtotals) is reported as
//     skipped rather than dropped silently.
//   • buildBillFromReceipt(): the Bill a receipt becomes — each line linked to
//     the PO line (TxnLineId) so QuickBooks itself closes the PO as it is
//     billed, which is what makes "receive here" and "receive in QuickBooks"
//     converge on the same books.

import { qboRequest, qboQuery } from '../qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ── PostgREST on ops ──────────────────────────────────────────────────────

/**
 * `bearer` = the caller's JWT for RPCs that must run as the person (receipts,
 * edits — auth.uid() is the real user). Omitted = service role, for the
 * bookkeeping writes (mirror upserts, sync_log).
 */
export async function ops(method, path, body, bearer, prefer) {
  const key = bearer || SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured on this site');
  const headers = {
    apikey: bearer ? SUPABASE_ANON_KEY : SERVICE_KEY,
    Authorization: `Bearer ${key}`,
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  else if (method === 'PATCH' || method === 'POST') headers.Prefer = 'return=representation';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || j.hint || j.error || text; } catch { /* keep text */ }
    throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${String(msg).slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

export const rpc = (fn, args, bearer) => ops('POST', `rpc/${fn}`, args, bearer, 'return=representation');

async function upsert(table, rows, onConflict) {
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 200) {
    await ops('POST', `${table}?on_conflict=${onConflict}`, rows.slice(i, i + 200), null,
      'resolution=merge-duplicates,return=minimal');
  }
  return rows.length;
}

// ── pure mappers ──────────────────────────────────────────────────────────

const CDC_MAX_DAYS = 29;    // QuickBooks CDC refuses more than 30 days back
const CDC_OVERLAP_MS = 5 * 60_000;

/**
 * The CDC window for this run. `lastSuccessIso` is the completed_at of the
 * last successful purchasing sync; null means nothing has ever run.
 * Returns { mode: 'full' } or { mode: 'cdc', since: ISO }.
 */
export function cdcWindow(lastSuccessIso, now = new Date()) {
  if (!lastSuccessIso) return { mode: 'full' };
  const last = new Date(lastSuccessIso).getTime();
  if (!Number.isFinite(last)) return { mode: 'full' };
  const floor = now.getTime() - CDC_MAX_DAYS * 86_400_000;
  if (last < floor) return { mode: 'full' };            // too stale for CDC — walk it fully
  const since = new Date(Math.min(last - CDC_OVERLAP_MS, now.getTime()));
  return { mode: 'cdc', since: since.toISOString() };
}

function fallbackLineKey(ln, idx) {
  // sync-qbo-expenses v10 rule, byte for byte: a Purchase/Bill line with no
  // Id AND no LineNum keys on its content so a re-sync updates instead of
  // duplicating. Kept identical so the two writers never split one line.
  const item = ln.ItemBasedExpenseLineDetail;
  const acct = ln.AccountBasedExpenseLineDetail;
  return 'k' + idx + ':' + [
    ln.DetailType ?? '',
    item?.ItemRef?.value ?? '',
    item?.ItemRef?.name ?? '',
    acct?.AccountRef?.value ?? '',
    acct?.AccountRef?.name ?? '',
    ln.Description ?? '',
    ln.Amount ?? '',
    item?.Qty ?? '',
    item?.UnitPrice ?? '',
  ].join('|');
}

/** A Bill / VendorCredit → ops.qbo_expense_lines rows. */
export function billLineRows(txn, type, nowIso = new Date().toISOString()) {
  const out = [];
  const vendor = txn.VendorRef?.name ?? txn.EntityRef?.name ?? null;
  const lines = Array.isArray(txn.Line) ? txn.Line : [];
  lines.forEach((ln, idx) => {
    const dt = ln.DetailType;
    if (!dt) return;
    const item = ln.ItemBasedExpenseLineDetail;
    const acct = ln.AccountBasedExpenseLineDetail;
    const linked = (Array.isArray(ln.LinkedTxn) ? ln.LinkedTxn : []).find((t) => t.TxnType === 'PurchaseOrder');
    const row = {
      qbo_txn_id: String(txn.Id),
      qbo_txn_type: type,
      line_key: String(ln.Id ?? ln.LineNum ?? fallbackLineKey(ln, idx)),
      line_num: ln.LineNum ?? null,
      detail_type: dt,
      description: ln.Description ?? null,
      amount: typeof ln.Amount === 'number' ? ln.Amount : null,
      txn_date: txn.TxnDate || null,
      vendor_name: vendor,
      synced_at: nowIso,
      item_ref_id: null, item_name: null, quantity: null, unit_cost: null,
      account_ref_id: null, account_name: null,
      linked_po_qbo_id: linked ? String(linked.TxnId) : null,
      linked_po_line_id: linked && linked.TxnLineId != null ? String(linked.TxnLineId) : null,
    };
    if (dt === 'ItemBasedExpenseLineDetail' && item) {
      row.item_ref_id = item.ItemRef?.value ?? null;
      row.item_name = item.ItemRef?.name ?? null;
      row.quantity = typeof item.Qty === 'number' ? item.Qty : null;
      row.unit_cost = typeof item.UnitPrice === 'number' ? item.UnitPrice : null;
    } else if (dt === 'AccountBasedExpenseLineDetail' && acct) {
      row.account_ref_id = acct.AccountRef?.value ?? null;
      row.account_name = acct.AccountRef?.name ?? null;
    }
    out.push(row);
  });
  return out;
}

/** A QuickBooks Item → ops.qbo_items row (sync-qbo-items' mapping). */
export function itemRow(it, nowIso = new Date().toISOString()) {
  const fqn = it.FullyQualifiedName ?? null;
  const inc = it.IncomeAccountRef ?? {};
  const exp = it.ExpenseAccountRef ?? {};
  const ass = it.AssetAccountRef ?? {};
  return {
    qbo_item_id: String(it.Id),
    name: it.Name ?? fqn ?? `Item ${it.Id}`,
    fully_qualified_name: fqn,
    sku: it.Sku ?? null,
    type: it.Type ?? null,
    active: it.Active ?? true,
    taxable: typeof it.Taxable === 'boolean' ? it.Taxable : null,
    unit_price: it.UnitPrice ?? null,
    purchase_cost: it.PurchaseCost ?? null,
    qty_on_hand: it.QtyOnHand ?? null,
    income_account_ref_id: inc.value ?? null,
    income_account_name: inc.name ?? null,
    expense_account_ref_id: exp.value ?? null,
    expense_account_name: exp.name ?? null,
    asset_account_ref_id: ass.value ?? null,
    asset_account_name: ass.name ?? null,
    parent_ref_id: it.ParentRef?.value ?? null,
    category_path: fqn && fqn.includes(':') ? fqn.split(':').slice(0, -1).join(':') : null,
    qbo_updated_at: it.MetaData?.LastUpdatedTime ? new Date(it.MetaData.LastUpdatedTime).toISOString() : null,
    synced_at: nowIso,
  };
}

/** A QuickBooks Vendor → ops.qbo_vendors row (push-qbo-item syncVendors' mapping). */
export function vendorRow(v, nowIso = new Date().toISOString()) {
  const addr = v?.BillAddr || {};
  return {
    qbo_vendor_id: String(v.Id),
    display_name: String(v.DisplayName || v.CompanyName || ('Vendor ' + v.Id)),
    company_name: v.CompanyName ?? null,
    active: v.Active !== false,
    email: v?.PrimaryEmailAddr?.Address ?? null,
    phone: v?.PrimaryPhone?.FreeFormNumber ?? null,
    address_line1: addr.Line1 ?? null,
    city: addr.City ?? null,
    state: addr.CountrySubDivisionCode ?? null,
    postal_code: addr.PostalCode ?? null,
    country: addr.Country ?? null,
    default_terms: v?.TermRef?.name ?? null,
    qbo_updated_at: v?.MetaData?.LastUpdatedTime ?? null,
    synced_at: nowIso,
  };
}

/** The item ids a PurchaseOrder's ItemBased lines name (for the mirror pre-check). */
export function itemIdsOnPo(po) {
  const ids = new Set();
  for (const ln of Array.isArray(po?.Line) ? po.Line : []) {
    const v = ln?.ItemBasedExpenseLineDetail?.ItemRef?.value;
    if (ln?.DetailType === 'ItemBasedExpenseLineDetail' && v) ids.add(String(v));
  }
  return [...ids];
}

/**
 * Our PO + its lines + the mirror's names → the QuickBooks PurchaseOrder body.
 * `remote` (the entity as QuickBooks holds it now) is passed on an UPDATE so
 * fields we do not manage (ShipAddr, Memo, custom fields, non-item lines) are
 * carried back untouched — a full-entity POST replaces what it does not
 * receive, and "we edited a quantity" must not read as "we blanked the memo".
 */
export function buildPoPayload({ po, lines, vendorName, itemNames, remote = null }) {
  const itemLines = lines.map((ln) => {
    const qty = Number(ln.qty_ordered || 0);
    const cost = Number(ln.unit_cost || 0);
    const line = {
      DetailType: 'ItemBasedExpenseLineDetail',
      Amount: Number((qty * cost).toFixed(2)),
      Description: ln.description || itemNames[ln.qbo_item_id] || undefined,
      ItemBasedExpenseLineDetail: {
        ItemRef: { value: String(ln.qbo_item_id), name: itemNames[ln.qbo_item_id] || undefined },
        Qty: qty,
        UnitPrice: cost,
        BillableStatus: 'NotBillable',
      },
    };
    if (ln.qbo_line_id) line.Id = String(ln.qbo_line_id);
    return line;
  });
  const keptRemote = remote
    ? (Array.isArray(remote.Line) ? remote.Line : []).filter((l) => l.DetailType !== 'ItemBasedExpenseLineDetail')
    : [];
  const base = remote ? { ...remote } : {};
  delete base.MetaData; delete base.domain; delete base.sparse; delete base.TotalAmt;
  delete base.LinkedTxn; delete base.SyncToken; delete base.Id;
  const payload = {
    ...base,
    VendorRef: { value: String(po.qbo_vendor_id), name: vendorName || undefined },
    DueDate: po.expected_date ? String(po.expected_date) : undefined,
    POStatus: remote?.POStatus || 'Open',
    Line: [...itemLines, ...keptRemote],
    PrivateNote: po.notes || remote?.PrivateNote || ('BRIX PO ' + po.po_number),
  };
  if (remote) {
    payload.Id = String(remote.Id);
    payload.SyncToken = String(remote.SyncToken);
    payload.DocNumber = remote.DocNumber || undefined;
  } else {
    payload.DocNumber = po.po_number ? String(po.po_number).slice(0, 21) : undefined;
    payload.TxnDate = new Date().toISOString().slice(0, 10);
  }
  if (payload.DueDate === undefined) delete payload.DueDate;
  return payload;
}

/**
 * A receipt → the QuickBooks Bill. Every line carries LinkedTxn to the PO
 * (and its line when we know the QuickBooks line Id), which is how QuickBooks
 * marks the PO received/closed itself. DocNumber is the vendor's invoice number
 * when the warehouse has it; otherwise the PO number + receipt short id, so
 * the bill can be found from either side while the invoice is still to come.
 */
export function buildBillFromReceipt({ receipt, po, vendorName, itemNames }) {
  const lines = (Array.isArray(receipt.lines) ? receipt.lines : []).map((l) => {
    const qty = Number(l.qty || 0);
    const cost = Number(l.unit_cost || 0);
    const line = {
      DetailType: 'ItemBasedExpenseLineDetail',
      Amount: Number((qty * cost).toFixed(2)),
      Description: l.description || l.item_name || itemNames[l.qbo_item_id] || undefined,
      ItemBasedExpenseLineDetail: {
        ItemRef: { value: String(l.qbo_item_id), name: itemNames[l.qbo_item_id] || l.item_name || undefined },
        Qty: qty,
        UnitPrice: cost,
        BillableStatus: 'NotBillable',
      },
    };
    if (po.qbo_purchase_order_id) {
      const link = { TxnId: String(po.qbo_purchase_order_id), TxnType: 'PurchaseOrder' };
      if (l.qbo_line_id) link.TxnLineId = String(l.qbo_line_id);
      line.LinkedTxn = [link];
    }
    return line;
  });
  const inv = receipt.vendor_invoice_number ? String(receipt.vendor_invoice_number).trim() : '';
  const shortId = String(receipt.id || '').replace(/-/g, '').slice(0, 6).toUpperCase();
  return {
    VendorRef: { value: String(po.qbo_vendor_id), name: vendorName || undefined },
    TxnDate: receipt.invoice_date || String(receipt.received_at || new Date().toISOString()).slice(0, 10),
    DocNumber: (inv || `${po.po_number}-R${shortId}`).slice(0, 21),
    Line: lines,
    PrivateNote: `Received in Refractor against ${po.po_number}` + (inv ? '' : ' — vendor invoice not yet in hand')
      + ` · receipt ${receipt.id}`,
  };
}

// ── QuickBooks reads ──────────────────────────────────────────────────────

async function qboQueryAll(sql, entity) {
  const out = [];
  const page = 1000;
  for (let start = 1; ; start += page) {
    const j = await qboQuery(`${sql} startposition ${start} maxresults ${page}`);
    const list = j?.QueryResponse?.[entity] ?? [];
    out.push(...list);
    if (list.length < page) break;
  }
  return out;
}

/** GET /cdc for the entities we mirror. Returns { PurchaseOrder:[], Bill:[], VendorCredit:[], Item:[] }. */
export async function qboCdc(sinceIso) {
  const j = await qboRequest('GET', `/cdc?entities=PurchaseOrder,Bill,VendorCredit,Item&changedSince=${encodeURIComponent(sinceIso)}`);
  const out = { PurchaseOrder: [], Bill: [], VendorCredit: [], Item: [] };
  for (const resp of j?.CDCResponse ?? []) {
    for (const qr of resp?.QueryResponse ?? []) {
      for (const k of Object.keys(out)) if (Array.isArray(qr[k])) out[k].push(...qr[k]);
    }
  }
  return out;
}

// ── mirror maintenance ─────────────────────────────────────────────────────

/** Make sure every vendor id is in ops.qbo_vendors, pulling any that are not. Returns ids pulled. */
export async function ensureVendorsMirrored(vendorIds) {
  const ids = [...new Set(vendorIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const have = await ops('GET', `qbo_vendors?select=qbo_vendor_id&qbo_vendor_id=in.(${ids.map((i) => `"${i}"`).join(',')})`);
  const haveSet = new Set((have || []).map((r) => r.qbo_vendor_id));
  const missing = ids.filter((i) => !haveSet.has(i));
  const rows = [];
  for (const id of missing) {
    const j = await qboRequest('GET', `/vendor/${encodeURIComponent(id)}`);
    if (j?.Vendor?.Id) rows.push(vendorRow(j.Vendor));
  }
  await upsert('qbo_vendors', rows, 'qbo_vendor_id');
  return rows.map((r) => r.qbo_vendor_id);
}

/** Same for items. Returns ids pulled. */
export async function ensureItemsMirrored(itemIds) {
  const ids = [...new Set(itemIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const have = await ops('GET', `qbo_items?select=qbo_item_id&qbo_item_id=in.(${ids.map((i) => `"${i}"`).join(',')})`);
  const haveSet = new Set((have || []).map((r) => r.qbo_item_id));
  const missing = ids.filter((i) => !haveSet.has(i));
  const rows = [];
  for (const id of missing) {
    const j = await qboRequest('GET', `/item/${encodeURIComponent(id)}`);
    if (j?.Item?.Id) rows.push(itemRow(j.Item));
  }
  await upsert('qbo_items', rows, 'qbo_item_id');
  return rows.map((r) => r.qbo_item_id);
}

/**
 * Re-read QuickBooks' own quantities for every Inventory item into
 * ops.qbo_items — the number the drift strip compares the ledger against. The
 * nightly sync-qbo-items still owns the full item catalogue (inactives,
 * accounts); this is the fast lane for QtyOnHand.
 */
export async function refreshInventoryItems(itemIds = null) {
  let items;
  if (itemIds && itemIds.length) {
    items = [];
    for (const id of [...new Set(itemIds.map(String))]) {
      const j = await qboRequest('GET', `/item/${encodeURIComponent(id)}`);
      if (j?.Item?.Id) items.push(j.Item);
    }
  } else {
    items = await qboQueryAll("select * from Item where Type = 'Inventory'", 'Item');
  }
  const rows = items.map((it) => itemRow(it));
  await upsert('qbo_items', rows, 'qbo_item_id');
  return rows.length;
}

/** One QuickBooks PurchaseOrder JSON → our mirror row. Pulls vendor/items first. */
export async function mirrorPo(po) {
  if (po?.status !== 'Deleted') {
    await ensureVendorsMirrored([po?.VendorRef?.value]);
    await ensureItemsMirrored(itemIdsOnPo(po));
  }
  return rpc('fn_qbo_po_mirror_upsert', { p_po: po });
}

/** Re-read one PO from QuickBooks by its id and mirror it. */
export async function pullPo(qboPoId) {
  const j = await qboRequest('GET', `/purchaseorder/${encodeURIComponent(qboPoId)}`);
  if (!j?.PurchaseOrder?.Id) throw new Error(`QuickBooks returned no PurchaseOrder for id ${qboPoId}`);
  return mirrorPo(j.PurchaseOrder);
}

/** Mirror a Bill / VendorCredit's lines (or drop them when deleted). */
export async function mirrorBill(txn, type) {
  const id = String(txn.Id);
  if (txn.status === 'Deleted') {
    await ops('DELETE', `qbo_expense_lines?qbo_txn_type=eq.${type}&qbo_txn_id=eq.${encodeURIComponent(id)}`, undefined, null, 'return=minimal');
    return { id, deleted: true, lines: 0 };
  }
  const rows = billLineRows(txn, type);
  // lines QuickBooks no longer has on this bill
  const keep = rows.map((r) => `"${r.line_key.replace(/"/g, '')}"`).join(',');
  if (rows.length) {
    await ops('DELETE', `qbo_expense_lines?qbo_txn_type=eq.${type}&qbo_txn_id=eq.${encodeURIComponent(id)}&line_key=not.in.(${keep})`, undefined, null, 'return=minimal');
  }
  await upsert('qbo_expense_lines', rows, 'qbo_txn_type,qbo_txn_id,line_key');
  return { id, deleted: false, lines: rows.length, linked_pos: [...new Set(rows.map((r) => r.linked_po_qbo_id).filter(Boolean))] };
}

// ── the sync run ──────────────────────────────────────────────────────────

export async function lastPurchasingSuccess() {
  const rows = await ops('GET', 'sync_log?select=completed_at&source=eq.qbo&sync_type=eq.purchasing&status=eq.success&order=completed_at.desc&limit=1');
  return rows?.[0]?.completed_at ?? null;
}

/** Full-pull PO window: a year before the bill apply_from, ISO date. */
export function poWindowStart(fromIso) {
  const d = new Date(String(fromIso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '2025-09-01';
  d.setUTCDate(d.getUTCDate() - 365);
  return d.toISOString().slice(0, 10);
}

async function applyFrom() {
  const rows = await ops('GET', 'purchase_ledger_config?select=apply_from&limit=1');
  return rows?.[0]?.apply_from ?? '2026-09-03';
}

/**
 * The whole pull. Never throws for a single PO or bill — each failure is
 * collected and the run is logged either way, because a run that dies before
 * logging reads as "nothing to do" (the sf-receipt-sync lesson).
 */
export async function runPurchasingSync({ trigger = 'manual', budgetMs = 20_000, singlePo = null } = {}) {
  const started = new Date();
  const deadline = started.getTime() + budgetMs;
  const meta = { trigger, mode: null, since: null, pos: 0, bills: 0, items: 0, conflicts: 0, vendors_pulled: 0, items_pulled: 0, errors: [], feed: null };
  let status = 'success';
  let errorMessage = null;
  const timeLeft = () => Date.now() < deadline;

  try {
    if (singlePo) {
      meta.mode = 'single';
      const r = await pullPo(singlePo);
      meta.pos = 1;
      if (r?.action === 'skipped_dirty') meta.conflicts = 1;
      meta.result = r;
    } else {
      const last = await lastPurchasingSuccess();
      const win = cdcWindow(last, started);
      meta.mode = win.mode; meta.since = win.since ?? null;

      let pos = [], bills = [], credits = [], changedItems = [];
      if (win.mode === 'full') {
        const from = await applyFrom();
        // POStatus is NOT a queryable field on PurchaseOrder — QuickBooks answers
        // 400 QueryValidationError, and because a failed full pull never logs a
        // success, every 15-minute run retried the full pull and failed again
        // (found 2026-09-04: the purchasing light had been red since the first
        // run). Pull by TxnDate instead — a year back, so an open PO raised
        // months ago is still mirrored — and let fn_qbo_po_mirror_upsert read
        // the status off each row; closed ones are mirrored too, which is what
        // "QuickBooks and Refractor share one PO table" means.
        pos = await qboQueryAll(`select * from PurchaseOrder where TxnDate >= '${poWindowStart(from)}'`, 'PurchaseOrder');
        bills = await qboQueryAll(`select * from Bill where TxnDate >= '${from}'`, 'Bill');
        credits = await qboQueryAll(`select * from VendorCredit where TxnDate >= '${from}'`, 'VendorCredit');
      } else {
        const c = await qboCdc(win.since);
        pos = c.PurchaseOrder; bills = c.Bill; credits = c.VendorCredit; changedItems = c.Item;
      }

      // POs first: a bill's LinkedTxn may point at one that arrived in the same window.
      const touchedPos = new Set();
      for (const po of pos) {
        if (!timeLeft()) { meta.errors.push('budget: stopped before PO ' + po.Id); break; }
        try {
          const r = await mirrorPo(po);
          meta.pos += 1;
          if (r?.action === 'skipped_dirty') meta.conflicts += 1;
          touchedPos.add(String(po.Id));
        } catch (e) {
          meta.errors.push(`PO ${po.DocNumber || po.Id}: ${e.message}`.slice(0, 300));
        }
      }

      const linkedPos = new Set();
      for (const [list, type] of [[bills, 'Bill'], [credits, 'VendorCredit']]) {
        for (const txn of list) {
          if (!timeLeft()) { meta.errors.push('budget: stopped before ' + type + ' ' + txn.Id); break; }
          try {
            const r = await mirrorBill(txn, type);
            meta.bills += 1;
            for (const p of r.linked_pos || []) if (!touchedPos.has(p)) linkedPos.add(p);
          } catch (e) {
            meta.errors.push(`${type} ${txn.DocNumber || txn.Id}: ${e.message}`.slice(0, 300));
          }
        }
      }
      // A bill received against a PO in QuickBooks changes that PO's status;
      // if the PO itself was not in this window, re-read it.
      for (const p of linkedPos) {
        if (!timeLeft()) break;
        try { await pullPo(p); meta.pos += 1; } catch (e) { meta.errors.push(`PO ${p} (from bill link): ${e.message}`.slice(0, 300)); }
      }

      // Item quantities: the whole Inventory set every run — it is one query
      // and it is the number the drift strip is measured against.
      if (timeLeft()) {
        try {
          meta.items = await refreshInventoryItems(null);
          meta.items_changed = changedItems.length;
        } catch (e) { meta.errors.push('items: ' + e.message.slice(0, 300)); }
      }
    }

    // The purchase feed (bills → ledger receipts) runs inside the same call,
    // so a bill mirrored a second ago reaches the ledger now and not at the
    // next tick. It logs its own sync_log row.
    try { meta.feed = await rpc('fn_purchase_ledger_run', {}); }
    catch (e) { meta.errors.push('purchase feed: ' + e.message.slice(0, 300)); }

    if (meta.errors.length && meta.pos === 0 && meta.bills === 0 && meta.items === 0) {
      status = 'error'; errorMessage = meta.errors.join(' | ').slice(0, 900);
    }
  } catch (e) {
    status = 'error';
    errorMessage = String(e?.message || e).slice(0, 900);
    meta.errors.push(errorMessage);
  }

  const completed = new Date();
  try {
    await ops('POST', 'sync_log', {
      source: 'qbo', sync_type: 'purchasing', status,
      started_at: started.toISOString(), completed_at: completed.toISOString(),
      records_synced: meta.pos + meta.bills, error_message: errorMessage,
      metadata: { ...meta, elapsed_ms: completed - started },
    }, null, 'return=minimal');
  } catch (e) {
    meta.errors.push('sync_log: ' + e.message);
  }
  return { ok: status === 'success', status, ...meta, elapsed_ms: completed - started };
}

// ── shared helpers for the push + receive functions ───────────────────────

export async function loadPoForQbo(poId) {
  const [pos, lines] = await Promise.all([
    ops('GET', `purchase_orders?select=*&id=eq.${poId}`),
    ops('GET', `purchase_order_lines?select=*&po_id=eq.${poId}&order=sort_order.asc`),
  ]);
  const po = pos?.[0];
  if (!po) throw new Error('purchase order not found');
  const vendors = await ops('GET', `qbo_vendors?select=qbo_vendor_id,display_name&qbo_vendor_id=eq.${encodeURIComponent(po.qbo_vendor_id)}`);
  const ids = [...new Set((lines || []).map((l) => l.qbo_item_id))];
  const items = ids.length
    ? await ops('GET', `qbo_items?select=qbo_item_id,name,active&qbo_item_id=in.(${ids.map((i) => `"${i}"`).join(',')})`)
    : [];
  const itemNames = Object.fromEntries((items || []).map((i) => [i.qbo_item_id, i.name]));
  const inactive = (items || []).filter((i) => i.active === false).map((i) => i.name || i.qbo_item_id);
  return { po, lines: lines || [], vendorName: vendors?.[0]?.display_name ?? null, itemNames, inactive };
}

/** Create the PO in QuickBooks and stamp the ids back. Refuses if it already exists there. */
export async function pushPoCreate(poId, bearer) {
  const { po, lines, vendorName, itemNames, inactive } = await loadPoForQbo(poId);
  if (po.qbo_purchase_order_id) return { no_change: true, qbo_purchase_order_id: po.qbo_purchase_order_id, po };
  if (po.status === 'void') throw new Error(`${po.po_number} is void`);
  if (!lines.length) throw new Error(`${po.po_number} has no lines`);
  if (inactive.length) throw new Error(`inactive in QuickBooks: ${inactive.join(', ')} — reactivate them or take them off the PO`);
  const payload = buildPoPayload({ po, lines, vendorName, itemNames });
  let created;
  try {
    const r = await qboRequest('POST', '/purchaseorder', payload);
    created = r?.PurchaseOrder;
    if (!created?.Id) throw new Error('QuickBooks returned no PurchaseOrder id');
  } catch (e) {
    await rpc('fn_po_mark_push_error', { p_po_id: poId, p_error: e.message }, bearer).catch(() => {});
    throw e;
  }
  await rpc('fn_po_mark_pushed', { p_po_id: poId, p_po: created }, bearer);
  return { no_change: false, qbo_purchase_order_id: String(created.Id), created, po };
}

/**
 * Push local edits onto the PO QuickBooks already has. The SyncToken is the
 * conflict check: if QuickBooks' token is not the one we last saw, someone
 * changed it there since, and the caller decides (409) — unless `force`.
 */
export async function pushPoUpdate(poId, { force = false } = {}, bearer) {
  const { po, lines, vendorName, itemNames, inactive } = await loadPoForQbo(poId);
  if (!po.qbo_purchase_order_id) return pushPoCreate(poId, bearer);
  if (inactive.length) throw new Error(`inactive in QuickBooks: ${inactive.join(', ')}`);
  const j = await qboRequest('GET', `/purchaseorder/${encodeURIComponent(po.qbo_purchase_order_id)}`);
  const remote = j?.PurchaseOrder;
  if (!remote?.Id) throw new Error('QuickBooks no longer has this PurchaseOrder');
  if (!force && po.qbo_sync_token != null && String(remote.SyncToken) !== String(po.qbo_sync_token)) {
    return {
      conflict: true,
      message: `${po.po_number} was changed in QuickBooks since it was last pulled (QuickBooks version ${remote.SyncToken}, ours ${po.qbo_sync_token}). Reload it from QuickBooks and redo the edit, or force the push to overwrite QuickBooks.`,
      remote_sync_token: String(remote.SyncToken), local_sync_token: po.qbo_sync_token, remote,
    };
  }
  const payload = buildPoPayload({ po, lines, vendorName, itemNames, remote });
  let updated;
  try {
    const r = await qboRequest('POST', '/purchaseorder', payload);
    updated = r?.PurchaseOrder;
    if (!updated?.Id) throw new Error('QuickBooks returned no PurchaseOrder');
  } catch (e) {
    await rpc('fn_po_mark_push_error', { p_po_id: poId, p_error: e.message }, bearer).catch(() => {});
    throw e;
  }
  await rpc('fn_po_mark_pushed', { p_po_id: poId, p_po: updated }, bearer);
  // now that qbo_dirty is clear, let the mirror refresh subtotal/status/line ids from the truth
  await rpc('fn_qbo_po_mirror_upsert', { p_po: updated }).catch(() => {});
  return { conflict: false, qbo_purchase_order_id: String(updated.Id), sync_token: String(updated.SyncToken) };
}

/** After a bill lands: mirror its lines, refresh the items' QtyOnHand, re-read the PO. Best-effort. */
export async function afterBillLanded(bill, qboPoId) {
  const notes = [];
  try { await mirrorBill(bill, 'Bill'); } catch (e) { notes.push('mirror bill: ' + e.message); }
  try {
    const ids = itemIdsOnPo(bill);
    if (ids.length) await refreshInventoryItems(ids);
  } catch (e) { notes.push('refresh items: ' + e.message); }
  if (qboPoId) { try { await pullPo(qboPoId); } catch (e) { notes.push('re-read PO: ' + e.message); } }
  return notes;
}
