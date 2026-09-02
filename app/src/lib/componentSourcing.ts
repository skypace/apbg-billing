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
