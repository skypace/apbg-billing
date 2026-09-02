import { sbq, sbrpc } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';

// ── Raw materials ─────────────────────────────────────────────────────────
//
// ops.raw_ingredients is the shared ingredient master: ONE row per physical
// material, used by every formula that batches it. It keeps two facts apart
// that are easy to conflate and expensive to conflate:
//
//   how a material is BATCHED   percent by weight on the formula, in lbs
//   how a material is BOUGHT    a 50-lb bag from AC Calderoni at $X
//
// The formula owns the first. This table owns the second. The work order is
// where they meet: it needs `recipe_qty` lbs, so it orders ceil(lbs / 50) bags.

export interface RawIngredient {
  id: string;
  name: string;
  slug: string;
  category: 'ingredient' | 'packaging' | 'service' | 'other';
  recipe_uom: string;
  /** false = real in the batch, never on a purchase order. Water. */
  is_purchased: boolean;
  /**
   * 'rollup' — billed inside the flavour's 1-gallon item. The quantity is shown
   * to the supplier so they know what to buy, but it never becomes its own
   * purchase order line and needs NO QuickBooks item. This is every ingredient
   * today, and it matches how AC Calderoni has always billed: per gallon of a
   * flavour, never per ingredient.
   * 'direct' — we buy this material ourselves, so it gets its own PO line and
   * does need an item.
   */
  purchase_mode: 'rollup' | 'direct';
  purchase_uom: string | null;
  /** Recipe units in ONE purchase unit. 50 for a 50-lb bag. */
  pack_size: number | null;
  order_multiple: number;
  /** Per PURCHASE unit. null is a visible gap, never a guess. */
  purchase_cost: number | null;
  qbo_item_id: string | null;
  qbo_vendor_id: string | null;
  vendor_part_no: string | null;
  notes: string | null;
  active: boolean;
  // from v_raw_ingredients
  qbo_item_name: string | null;
  qbo_item_active: boolean | null;
  expense_account_name: string | null;
  vendor_name: string | null;
  formula_count: number;
  /** Which of item / vendor / pack / cost is still missing. */
  gaps: string[];
}

/** One ingredient's share of ONE case, straight off the formula. */
export interface CaseRequirement {
  ingredient_id: string | null;
  /** What the batching sheet literally calls it. */
  sheet_name: string;
  /** The canonical master name. */
  material_name: string;
  pct_by_weight: number;
  recipe_uom: string;
  gal_per_case: number;
  /** lbs of finished liquid in a whole case. */
  lbs_per_case: number;
  /** lbs of THIS material in one case. */
  qty_per_case: number;
  is_purchased: boolean;
  qbo_item_id: string | null;
  qbo_vendor_id: string | null;
  vendor_name: string | null;
  pack_size: number | null;
  purchase_uom: string | null;
  purchase_cost: number | null;
  cost_per_case: number | null;
  sort_order: number;
  notes: string | null;
}

export interface BatchPlanTank {
  tank_gal: number;
  cases_from_tank: number;
  /** How many MORE cases than asked for a full tank of this size yields. */
  extra_cases: number;
  fits: boolean;
  unused_gal: number;
  over_by_gal: number;
}

export interface BatchPlan {
  cases_requested: number;
  gal_per_case: number;
  yield_pct: number;
  finished_gal: number;
  /** What must go IN the tank — finished gallons divided by the yield rate. */
  gal_to_batch: number;
  recommended_tank: number | null;
  tanks: BatchPlanTank[];
}

export interface BomSyncResult {
  bom_id: string;
  removed: number;
  added: number;
  /** How many of those lines roll up into the flavour's gallon item. */
  rolled_up: number;
  gallon_qbo_item_id: string | null;
  /** Directly-bought materials with no QuickBooks item — they cannot be lines. */
  unlinked: { name: string; qty_per_case: number; uom: string; reason?: string }[];
  /** Materials deliberately left off, e.g. water. */
  skipped: { name: string; reason: string }[];
  /** Anything structurally wrong, e.g. no gallon item to roll into. */
  warnings: string[];
  scrap_pct: number;
}

export interface ProductionSettings {
  production_vendor_qbo_id: string | null;
  clearing_account_ref_id: string | null;
  clearing_account_name: string | null;
  default_tank_sizes_gal: number[];
  raw_material_vendor_qbo_id: string | null;
}

export async function fetchRawIngredients(): Promise<RawIngredient[]> {
  return sbq<RawIngredient>('v_raw_ingredients', 'select=*&order=name.asc');
}

export async function fetchProductionSettings(): Promise<ProductionSettings | null> {
  const rows = await sbq<ProductionSettings>('production_settings', 'select=*&limit=1');
  return rows[0] ?? null;
}

export async function updateRawIngredient(
  id: string,
  patch: Partial<Pick<RawIngredient,
    'name' | 'recipe_uom' | 'is_purchased' | 'purchase_uom' | 'pack_size'
    | 'order_multiple' | 'purchase_cost' | 'qbo_item_id' | 'qbo_vendor_id'
    | 'vendor_part_no' | 'notes' | 'active' | 'purchase_mode'>>,
): Promise<void> {
  const token = await _sbToken();
  const res = await fetch(
    SB_URL + '/rest/v1/raw_ingredients?id=eq.' + encodeURIComponent(id),
    {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + token,
        'Accept-Profile': 'ops',
        'Content-Profile': 'ops',
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error('save material failed: ' + res.status + ' ' + (await res.text()));
}

/** Per-case requirements for a BOM's formula. The one source of the math. */
export async function fetchCaseRequirements(bomId: string): Promise<CaseRequirement[]> {
  return sbrpc<CaseRequirement[]>('fn_formula_case_requirements', { p_bom_id: bomId });
}

/** Write the formula's ingredients onto the BOM. Hand-entered lines survive. */
export async function syncBomFromFormula(bomId: string): Promise<BomSyncResult> {
  return sbrpc<BomSyncResult>('fn_bom_sync_from_formula', { p_bom_id: bomId });
}

/** Gallons needed and, per tank, how many more cases would fill it. */
export async function fetchBatchPlan(bomId: string, cases: number): Promise<BatchPlan> {
  return sbrpc<BatchPlan>('fn_batch_plan', { p_bom_id: bomId, p_cases: cases });
}

export interface ProductionPoResult {
  po_id: string;
  po_number: string;
  qbo_vendor_id: string;
  qty: number;
  unit_cost: number;
  subtotal: number;
}

/** The finished cases coming back from ALAMEDA SODA COMPANY PRODUCTION. */
export async function createProductionPo(
  woId: string,
  expectedDate?: string | null,
): Promise<ProductionPoResult> {
  return sbrpc<ProductionPoResult>('fn_wo_create_production_po', {
    p_wo_id: woId,
    p_expected_date: expectedDate || null,
  });
}

export interface RawMaterialItemsResult {
  ok: boolean;
  commit: boolean;
  expense_account: { id: string; name: string };
  candidates: number;
  created: { slug: string; name: string; qbo_item_id: string }[];
  linked: { slug: string; name: string; qbo_item_id: string }[];
  failed: { slug: string; name: string; error: string }[];
  planned?: { slug: string; name: string; sku: string; has_cost: boolean }[];
  error?: string;
}

/**
 * Create the QuickBooks items for every purchased material that has none.
 *
 * Preview by default. `commit` is a separate, deliberate act because a
 * QuickBooks item cannot be deleted once created — only deactivated — and the
 * names are the operator's to approve.
 */
export async function createRawMaterialItems(
  opts: { commit?: boolean; slugs?: string[] } = {},
): Promise<RawMaterialItemsResult> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/functions/v1/qbo-raw-materials', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: opts.commit ? 'create' : 'preview',
      commit: opts.commit === true,
      ...(opts.slugs?.length ? { slugs: opts.slugs } : {}),
    }),
  });
  const j = (await res.json()) as RawMaterialItemsResult;
  if (!res.ok || j.ok === false) {
    throw new Error(j.error || ('qbo-raw-materials failed: HTTP ' + res.status));
  }
  return j;
}
