import type { ProductionItem } from './rawMaterials';

/**
 * Where a stocked component's vendor, price and quantity come from.
 *
 * The server settles all three — `fn_wo_create_pipeline`, `fn_bom_preflight` and
 * `fn_bom_material_requirements` — and every screen that previews a run has to
 * read them the SAME way, or it tells the operator a material has no vendor
 * while the purchase order it is about to raise has one.
 *
 * Precedence, in order: the BOM line's own override, then the Materials &
 * Pricing master (`ops.production_items`), then the QuickBooks mirror.
 * The line slot is an OVERRIDE, not the default — a master shadowed by a copy
 * on every BOM is not a master.
 */

export interface ComponentLineLike {
  component_qbo_item_id: string | null;
  preferred_qbo_vendor_id?: string | null;
  default_cost?: number | null;
  qty_per: number | string;
  qty_basis?: 'per_yield' | 'per_run';
  scrap_pct?: number | string | null;
}

export type MasterIndex = Map<string, ProductionItem>;

export function masterIndex(items: ProductionItem[] | null | undefined): MasterIndex {
  return new Map((items ?? []).filter((m) => m.active).map((m) => [m.qbo_item_id, m]));
}

export function componentVendorId(line: ComponentLineLike, master: MasterIndex): string | null {
  if (line.preferred_qbo_vendor_id) return line.preferred_qbo_vendor_id;
  return master.get(line.component_qbo_item_id ?? '')?.qbo_vendor_id ?? null;
}

export function componentUnitCost(
  line: ComponentLineLike,
  master: MasterIndex,
  qboPurchaseCost?: number | null,
): number | null {
  if (line.default_cost != null) return Number(line.default_cost);
  const m = master.get(line.component_qbo_item_id ?? '');
  if (m?.unit_cost != null) return Number(m.unit_cost);
  return qboPurchaseCost ?? null;
}

/**
 * How much of this component a run of `yieldQty` finished units needs.
 * A `per_run` line is a flat charge for the whole work order — the syrup
 * compounding fee is billed once whether the run is 100 cases or 5,000 — so it
 * must never be multiplied by the run size.
 */
export function componentRequiredQty(line: ComponentLineLike, yieldQty: number): number {
  const per = Number(line.qty_per) || 0;
  if (line.qty_basis === 'per_run') return per;
  return yieldQty * per * (1 + Number(line.scrap_pct || 0));
}

/**
 * ONE rounding rule, mirroring ops.fn_order_qty: nothing said (no MOQ, blank
 * multiple) → order the demand; otherwise ceil(max(demand, MOQ) / multiple) ×
 * multiple — so a typed multiple of 1 means WHOLE units. A per_run line is a
 * flat charge and is never rounded.
 */
export function orderQty(demand: number, moq: number | null | undefined, multiple: number | null | undefined): number {
  if (!(demand > 0)) return 0;
  if (moq == null && multiple == null) return demand;
  const m = multiple && multiple > 0 ? multiple : 1;
  return Math.ceil(Math.max(demand, moq ?? 0) / m) * m;
}

export interface OrderPreview {
  /** what the batch needs, in purchase units */
  demand: number;
  /** what the PO will order */
  ordered: number;
  /** ordered − demand: lands at the co-packer as stock for the next run */
  surplus: number;
  /** why it was lifted, for the screen */
  reason: 'moq' | 'multiple' | null;
}

/** What a run of `yieldQty` will ORDER for this component, and why it differs from the need. */
export function componentOrderQty(line: ComponentLineLike, yieldQty: number, master: MasterIndex): OrderPreview {
  const demand = componentRequiredQty(line, yieldQty);
  if (line.qty_basis === 'per_run') return { demand, ordered: demand, surplus: 0, reason: null };
  const m = master.get(line.component_qbo_item_id ?? '');
  const ordered = orderQty(demand, m?.min_order_qty, m?.order_multiple);
  const surplus = Math.max(ordered - demand, 0);
  const reason = surplus <= 0 ? null : (m?.min_order_qty != null && demand < m.min_order_qty ? 'moq' : 'multiple');
  return { demand, ordered, surplus, reason };
}
