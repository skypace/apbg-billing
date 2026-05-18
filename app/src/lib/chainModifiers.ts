import type { SalesFilters } from './sales';
import { loadSetting, saveSetting, KEYS } from './settingsStore';
import { previewRollupMatch, type RollupMatchPreview } from './inventory';

// ─────────── Type definitions ───────────

export type ModifierGroup = 'equipment' | 'soda';

export interface ChainModifier {
  code:    string;
  label:   string;
  full:    string;
  filters: Partial<SalesFilters>;
  parent?: string;
  group:   ModifierGroup;
}

// ─────────── Defaults (shipped baseline) ───────────
//
// Rollups are flat exclusion chips: each chip removes either CUSTOMERS or
// CATEGORIES (never both). The previous "MTE = Melt customers AND E&S
// categories" intersection model worked for include-narrowing but on
// exclusion it wiped the entire grid (customer NOT in Melt OR category
// NOT in E&S can't be expressed as independent NOT-IN lists).
//
// Chips are stackable — click MT + SODA to see totals without Melt
// customers AND without soda categories. The settings localStorage key
// was bumped to chainModifiersV2 on 2026-05-17 so the new defaults apply.

const MELT     = 'THE MELT';
const STARBIRD = 'STARBIRD';

const SODA_REVENUE_LINES = [
  'BIB - 3 Gallon',
  'BIB - 5 Gallon',
  'BIB - Delivery Fees',
  'Packaged Beverage',
];
const ES_REVENUE_LINES = [
  'Equipment Sales',
  'Equipment Rental',
  'Tank Rental',
  'Subleased Space',
  'Service - General',
  'Service - PM Contract',
  'Service - Reman',
  'Service - Freshpet',
];
const GAS_REVENUE_LINES = [
  'Gas - CO2',
  'Gas - Mixed/Nitro',
  'Gas - Hazmat Fees',
];

export const DEFAULT_CHAIN_MODIFIERS: ChainModifier[] = [
  // Chain rollups — exclude customers whose name contains the chain pattern
  { code: 'MT', label: 'Melt',     full: 'The Melt (all locations)',
    filters: { customers: [MELT] }, group: 'equipment' },
  { code: 'SB', label: 'Starbird', full: 'Starbird (all locations)',
    filters: { customers: [STARBIRD] }, group: 'equipment' },
  { code: 'CH', label: 'Chains',   full: 'All chain customers (Melt + Starbird)',
    filters: { customers: [MELT, STARBIRD] }, group: 'equipment' },

  // Category rollups — exclude entire revenue-line groups
  { code: 'SODA', label: 'Soda',                  full: '3 Gallon + 5 Gallon + Packaged Beverage',
    filters: { categories: SODA_REVENUE_LINES }, group: 'soda' },
  { code: 'ES',   label: 'Equipment & Service',   full: 'All Equipment and Service revenue',
    filters: { categories: ES_REVENUE_LINES }, group: 'equipment' },
  { code: 'GAS',  label: 'Gas',                   full: 'CO2, Mixed/Nitro, Hazmat fees',
    filters: { categories: GAS_REVENUE_LINES }, group: 'soda' },
];

export const DEFAULT_ENTITY_AUTO_FILTERS: Record<string, Partial<SalesFilters>> = {
  AS:       { categories: SODA_REVENUE_LINES },
  freeflow: { customers:  ['FREEFLOW CUSTOMER', 'FRESHPET CUSTOMER'] },
  FF:       { customers:  ['FREEFLOW CUSTOMER', 'FRESHPET CUSTOMER'] },
  brix:     { categories: ES_REVENUE_LINES },
};

// ─────────── Runtime getters/setters (localStorage-backed) ───────────

export function getChainModifiers(): ChainModifier[] {
  return loadSetting<ChainModifier[]>(KEYS.chainModifiers, DEFAULT_CHAIN_MODIFIERS);
}
export function setChainModifiers(list: ChainModifier[]): void {
  saveSetting(KEYS.chainModifiers, list);
}

export function getEntityDefaults(): Record<string, Partial<SalesFilters>> {
  return loadSetting<Record<string, Partial<SalesFilters>>>(KEYS.entityDefaults, DEFAULT_ENTITY_AUTO_FILTERS);
}
export function setEntityDefaults(map: Record<string, Partial<SalesFilters>>): void {
  saveSetting(KEYS.entityDefaults, map);
}

/** @deprecated kept for backward compat — use getChainModifiers() instead. */
export const CHAIN_MODIFIERS = DEFAULT_CHAIN_MODIFIERS;
/** @deprecated kept for backward compat — use getEntityDefaults() instead. */
export const ENTITY_AUTO_FILTERS = DEFAULT_ENTITY_AUTO_FILTERS;

// ─────────── Apply helpers ───────────

/**
 * Legacy synchronous apply — concatenates literal pattern strings into filters.
 * fn_sales_pivot uses exact matching, so this rarely produces results when the
 * rollup definition contains substring patterns (e.g. 'THE MELT' won't match
 * 'The Melt :: Berkeley'). Use `expandModifierFilters` for live data instead.
 */
export function applyModifiers(base: SalesFilters, codes: string[]): SalesFilters {
  if (codes.length === 0) return base;
  const list = getChainModifiers();
  const next: SalesFilters = { ...base };
  for (const code of codes) {
    const m = list.find((c) => c.code === code);
    if (!m) continue;
    for (const k of ['customers', 'categories', 'items', 'channels', 'segments'] as const) {
      const vals = m.filters[k];
      if (!vals || vals.length === 0) continue;
      const cur = (next[k] as string[] | null | undefined) ?? [];
      next[k] = Array.from(new Set([...cur, ...vals]));
    }
  }
  return next;
}

export function applyEntityDefaults(base: SalesFilters, entity: string | null): SalesFilters {
  if (!entity) return base;
  const map = getEntityDefaults();
  const d = map[entity];
  if (!d) return { ...base, entities: [entity] };
  return {
    ...base,
    entities: [entity],
    categories: d.categories ?? base.categories,
    customers:  d.customers  ?? base.customers,
    items:      d.items      ?? base.items,
  };
}

/**
 * Resolve a list of active rollup codes to actual customer/category/item name
 * lists by calling fn_preview_rollup_match for each. Returns a merged
 * Partial<SalesFilters> with exact names that fn_sales_pivot can filter on.
 *
 * Also returns total match counts for surfacing in the modifier bar.
 */
export interface ExpandedRollupFilters {
  filters: Partial<SalesFilters>;
  perRollup: Array<{
    code: string;
    label: string;
    matched_customers: number;
    matched_items: number;
    matched_revenue: number;
  }>;
}

export async function expandModifierFilters(codes: string[]): Promise<ExpandedRollupFilters> {
  if (codes.length === 0) return { filters: {}, perRollup: [] };

  const list = getChainModifiers();
  const customers   = new Set<string>();
  const categories  = new Set<string>();
  const items       = new Set<string>();
  const perRollup: ExpandedRollupFilters['perRollup'] = [];

  for (const code of codes) {
    const m = list.find((c) => c.code === code);
    if (!m) continue;
    let preview: RollupMatchPreview | undefined;
    try {
      const res = await previewRollupMatch({
        customers:  m.filters.customers ?? null,
        categories: m.filters.categories ?? null,
        items:      m.filters.items ?? null,
        channels:   m.filters.channels ?? null,
        segments:   m.filters.segments ?? null,
      });
      preview = res?.[0];
    } catch { /* swallow; surface as zero */ }

    for (const n of preview?.sample_customer_names ?? []) customers.add(n);
    for (const n of preview?.sample_category_names ?? []) categories.add(n);
    for (const n of preview?.sample_item_names      ?? []) items.add(n);

    perRollup.push({
      code: m.code, label: m.label,
      matched_customers: preview?.matched_customers ?? 0,
      matched_items:     preview?.matched_items     ?? 0,
      matched_revenue:   Number(preview?.matched_revenue ?? 0),
    });
  }

  const filters: Partial<SalesFilters> = {};
  if (customers.size  > 0) filters.customers  = Array.from(customers);
  if (categories.size > 0) filters.categories = Array.from(categories);
  if (items.size      > 0) filters.items      = Array.from(items);
  return { filters, perRollup };
}
