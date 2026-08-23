import { sbDelete, sbInsert, sbq, sbrpc } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';
import type { InventoryLaneDb, InventoryLaneSize } from './inventoryLane';

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
  qty_on_order: number;
  daily_velocity: number | null;
  days_of_supply: number | null;
  suggested_order_qty: number | null;
  suggested_order_cycle_days: number | null;
  status: string;
  product_family_code: string | null;
  product_family_label: string | null;
  product_type_code: string | null;
  product_type_label: string | null;
  segment_code: string | null;
  segment_label: string | null;
  segment_source: 'item' | 'category' | null;
  track_locations: boolean;
  has_bom: boolean;
  inventory_lane: InventoryLaneDb;
  inventory_lane_size: InventoryLaneSize | null;
  inventory_lane_source: 'auto' | 'manual';
  inventory_lane_reviewed: boolean;
  default_receiving_location_id: string | null;
  qbo_on_hand: number | null;
  brix_on_hand: number | null;
  planning_on_hand: number | null;
  on_hand_drift: number | null;
  weight_per_unit_lbs: number | null;
  units_per_pallet: number | null;
  freight_class: string | null;
  dim_l_in: number | null;
  dim_w_in: number | null;
  dim_h_in: number | null;
  unit_type: string | null;
  nmfc_code: string | null;
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
  track_locations?: boolean | null;
  has_bom?: boolean | null;
  weight_per_unit_lbs?: number | null;
  units_per_pallet?: number | null;
  freight_class?: string | null;
  dim_l_in?: number | null;
  dim_w_in?: number | null;
  dim_h_in?: number | null;
  unit_type?: string | null;
  nmfc_code?: string | null;
}) {
  return sbrpc<void>('fn_set_inventory_settings', {
    p_qbo_item_id:         opts.qbo_item_id,
    p_is_managed:          opts.is_managed ?? null,
    p_is_planner:          opts.is_planner ?? null,
    p_target_days_supply:  opts.target_days_supply ?? null,
    p_lead_time_days:      opts.lead_time_days ?? null,
    p_reorder_point:       opts.reorder_point ?? null,
    p_min_order_qty:       opts.min_order_qty ?? null,
    p_notes:               opts.notes ?? null,
    p_category_override:   opts.category_override ?? null,
    p_track_locations:     opts.track_locations ?? null,
    p_has_bom:             opts.has_bom ?? null,
    p_weight_per_unit_lbs: opts.weight_per_unit_lbs ?? null,
    p_units_per_pallet:    opts.units_per_pallet ?? null,
    p_freight_class:       opts.freight_class ?? null,
    p_dim_l_in:            opts.dim_l_in ?? null,
    p_dim_w_in:            opts.dim_w_in ?? null,
    p_dim_h_in:            opts.dim_h_in ?? null,
    p_unit_type:           opts.unit_type ?? null,
    p_nmfc_code:           opts.nmfc_code ?? null,
  });
}

export function setInventoryLane(opts: {
  qbo_item_id: string;
  inventory_lane: InventoryLaneDb;
  inventory_lane_size?: InventoryLaneSize | null;
  default_receiving_location_id?: string | null;
  inventory_lane_reviewed?: boolean | null;
}) {
  return sbrpc<void>('fn_set_inventory_lane', {
    p_qbo_item_id: opts.qbo_item_id,
    p_inventory_lane: opts.inventory_lane,
    p_inventory_lane_size: opts.inventory_lane_size ?? null,
    p_default_receiving_location_id: opts.default_receiving_location_id ?? null,
    p_inventory_lane_reviewed: opts.inventory_lane_reviewed ?? true,
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

// Pull item master from QBO on demand (instead of waiting for the
// nightly 1:30am PT cron). Returns the sync result so the UI can show
// "synced 1,211 items, 738 inactive" or similar.
export interface QboItemsSyncResult {
  ok: boolean;
  synced?: number;
  active_in_qbo?: number;
  inactive_in_qbo?: number;
  with_purchase_cost?: number;
  upserted?: number;
  reconciled_inactive?: number;
  duration_ms?: number;
  error?: string;
}
export async function pullQboItemsNow(): Promise<QboItemsSyncResult> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/functions/v1/sync-qbo-items', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const j = (await res.json()) as QboItemsSyncResult;
  if (!res.ok || j.ok === false) {
    throw new Error(j.error || ('QBO items sync failed: HTTP ' + res.status));
  }
  return j;
}

// Logs every QBO writeback attempt to ops.qbo_writeback_log so we have
// our own audit trail (not just edge-function HTTP logs). Best-effort:
// logging failures never throw — we don't want to mask the real result.
export async function logQboWriteback(opts: {
  action: string;
  qbo_item_id: string | null;
  before: Record<string, unknown>;
  after:  Record<string, unknown>;
  result: 'success' | 'failure' | 'cancelled';
  error?: string | null;
}) {
  try {
    await sbrpc<number>('fn_log_qbo_writeback', {
      p_action:      opts.action,
      p_qbo_item_id: opts.qbo_item_id,
      p_before:      opts.before,
      p_after:       opts.after,
      p_result:      opts.result,
      p_error:       opts.error ?? null,
    });
  } catch {
    // intentionally swallow — audit log shouldn't break the real call
  }
}

// Wraps setItemActive with audit logging. Use this from the UI instead
// of calling setItemActive directly so every Active flip lands in
// ops.qbo_writeback_log.
export async function setItemActiveAudited(opts: {
  qbo_item_id: string;
  item_name: string;
  current_active: boolean;
  next_active: boolean;
}) {
  const beforeName = opts.item_name;
  const afterName  = opts.next_active
    ? beforeName.replace(/\s*\(deleted\)\s*$/i, '')
    : (beforeName.endsWith(' (deleted)') ? beforeName : beforeName + ' (deleted)');
  const before = { active: opts.current_active, name: beforeName };
  const after  = { active: opts.next_active,    name: afterName };

  try {
    const res = await setItemActive(opts.qbo_item_id, opts.next_active);
    await logQboWriteback({
      action: 'setActive', qbo_item_id: opts.qbo_item_id,
      before, after, result: 'success',
    });
    return res;
  } catch (e) {
    await logQboWriteback({
      action: 'setActive', qbo_item_id: opts.qbo_item_id,
      before, after, result: 'failure',
      error: (e as Error).message,
    });
    throw e;
  }
}

export async function logQboWritebackCancelled(opts: {
  qbo_item_id: string;
  item_name: string;
  current_active: boolean;
  intended_active: boolean;
}) {
  return logQboWriteback({
    action: 'setActive', qbo_item_id: opts.qbo_item_id,
    before: { active: opts.current_active, name: opts.item_name },
    after:  { active: opts.intended_active, name: opts.item_name },
    result: 'cancelled',
  });
}

export async function bulkSyncCategoriesToQbo(commit = false): Promise<QboCategorySyncResult> {
  return callPushQboItem<QboCategorySyncResult>({
    action: 'bulkSyncCategories',
    commit,
  });
}

// ── One-shot QBO cleanup: flatten + inactivate categories ────────────────
// Companion of bulkSyncCategoriesToQbo. Runs in phases — UI calls it
// repeatedly until `remaining` drops to 0 for each phase. BRIX
// inventory_settings.category_override stays untouched throughout.
export interface QboUnparentResult {
  ok: boolean;
  phase: 'preview' | 'unparent' | 'inactivate';
  commit?: boolean;
  // preview-only fields:
  items_to_unparent?: number;
  categories_to_inactivate?: number;
  categories_total_in_qbo?: number;
  // phase-run fields:
  summary?: {
    attempted: number;
    updated?: number;
    already_clean?: number;
    already_inactive?: number;
    errors: { id: string; error: string }[];
  };
  remaining?: number;
  duration_ms?: number;
  error?: string;
  note?: string;
}

export async function previewQboCategoryCleanup() {
  return callPushQboItem<QboUnparentResult>({
    action: 'unparentAndInactivateCategories',
    phase: 'preview',
  });
}

export async function runQboUnparentBatch(commit: boolean, limit = 50) {
  return callPushQboItem<QboUnparentResult>({
    action: 'unparentAndInactivateCategories',
    phase: 'unparent',
    commit,
    limit,
  });
}

export async function runQboInactivateBatch(commit: boolean, limit = 50) {
  return callPushQboItem<QboUnparentResult>({
    action: 'unparentAndInactivateCategories',
    phase: 'inactivate',
    commit,
    limit,
  });
}

export function fetchCategoryList() {
  return sbrpc<CategoryOption[]>('fn_list_category_options', {});
}

export interface ProductFamily { family_code: string; label: string; sort_order: number }
export interface ProductType   { type_code:   string; label: string; sort_order: number }
export interface SegmentOption { segment_code: string; label: string; sort_order: number }

export function fetchProductFamilies() {
  return sbrpc<ProductFamily[]>('fn_list_product_families', {});
}
export function fetchProductTypes() {
  return sbrpc<ProductType[]>('fn_list_product_types', {});
}
export function fetchSegmentOptions() {
  return sbrpc<SegmentOption[]>('fn_list_segments_for_items', {});
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
export function setItemSegment(qbo_item_id: string, segment_code: string | null) {
  return sbrpc<void>('fn_set_item_segment', {
    p_qbo_item_id:  qbo_item_id,
    p_segment_code: segment_code,
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
export function bulkSetItemSegment(qbo_item_ids: string[], segment_code: string | null) {
  return sbrpc<number>('fn_bulk_set_item_segment', {
    p_qbo_item_ids: qbo_item_ids,
    p_segment_code: segment_code,
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
