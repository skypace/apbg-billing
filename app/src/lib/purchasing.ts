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
  /** open | pending | closed | voided — ops.fn_status_bucket, from the view. */
  bucket?: string | null;
  po_kind?: 'materials' | 'production' | 'other' | null;
  reopened_at?: string | null;
  reopen_reason?: string | null;
  /** on_receipt (closes itself when every receivable line is in) | on_run_yield (the co-packer's PO — closes when the run ships). */
  close_rule?: PoCloseRule | null;
  closed_reason?: string | null;
  receivable_line_count?: number | null;
  /** The run this PO was raised from (20260903f); work_order_id is null on a run PO. */
  production_run_id?: string | null;
  run_number?: string | null;
  /** Every WO the lines cover, comma-joined — a run PO carries several. */
  work_order_batch_codes?: string | null;
  /** Σ (ordered − demand) — the MOQ / pack surplus that will sit at the co-packer. */
  qty_surplus_total?: number | null;
}

export type PoCloseRule = 'on_receipt' | 'on_run_yield';

/** What the close rule means, in the words the screen uses. */
export function closeRuleCopy(po: { close_rule?: PoCloseRule | null; work_order_id?: string | null; production_run_id?: string | null; receivable_line_count?: number | null }): { label: string; detail: string } {
  if (po.close_rule === 'on_run_yield') {
    return { label: 'Closes when the run ships', detail: 'The co-packer supplies and performs these itself — nothing is received against this PO. It closes by itself when the run ships its finished goods.' };
  }
  if (po.work_order_id || po.production_run_id) {
    return { label: 'Closes on receipt', detail: 'Closes by itself once every receivable line is fully received; every work order on it moves to "materials at co-packer" when the last such PO closes.' };
  }
  return { label: 'Closes on Close', detail: 'A standalone PO: receive its lines, then press Close.' };
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
  /** false on a service line or any line of an on_run_yield PO — nothing arrives, nothing is received. */
  receivable?: boolean | null;
  /** ordered − shortfall when the vendor's terms lifted this line (run POs). */
  moq_applied?: number | null;
  /** Σ demand the line covers; surplus = qty_ordered − demand_total. */
  demand_total?: number | null;
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

/** Closed → recomputed from its lines (received / partial / open). QBO PurchaseOrder is untouched. */
export async function reopenPurchaseOrder(poId: string, reason: string): Promise<string> {
  return sbrpc<string>('fn_reopen_purchase_order', { p_po_id: poId, p_reason: reason });
}

/** Correct a line's received quantity up or down (a compensating movement, never an edit). */
export async function adjustReceipt(args: {
  po_line_id: string; new_qty_received: number; reason: string; occurred_at?: string | null;
}): Promise<{ po_id: string; from: number; to: number; delta: number; status: string }> {
  return sbrpc('fn_adjust_receipt', {
    p_po_line_id: args.po_line_id, p_new_qty_received: args.new_qty_received,
    p_reason: args.reason, p_occurred_at: args.occurred_at ?? new Date().toISOString(),
  });
}

// ── QBO writebacks via push-qbo-item ─────────────────────────────────────

async function callPushQboItem<T>(body: Record<string, unknown>): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/functions/v1/push-qbo-item', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || (j && j.ok === false)) {
    throw new Error(j?.error || ('push-qbo-item failed: HTTP ' + res.status));
  }
  return j as T;
}

// One-shot: pulls QBO Vendors into ops.qbo_vendors. Idempotent.
export async function pullQboVendorsNow(): Promise<SyncVendorsResult> {
  return callPushQboItem<SyncVendorsResult>({ action: 'syncVendors' });
}

// Push a PO to QBO as a PurchaseOrder. Idempotent — refuses if the PO
// already has qbo_purchase_order_id set. dry_run returns the payload
// preview without posting.
export async function pushPoToQbo(
  poId: string,
  opts: { dry_run?: boolean } = {},
): Promise<PushPoToQboResult> {
  return callPushQboItem<PushPoToQboResult>({
    action: 'postPurchaseOrder',
    purchase_order_id: poId,
    dry_run: opts.dry_run ?? false,
  });
}
