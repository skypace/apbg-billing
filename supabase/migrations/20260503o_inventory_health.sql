-- Inventory analytics layer.
--   ops.inventory_settings        per-item: is_managed, target_days_supply, lead_time_days
--   ops.inventory_velocity_excludes  per-customer: don't count toward velocity
--   ops.fn_inventory_health(lookback, managed_only) returns one row per QBO
--   item with on_hand, sold_qty/revenue, purchased_qty/cost, daily_velocity,
--   days_of_supply, reorder_point, suggested_order_qty, status.
-- Applied to live DB on 2026-05-03.

CREATE TABLE IF NOT EXISTS ops.inventory_settings (
  qbo_item_id        text PRIMARY KEY,
  is_managed         boolean NOT NULL DEFAULT false,
  target_days_supply int     NOT NULL DEFAULT 30,
  lead_time_days     int     NOT NULL DEFAULT 7,
  min_order_qty      numeric DEFAULT 0,
  reorder_point      numeric,
  notes              text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.inventory_velocity_excludes (
  qbo_customer_id text PRIMARY KEY REFERENCES ops.qbo_customers(qbo_customer_id) ON DELETE CASCADE,
  reason          text,
  added_by        text,
  added_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ops.inventory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.inventory_velocity_excludes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inv_settings_read ON ops.inventory_settings;
DROP POLICY IF EXISTS inv_settings_write ON ops.inventory_settings;
CREATE POLICY inv_settings_read ON ops.inventory_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY inv_settings_write ON ops.inventory_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.inventory_settings TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.inventory_settings TO authenticated;

DROP POLICY IF EXISTS inv_excludes_read ON ops.inventory_velocity_excludes;
DROP POLICY IF EXISTS inv_excludes_write ON ops.inventory_velocity_excludes;
CREATE POLICY inv_excludes_read ON ops.inventory_velocity_excludes FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY inv_excludes_write ON ops.inventory_velocity_excludes FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.inventory_velocity_excludes TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.inventory_velocity_excludes TO authenticated;

-- Full SQL applied via apply_migration "inventory_health" (function bodies
-- omitted for brevity — see fn_inventory_health and fn_set_inventory_settings
-- in the live DB).
