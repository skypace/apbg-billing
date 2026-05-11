import { sbDelete, sbInsert, sbq, sbrpc } from './rpc';

export interface InventoryHealthRow {
  qbo_item_id: string;
  item_name: string;
  category_path: string | null;
  income_account_name: string | null;
  active: boolean;
  on_hand: number | null;
  unit_price: number | null;
  static_purchase_cost: number | null;
  is_managed: boolean;
  target_days_supply: number;
  lead_time_days: number;
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
  reorder_point: number | null;
  suggested_order_qty: number | null;
  suggested_order_cycle_days: number | null;
  status: 'reorder_now' | 'reorder_soon' | 'healthy' | 'overstock' | 'no_velocity' | 'unmanaged' | 'inactive' | 'idle' | 'critical' | 'reorder' | 'ok' | string;
}

export interface InventorySettingsRow {
  qbo_item_id: string;
  is_managed: boolean;
  target_days_supply: number;
  lead_time_days: number;
  min_order_qty: number | null;
  reorder_point: number | null;
  notes: string | null;
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

export function fetchInventoryHealth(opts: { lookback?: number; managed_only?: boolean }) {
  return sbrpc<InventoryHealthRow[]>('fn_inventory_health', {
    p_lookback_days: opts.lookback ?? 90,
    p_managed_only: opts.managed_only ?? false,
  });
}

export function setInventorySettings(opts: {
  qbo_item_id: string;
  is_managed?: boolean | null;
  target_days_supply?: number | null;
  lead_time_days?: number | null;
  notes?: string | null;
}) {
  return sbrpc<void>('fn_set_inventory_settings', {
    p_qbo_item_id: opts.qbo_item_id,
    p_is_managed: opts.is_managed ?? null,
    p_target_days_supply: opts.target_days_supply ?? null,
    p_lead_time_days: opts.lead_time_days ?? null,
    p_notes: opts.notes ?? null,
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
