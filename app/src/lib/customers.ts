import { sbrpc } from './rpc';

export interface CustomerListRow {
  qbo_customer_id: string;
  display_name: string;
  is_sub_customer: boolean;
  active: boolean;
  state: string | null;
  customer_type_name: string | null;
  ytd_revenue: number;
  invoice_count: number;
  channels: string[] | null;
  primary_channel: string | null;
  sales_reps: string[] | null;
  primary_sales_rep: string | null;
}

export interface CustomerDetail {
  qbo_customer_id: string;
  display_name: string;
  customer_type_name: string | null;
  bill_addr_line1: string | null;
  bill_addr_city: string | null;
  bill_addr_state: string | null;
  bill_addr_postal: string | null;
  email: string | null;
  phone: string | null;
  is_sub_customer: boolean;
  active: boolean;
  notes: string | null;
  primary_channel: string | null;
  primary_sales_rep: string | null;
  all_channels: string[] | null;
  all_sales_reps: string[] | null;
  current_revenue: number;
  current_invoice_count: number;
  current_line_count: number;
  current_est_cost: number | null;
  current_est_margin: number | null;
  current_margin_pct: number | null;
  lifetime_revenue: number;
  lifetime_invoice_count: number;
  last_invoice_date: string | null;
  ar_balance: number;
  ar_overdue: number;
  ar_overdue_count: number;
}

export interface CustomerHealth {
  qbo_customer_id: string;
  customer_name: string;
  primary_channel: string | null;
  primary_sales_rep: string | null;
  recency_days: number;
  frequency: number;
  monetary: number;
  r_score: number;
  f_score: number;
  m_score: number;
  rfm_total: number;
  rfm_segment: string;
  last_invoice_date: string | null;
}

export interface CustomerScorecard {
  qbo_customer_id: string;
  customer_name: string;
  primary_channel: string | null;
  primary_sales_rep: string | null;
  rfm_segment: string | null;
  rfm_total: number | null;
  r_score: number | null;
  f_score: number | null;
  m_score: number | null;
  recency_days: number | null;
  frequency: number | null;
  monetary: number | null;
  ytd_revenue: number;
  prior_year_revenue: number;
  total_invoices: number;
  avg_order_value: number;
  est_margin: number;
  est_margin_pct: number | null;
  top_item_name: string | null;
  top_item_revenue: number | null;
  last_invoice_date: string | null;
  first_invoice_date: string | null;
  bill_state: string | null;
  bill_city: string | null;
}

export interface DrillRow {
  txn_date: string;
  doc_number: string | null;
  qbo_invoice_id: string | null;
  customer_name: string;
  item_name: string | null;
  category: string | null;
  segment: string | null;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  revenue: number;
  est_cost: number | null;
  est_margin: number | null;
}

export function fetchCustomerList(opts: {
  search?: string;
  channel?: string;
  start: string;
  end: string;
  limit?: number;
  offset?: number;
}) {
  return sbrpc<CustomerListRow[]>('fn_customer_classification_list', {
    p_search: opts.search ?? null,
    p_channel: opts.channel ?? null,
    p_start: opts.start,
    p_end: opts.end,
    p_limit: opts.limit ?? 200,
    p_offset: opts.offset ?? 0,
  });
}

export function fetchCustomerDetail(qbo_customer_id: string, start: string, end: string) {
  return sbrpc<CustomerDetail[]>('fn_customer_detail', {
    p_qbo_customer_id: qbo_customer_id,
    p_start: start,
    p_end: end,
  }).then((rows) => rows[0] ?? null);
}

export function fetchCustomerHealth(window_days = 365) {
  return sbrpc<CustomerHealth[]>('fn_customer_health', { p_window_days: window_days });
}

export function fetchCustomerScorecard(qbo_customer_id: string, window_days = 365) {
  return sbrpc<CustomerScorecard[]>('fn_customer_scorecard', {
    p_qbo_customer_id: qbo_customer_id,
    p_window_days: window_days,
  }).then((rows) => rows[0] ?? null);
}

export function fetchInvoiceLines(opts: {
  dim: 'customer' | 'item' | 'category';
  dim_label: string;
  start: string;
  end: string;
  customers?: string[] | null;
  limit?: number;
}) {
  return sbrpc<DrillRow[]>('fn_pivot_drill', {
    p_dim: opts.dim,
    p_dim_label: opts.dim_label,
    p_start: opts.start,
    p_end: opts.end,
    p_customers: opts.customers && opts.customers.length ? opts.customers : null,
    p_limit: opts.limit ?? 200,
  });
}
