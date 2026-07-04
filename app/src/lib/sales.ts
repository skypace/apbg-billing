// Typed wrappers around the ops sales RPCs.

import { sbrpc } from './rpc';

export type Dim =
  | 'category'
  | 'item'
  | 'customer'
  | 'month'
  | 'entity'
  | 'account'
  | 'segment'
  | 'channel'
  | 'product_family'
  | 'product_type';

export interface SalesPivotRow {
  dim_label: string;
  line_count: number;
  qty: number | null;
  revenue: number;
  est_cost: number | null;
  est_margin: number | null;
  margin_pct: number | null;
  cost_coverage_pct: number | null;
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

export interface PlMarginSummary {
  revenue: number;
  cogs: number;
  gross_margin: number;
  operating_expenses: number;
  net_margin: number;
  gross_margin_pct: number | null;
  net_margin_pct: number | null;
  account_count: number;
  period_start: string | null;
  period_end: string | null;
  months: number;
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
  product_families?: string[] | null;
  product_types?: string[] | null;
  // Exclude filters — populated by the rollup picker on the Margin page so
  // clicking a chain takes its revenue OUT of totals (vs narrowing to it).
  exclude_customers?: string[] | null;
  exclude_categories?: string[] | null;
  exclude_items?: string[] | null;
}

export function rpcArgs(f: SalesFilters) {
  return {
    p_start: f.start,
    p_end: f.end,
    p_entities:         f.entities         && f.entities.length         ? f.entities         : null,
    p_categories:       f.categories       && f.categories.length       ? f.categories       : null,
    p_customers:        f.customers        && f.customers.length        ? f.customers        : null,
    p_items:            f.items            && f.items.length            ? f.items            : null,
    p_channels:         f.channels         && f.channels.length         ? f.channels         : null,
    p_segments:         f.segments         && f.segments.length         ? f.segments         : null,
    p_product_families: f.product_families && f.product_families.length ? f.product_families : null,
    p_product_types:    f.product_types    && f.product_types.length    ? f.product_types    : null,
    p_exclude_customers:  f.exclude_customers  && f.exclude_customers.length  ? f.exclude_customers  : null,
    p_exclude_categories: f.exclude_categories && f.exclude_categories.length ? f.exclude_categories : null,
    p_exclude_items:      f.exclude_items      && f.exclude_items.length      ? f.exclude_items      : null,
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

export function fetchPlMarginSummary(start: string, end: string) {
  return sbrpc<PlMarginSummary[]>('fn_pl_margin_summary', {
    p_start: start,
    p_end: end,
  }).then((rows) => rows[0] || null);
}

export interface QboSyncFreshness {
  status: 'ok' | 'warn' | string;
  warnings: string[] | null;
  invoice_cache_at: string | null;
  item_cache_at: string | null;
  expense_line_cache_at: string | null;
  last_invoice_sync_at: string | null;
  last_line_backfill_at: string | null;
  last_mv_refresh_at: string | null;
  recent_qbo_errors: number;
}

export function fetchQboSyncFreshness() {
  return sbrpc<QboSyncFreshness[]>('fn_qbo_sync_freshness').then(
    (rows) => rows[0] || null,
  );
}

export interface MarginHealthIssue {
  issue_key: string;
  severity: 'critical' | 'warn' | 'ok' | string;
  title: string;
  detail: string | null;
  line_count: number;
  revenue: number | null;
  sample_labels: string[] | null;
  action: string | null;
}

export function fetchMarginDataHealth(f: SalesFilters) {
  return sbrpc<MarginHealthIssue[]>('fn_margin_data_health', rpcArgs(f));
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

function parseYmd(s: string): { y: number; m: number; d: number } {
  return {
    y: parseInt(s.slice(0, 4), 10),
    m: parseInt(s.slice(5, 7), 10),
    d: parseInt(s.slice(8, 10), 10),
  };
}

function formatYmd(y: number, m: number, d: number): string {
  return (
    String(y).padStart(4, '0') + '-' +
    String(m).padStart(2, '0') + '-' +
    String(d).padStart(2, '0')
  );
}

export function computePriorBounds(start: string, end: string, mode: 'prior_period' | 'prior_year') {
  if (mode === 'prior_year') {
    const startY = parseYmd(start).y;
    const prevYear = startY - 1;
    return {
      prior_start: prevYear + start.slice(4),
      prior_end:   prevYear + end.slice(4),
    };
  }
  const a = parseYmd(start);
  const b = parseYmd(end);
  const aUtc = Date.UTC(a.y, a.m - 1, a.d);
  const bUtc = Date.UTC(b.y, b.m - 1, b.d);
  const len = Math.round((bUtc - aUtc) / 86400000);
  const psUtc = aUtc - (len + 1) * 86400000;
  const peUtc = bUtc - (len + 1) * 86400000;
  const ps = new Date(psUtc);
  const pe = new Date(peUtc);
  return {
    prior_start: formatYmd(ps.getUTCFullYear(), ps.getUTCMonth() + 1, ps.getUTCDate()),
    prior_end:   formatYmd(pe.getUTCFullYear(), pe.getUTCMonth() + 1, pe.getUTCDate()),
  };
}

// Pair current ↔ prior rows.
// For month-shaped labels ('YYYY-MM') we ALWAYS pair by sorted index —
// that handles both prior_year (same months, prior year) and
// prior_period (shifted window, different months) correctly.
// For all other dims, exact-label matching is the right move.
export function mergeWithPrior(current: SalesPivotRow[], prior: SalesPivotRow[]): ComparisonRow[] {
  const isMonth = current.length > 0 && /^\d{4}-\d{2}$/.test(current[0].dim_label);

  function buildRow(r: SalesPivotRow, p: SalesPivotRow | undefined): ComparisonRow {
    const priorRev    = p?.revenue    != null ? Number(p.revenue)    : null;
    const priorMargin = p?.est_margin != null ? Number(p.est_margin) : null;
    const deltaRev    = priorRev != null ? Number(r.revenue) - priorRev : null;
    const deltaPct    = priorRev != null && priorRev !== 0
      ? (Number(r.revenue) - priorRev) / Math.abs(priorRev)
      : null;
    return { ...r, prior_revenue: priorRev, prior_margin: priorMargin, delta_revenue: deltaRev, delta_pct: deltaPct };
  }

  if (isMonth) {
    const cur = [...current].sort((a, b) => a.dim_label.localeCompare(b.dim_label));
    const pri = [...prior].sort((a, b) => a.dim_label.localeCompare(b.dim_label));
    return cur.map((r, i) => buildRow(r, pri[i]));
  }

  const priorByKey = new Map<string, SalesPivotRow>();
  for (const r of prior) priorByKey.set(r.dim_label, r);
  return current.map((r) => buildRow(r, priorByKey.get(r.dim_label)));
}

export function fetchSparkline(dim: Dim, labels: string[], end: string, f: SalesFilters) {
  const { p_start: _start, p_end: _end, ...filterArgs } = rpcArgs(f);
  const args = {
    p_dim: dim,
    p_labels: labels,
    p_end: end,
    ...filterArgs,
  } as Record<string, unknown>;
  for (const [key, value] of Object.entries(args)) {
    if (value == null) delete args[key];
  }
  return sbrpc<SparklineRow[]>('fn_sparkline', {
    ...args,
  });
}

export function trailing12MonthKeys(end: string): string[] {
  const { y, m } = parseYmd(end);
  const keys: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const cursorUtc = Date.UTC(y, m - 1 - i, 1);
    const cursor = new Date(cursorUtc);
    keys.push(
      cursor.getUTCFullYear() + '-' +
      String(cursor.getUTCMonth() + 1).padStart(2, '0'),
    );
  }
  return keys;
}
