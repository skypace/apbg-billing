// Typed wrappers around the ops sales RPCs.
// Keep the shapes in sync with the SQL function signatures so the
// migration stays type-safe end-to-end.

import { sbrpc } from './rpc';

export type Dim =
  | 'category'
  | 'item'
  | 'customer'
  | 'month'
  | 'entity'
  | 'account'
  | 'segment'
  | 'channel';

export interface SalesPivotRow {
  dim_label: string;
  line_count: number;
  qty: number | null;
  revenue: number;
  est_cost: number | null;
  est_margin: number | null;
  margin_pct: number | null;
  avg_price: number | null;
  effective_segment: string | null;
}

export interface SalesTotals {
  line_count: number;
  invoice_count: number;
  customer_count: number;
  item_count: number;
  qty: number | null;
  revenue: number;
  est_cost: number | null;
  est_margin: number | null;
  margin_pct: number | null;
  cost_coverage_pct: number | null;
}

export interface DimValue {
  label: string;
  revenue: number;
}

export interface SalesFilters {
  start: string;
  end: string;
  entities?: string[] | null;
  categories?: string[] | null;
  customers?: string[] | null;
  items?: string[] | null;
  channels?: string[] | null;
  segments?: string[] | null;
}

export function rpcArgs(f: SalesFilters) {
  return {
    p_start: f.start,
    p_end: f.end,
    p_entities:   f.entities   && f.entities.length   ? f.entities   : null,
    p_categories: f.categories && f.categories.length ? f.categories : null,
    p_customers:  f.customers  && f.customers.length  ? f.customers  : null,
    p_items:      f.items      && f.items.length      ? f.items      : null,
    p_channels:   f.channels   && f.channels.length   ? f.channels   : null,
    p_segments:   f.segments   && f.segments.length   ? f.segments   : null,
  };
}

export function fetchPivot(dim: Dim, f: SalesFilters, limit = 250) {
  return sbrpc<SalesPivotRow[]>('fn_sales_pivot', {
    p_dim: dim,
    ...rpcArgs(f),
    p_limit: limit,
  });
}

export function fetchTotals(f: SalesFilters) {
  return sbrpc<SalesTotals[]>('fn_sales_totals', rpcArgs(f)).then(
    (rows) => rows[0] || null,
  );
}

export function fetchDimValues(dim: Dim, start: string, end: string, limit = 2000) {
  return sbrpc<DimValue[]>('fn_sales_dim_values', {
    p_dim: dim,
    p_start: start,
    p_end: end,
    p_limit: limit,
  });
}

export interface SparklineRow { dim_label: string; ym: string; revenue: number }

export interface ComparisonRow extends SalesPivotRow {
  prior_revenue: number | null;
  prior_margin: number | null;
  delta_revenue: number | null;
  delta_pct: number | null;
}

// Compute prior-period bounds: same length as the current period,
// shifted back by `mode` ('prior_period') or to the prior calendar year
// boundaries ('prior_year').
export function computePriorBounds(start: string, end: string, mode: 'prior_period' | 'prior_year') {
  if (mode === 'prior_year') {
    const prevYear = new Date(start).getFullYear() - 1;
    return {
      prior_start: prevYear + start.slice(4),
      prior_end:   prevYear + end.slice(4),
    };
  }
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const len = (e.getTime() - s.getTime()) / 86400000;
  const ps = new Date(s.getTime() - (len + 1) * 86400000);
  const pe = new Date(e.getTime() - (len + 1) * 86400000);
  return {
    prior_start: ps.toISOString().slice(0, 10),
    prior_end:   pe.toISOString().slice(0, 10),
  };
}

export function mergeWithPrior(current: SalesPivotRow[], prior: SalesPivotRow[]): ComparisonRow[] {
  const priorByLabel = new Map<string, SalesPivotRow>();
  for (const r of prior) priorByLabel.set(r.dim_label, r);
  return current.map((r) => {
    const p = priorByLabel.get(r.dim_label);
    const priorRev = p ? Number(p.revenue) : null;
    const deltaRev = priorRev != null ? Number(r.revenue) - priorRev : null;
    const deltaPct = priorRev && priorRev > 0 ? (Number(r.revenue) - priorRev) / priorRev : null;
    return {
      ...r,
      prior_revenue: priorRev,
      prior_margin: p?.est_margin ?? null,
      delta_revenue: deltaRev,
      delta_pct: deltaPct,
    };
  });
}

export function fetchSparkline(dim: Dim, labels: string[], end: string, f: SalesFilters) {
  // fn_sparkline has p_end + filter args but no p_start (it always
  // looks back 12 months from p_end), so strip start/end before spread.
  const { p_start: _start, p_end: _end, ...filterArgs } = rpcArgs(f);
  return sbrpc<SparklineRow[]>('fn_sparkline', {
    p_dim: dim,
    p_labels: labels,
    p_end: end,
    ...filterArgs,
  });
}

// Build the 12-month label array ending at the given month-end.
export function trailing12MonthKeys(end: string): string[] {
  const d = new Date(end + 'T00:00:00');
  const keys: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(m.getFullYear() + '-' + String(m.getMonth() + 1).padStart(2, '0'));
  }
  return keys;
}
