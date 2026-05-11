// Margin → Columns registry.
//
// Phase 1 (v0.9.0): three derived per-unit columns (price / COGS / gross)
//   that compute from pivot fields and work for every dim.
// Phase 2A (v0.9.1): customer enrichment via fn_dim_meta('customer').
// Phase 2B (v0.9.2): item enrichment via fn_dim_meta('item') —
//   SKU, type, category path, master list price + master item cost,
//   on-hand qty, inventory value, income/expense/asset accounts.
// Phase 3 (Workstream B): Unit Overhead + Unit Net once overhead engine
//   ships.

import type { Dim, SalesPivotRow } from './sales';
import { fm, fmtNum } from './formatters';

export type MarginColumnGroup =
  | 'unit'        // Per-unit price / COGS / margin (current + master)
  | 'address'     // Customer city / state / zip / street
  | 'attribute'   // SKU, UPC, brand, size, contact, type, etc.
  | 'ar'          // AR balance, aging buckets, credit limit
  | 'inventory'   // On-hand qty, inventory value, days of supply
  | 'derived';    // Account refs, lifetime gross, days-since, etc.

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
const fmtCount  = (v: unknown): string => (v == null ? '—' : fmtNum(Number(v)));

// ---------------------------------------------------------------------------
// Phase 1 — Unit-level derived columns. Work for every dim with qty data.
// ---------------------------------------------------------------------------

const UNIT_PRICE: MarginColumnDef = {
  id: 'unit_price',
  label: 'Unit Price (avg)',
  dims: 'all',
  group: 'unit',
  width: 130,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const rev = Number(r.revenue ?? 0);
    return q > 0 ? rev / q : null;
  },
  format: fmtMoney,
};

const UNIT_COST: MarginColumnDef = {
  id: 'unit_cost',
  label: 'Unit COGS (avg)',
  dims: 'all',
  group: 'unit',
  width: 130,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const c = r.est_cost != null ? Number(r.est_cost) : null;
    return q > 0 && c != null ? c / q : null;
  },
  format: fmtMoney,
};

const UNIT_GROSS: MarginColumnDef = {
  id: 'unit_gross',
  label: 'Unit Gross (avg)',
  dims: 'all',
  group: 'unit',
  width: 130,
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
    id, label, dims: ['customer'], group, width,
    requiresFetch: true, enrichmentKey, format,
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
  customerCol('primary_channel', 'Channel',       'attribute', 'primary_channel', 150),
  customerCol('customer_type',   'Customer Type', 'attribute', 'customer_type',   140),
  customerCol('is_sub_customer', 'Sub-customer?', 'attribute', 'is_sub_customer', 110, fmtBool),
  customerCol('phone',           'Phone',         'attribute', 'phone',           130),
  customerCol('email',           'Email',         'attribute', 'email',           200),
];

// ---------------------------------------------------------------------------
// Phase 2B — Item enrichment columns (qbo_items via fn_dim_meta)
// ---------------------------------------------------------------------------

function itemCol(
  id: string,
  label: string,
  group: MarginColumnGroup,
  enrichmentKey: string,
  width = 130,
  format: (v: unknown) => string = fmtString,
): MarginColumnDef {
  return {
    id, label, dims: ['item'], group, width,
    requiresFetch: true, enrichmentKey, format,
  };
}

const ITEM_COLUMNS: MarginColumnDef[] = [
  // Per-unit — MASTER values from qbo_items (vs the avg actuals from Phase 1).
  // List Price = qbo_items.unit_price (the published price).
  // Item Cost  = qbo_items.purchase_cost (the recorded master COGS).
  itemCol('list_price', 'List Price (master)', 'unit', 'list_price', 140, fmtMoney),
  itemCol('item_cost',  'Item Cost (master)',  'unit', 'item_cost',  140, fmtMoney),

  // Attributes
  itemCol('sku',           'SKU',           'attribute', 'sku',           110),
  itemCol('item_type',     'Item Type',     'attribute', 'item_type',     120),
  itemCol('category_path', 'Category Path', 'attribute', 'category_path', 220),
  itemCol('active',        'Active?',       'attribute', 'active',         90, fmtBool),
  itemCol('taxable',       'Taxable?',      'attribute', 'taxable',        90, fmtBool),

  // Inventory
  itemCol('on_hand',         'On-Hand Qty',     'inventory', 'on_hand',         110, fmtCount),
  itemCol('inventory_value', 'Inv $ at cost',   'inventory', 'inventory_value', 130, fmtMoney),

  // Derived (account refs from QBO)
  itemCol('income_account',  'Income Account',  'derived', 'income_account',  180),
  itemCol('expense_account', 'Expense Account', 'derived', 'expense_account', 180),
  itemCol('asset_account',   'Asset Account',   'derived', 'asset_account',   180),
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MARGIN_COLUMN_REGISTRY: MarginColumnDef[] = [
  UNIT_PRICE,
  UNIT_COST,
  UNIT_GROSS,
  ...CUSTOMER_COLUMNS,
  ...ITEM_COLUMNS,
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
