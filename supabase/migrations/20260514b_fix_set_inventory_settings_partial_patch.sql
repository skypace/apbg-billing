-- v0.9.38 — fix fn_set_inventory_settings overwriting non-patched fields.
--
-- Reproduction: in psql, set is_managed=true, then call again with
-- only p_is_planner=true. Expected: is_managed stays true. Actual: it
-- flipped back to false. Repro showed every partial patch reset the
-- non-patched boolean fields to defaults and the numeric fields to
-- their defaults too.
--
-- Root cause: previous version used EXCLUDED.x in the DO UPDATE SET,
-- but EXCLUDED.x was always non-NULL because the INSERT VALUES clause
-- COALESCE'd NULL parameters to defaults (false / 30 / 7). So
-- COALESCE(EXCLUDED.is_managed, current.is_managed) was effectively
-- COALESCE(false, current) → false. Every patch reset non-patched
-- fields.
--
-- Fix: in DO UPDATE SET, COALESCE against the parameter directly
-- (p_is_managed), which IS null when the caller didn't include it.
-- NULL → use current value. Non-null → take the new value.
--
-- Also: drop a stale 19-arg overload that someone left behind, which
-- was causing PGRST203 ambiguity in some clients.

DROP FUNCTION IF EXISTS ops.fn_set_inventory_settings(
  text, boolean, integer, integer, numeric, numeric, text, text,
  boolean, boolean, boolean, numeric, numeric, text, numeric,
  numeric, numeric, text, text
);

CREATE OR REPLACE FUNCTION ops.fn_set_inventory_settings(
  p_qbo_item_id        TEXT,
  p_is_managed         BOOLEAN DEFAULT NULL,
  p_target_days_supply INTEGER DEFAULT NULL,
  p_lead_time_days     INTEGER DEFAULT NULL,
  p_reorder_point      NUMERIC DEFAULT NULL,
  p_min_order_qty      NUMERIC DEFAULT NULL,
  p_notes              TEXT    DEFAULT NULL,
  p_category_override  TEXT    DEFAULT NULL,
  p_is_planner         BOOLEAN DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ops, public
AS $func$
BEGIN
  INSERT INTO ops.inventory_settings (
    qbo_item_id, is_managed, target_days_supply, lead_time_days,
    reorder_point, min_order_qty, notes, category_override, is_planner, updated_at
  )
  VALUES (
    p_qbo_item_id,
    COALESCE(p_is_managed, false),
    COALESCE(p_target_days_supply, 30),
    COALESCE(p_lead_time_days, 7),
    p_reorder_point, p_min_order_qty, p_notes, p_category_override,
    COALESCE(p_is_planner, false), NOW()
  )
  ON CONFLICT (qbo_item_id) DO UPDATE SET
    is_managed         = COALESCE(p_is_managed,         ops.inventory_settings.is_managed),
    target_days_supply = COALESCE(p_target_days_supply, ops.inventory_settings.target_days_supply),
    lead_time_days     = COALESCE(p_lead_time_days,     ops.inventory_settings.lead_time_days),
    reorder_point      = COALESCE(p_reorder_point,      ops.inventory_settings.reorder_point),
    min_order_qty      = COALESCE(p_min_order_qty,      ops.inventory_settings.min_order_qty),
    notes              = COALESCE(p_notes,              ops.inventory_settings.notes),
    category_override  = COALESCE(p_category_override,  ops.inventory_settings.category_override),
    is_planner         = COALESCE(p_is_planner,         ops.inventory_settings.is_planner),
    updated_at         = NOW();
END;
$func$;
GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_settings(
  TEXT, BOOLEAN, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN
) TO authenticated;
