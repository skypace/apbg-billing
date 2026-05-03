// Typed wrappers for the ops Reports RPCs.
import { sbrpc } from './rpc';

export interface InactiveCustomerRow {
  qbo_customer_id: string;
  customer_name: string;
  prior_revenue: number;
  current_revenue: number;
  last_invoice_date: string | null;
  primary_channel: string | null;
  primary_sales_rep: string | null;
  bill_state: string | null;
}

export interface TopMoverRow {
  dim_label: string;
  current_rev: number;
  prior_rev: number;
  delta_rev: number;
  delta_pct: number | null;
}

export interface HealthMoverRow {
  qbo_customer_id: string;
  customer_name: string;
  primary_channel: string | null;
  primary_sales_rep: string | null;
  prev_snapshot_date: string | null;
  prev_segment: string | null;
  prev_rfm_total: number | null;
  prev_monetary: number | null;
  curr_segment: string;
  curr_rfm_total: number;
  curr_monetary: number;
  rfm_total_delta: number;
  monetary_delta: number;
  movement: string;
}

export interface AnomalyRow {
  qbo_customer_id: string;
  customer_name: string;
  primary_channel: string | null;
  primary_sales_rep: string | null;
  baseline_avg: number;
  baseline_stddev: number;
  recent_avg: number;
  z_score: number | null;
  delta_pct: number | null;
  direction: 'spike' | 'drop';
}

export interface VoidRow {
  qbo_customer_id: string;
  customer_name: string;
  primary_channel: string | null;
  primary_sales_rep: string | null;
  qbo_item_id: string;
  item_name: string;
  revenue: number;
  qty: number | null;
  has_item: boolean;
  customer_set_revenue: number;
  customer_set_items_count: number;
  set_total_items: number;
}

export interface ItemSet {
  set_code: string;
  label: string;
  is_active: boolean;
  sort_order: number | null;
}

export function fetchInactiveCustomers(opts: {
  current_start: string;
  current_end: string;
  prior_start: string;
  prior_end: string;
  min_prior_rev?: number;
  max_current_rev?: number;
  limit?: number;
}) {
  return sbrpc<InactiveCustomerRow[]>('fn_inactive_customers', {
    p_current_start: opts.current_start,
    p_current_end: opts.current_end,
    p_prior_start: opts.prior_start,
    p_prior_end: opts.prior_end,
    p_min_prior_rev: opts.min_prior_rev ?? 1000,
    p_max_current_rev: opts.max_current_rev ?? 0,
    p_limit: opts.limit ?? 200,
  });
}

export function fetchTopMovers(opts: {
  dim?: 'customer' | 'item' | 'category' | 'segment';
  start: string;
  end: string;
  prev_start: string;
  prev_end: string;
  limit?: number;
}) {
  return sbrpc<TopMoverRow[]>('fn_top_movers', {
    p_dim: opts.dim ?? 'customer',
    p_start: opts.start,
    p_end: opts.end,
    p_prev_start: opts.prev_start,
    p_prev_end: opts.prev_end,
    p_limit: opts.limit ?? 50,
  });
}

export function fetchHealthMovers(max_age_days = 14) {
  return sbrpc<HealthMoverRow[]>('fn_health_movers', { p_max_age_days: max_age_days });
}

export function takeHealthSnapshot() {
  return sbrpc<number>('fn_take_health_snapshot', {});
}

export function fetchAnomalies(opts: {
  baseline_months?: number;
  recent_months?: number;
  min_baseline?: number;
  sigma_threshold?: number;
}) {
  return sbrpc<AnomalyRow[]>('fn_revenue_anomalies', {
    p_baseline_months: opts.baseline_months ?? 6,
    p_recent_months: opts.recent_months ?? 1,
    p_min_baseline: opts.min_baseline ?? 500,
    p_sigma_threshold: opts.sigma_threshold ?? 2.0,
  });
}

export function fetchProductVoids(opts: {
  set_code: string;
  start: string;
  end: string;
  min_set_revenue?: number;
  require_some?: boolean;
}) {
  return sbrpc<VoidRow[]>('fn_product_voids', {
    p_set_code: opts.set_code,
    p_start: opts.start,
    p_end: opts.end,
    p_min_set_revenue: opts.min_set_revenue ?? 0,
    p_require_some: opts.require_some ?? true,
  });
}
