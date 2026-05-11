// Margin → Columns registry.
//
// Phase 1 (v0.9.0): three derived per-unit columns.
// Phase 2A (v0.9.1): customer enrichment.
// Phase 2B (v0.9.2): item enrichment.
// Phase 2C (v0.9.3): AR aging.
// Workstream B (v0.9.6-7): Overhead allocation columns.
// Workstream C (v0.9.11): Break-even units — minimum sales velocity to
//   cover allocated overhead at current per-unit margin.

import type { Dim, SalesPivotRow } from './sales';
import { fm, fp, fmtNum } from './formatters';

export type MarginColumnGroup =
  | 'unit'
  | 'overhead'
  | 'address'
  | 'attribute'
  | 'ar'
  | 'inventory'
  | 'derived';

export interface MarginColumnDef {
  id: string;
  label: string;
  dims: Dim[] | 'all';
  group: MarginColumnGroup;
  width: number;
  compute?: (row: SalesPivotRow & Record<string, unknown>) => number | string | null;
  format?: (value: unknown) => string;
  requiresFetch?: boolean;
  enrichmentKey?: string;
}

const fmtString = (v: unknown): string => (v == null || v === '' ? '—' : String(v));
const fmtBool   = (v: unknown): string => (v == null ? '—' : v ? 'yes' : 'no');
const fmtMoney  = (v: unknown): string => (v == null ? '—' : fm(Number(v)));
const fmtCount  = (v: unknown): string => (v == null ? '—' : fmtNum(Number(v)));
const fmtPct    = (v: unknown): string => (v == null ? '—' : fp(Number(v)));
const fmtMoneyZeroDash = (v: unknown): string => {
  if (v == null) return '—';
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '—';
  return fm(n);
};

const UNIT_PRICE: MarginColumnDef = {
  id: 'unit_price', label: 'Unit Price (avg)', dims: 'all', group: 'unit', width: 130,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const rev = Number(r.revenue ?? 0);
    return q > 0 ? rev / q : null;
  },
  format: fmtMoney,
};

const UNIT_COST: MarginColumnDef = {
  id: 'unit_cost', label: 'Unit COGS (avg)', dims: 'all', group: 'unit', width: 130,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const c = r.est_cost != null ? Number(r.est_cost) : null;
    return q > 0 && c != null ? c / q : null;
  },
  format: fmtMoney,
};

const UNIT_GROSS: MarginColumnDef = {
  id: 'unit_gross', label: 'Unit Gross (avg)', dims: 'all', group: 'unit', width: 130,
  compute: (r) => {
    const q = Number(r.qty ?? 0);
    const m = r.est_margin != null ? Number(r.est_margin) : null;
    return q > 0 && m != null ? m / q : null;
  },
  format: fmtMoney,
};

function overheadCol(
  id: string, label: string, enrichmentKey: string, width: number, format: (v: unknown) => string,
): MarginColumnDef {
  return { id, label, dims: 'all', group: 'overhead', width, requiresFetch: false, enrichmentKey, format };
}

const OVERHEAD_COLUMNS: MarginColumnDef[] = [
  overheadCol('overhead_total',    'Overhead $',    '_overhead',          120, fmtMoneyZeroDash),
  overheadCol('overhead_per_unit', 'OH / unit',     '_overhead_per_unit', 110, fmtMoney),
  overheadCol('net_margin',        'Net Margin $',  '_net_margin',        130, fmtMoney),
  overheadCol('net_margin_pct',    'Net Margin %',  '_net_margin_pct',    110, fmtPct),
  overheadCol('unit_net',          'Unit Net',      '_unit_net',          110, fmtMoney),
];

// Break-even units (Workstream C): how many units this row would need to
// sell at the current gross-per-unit to cover its allocated overhead.
// breakeven = _overhead / unit_gross_per_unit
const BREAKEVEN_UNITS: MarginColumnDef = {
  id: 'breakeven_units',
  label: 'Break-even Units',
  dims: 'all',
  group: 'overhead',
  width: 130,
  compute: (r) => {
    const oh = r._overhead != null ? Number(r._overhead) : 0;
    if (oh <= 0) return null;
    const q = Number(r.qty ?? 0);
    const m = r.est_margin != null ? Number(r.est_margin) : null;
    if (q <= 0 || m == null || m <= 0) return null;
    const unitGross = m / q;
    if (unitGross <= 0) return null;
    return oh / unitGross;
  },
  format: (v) => (v == null ? '—' : fmtNum(Math.ceil(Number(v))) + ' u'),
};

function customerCol(
  id: string, label: string, group: MarginColumnGroup, enrichmentKey: string,
  width = 140, format: (v: unknown) => string = fmtString,
): MarginColumnDef {
  return { id, label, dims: ['customer'], group, width, requiresFetch: true, enrichmentKey, format };
}

const CUSTOMER_COLUMNS: MarginColumnDef[] = [
  customerCol('bill_addr_line1', 'Bill Street', 'address', 'bill_addr_line1', 220),
  customerCol('bill_addr_city',  'Bill City',   'address', 'bill_addr_city',  140),
  customerCol('bill_addr_state', 'Bill State',  'address', 'bill_addr_state',  80),
  customerCol('bill_addr_postal','Bill ZIP',    'address', 'bill_addr_postal', 90),
  customerCol('ship_addr_city',  'Ship City',   'address', 'ship_addr_city',  140),
  customerCol('ship_addr_state', 'Ship State',  'address', 'ship_addr_state',  80),

  customerCol('primary_channel', 'Channel',       'attribute', 'primary_channel', 150),
  customerCol('customer_type',   'Customer Type', 'attribute', 'customer_type',   140),
  customerCol('is_sub_customer', 'Sub-customer?', 'attribute', 'is_sub_customer', 110, fmtBool),
  customerCol('phone',           'Phone',         'attribute', 'phone',           130),
  customerCol('email',           'Email',         'attribute', 'email',           200),

  customerCol('ar_total',            'AR Total',        'ar', 'ar_total',            120, fmtMoneyZeroDash),
  customerCol('ar_0_30',             'AR 0-30 d',       'ar', 'ar_0_30',             110, fmtMoneyZeroDash),
  customerCol('ar_31_60',            'AR 31-60 d',      'ar', 'ar_31_60',            110, fmtMoneyZeroDash),
  customerCol('ar_61_90',            'AR 61-90 d',      'ar', 'ar_61_90',            110, fmtMoneyZeroDash),
  customerCol('ar_90_plus',          'AR 90+ d',        'ar', 'ar_90_plus',          110, fmtMoneyZeroDash),
  customerCol('ar_not_due',          'AR Not Due',      'ar', 'ar_not_due',          120, fmtMoneyZeroDash),
  customerCol('open_invoice_count',  'Open Invoices',   'ar', 'open_invoice_count',  110, fmtCount),
  customerCol('days_oldest_overdue', 'Oldest Overdue',  'ar', 'days_oldest_overdue', 130, (v) => v == null ? '—' : `${fmtNum(Number(v))} d`),
];

function itemCol(
  id: string, label: string, group: MarginColumnGroup, enrichmentKey: string,
  width = 130, format: (v: unknown) => string = fmtString,
): MarginColumnDef {
  return { id, label, dims: ['item'], group, width, requiresFetch: true, enrichmentKey, format };
}

const ITEM_COLUMNS: MarginColumnDef[] = [
  itemCol('list_price', 'List Price (master)', 'unit', 'list_price', 140, fmtMoney),
  itemCol('item_cost',  'Item Cost (master)',  'unit', 'item_cost',  140, fmtMoney),

  itemCol('sku',           'SKU',           'attribute', 'sku',           110),
  itemCol('item_type',     'Item Type',     'attribute', 'item_type',     120),
  itemCol('category_path', 'Category Path', 'attribute', 'category_path', 220),
  itemCol('active',        'Active?',       'attribute', 'active',         90, fmtBool),
  itemCol('taxable',       'Taxable?',      'attribute', 'taxable',        90, fmtBool),

  itemCol('on_hand',         'On-Hand Qty',     'inventory', 'on_hand',         110, fmtCount),
  itemCol('inventory_value', 'Inv $ at cost',   'inventory', 'inventory_value', 130, fmtMoney),

  itemCol('income_account',  'Income Account',  'derived', 'income_account',  180),
  itemCol('expense_account', 'Expense Account', 'derived', 'expense_account', 180),
  itemCol('asset_account',   'Asset Account',   'derived', 'asset_account',   180),
];

export const MARGIN_COLUMN_REGISTRY: MarginColumnDef[] = [
  UNIT_PRICE,
  UNIT_COST,
  UNIT_GROSS,
  ...OVERHEAD_COLUMNS,
  BREAKEVEN_UNITS,
  ...CUSTOMER_COLUMNS,
  ...ITEM_COLUMNS,
];

export function getColumnsForDim(dim: Dim): MarginColumnDef[] {
  return MARGIN_COLUMN_REGISTRY.filter((c) => c.dims === 'all' || c.dims.includes(dim));
}

export function columnsNeedFetch(cols: MarginColumnDef[]): boolean {
  return cols.some((c) => c.requiresFetch === true);
}

export const GROUP_LABEL: Record<MarginColumnGroup, string> = {
  unit:      'Per-unit',
  overhead:  'Overhead',
  attribute: 'Attributes',
  address:   'Address',
  ar:        'AR / Aging',
  inventory: 'Inventory',
  derived:   'Derived',
};

export const GROUP_ORDER: Record<MarginColumnGroup, number> = {
  unit: 1, overhead: 2, attribute: 3, address: 4, ar: 5, inventory: 6, derived: 7,
};
