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
  /** The product spec sheet / formula this BOM is built from — the driver. */
  formula_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type BomLineType = 'component' | 'service';
/** per_yield: qty_per is per finished unit and scales with the run. per_run: a
 *  fixed quantity per work order — a vendor's flat fee (Calderoni's canning
 *  fee is the live case). */
export type BomQtyBasis = 'per_yield' | 'per_run';

export interface ProductBomLine {
  id: string;
  bom_id: string;
  line_type: BomLineType;
  component_qbo_item_id: string | null;
  service_label: string | null;
  qty_per: number;
  qty_uom: string;
  qty_basis: BomQtyBasis;
  scrap_pct: number;
  default_cost: number | null;
  /** Which vendor this sub-item is purchased from. Drives PO generation. */
  preferred_qbo_vendor_id: string | null;
  notes: string | null;
  sort_order: number;
  /**
   * 'formula' = written by the formula sync and owned by it — a rebuild
   * replaces exactly these. 'manual' = a human put it there (cans, tolling,
   * Velcorin, dunnage) and the rebuild never touches it. The BOM editor edits
   * ONLY manual lines; saving it re-writes just those.
   */
  source: 'manual' | 'formula';
  ingredient_id: string | null;
  created_at: string;
}

export interface BomLineInput {
  line_type: BomLineType;
  component_qbo_item_id?: string | null;
  service_label?: string | null;
  qty_per: number;
  qty_uom?: string;
  qty_basis?: BomQtyBasis;
  scrap_pct?: number;
  default_cost?: number | null;
  preferred_qbo_vendor_id?: string | null;
  notes?: string | null;
}

/** Pipeline statuses (2026-07 redesign). 'consumed' is the retired legacy
 *  in-house flow value, kept only so old rows render. */
export type WorkOrderStatus =
  | 'draft' | 'ordered' | 'at_copacker' | 'in_production'
  | 'yield_recorded' | 'in_transit' | 'received' | 'closed' | 'void'
  | 'consumed';

export interface WorkOrder {
  id: string;
  batch_code: string;
  bom_id: string;
  finished_qbo_item_id: string;
  qty_to_produce: number;
  target_uom: string | null;
  qty_produced_actual: number | null;
  // ── Pipeline fields (2026-07 redesign) ──
  formula_id: string | null;
  copacker_qbo_vendor_id: string | null;
  copacker_location_id: string | null;
  destination_location_id: string | null;
  batch_size_gal: number | null;
  expected_units: number | null;
  yield_pct: number | null;
  ordered_at: string | null;
  materials_at_copacker_at: string | null;
  production_started_at: string | null;
  yield_recorded_at: string | null;
  shipped_at: string | null;
  received_at: string | null;
  ship_carrier: string | null;
  ship_tracking: string | null;
  ship_bol_number: string | null;
  transfer_id: string | null;
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

export type BomMaterialRequirementStatus = 'ok' | 'on_order' | 'short' | 'no_stock';

export interface BomMaterialRequirement {
  component_qbo_item_id: string;
  item_name: string | null;
  required_qty: number;
  required_uom: string;
  source_line_count: number;
  qty_per: number | null;
  scrap_pct: number | null;
  on_hand_qty: number;
  location_on_hand_qty: number | null;
  on_order_qty: number;
  available_qty: number;
  shortage_qty: number;
  unit_cost: number | null;
  shortage_cost: number;
  status: BomMaterialRequirementStatus;
}

/** Row from ops.v_work_orders — WorkOrder plus joined display fields. */
export interface WorkOrderView extends WorkOrder {
  bom_name: string | null;
  bom_version: string | null;
  bom_yield_uom: string | null;
  bom_cans_per_case: number | null;
  bom_oz_per_can: number | null;
  formula_name: string | null;
  formula_doc_rev: string | null;
  finished_item_name: string | null;
  copacker_vendor_name: string | null;
  copacker_location_label: string | null;
  destination_location_label: string | null;
  transfer_bol_number: string | null;
  transfer_status: string | null;
  total_cost: number | null;
  unit_cost: number | null;
  components_cost: number | null;
  services_cost: number | null;
  po_count: number | null;
  po_open_count: number | null;
  /** open | pending | closed | voided — ops.fn_status_bucket, from the view. */
  bucket?: string | null;
}

/** A WO material requirement row — the quantity calc lives here, per vendor. */
export interface WorkOrderMaterial {
  id: string;
  wo_id: string;
  bom_line_id: string | null;
  component_qbo_item_id: string;
  item_name: string | null;
  required_qty: number;
  uom: string;
  unit_cost_est: number | null;
  qbo_vendor_id: string | null;
  vendor_name: string | null;
  po_id: string | null;
  po_line_id: string | null;
  sort_order: number;
  notes: string | null;
  created_at: string;
}

export interface WorkOrderEvent {
  id: string;
  wo_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  payload: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

/** A co-packer lot on a work order: their lot code, the born-on (production)
 *  date, an optional best-by, and how many cases. Lot quantities must total the
 *  recorded yield; the return BOL is written one line per lot. */
export interface WorkOrderLot {
  id: string;
  wo_id: string;
  lot_code: string;
  born_on_date: string | null;
  best_by_date: string | null;
  qty: number;
  notes: string | null;
  sort_order: number;
  created_at: string;
}

export interface WorkOrderLotInput {
  lot_code: string;
  born_on_date?: string | null;
  best_by_date?: string | null;
  qty: number;
  notes?: string | null;
}

export type WoAdvanceAction =
  | 'materials_at_copacker' | 'start_production' | 'record_yield'
  | 'ship' | 'receive' | 'close' | 'void';

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

export async function fetchWorkOrderViews(limit = 200): Promise<WorkOrderView[]> {
  return sbq<WorkOrderView>('v_work_orders', `select=*&order=created_at.desc&limit=${limit}`);
}

export async function fetchWorkOrderLots(woId: string): Promise<WorkOrderLot[]> {
  return sbq<WorkOrderLot>('work_order_lots', `select=*&wo_id=eq.${woId}&order=sort_order.asc`);
}

/** Replace the lots on a work order (allowed while in_production or
 *  yield_recorded). Once a yield is recorded the quantities must total it. */
export async function setWorkOrderLots(woId: string, lots: WorkOrderLotInput[]): Promise<void> {
  await sbrpc('fn_wo_set_lots', { p_wo_id: woId, p_lots: lots });
}

export async function fetchWorkOrderMaterials(woId: string): Promise<WorkOrderMaterial[]> {
  return sbq<WorkOrderMaterial>('work_order_materials',
    `select=*&wo_id=eq.${woId}&order=sort_order.asc`);
}

export async function fetchWorkOrderEvents(woId: string): Promise<WorkOrderEvent[]> {
  return sbq<WorkOrderEvent>('work_order_events',
    `select=*&wo_id=eq.${woId}&order=created_at.asc`);
}

export async function fetchWorkOrderCosts(woId: string): Promise<WorkOrderCosts | null> {
  const rows = await sbq<WorkOrderCosts>('work_order_costs', `select=*&wo_id=eq.${woId}`);
  return rows[0] ?? null;
}

export async function fetchBomMaterialRequirements(args: {
  bom_id: string;
  target_qty: number;
  target_uom?: string | null;
  location_id?: string | null;
}): Promise<BomMaterialRequirement[]> {
  return sbrpc<BomMaterialRequirement[]>('fn_bom_material_requirements', {
    p_bom_id: args.bom_id,
    p_target_qty: args.target_qty,
    p_target_uom: args.target_uom ?? null,
    p_location_id: args.location_id ?? null,
  });
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

/** v2 save — the redesigned parts-list BOM (formula link + per-line vendor). */
export async function saveBomV2(args: {
  id?: string | null;
  header: {
    finished_qbo_item_id: string;
    name?: string | null;
    version?: string;
    formula_id?: string | null;
    yield_qty?: number;
    yield_uom?: string;
    cans_per_case?: number;
    oz_per_can?: number;
    effective_date?: string | null;
    notes?: string | null;
    is_active?: boolean;
  };
  lines: BomLineInput[];
}): Promise<string> {
  return sbrpc<string>('fn_bom_save_v2', {
    p_id: args.id ?? null,
    p_header: args.header,
    p_lines: args.lines,
  });
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

// ── Work order pipeline (2026-07 redesign) ───────────────────────────────

/** Create a pipeline WO. Material quantities are computed server-side and
 *  snapshotted into ops.work_order_materials — the calc lives on the WO. */
export async function createWorkOrderPipeline(args: {
  bom_id: string;
  qty_to_produce: number;
  copacker_qbo_vendor_id?: string | null;
  copacker_location_id: string;
  destination_location_id: string;
  scheduled_date?: string | null;
  batch_size_gal?: number | null;
  notes?: string | null;
}): Promise<string> {
  return sbrpc<string>('fn_wo_create_pipeline', {
    p_bom_id: args.bom_id,
    p_qty_to_produce: args.qty_to_produce,
    p_copacker_qbo_vendor_id: args.copacker_qbo_vendor_id ?? null,
    p_copacker_location_id: args.copacker_location_id,
    p_destination_location_id: args.destination_location_id,
    p_scheduled_date: args.scheduled_date ?? null,
    p_batch_size_gal: args.batch_size_gal ?? null,
    p_notes: args.notes ?? null,
  });
}

export interface GeneratedPo {
  po_id: string;
  po_number: string;
  qbo_vendor_id: string;
  subtotal: number;
}

export interface GeneratePosResult {
  pos: GeneratedPo[];
  /**
   * The ingredient breakdown filed underneath the gallon lines. `orphans` names
   * any flavour whose ingredients had no gallon line to be billed inside —
   * a visible gap, not a silent drop.
   */
  recipe_detail: {
    attached: number;
    orphans: { rollup_qbo_item_id: string; reason: string }[];
  };
}

/**
 * One PO per vendor from the WO's unassigned materials; draft → ordered.
 *
 * The ingredients do NOT get purchase order lines of their own: they are filed
 * as detail under the flavour's 1-gallon line, which is what the vendor bills
 * and the only thing QuickBooks sees.
 */
export async function generateWoPurchaseOrders(
  woId: string,
  expectedDate?: string | null,
): Promise<GeneratePosResult> {
  return sbrpc<GeneratePosResult>('fn_wo_generate_pos', {
    p_wo_id: woId,
    p_expected_date: expectedDate ?? null,
  });
}

/** Drive the pipeline: materials_at_copacker / start_production /
 *  record_yield / ship / receive / close / void. */
export async function advanceWorkOrder(
  woId: string,
  action: WoAdvanceAction,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await sbrpc('fn_wo_advance', { p_wo_id: woId, p_action: action, p_payload: payload });
}

export async function setWoMaterialVendor(materialId: string, qboVendorId: string | null): Promise<void> {
  await sbrpc('fn_wo_set_material_vendor', {
    p_material_id: materialId,
    p_qbo_vendor_id: qboVendorId ?? '',
  });
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
