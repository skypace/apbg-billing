-- Hotfix: PostgREST PGRST203 because v0.9.31's CREATE OR REPLACE left
-- older fn_set_inventory_settings signatures (5-arg and 8-arg) coexisting
-- with the new 9-arg version. PostgREST can't pick a winner when the
-- caller's named args match multiple candidates.
--
-- Scorched all signatures and recreated exactly one (9-arg canonical).
-- Plus a sweep of the ops schema confirmed no other functions have
-- multiple signatures.

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'fn_set_inventory_settings'
  LOOP
    EXECUTE 'DROP FUNCTION ' || rec.sig::text;
  END LOOP;
END $$;

CREATE FUNCTION ops.fn_set_inventory_settings(
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
    is_managed         = COALESCE(EXCLUDED.is_managed, ops.inventory_settings.is_managed),
    target_days_supply = COALESCE(EXCLUDED.target_days_supply, ops.inventory_settings.target_days_supply),
    lead_time_days     = COALESCE(EXCLUDED.lead_time_days, ops.inventory_settings.lead_time_days),
    reorder_point      = COALESCE(EXCLUDED.reorder_point, ops.inventory_settings.reorder_point),
    min_order_qty      = COALESCE(EXCLUDED.min_order_qty, ops.inventory_settings.min_order_qty),
    notes              = COALESCE(EXCLUDED.notes, ops.inventory_settings.notes),
    category_override  = COALESCE(EXCLUDED.category_override, ops.inventory_settings.category_override),
    is_planner         = COALESCE(EXCLUDED.is_planner, ops.inventory_settings.is_planner),
    updated_at         = NOW();
END;
$func$;

GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_settings(
  TEXT, BOOLEAN, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN
) TO authenticated;
