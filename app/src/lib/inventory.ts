import { sbDelete, sbInsert, sbq, sbrpc } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';

// fetchInventoryHealth now calls fn_items_master under the hood so
// Inventory + Settings → Items share one data source. category_override
// from inventory_settings flows through as category_resolved.

export interface InventoryHealthRow {
  qbo_item_id: string;
  item_name: string;
  fully_qualified_name: string | null;
  active: boolean;
  category_path: string | null;
  category_override: string | null;
  category_resolved: string;
  income_account_name: string | null;
  expense_account_name: string | null;
  on_hand: number | null;
  unit_price: number | null;
  purchase_cost: number | null;
  static_purchase_cost?: number | null;
  is_managed: boolean;
  is_planner: boolean;
  target_days_supply: number;
  lead_time_days: number;
  reorder_point: number | null;
  min_order_qty: number | null;
  notes: string | null;
  sold_qty: number;
  sold_revenue: number;
  customers_count: number;
  purchased_qty: number;
  purchased_cost: number;
  adjustment_qty: number;
  shrinkage_qty: number;
  daily_velocity: number | null;
  days_of_supply: number | null;
  suggested_order_qty: number | null;
  suggested_order_cycle_days: number | null;
  status: string;
  product_family_code: string | null;
  product_family_label: string | null;
  product_type_code: string | null;
  product_type_label: string | null;
}

export interface InventorySettingsRow {
  qbo_item_id: string;
  is_managed: boolean;
  is_planner: boolean;
  target_days_supply: number;
  lead_time_days: number;
  min_order_qty: number | null;
  reorder_point: number | null;
  notes: string | null;
  category_override: string | null;
  updated_at: string;
}

export interface VelocityExcludeRow {
  qbo_customer_id: string;
  reason: string | null;
  added_by: string | null;
  added_at: string;
}

export interface QboCustomerOption {
  qbo_customer_id: string;
  display_name: string;
}

export interface CategoryOption {
  label: string;
  source: 'qbo' | 'override' | 'both';
  count: number;
}

export type AlignmentStatus =
  | 'aligned' | 'misaligned' | 'isolated'
  | 'no_account' | 'unclassified_account';

export interface ItemPlAuditRow {
  qbo_item_id: string;
  item_name: string;
  active: boolean;
  income_account_name: string | null;
  expense_account_name: string | null;
  current_category: string;
  category_override: string | null;
  dominant_category_for_account: string | null;
  account_item_count: number | null;
  account_category_consensus_pct: number | null;
  alignment_status: AlignmentStatus;
  suggested_category: string | null;
}

export interface PlSuggestionApplyRow {
  qbo_item_id: string;
  item_name: string;
  from_category: string;
  to_category: string;
  income_account: string;
  applied: boolean;
}

export interface QboCategorySyncResult {
  ok: boolean;
  commit: boolean;
  message?: string;
  categories_total?: number;
  categories_created?: string[];
  summary?: {
    total: number;
    already_correct: number;
    would_update: number;
    updated: number;
    skipped_unknown_category: number;
    errors: Array<{ qboItemId: string; error: string }>;
  };
  error?: string;
  duration_ms?: number;
}

export type HygieneBucket =
  | 'no_income_account' | 'no_category'
  | 'isolated_in_account' | 'account_uncategorized';

export interface ItemHygieneRow {
  bucket: HygieneBucket;
  label: string;
  item_count: number;
  detail: string[] | null;
}

export interface RollupMatchPreview {
  match_mode: string;
  matched_customers: number;
  matched_categories: number;
  matched_items: number;
  matched_line_count: number;
  matched_revenue: number;
  sample_customer_names: string[] | null;
  sample_category_names: string[] | null;
  sample_item_names: string[] | null;
}

export function fetchInventoryHealth(opts: { lookback?: number; managed_only?: boolean; search?: string }) {
  return sbrpc<InventoryHealthRow[]>('fn_items_master', {
    p_lookback_days: opts.lookback ?? 90,
    p_search:        opts.search ?? null,
    p_managed_only:  opts.managed_only ?? false,
  });
}

export function setInventorySettings(opts: {
  qbo_item_id: string;
  is_managed?: boolean | null;
  is_planner?: boolean | null;
  target_days_supply?: number | null;
  lead_time_days?: number | null;
  reorder_point?: number | null;
  min_order_qty?: number | null;
  notes?: string | null;
  category_override?: string | null;
}) {
  return sbrpc<void>('fn_set_inventory_settings', {
    p_qbo_item_id:        opts.qbo_item_id,
    p_is_managed:         opts.is_managed ?? null,
    p_is_planner:         opts.is_planner ?? null,
    p_target_days_supply: opts.target_days_supply ?? null,
    p_lead_time_days:     opts.lead_time_days ?? null,
    p_reorder_point:      opts.reorder_point ?? null,
    p_min_order_qty:      opts.min_order_qty ?? null,
    p_notes:              opts.notes ?? null,
    p_category_override:  opts.category_override ?? null,
  });
}

async function callPushQboItem<T>(body: Record<string, unknown>): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/functions/v1/push-qbo-item', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || (j && j.ok === false)) {
    throw new Error(j?.error || ('push-qbo-item failed: HTTP ' + res.status));
  }
  return j as T;
}

export async function setItemActive(qbo_item_id: string, active: boolean): Promise<{
  ok: boolean;
  no_change?: boolean;
  was_active?: boolean;
  now_active?: boolean;
}> {
  return callPushQboItem({ action: 'setActive', qbo_item_id, active });
}

export async function bulkSyncCategoriesToQbo(commit = false): Promise<QboCategorySyncResult> {
  return callPushQboItem<QboCategorySyncResult>({
    action: 'bulkSyncCategories',
    commit,
  });
}

export function fetchCategoryList() {
  return sbrpc<CategoryOption[]>('fn_list_category_options', {});
}

export interface ProductFamily { family_code: string; label: string; sort_order: number }
export interface ProductType   { type_code:   string; label: string; sort_order: number }

export function fetchProductFamilies() {
  return sbrpc<ProductFamily[]>('fn_list_product_families', {});
}
export function fetchProductTypes() {
  return sbrpc<ProductType[]>('fn_list_product_types', {});
}

export function setItemProductFamily(qbo_item_id: string, family_code: string | null) {
  return sbrpc<void>('fn_set_item_product_family', {
    p_qbo_item_id: qbo_item_id,
    p_family_code: family_code,
  });
}
export function setItemProductType(qbo_item_id: string, type_code: string | null) {
  return sbrpc<void>('fn_set_item_product_type', {
    p_qbo_item_id: qbo_item_id,
    p_type_code:   type_code,
  });
}
export function bulkSetItemProductFamily(qbo_item_ids: string[], family_code: string | null) {
  return sbrpc<number>('fn_bulk_set_item_product_family', {
    p_qbo_item_ids: qbo_item_ids,
    p_family_code:  family_code,
  });
}
export function bulkSetItemProductType(qbo_item_ids: string[], type_code: string | null) {
  return sbrpc<number>('fn_bulk_set_item_product_type', {
    p_qbo_item_ids: qbo_item_ids,
    p_type_code:    type_code,
  });
}

export function fetchItemPlAudit(min_account_items = 3) {
  return sbrpc<ItemPlAuditRow[]>('fn_item_pl_audit', {
    p_min_account_items: min_account_items,
  });
}

export function applyPlCategorySuggestions(opts: {
  min_account_items?: number;
  min_consensus_pct?: number;
  dry_run?: boolean;
} = {}) {
  return sbrpc<PlSuggestionApplyRow[]>('fn_apply_pl_category_suggestions', {
    p_min_account_items: opts.min_account_items ?? 3,
    p_min_consensus_pct: opts.min_consensus_pct ?? 60,
    p_dry_run:           opts.dry_run ?? true,
  });
}

export interface PlAlignRow {
  qbo_item_id: string;
  item_name: string;
  income_account_name: string | null;
  from_category: string;
  to_category: string | null;
  status: 'updated' | 'already_aligned' | 'skipped_no_account';
  applied: boolean;
}

// Forces every active item's category_override = income_account_name.
// commit=false → dry-run preview. commit=true → applies.
export function alignCategoriesToPl(commit = false) {
  return sbrpc<PlAlignRow[]>('fn_align_categories_to_pl', {
    p_commit: commit,
  });
}

// ----- Track 1 — Data hygiene (v0.9.26) -----

export function fetchItemHygieneSummary() {
  return sbrpc<ItemHygieneRow[]>('fn_item_hygiene_summary', {});
}

export function previewRollupMatch(opts: {
  customers?: string[] | null;
  categories?: string[] | null;
  items?: string[] | null;
  channels?: string[] | null;
  segments?: string[] | null;
}) {
  return sbrpc<RollupMatchPreview[]>('fn_preview_rollup_match', {
    p_customers:  opts.customers  ?? null,
    p_categories: opts.categories ?? null,
    p_items:      opts.items      ?? null,
    p_channels:   opts.channels   ?? null,
    p_segments:   opts.segments   ?? null,
  });
}

export function fetchVelocityExcludes() {
  return sbq<VelocityExcludeRow>('inventory_velocity_excludes', 'select=*&order=added_at.desc');
}

export function addVelocityExclude(qbo_customer_id: string, reason?: string) {
  return sbInsert('inventory_velocity_excludes', {
    qbo_customer_id,
    reason: reason ?? null,
  });
}

export function removeVelocityExclude(qbo_customer_id: string) {
  return sbDelete('inventory_velocity_excludes', 'qbo_customer_id=eq.' + encodeURIComponent(qbo_customer_id));
}

export function fetchCustomerOptions() {
  return sbq<QboCustomerOption>(
    'qbo_customers',
    'select=qbo_customer_id,display_name&active=eq.true&order=display_name&limit=1500',
  );
}
