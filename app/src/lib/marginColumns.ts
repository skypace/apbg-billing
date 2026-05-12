// Margin → Columns registry.
//
// Phase 1 (v0.9.0): unit-level columns.
// Phase 2 (v0.9.1-3): customer/item enrichment + AR aging.
// Workstream B (v0.9.6-7): overhead allocation.
// Workstream C (v0.9.11-12): break-even + Forecast 30/60/90 (sparkline-based).

import type { Dim, SalesPivotRow } from './sales';
import { fm, fp, fmtNum } from './formatters';

export type MarginColumnGroup =
  | 'unit' | 'overhead' | 'address' | 'attribute' | 'ar' | 'inventory' | 'derived' | 'forecast';

export interface MarginColumnDef {
  id: string;
  label: string;
  dims: Dim[] | 'all';
  group: MarginColumnGroup;
  width: number;
  compute?: (row: SalesPivotRow & Record<string, unknown>) => number | string | null;
  format?: (value: unknown) => string;
  requiresFetch?: boolean;
  requiresSparklines?: boolean;
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
  compute: (r) => { const q = Number(r.qty ?? 0); return q > 0 ? Number(r.revenue ?? 0) / q : null; },
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

function overheadCol(id: string, label: string, key: string, w: number, fmt: (v: unknown) => string): MarginColumnDef {
  return { id, label, dims: 'all', group: 'overhead', width: w, requiresFetch: false, enrichmentKey: key, format: fmt };
}
const OVERHEAD_COLUMNS: MarginColumnDef[] = [
  overheadCol('overhead_total',    'Overhead $',    '_overhead',          120, fmtMoneyZeroDash),
  overheadCol('overhead_per_unit', 'OH / unit',     '_overhead_per_unit', 110, fmtMoney),
  overheadCol('net_margin',        'Net Margin $',  '_net_margin',        130, fmtMoney),
  overheadCol('net_margin_pct',    'Net Margin %',  '_net_margin_pct',    110, fmtPct),
  overheadCol('unit_net',          'Unit Net',      '_unit_net',          110, fmtMoney),
];

const BREAKEVEN_UNITS: MarginColumnDef = {
  id: 'breakeven_units', label: 'Break-even Units', dims: 'all', group: 'overhead', width: 130,
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

// ---------------------------------------------------------------------------
// Forecast 30/60/90 — sparkline-based linear projection
// ---------------------------------------------------------------------------
// Uses the row's _spark12 field (set by MarginPage when sparklines are loaded)
// — a 12-element array of trailing monthly revenue. Forecast = trailing-3
// average × N months.
function forecastCompute(months: number) {
  return (r: SalesPivotRow & Record<string, unknown>): number | null => {
    const spark = r._spark12 as number[] | undefined;
    if (!Array.isArray(spark) || spark.length < 3) return null;
    const last3 = spark.slice(-3).map((v) => Number(v) || 0);
    const nonZero = last3.filter((v) => v > 0);
    if (nonZero.length === 0) return null;
    const avg = last3.reduce((s, v) => s + v, 0) / last3.length;
    return avg * months;
  };
}

const FORECAST_30: MarginColumnDef = {
  id: 'forecast_30', label: 'Forecast 30d', dims: 'all', group: 'forecast', width: 120,
  compute: forecastCompute(1),
  format: fmtMoney,
  requiresSparklines: true,
};
const FORECAST_60: MarginColumnDef = {
  id: 'forecast_60', label: 'Forecast 60d', dims: 'all', group: 'forecast', width: 120,
  compute: forecastCompute(2),
  format: fmtMoney,
  requiresSparklines: true,
};
const FORECAST_90: MarginColumnDef = {
  id: 'forecast_90', label: 'Forecast 90d', dims: 'all', group: 'forecast', width: 120,
  compute: forecastCompute(3),
  format: fmtMoney,
  requiresSparklines: true,
};

function customerCol(id: string, label: string, group: MarginColumnGroup, key: string,
  w = 140, fmt: (v: unknown) => string = fmtString): MarginColumnDef {
  return { id, label, dims: ['customer'], group, width: w, requiresFetch: true, enrichmentKey: key, format: fmt };
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

function itemCol(id: string, label: string, group: MarginColumnGroup, key: string,
  w = 130, fmt: (v: unknown) => string = fmtString): MarginColumnDef {
  return { id, label, dims: ['item'], group, width: w, requiresFetch: true, enrichmentKey: key, format: fmt };
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
  UNIT_PRICE, UNIT_COST, UNIT_GROSS,
  ...OVERHEAD_COLUMNS, BREAKEVEN_UNITS,
  FORECAST_30, FORECAST_60, FORECAST_90,
  ...CUSTOMER_COLUMNS, ...ITEM_COLUMNS,
];

export function getColumnsForDim(dim: Dim): MarginColumnDef[] {
  return MARGIN_COLUMN_REGISTRY.filter((c) => c.dims === 'all' || c.dims.includes(dim));
}

export function columnsNeedFetch(cols: MarginColumnDef[]): boolean {
  return cols.some((c) => c.requiresFetch === true);
}

export function columnsNeedSparklines(cols: MarginColumnDef[]): boolean {
  return cols.some((c) => c.requiresSparklines === true);
}

export const GROUP_LABEL: Record<MarginColumnGroup, string> = {
  unit: 'Per-unit', overhead: 'Overhead', forecast: 'Forecast',
  attribute: 'Attributes', address: 'Address', ar: 'AR / Aging',
  inventory: 'Inventory', derived: 'Derived',
};
export const GROUP_ORDER: Record<MarginColumnGroup, number> = {
  unit: 1, overhead: 2, forecast: 3, attribute: 4, address: 5, ar: 6, inventory: 7, derived: 8,
};
