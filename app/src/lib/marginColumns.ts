// Margin → Columns registry.
//
// Phase 1 (v0.9.0) shipped three "derived" columns that compute from the
// existing pivot fields (revenue, qty, est_cost, est_margin) — they work
// for any Group-by dim without a backend change.
//
// Phase 2A (v0.9.1) adds customer enrichment columns. Each carries
// `requiresFetch: true` + an `enrichmentKey` so MarginPage side-fetches
// via fn_dim_meta('customer', labels) and merges the resulting jsonb
// payload into the grid rows by dim_label.
//
// Phase 2B (v0.9.2) will add item enrichment (SKU/UPC/size/brand/etc).
// Phase 3 (Workstream B) will add Unit Overhead + Unit Net to the
// per-unit group once the overhead allocation engine is in place.

import type { Dim, SalesPivotRow } from './sales';
import { fm } from './formatters';

export type MarginColumnGroup =
  | 'unit'        // Per-unit price / COGS / margin
  | 'address'     // Customer city / state / zip / street
  | 'attribute'   // SKU, UPC, brand, size, contact, type, etc.
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
// Helpers
// ---------------------------------------------------------------------------

const fmtString = (v: unknown): string => (v == null || v === '' ? '—' : String(v));
const fmtBool   = (v: unknown): string => (v == null ? '—' : v ? 'yes' : 'no');
const fmtMoney  = (v: unknown): string => (v == null ? '—' : fm(Number(v)));

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
  format: fmtMoney,
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
  format: fmtMoney,
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
  format: fmtMoney,
};

// ---------------------------------------------------------------------------
// Phase 2A — Customer enrichment columns (qbo_customers via fn_dim_meta)
// ---------------------------------------------------------------------------

function customerCol(
  id: string,
  label: string,
  group: MarginColumnGroup,
  enrichmentKey: string,
  width = 140,
  format: (v: unknown) => string = fmtString,
): MarginColumnDef {
  return {
    id,
    label,
    dims: ['customer'],
    group,
    width,
    requiresFetch: true,
    enrichmentKey,
    format,
  };
}

const CUSTOMER_COLUMNS: MarginColumnDef[] = [
  // Address
  customerCol('bill_addr_line1', 'Bill Street', 'address', 'bill_addr_line1', 220),
  customerCol('bill_addr_city',  'Bill City',   'address', 'bill_addr_city',  140),
  customerCol('bill_addr_state', 'Bill State',  'address', 'bill_addr_state',  80),
  customerCol('bill_addr_postal','Bill ZIP',    'address', 'bill_addr_postal', 90),
  customerCol('ship_addr_city',  'Ship City',   'address', 'ship_addr_city',  140),
  customerCol('ship_addr_state', 'Ship State',  'address', 'ship_addr_state',  80),

  // Attribute
  customerCol('primary_channel', 'Channel',          'attribute', 'primary_channel', 150),
  customerCol('customer_type',   'Customer Type',    'attribute', 'customer_type',   140),
  customerCol('is_sub_customer', 'Sub-customer?',    'attribute', 'is_sub_customer', 110, fmtBool),
  customerCol('phone',           'Phone',            'attribute', 'phone',           130),
  customerCol('email',           'Email',            'attribute', 'email',           200),
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MARGIN_COLUMN_REGISTRY: MarginColumnDef[] = [
  UNIT_PRICE,
  UNIT_COST,
  UNIT_GROSS,
  ...CUSTOMER_COLUMNS,
  // Phase 2B will add item enrichment columns here.
  // Phase 3 will add Unit Overhead / Unit Net once overhead allocation ships.
];

export function getColumnsForDim(dim: Dim): MarginColumnDef[] {
  return MARGIN_COLUMN_REGISTRY.filter(
    (c) => c.dims === 'all' || c.dims.includes(dim),
  );
}

/** Returns true if any selected column needs an enrichment side-fetch. */
export function columnsNeedFetch(cols: MarginColumnDef[]): boolean {
  return cols.some((c) => c.requiresFetch === true);
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
