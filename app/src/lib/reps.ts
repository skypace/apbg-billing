import { sbq, sbrpc } from './rpc';

export interface RepScorecardRow {
  rep_code: string;
  rep_name: string;
  customer_count: number;
  invoice_count: number;
  revenue: number;
  est_margin: number;
  margin_pct: number | null;
  avg_order_value: number | null;
  active_30d: number;
  inactive_60d: number;
  rate_revenue: number;
  rate_margin: number;
  commission: number;
}

export interface RepBookRow {
  qbo_customer_id: string;
  customer_name: string;
  primary_channel: string | null;
  invoice_count: number;
  revenue: number;
  est_margin: number;
  margin_pct: number | null;
  last_invoice: string | null;
  recency_days: number | null;
  rfm_segment: string | null;
}

export interface CommissionRule {
  rep_code: string;
  rate_revenue: number;
  rate_margin: number;
  draw_monthly: number;
  applies_to: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  updated_at: string;
}

export function fetchRepScorecard(start: string, end: string) {
  return sbrpc<RepScorecardRow[]>('fn_rep_scorecard', { p_start: start, p_end: end });
}

export function fetchRepBook(rep_code: string, start: string, end: string) {
  return sbrpc<RepBookRow[]>('fn_rep_book', {
    p_rep_code: rep_code,
    p_start: start,
    p_end: end,
  });
}

export function fetchCommissionRules() {
  return sbq<CommissionRule>('commission_rules', 'select=*');
}
