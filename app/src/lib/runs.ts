// Production runs — the ORDER: one document, several bills of materials, one
// purchase order per vendor for the lot (migration 20260903f).
//
// A run is a parent; each flavour on it is an ordinary work order (run_id), so
// yield, lots, costs and the BOL machinery are the same rows they always were.
// What happens at the RUN level: PO generation (aggregated per vendor, netted
// against stock already at the co-packer, lifted to MOQ), one bill of lading
// for the truck, the void cascade, close and reopen.

import { sbq, sbrpc } from './rpc';
import type { WorkOrderView } from './production';
import type { PurchaseOrderRow } from './purchasing';

export type RunStatus = 'draft' | 'ordered' | 'in_progress' | 'closed' | 'void';

export interface ProductionRun {
  id: string;
  run_number: string;
  status: RunStatus;
  copacker_qbo_vendor_id: string;
  copacker_location_id: string;
  destination_location_id: string;
  scheduled_date: string | null;
  tank_size_gal: number | null;
  net_against_stock: boolean;
  notes: string | null;
  ordered_at: string | null;
  started_at: string | null;
  shipped_at: string | null;
  closed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  created_at: string;
  // v_production_runs
  copacker_vendor_name: string | null;
  copacker_location_label: string | null;
  destination_location_label: string | null;
  bucket: 'open' | 'pending' | 'closed' | 'voided';
  wo_count: number;
  wo_live_count: number;
  cases_planned: number;
  cases_produced: number | null;
  flavours: string | null;
  stages: string | null;
  po_count: number;
  po_open_count: number;
  po_total: number;
  total_cost: number | null;
  reserved_lines: number;
}

export interface RunLineInput { bom_id: string; qty_to_produce: number; batch_size_gal?: number | null; notes?: string | null }

export interface RunPreviewLine {
  qbo_item_id: string; item_name: string; item_type: string | null;
  demand: number; on_hand: number; reserved: number; available: number;
  use_stock: number; shortfall: number; ordered: number; surplus: number;
  moq: number | null; multiple: number | null; unit_cost: number | null; ext: number;
  receivable: boolean;
  from: { bom: string; qty: number }[];
}
export interface RunPreviewPo {
  qbo_vendor_id: string | null; vendor_name: string;
  close_rule: 'on_receipt' | 'on_run_yield';
  lines: RunPreviewLine[]; subtotal: number;
}
export interface RunPreview {
  pos: RunPreviewPo[];
  blockers: { kind: string; bom_id: string; qbo_item_id?: string; item_name?: string; detail: string }[];
  warnings: { kind: string; bom_id: string; qbo_item_id?: string; item_name?: string; detail: string }[];
  total: number;
  lines: { bom_id: string; bom_name: string; qty: number }[];
}

export interface Reservation {
  id: string; qbo_item_id: string; location_id: string; qty: number;
  run_id: string | null; wo_id: string | null; wo_material_id: string | null;
  status: 'active' | 'consumed' | 'released'; note: string | null; created_at: string; resolved_at: string | null;
}

export interface RunAdvanceResult { done: { id: string; number: string }[]; skipped: { id: string; number: string; reason: string }[] }
export interface RunShipResult { transfer_id: string; bol_number: string; work_orders: string[]; closed_pos: string[] }
export interface RunVoidResult { voided_pos: string[]; short_closed_pos: string[]; released_reservations: number; qbo_pos_to_close: { po_number: string; qbo_purchase_order_id: string }[] }

// ── reads ────────────────────────────────────────────────────────────────────
export async function fetchRuns(limit = 200): Promise<ProductionRun[]> {
  const rows = await sbq<ProductionRun>('v_production_runs', `select=*&order=created_at.desc&limit=${limit}`);
  return rows.map((r) => ({ ...r,
    cases_planned: Number(r.cases_planned ?? 0), cases_produced: r.cases_produced == null ? null : Number(r.cases_produced),
    po_total: Number(r.po_total ?? 0), total_cost: r.total_cost == null ? null : Number(r.total_cost) }));
}
export async function fetchRunWorkOrders(runId: string): Promise<WorkOrderView[]> {
  return sbq<WorkOrderView>('v_work_orders', `select=*&run_id=eq.${runId}&order=created_at.asc`);
}
export async function fetchRunPurchaseOrders(runId: string): Promise<PurchaseOrderRow[]> {
  return sbq<PurchaseOrderRow>('v_purchase_orders', `select=*&production_run_id=eq.${runId}&order=created_at.asc`);
}
export async function fetchRunReservations(runId: string): Promise<Reservation[]> {
  return sbq<Reservation>('inventory_reservations', `select=*&run_id=eq.${runId}&order=created_at.asc`);
}

// ── writes (all guarded RPCs) ────────────────────────────────────────────────
export async function previewRun(lines: RunLineInput[], copackerVendorId: string, copackerLocationId: string, netAgainstStock: boolean): Promise<RunPreview> {
  return sbrpc<RunPreview>('fn_run_preview', {
    p_lines: lines, p_copacker_qbo_vendor_id: copackerVendorId, p_copacker_location_id: copackerLocationId, p_net_against_stock: netAgainstStock,
  });
}
export async function createRun(args: {
  lines: RunLineInput[]; copacker_qbo_vendor_id: string; copacker_location_id: string; destination_location_id: string;
  scheduled_date?: string | null; tank_size_gal?: number | null; notes?: string | null; net_against_stock?: boolean;
}): Promise<string> {
  return sbrpc<string>('fn_run_create', {
    p_lines: args.lines, p_copacker_qbo_vendor_id: args.copacker_qbo_vendor_id, p_copacker_location_id: args.copacker_location_id,
    p_destination_location_id: args.destination_location_id, p_scheduled_date: args.scheduled_date ?? null,
    p_tank_size_gal: args.tank_size_gal ?? null, p_notes: args.notes ?? null, p_net_against_stock: args.net_against_stock ?? true,
  });
}
export async function addRunLine(runId: string, bomId: string, qty: number, batchSizeGal?: number | null): Promise<string> {
  return sbrpc<string>('fn_run_add_line', { p_run_id: runId, p_bom_id: bomId, p_qty_to_produce: qty, p_batch_size_gal: batchSizeGal ?? null });
}
export async function removeRunLine(runId: string, woId: string, reason?: string): Promise<void> {
  await sbrpc('fn_run_remove_line', { p_run_id: runId, p_wo_id: woId, p_reason: reason ?? null });
}
export async function generateRunPos(runId: string, expectedDate?: string | null): Promise<{ pos: { po_id: string; po_number: string; qbo_vendor_id: string; close_rule: string; subtotal: number }[]; reservations: number }> {
  return sbrpc('fn_run_generate_pos', { p_run_id: runId, p_expected_date: expectedDate ?? null });
}
export async function advanceRun(runId: string, action: 'materials_at_copacker' | 'start_production' | 'receive' | 'close', payload: Record<string, unknown> = {}): Promise<RunAdvanceResult> {
  return sbrpc<RunAdvanceResult>('fn_run_advance', { p_run_id: runId, p_action: action, p_payload: payload });
}
export async function shipRun(runId: string, payload: Record<string, unknown>): Promise<RunShipResult> {
  return sbrpc<RunShipResult>('fn_run_ship', { p_run_id: runId, p_payload: payload });
}
export async function receiveRun(runId: string, payload: Record<string, unknown> = {}): Promise<{ received: number }> {
  return sbrpc('fn_run_receive', { p_run_id: runId, p_payload: payload });
}
export async function closeRun(runId: string): Promise<{ short_closed_pos: string[] }> {
  return sbrpc('fn_run_close', { p_run_id: runId });
}
export async function reopenRun(runId: string, reason: string): Promise<string> {
  return sbrpc<string>('fn_run_reopen', { p_run_id: runId, p_reason: reason });
}
export async function voidRun(runId: string, reason: string): Promise<RunVoidResult> {
  return sbrpc<RunVoidResult>('fn_run_void', { p_run_id: runId, p_reason: reason });
}
export async function createRunProductionPo(runId: string, expectedDate?: string | null): Promise<{ po_id: string; po_number: string; lines: number; subtotal: number }> {
  return sbrpc('fn_run_create_production_po', { p_run_id: runId, p_expected_date: expectedDate ?? null });
}

export const RUN_STAGES: { status: RunStatus; label: string }[] = [
  { status: 'draft',       label: 'Draft' },
  { status: 'ordered',     label: 'POs issued' },
  { status: 'in_progress', label: 'In production / shipping' },
  { status: 'closed',      label: 'Closed' },
];
