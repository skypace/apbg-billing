// Typed wrappers for sales plans + plan analytics RPCs.
import { sbq, sbrpc } from './rpc';

export interface SalesPlan {
  id: string;
  name: string;
  fiscal_year: number;
  scenario: string;
  notes: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SalesPlanLine {
  id: string;
  plan_id: string;
  line_type: string;
  qbo_item_id: string | null;
  item_name: string | null;
  qbo_account_id: string | null;
  account_name: string | null;
  notes: string | null;
  amounts: number[];
  sort_order: number;
  updated_at: string;
}

export interface PlanAccountRollupRow {
  qbo_account_id: string | null;
  account_name: string;
  line_count: number;
  m1: number; m2: number; m3: number; m4: number;
  m5: number; m6: number; m7: number; m8: number;
  m9: number; m10: number; m11: number; m12: number;
  total: number;
}

export interface PlanForecastRow {
  line_id: string;
  item_name: string | null;
  account_name: string | null;
  full_year_plan: number;
  ytd_plan: number;
  ytd_actual: number;
  months_complete: number;
  projected_full_year: number | null;
  projected_vs_plan_pct: number | null;
  status: 'ahead' | 'on_track' | 'behind' | 'critical' | 'no_data';
}

export interface QboItemOption {
  qbo_item_id: string;
  name: string;
  fully_qualified_name: string | null;
  income_account_ref_id: string | null;
  income_account_name: string | null;
}

export const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function fetchPlans() {
  return sbq<SalesPlan>('sales_plans', 'select=*&order=fiscal_year.desc,name');
}

export function fetchPlanLines(plan_id: string) {
  return sbq<SalesPlanLine>(
    'sales_plan_lines',
    'select=*&plan_id=eq.' + encodeURIComponent(plan_id) + '&order=sort_order,item_name',
  );
}

export function fetchPlanAccountRollup(plan_id: string) {
  return sbrpc<PlanAccountRollupRow[]>('fn_plan_account_rollup', { p_plan_id: plan_id });
}

export function fetchPlanForecast(plan_id: string) {
  return sbrpc<PlanForecastRow[]>('fn_plan_forecast', { p_plan_id: plan_id });
}

export function fetchItemOptions() {
  return sbq<QboItemOption>(
    'qbo_items',
    'select=qbo_item_id,name,fully_qualified_name,income_account_ref_id,income_account_name&active=eq.true&order=name&limit=2000',
  );
}

// ----- Plan Builder auto-fill (v0.9.31) -----

export interface AutofillResultRow {
  qbo_item_id: string;
  item_name: string;
  qbo_customer_id: string;
  customer_name: string;
  annual_qty: number;
  annual_revenue: number;
  created: boolean;
}

export function autofillPlanFromHistory(opts: {
  plan_id: string;
  item_ids?: string[] | null;
  customer_ids?: string[] | null;
  adjustment_pct?: number;
  source_year?: number | null;
}) {
  return sbrpc<AutofillResultRow[]>('fn_autofill_plan_from_history', {
    p_plan_id:        opts.plan_id,
    p_item_ids:       opts.item_ids ?? null,
    p_customer_ids:   opts.customer_ids ?? null,
    p_adjustment_pct: opts.adjustment_pct ?? 0,
    p_source_year:    opts.source_year ?? null,
  });
}
