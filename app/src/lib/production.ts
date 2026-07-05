import { sbq, sbrpc, sbUpdate } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────

export interface ProductBom {
  id: string;
  finished_qbo_item_id: string;
  version: string;
  /** Friendly operator-assigned label. Lets you save multiple named
   *  recipes per finished SKU (e.g., "Cola — 1000 gal batch"). Falls back
   *  to "Version N" when null. */
  name: string | null;
  effective_date: string | null;
  yield_qty: number;
  yield_uom: string;
  /** Optional bridge for cross-family scaling: if yield_uom is a count
   *  (each/case) and 1 yield produces a known volume of finished product,
   *  set this to the gallons-per-yield. Lets the BOM scaler convert "make
   *  1000 gal" → runs even though yield is in cases. */
  finished_vol_per_yield_gal: number | null;
  /** Post-mix dilution: water parts per 1 part concentrate. 5:1 → 5. The
   *  BOM scaler computes finished_vol_per_yield = concentrate_vol × (1 +
   *  dilution_ratio) when this is set and ingredient SKUs parse to known
   *  per-unit volumes. Default 0 = no dilution (concentrate is finished). */
  dilution_ratio: number;
  /** Pack count per case. Default 24. Used by the BOM cost-rollup to
   *  derive $/case from $/can. Configurable per BOM for non-24 packs. */
  cans_per_case: number;
  /** Fluid ounces per can. Default 12. Used for $/oz and $/gal-finished. */
  oz_per_can: number;
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type BomLineType = 'component' | 'service';

export interface ProductBomLine {
  id: string;
  bom_id: string;
  line_type: BomLineType;
  component_qbo_item_id: string | null;
  service_label: string | null;
  qty_per: number;
  qty_uom: string;
  scrap_pct: number;
  default_cost: number | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
}

export interface BomLineInput {
  line_type: BomLineType;
  component_qbo_item_id?: string | null;
  service_label?: string | null;
  qty_per: number;
  qty_uom?: string;
  scrap_pct?: number;
  default_cost?: number | null;
  notes?: string | null;
}

export type WorkOrderStatus = 'draft' | 'consumed' | 'closed' | 'void';

export interface WorkOrder {
  id: string;
  batch_code: string;
  bom_id: string;
  finished_qbo_item_id: string;
  qty_to_produce: number;
  target_uom: string | null;
  qty_produced_actual: number | null;
  /** Actual yield reported at WO close. Together with actual_yield_uom this
   *  drives the actual-vs-theoretical cost rollup. NULL until closed. */
  actual_yield_qty: number | null;
  actual_yield_uom: string | null;
  production_location_id: string;
  status: WorkOrderStatus;
  scheduled_date: string | null;
  consumed_at: string | null;
  consumed_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  notes: string | null;
  qbo_inventory_adjustment_id: string | null;
  qbo_pushed_at: string | null;
  qbo_push_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkOrderCostDetail {
  kind: 'component' | 'service';
  label: string;
  qbo_item_id?: string | null;
  qty: number;
  uom?: string | null;
  unit_cost: number | null;
  extended_cost: number;
  notes: string | null;
}

export interface WorkOrderCosts {
  wo_id: string;
  components_cost: number;
  services_cost: number;
  total_cost: number;
  unit_cost: number | null;
  qty_produced: number;
  /** Set when actual_yield_qty was recorded at WO close. NULL otherwise. */
  per_case: number | null;
  per_can: number | null;
  per_oz: number | null;
  per_gal_finished: number | null;
  actual_yield_pct: number | null;
  yield_loss_dollars: number | null;
  detail: WorkOrderCostDetail[];
  computed_at: string;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function fetchBoms(): Promise<ProductBom[]> {
  return sbq<ProductBom>('product_bom', 'select=*&order=created_at.desc');
}

export async function fetchBomLines(bomId: string): Promise<ProductBomLine[]> {
  return sbq<ProductBomLine>('product_bom_lines',
    `select=*&bom_id=eq.${bomId}&order=sort_order.asc`);
}

export async function fetchWorkOrders(limit = 200): Promise<WorkOrder[]> {
  return sbq<WorkOrder>('work_orders', `select=*&order=created_at.desc&limit=${limit}`);
}

export async function fetchWorkOrderCosts(woId: string): Promise<WorkOrderCosts | null> {
  const rows = await sbq<WorkOrderCosts>('work_order_costs', `select=*&wo_id=eq.${woId}`);
  return rows[0] ?? null;
}

// ── BOM mutations ────────────────────────────────────────────────────────

export async function createBom(args: {
  finished_qbo_item_id: string;
  yield_qty: number;
  yield_uom?: string;
  finished_vol_per_yield_gal?: number | null;
  lines: BomLineInput[];
  version?: string;
  name?: string | null;
  effective_date?: string | null;
  notes?: string | null;
}): Promise<string> {
  return sbrpc<string>('fn_create_bom', {
    p_finished_qbo_item_id: args.finished_qbo_item_id,
    p_yield_qty: args.yield_qty,
    p_yield_uom: args.yield_uom ?? 'each',
    p_finished_vol_per_yield_gal: args.finished_vol_per_yield_gal ?? null,
    p_lines: args.lines,
    p_version: args.version ?? '1',
    p_effective_date: args.effective_date ?? null,
    p_notes: args.notes ?? null,
    p_name: args.name ?? null,
  });
}

export async function replaceBomLines(bomId: string, lines: BomLineInput[]): Promise<void> {
  await sbrpc('fn_replace_bom_lines', { p_bom_id: bomId, p_lines: lines });
}

export async function updateBom(id: string, patch: Partial<ProductBom>): Promise<void> {
  await sbUpdate('product_bom', `id=eq.${id}`, patch);
}

// ── Work order transitions ──────────────────────────────────────────────

export async function createWorkOrder(args: {
  bom_id: string;
  qty_to_produce: number;
  /** Unit the operator typed. Consume/close read this through
   *  fn_bom_scale_runs, so "1000 gal" can scale a per-case Alameda Soda BOM
   *  when the recipe has either a valid finished-volume bridge or dilution
   *  ratio. */
  target_uom?: string | null;
  production_location_id: string;
  scheduled_date?: string | null;
  notes?: string | null;
}): Promise<string> {
  return sbrpc<string>('fn_create_work_order', {
    p_bom_id: args.bom_id,
    p_qty_to_produce: args.qty_to_produce,
    p_target_uom: args.target_uom ?? null,
    p_production_location_id: args.production_location_id,
    p_scheduled_date: args.scheduled_date ?? null,
    p_notes: args.notes ?? null,
  });
}

export async function consumeWorkOrder(woId: string): Promise<void> {
  await sbrpc('fn_consume_work_order', { p_wo_id: woId });
}

export async function closeWorkOrder(woId: string, qtyProducedActual: number, closeDate?: string | null): Promise<void> {
  await sbrpc('fn_close_work_order', {
    p_wo_id: woId,
    p_qty_produced_actual: qtyProducedActual,
    p_close_date: closeDate ?? null,
  });
}

export async function voidWorkOrder(woId: string, reason: string): Promise<void> {
  await sbrpc('fn_void_work_order', { p_wo_id: woId, p_reason: reason });
}

// ── QBO writeback for closed work orders ────────────────────────────────
// Posts an InventoryAdjustment to QBO so QBO's Item.QtyOnHand reflects
// the build. Idempotent — refuses to push a WO that already has
// qbo_inventory_adjustment_id set. dry_run=true returns the payload
// preview + resolved adjust account without actually posting.
export interface PushWoToQboResult {
  ok: boolean;
  no_change?: boolean;
  dry_run?: boolean;
  work_order_id: string;
  qbo_inventory_adjustment_id?: string;
  qbo_pushed_at?: string;
  adjust_account?: { id: string; name: string };
  line_count?: number;
  skipped?: { qbo_item_id: string; reason: string }[];
  payload?: unknown;
  error?: string;
  duration_ms?: number;
  message?: string;
}

export async function pushWorkOrderToQbo(
  woId: string,
  opts: { dry_run?: boolean; adjust_account_id?: string | null } = {},
): Promise<PushWoToQboResult> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/functions/v1/push-qbo-item', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'postInventoryAdjustment',
      work_order_id: woId,
      dry_run: opts.dry_run ?? false,
      adjust_account_id: opts.adjust_account_id ?? null,
    }),
  });
  const j = (await res.json()) as PushWoToQboResult;
  if (!res.ok || j.ok === false) {
    throw new Error(j.error || ('push-qbo-item failed: HTTP ' + res.status));
  }
  return j;
}
