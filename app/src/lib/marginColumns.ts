// Margin → Columns registry.
//
// Phase 1 ships three "derived" columns that compute from the existing
// pivot fields (revenue, qty, est_cost, est_margin) — so they work for
// any Group-by dim without a backend change.
//
// Phase 2+ will add enrichment columns (customer address/AR, item
// SKU/UPC/on-hand, etc.) that side-fetch from QBO master tables and
// merge by dim_label. Those will set `requiresFetch: true` and an
// `enrichmentKey` so the loader knows what to pull.

import type { Dim, SalesPivotRow } from './sales';
import { fm } from './formatters';

export type MarginColumnGroup =
  | 'unit'        // Per-unit price / COGS / margin
  | 'address'     // Customer city / state / zip / street
  | 'attribute'   // SKU, UPC, brand, size, etc.
  | 'ar'          // AR balance, aging buckets, credit limit
  | 'inventory'   // On-hand qty, days of supply
  | 'derived';    // Other computed columns (lifetime gross, days-since, etc.)

export interface MarginColumnDef {
  id: string;
  label: string;
  /** Which Group-by dims this column applies to. `'all'` = always available. */
  dims: Dim[] | 'all';
  group: MarginColumnGroup;
  width: number;
  /** Pure function over a row — used for derived (Phase-1) columns. */
  compute?: (row: SalesPivotRow & Record<string, unknown>) => number | string | null;
  /** Formatter — defaults to identity for strings, '—' for null. */
  format?: (value: unknown) => string;
  /** Whether the value must be side-fetched from QBO / Supabase. */
  requiresFetch?: boolean;
  /** Property name on the enrichment payload for this dim. */
  enrichmentKey?: string;
}

// ---------------------------------------------------------------------------
// Phase 1 — Unit-level derived columns. Work for every dim with qty data.
// ---------------------------------------------------------------------------

const UNIT_PRICE: MarginColumnDef = {
  id: 'unit_price',
  label: 'Unit Price',
  dims: 'all',
  group: 'unit',
  width: 110,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const rev = Number(r.revenue ?? 0);
    return q > 0 ? rev / q : null;
  },
  format: (v) => (v == null ? '—' : fm(Number(v))),
};

const UNIT_COST: MarginColumnDef = {
  id: 'unit_cost',
  label: 'Unit COGS',
  dims: 'all',
  group: 'unit',
  width: 110,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const c = r.est_cost != null ? Number(r.est_cost) : null;
    return q > 0 && c != null ? c / q : null;
  },
  format: (v) => (v == null ? '—' : fm(Number(v))),
};

const UNIT_GROSS: MarginColumnDef = {
  id: 'unit_gross',
  label: 'Unit Gross',
  dims: 'all',
  group: 'unit',
  width: 110,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const m = r.est_margin != null ? Number(r.est_margin) : null;
    return q > 0 && m != null ? m / q : null;
  },
  format: (v) => (v == null ? '—' : fm(Number(v))),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MARGIN_COLUMN_REGISTRY: MarginColumnDef[] = [
  UNIT_PRICE,
  UNIT_COST,
  UNIT_GROSS,
  // Phase 2+ slot-ins:
  //   Customer address / city / state / zip / channel / segment / parent
  //   Customer AR balance + 0-30 / 31-60 / 61-90 / 90+ aging
  //   Customer payment terms / credit limit / days since last order / lifetime gross
  //   Item SKU / UPC / size / case-pack / brand / manufacturer / MOQ
  //   Item on-hand qty / days of supply / COGS source / last cost change / supplier
  //   Phase 3+ (after overhead allocation):
  //     Unit Overhead, Unit Net
];

export function getColumnsForDim(dim: Dim): MarginColumnDef[] {
  return MARGIN_COLUMN_REGISTRY.filter(
    (c) => c.dims === 'all' || c.dims.includes(dim),
  );
}

export const GROUP_LABEL: Record<MarginColumnGroup, string> = {
  unit:      'Per-unit',
  attribute: 'Attributes',
  address:   'Address',
  ar:        'AR / Credit',
  inventory: 'Inventory',
  derived:   'Derived',
};

export const GROUP_ORDER: Record<MarginColumnGroup, number> = {
  unit:      1,
  attribute: 2,
  address:   3,
  ar:        4,
  inventory: 5,
  derived:   6,
};
