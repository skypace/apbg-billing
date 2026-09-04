import { sbq, sbrpc } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────

export interface QboVendor {
  qbo_vendor_id: string;
  display_name: string;
  company_name: string | null;
  active: boolean;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  default_terms: string | null;
  qbo_updated_at: string | null;
  synced_at: string;
}

export type PoStatus = 'draft' | 'open' | 'partial' | 'received' | 'closed' | 'void';

export interface PurchaseOrderRow {
  id: string;
  po_number: string;
  qbo_vendor_id: string;
  vendor_name: string | null;
  destination_location_id: string;
  location_label: string | null;
  status: PoStatus;
  expected_date: string | null;
  subtotal: number;
  notes: string | null;
  qbo_purchase_order_id: string | null;
  qbo_pushed_at: string | null;
  qbo_push_error: string | null;
  /** Set when this PO was generated from a work order. */
  work_order_id: string | null;
  work_order_batch_code: string | null;
  ordered_at: string | null;
  received_at: string | null;
  closed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  line_count: number;
  qty_ordered_total: number;
  qty_received_total: number;
  created_at: string;
  updated_at: string;
  po_kind?: 'materials' | 'production' | 'other' | null;
  production_run_id?: string | null;
  run_number?: string | null;
  /** 'brix' = created here; 'qbo' = created in QuickBooks and mirrored (20260904d). */
  origin: 'brix' | 'qbo';
  /** QuickBooks' own POStatus (Open / Closed / Deleted) as of the last pull. */
  qbo_status: string | null;
  qbo_doc_number: string | null;
  qbo_sync_token: string | null;
  qbo_synced_at: string | null;
  /** Edited here since the last push — the pull leaves it alone until it is pushed. */
  qbo_dirty: boolean;
  qbo_skipped_lines: { line?: string; detail_type?: string; description?: string; amount?: string; reason?: string }[] | null;
  receipt_count: number;
  last_receipt_at: string | null;
  /** Receipts whose QuickBooks bill has not landed (failed or in flight). */
  bills_pending: number;
}

export interface PurchaseOrderLine {
  id: string;
  po_id: string;
  qbo_item_id: string;
  description: string | null;
  qty_ordered: number;
  qty_received: number;
  unit_cost: number;
  sort_order: number;
  notes: string | null;
  created_at: string;
  receivable?: boolean;
  /** The QuickBooks line Id — what a bill's LinkedTxn points at. */
  qbo_line_id?: string | null;
}

/** One receiving event: what arrived, who took it, and the bill it became. */
export interface PoReceipt {
  id: string;
  po_id: string;
  received_at: string;
  received_by_email: string | null;
  vendor_invoice_number: string | null;
  invoice_date: string | null;
  notes: string | null;
  lines: { po_line_id: string; qbo_item_id: string; item_name?: string; qty: number; unit_cost: number; amount: number }[];
  total_amount: number;
  completes_po: boolean;
  qbo_bill_id: string | null;
  qbo_bill_doc_number: string | null;
  qbo_pushed_at: string | null;
  qbo_error: string | null;
  qbo_attempts: number;
  expense_request_id: string | null;
}

export type PurchaseOrderLineSummary = Pick<PurchaseOrderLine, 'po_id' | 'qbo_item_id'>;

export interface PoLineInput {
  qbo_item_id: string;
  description?: string | null;
  qty_ordered: number;
  unit_cost?: number;
  notes?: string | null;
}

export interface PushPoToQboResult {
  ok: boolean;
  no_change?: boolean;
  dry_run?: boolean;
  purchase_order_id: string;
  qbo_purchase_order_id?: string;
  qbo_pushed_at?: string;
  vendor?: { id: string; name: string };
  line_count?: number;
  skipped?: { line_id: string; qbo_item_id: string; reason: string }[];
  payload?: unknown;
  error?: string;
  duration_ms?: number;
  message?: string;
}

export interface SyncVendorsResult {
  ok: boolean;
  vendors_synced: number;
  duration_ms?: number;
  error?: string;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function fetchVendors(): Promise<QboVendor[]> {
  return sbq<QboVendor>('qbo_vendors', 'select=*&active=eq.true&order=display_name.asc&limit=2000');
}

export async function fetchPurchaseOrders(limit = 200): Promise<PurchaseOrderRow[]> {
  return sbq<PurchaseOrderRow>('v_purchase_orders', `select=*&order=created_at.desc&limit=${limit}`);
}

export async function fetchPoLines(poId: string): Promise<PurchaseOrderLine[]> {
  return sbq<PurchaseOrderLine>('purchase_order_lines',
    `select=*&po_id=eq.${poId}&order=sort_order.asc`);
}

export async function fetchAllPoLineSummaries(): Promise<PurchaseOrderLineSummary[]> {
  return sbq<PurchaseOrderLineSummary>(
    'purchase_order_lines',
    'select=po_id,qbo_item_id',
  );
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function createPurchaseOrder(args: {
  qbo_vendor_id: string;
  destination_location_id: string;
  lines: PoLineInput[];
  expected_date?: string | null;
  notes?: string | null;
}): Promise<string> {
  return sbrpc<string>('fn_create_purchase_order', {
    p_qbo_vendor_id:           args.qbo_vendor_id,
    p_destination_location_id: args.destination_location_id,
    p_lines:                   args.lines,
    p_expected_date:           args.expected_date ?? null,
    p_notes:                   args.notes ?? null,
  });
}

export async function receivePurchaseOrderLine(args: {
  po_line_id: string;
  qty_received: number;
  unit_cost?: number | null;
  receipt_date?: string | null;
}): Promise<void> {
  await sbrpc('fn_receive_purchase_order_line', {
    p_po_line_id:   args.po_line_id,
    p_qty_received: args.qty_received,
    p_unit_cost:    args.unit_cost ?? null,
    p_receipt_date: args.receipt_date ?? null,
  });
}

export async function closePurchaseOrder(poId: string): Promise<void> {
  await sbrpc('fn_close_purchase_order', { p_po_id: poId });
}

export async function voidPurchaseOrder(poId: string, reason: string): Promise<void> {
  await sbrpc('fn_void_purchase_order', { p_po_id: poId, p_reason: reason });
}

// ── QuickBooks: the two-way street ───────────────────────────────────────
//
// Pull, push, receive and Sync now all go through Netlify functions that hold
// the QuickBooks token (netlify/functions/qbo-purchasing-sync.mjs,
// po-qbo-push.mjs, po-receive.mjs). The app reaches them through the gateway
// at /margin/.netlify/functions/<name>; pg_cron reaches the sync at
// /api/qbo-purchasing-sync. One implementation behind both doors.

const FN_BASE = '/margin/.netlify/functions/';

async function callFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const token = await _sbToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch(FN_BASE + name, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try { j = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { j = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(String(j.message ?? j.error ?? (name + ' failed: HTTP ' + res.status))) as Error & {
      status?: number; body?: Record<string, unknown>;
    };
    err.status = res.status; err.body = j;
    throw err;
  }
  return j as T;
}

export function isConflict(e: unknown): e is Error & { status: number; body: Record<string, unknown> } {
  return e instanceof Error && (e as { status?: number }).status === 409;
}

export interface PurchasingSyncResult {
  ok: boolean;
  mode: 'full' | 'cdc' | 'single' | null;
  pos: number;
  bills: number;
  items: number;
  conflicts: number;
  errors: string[];
  elapsed_ms: number;
}

/** Pull QuickBooks purchasing now — POs, bills, item quantities, then the purchase feed. */
export async function syncPurchasingNow(): Promise<PurchasingSyncResult> {
  return callFn<PurchasingSyncResult>('qbo-purchasing-sync', {});
}

// One-shot: pulls QBO Vendors into ops.qbo_vendors. Idempotent. Still the
// push-qbo-item edge function — it has not moved.
export async function pullQboVendorsNow(): Promise<SyncVendorsResult> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/functions/v1/push-qbo-item', {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'syncVendors' }),
  });
  const j = await res.json();
  if (!res.ok || (j && j.ok === false)) throw new Error(j?.error || ('push-qbo-item failed: HTTP ' + res.status));
  return j as SyncVendorsResult;
}

export interface PushResult { ok: boolean; no_change?: boolean; qbo_purchase_order_id?: string; sync_token?: string; message?: string }

/** A native PO into QuickBooks (create) — or local edits onto the one it already has (update). */
export async function pushPoToQbo(poId: string, opts: { force?: boolean } = {}): Promise<PushResult> {
  return callFn<PushResult>('po-qbo-push', { action: 'update', po_id: poId, force: opts.force === true });
}

/** Re-read one PO from QuickBooks. `discardLocal` drops edits made here that were never pushed. */
export async function reloadPoFromQbo(poId: string, discardLocal = false): Promise<{ ok: boolean; message?: string }> {
  return callFn('po-qbo-push', { action: 'pull', po_id: poId, discard_local: discardLocal });
}

export interface PoLineEdit {
  id?: string | null;          // an existing line; omit for a new one
  qbo_item_id: string;
  description?: string | null;
  qty_ordered: number;
  unit_cost: number;
}

/** Edit header + lines here (ops.fn_po_update), then push when QuickBooks holds the PO. */
export async function updatePurchaseOrder(
  poId: string,
  patch: { expected_date?: string | null; notes?: string | null },
  lines: PoLineEdit[] | null,
  opts: { push?: boolean; force?: boolean } = {},
): Promise<{ qbo_dirty: boolean; pushed: PushResult | null }> {
  const r = await sbrpc<{ po_id: string; qbo_dirty: boolean; lines: number }>('fn_po_update', {
    p_po_id: poId, p_patch: patch, p_lines: lines,
  });
  let pushed: PushResult | null = null;
  if (r.qbo_dirty && opts.push !== false) pushed = await pushPoToQbo(poId, { force: opts.force });
  return { qbo_dirty: r.qbo_dirty, pushed };
}

export interface ReceiveResult {
  ok: boolean;
  receipt_id: string;
  total: number;
  completes_po: boolean;
  qbo_bill_id?: string;
  qbo_bill_doc_number?: string | null;
  expense_request_id?: string | null;
  error?: string;
}

/**
 * Receive lines on a PO: the ledger moves, the QuickBooks Bill is created
 * linked to the PO, and a posted Brixpense row waits for the vendor's invoice.
 * A 502 means the STOCK landed but the bill did not — the receipt row carries
 * the error and Retry bill finishes it.
 */
export async function receivePurchaseOrder(args: {
  po_id: string;
  lines: { po_line_id: string; qty: number }[];
  vendor_invoice_number?: string | null;
  invoice_date?: string | null;
  notes?: string | null;
}): Promise<ReceiveResult> {
  return callFn<ReceiveResult>('po-receive', { action: 'create', ...args });
}

export async function retryReceiptBill(receiptId: string): Promise<ReceiveResult> {
  return callFn<ReceiveResult>('po-receive', { action: 'retry', receipt_id: receiptId });
}

export async function fetchPoReceipts(poId: string): Promise<PoReceipt[]> {
  return sbq<PoReceipt>('po_receipts', `select=*&po_id=eq.${poId}&order=received_at.desc`);
}

/** When QuickBooks purchasing was last pulled, and how old the item quantities are. */
export interface PurchasingSyncStatus { purchasing_synced_at: string | null; qbo_as_of: string | null }
export async function fetchPurchasingSyncStatus(): Promise<PurchasingSyncStatus | null> {
  const rows = await sbq<PurchasingSyncStatus>('v_inventory_ledger_status', 'select=purchasing_synced_at,qbo_as_of&limit=1');
  return rows[0] ?? null;
}
