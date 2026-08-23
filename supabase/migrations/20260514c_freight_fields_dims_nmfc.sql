-- ============================================================================
-- Extra freight fields: dimensions, unit type, NMFC code
--
-- Adds the per-item fields the operator wants on the Items master to
-- complete the BOL freight payload:
--   dim_l_in / dim_w_in / dim_h_in  — per-unit dimensions in inches
--   unit_type                       — free-text 'case' | 'pallet' | 'drum'
--                                     | 'each' | 'bag' | 'crate' | etc
--   nmfc_code                       — NMFC commodity code (4-6 digit)
--
-- Bumps fn_set_inventory_settings to 19-arg canonical.
-- Bumps fn_items_master to return the 5 new columns.
--
-- The signature columns added in 20260514a remain in the schema for now
-- but the UI no longer prompts for or prints them (operator chose
-- "blank lines on BOL print" for wet-ink signing). The RPC params on
-- fn_ship_transfer / fn_receive_transfer remain so future re-enable is
-- a UI-only change.
-- ============================================================================

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS dim_l_in    NUMERIC,
  ADD COLUMN IF NOT EXISTS dim_w_in    NUMERIC,
  ADD COLUMN IF NOT EXISTS dim_h_in    NUMERIC,
  ADD COLUMN IF NOT EXISTS unit_type   TEXT,
  ADD COLUMN IF NOT EXISTS nmfc_code   TEXT;


-- fn_set_inventory_settings — canonical 19-arg
DO $$
DECLARE rec RECORD;
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
  p_is_planner         BOOLEAN DEFAULT NULL,
  p_track_locations    BOOLEAN DEFAULT NULL,
  p_has_bom            BOOLEAN DEFAULT NULL,
  p_weight_per_unit_lbs NUMERIC DEFAULT NULL,
  p_units_per_pallet    NUMERIC DEFAULT NULL,
  p_freight_class       TEXT    DEFAULT NULL,
  p_dim_l_in            NUMERIC DEFAULT NULL,
  p_dim_w_in            NUMERIC DEFAULT NULL,
  p_dim_h_in            NUMERIC DEFAULT NULL,
  p_unit_type           TEXT    DEFAULT NULL,
  p_nmfc_code           TEXT    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ops, public AS $func$
BEGIN
  INSERT INTO ops.inventory_settings (
    qbo_item_id, is_managed, target_days_supply, lead_time_days,
    reorder_point, min_order_qty, notes, category_override, is_planner,
    track_locations, has_bom,
    weight_per_unit_lbs, units_per_pallet, freight_class,
    dim_l_in, dim_w_in, dim_h_in, unit_type, nmfc_code,
    updated_at
  )
  VALUES (
    p_qbo_item_id,
    COALESCE(p_is_managed, false),
    COALESCE(p_target_days_supply, 30),
    COALESCE(p_lead_time_days, 7),
    p_reorder_point, p_min_order_qty, p_notes, p_category_override,
    COALESCE(p_is_planner, false),
    COALESCE(p_track_locations, false),
    COALESCE(p_has_bom, false),
    p_weight_per_unit_lbs, p_units_per_pallet, p_freight_class,
    p_dim_l_in, p_dim_w_in, p_dim_h_in, p_unit_type, p_nmfc_code,
    NOW()
  )
  ON CONFLICT (qbo_item_id) DO UPDATE SET
    is_managed         = COALESCE(EXCLUDED.is_managed,         ops.inventory_settings.is_managed),
    target_days_supply = COALESCE(EXCLUDED.target_days_supply, ops.inventory_settings.target_days_supply),
    lead_time_days     = COALESCE(EXCLUDED.lead_time_days,     ops.inventory_settings.lead_time_days),
    reorder_point      = COALESCE(EXCLUDED.reorder_point,      ops.inventory_settings.reorder_point),
    min_order_qty      = COALESCE(EXCLUDED.min_order_qty,      ops.inventory_settings.min_order_qty),
    notes              = COALESCE(EXCLUDED.notes,              ops.inventory_settings.notes),
    category_override  = COALESCE(EXCLUDED.category_override,  ops.inventory_settings.category_override),
    is_planner         = COALESCE(EXCLUDED.is_planner,         ops.inventory_settings.is_planner),
    track_locations    = COALESCE(EXCLUDED.track_locations,    ops.inventory_settings.track_locations),
    has_bom            = COALESCE(EXCLUDED.has_bom,            ops.inventory_settings.has_bom),
    weight_per_unit_lbs= COALESCE(EXCLUDED.weight_per_unit_lbs, ops.inventory_settings.weight_per_unit_lbs),
    units_per_pallet   = COALESCE(EXCLUDED.units_per_pallet,    ops.inventory_settings.units_per_pallet),
    freight_class      = COALESCE(EXCLUDED.freight_class,       ops.inventory_settings.freight_class),
    dim_l_in           = COALESCE(EXCLUDED.dim_l_in,            ops.inventory_settings.dim_l_in),
    dim_w_in           = COALESCE(EXCLUDED.dim_w_in,            ops.inventory_settings.dim_w_in),
    dim_h_in           = COALESCE(EXCLUDED.dim_h_in,            ops.inventory_settings.dim_h_in),
    unit_type          = COALESCE(EXCLUDED.unit_type,           ops.inventory_settings.unit_type),
    nmfc_code          = COALESCE(EXCLUDED.nmfc_code,           ops.inventory_settings.nmfc_code),
    updated_at         = NOW();
END;
$func$;

GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_settings(
  TEXT, BOOLEAN, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT,
  BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, NUMERIC, TEXT,
  NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT
) TO authenticated;


-- fn_items_master — return 5 new columns
DROP FUNCTION IF EXISTS ops.fn_items_master(integer, text, boolean);

CREATE FUNCTION ops.fn_items_master(
  p_lookback_days integer DEFAULT 90,
  p_search        text    DEFAULT NULL,
  p_managed_only  boolean DEFAULT false
)
RETURNS TABLE(
  qbo_item_id text, item_name text, fully_qualified_name text, active boolean,
  category_path text, category_override text, category_resolved text,
  income_account_name text, expense_account_name text,
  on_hand numeric, unit_price numeric, purchase_cost numeric,
  is_managed boolean, is_planner boolean,
  target_days_supply integer, lead_time_days integer,
  reorder_point numeric, min_order_qty numeric, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer,
  daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text,
  product_type_code   text, product_type_label   text,
  track_locations boolean, has_bom boolean,
  weight_per_unit_lbs numeric, units_per_pallet numeric, freight_class text,
  dim_l_in numeric, dim_w_in numeric, dim_h_in numeric,
  unit_type text, nmfc_code text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH start_date AS (SELECT (current_date - p_lookback_days)::date AS d),
  excludes AS (SELECT qbo_customer_id FROM ops.inventory_velocity_excludes),
  sold AS (
    SELECT v.item_ref_id AS qbo_item_id,
      sum(v.quantity)::numeric AS qty,
      sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM start_date)
      AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL
      AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(CASE WHEN a.qty_diff < 0 THEN ABS(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL
      AND a.txn_date >= (SELECT d FROM start_date)
    GROUP BY 1
  )
  SELECT
    it.qbo_item_id,
    COALESCE(it.name, it.fully_qualified_name),
    it.fully_qualified_name,
    COALESCE(it.active, true)::boolean,
    it.category_path,
    s.category_override,
    COALESCE(s.category_override, it.category_path, 'Uncategorized'),
    it.income_account_name,
    it.expense_account_name,
    COALESCE(it.qty_on_hand, 0)::numeric,
    it.unit_price,
    it.purchase_cost,
    COALESCE(s.is_managed, false),
    COALESCE(s.is_planner, false),
    COALESCE(s.target_days_supply, 30),
    COALESCE(s.lead_time_days, 7),
    s.reorder_point,
    s.min_order_qty,
    s.notes,
    COALESCE(sold.qty, 0),
    COALESCE(sold.revenue, 0),
    COALESCE(sold.customers_count, 0),
    ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))::numeric,
    CASE WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
         THEN COALESCE(it.qty_on_hand, 0) / ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))
         ELSE NULL END,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) > 0 THEN 'idle'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) = 0 THEN 'idle'
      WHEN COALESCE(it.qty_on_hand, 0) <= 0 THEN 'critical'
      WHEN COALESCE(it.qty_on_hand, 0) <
           COALESCE(s.lead_time_days, 7) * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1) THEN 'reorder'
      ELSE 'ok'
    END,
    ipf.family_code, pf.label,
    ipt.type_code,   pt.label,
    COALESCE(s.track_locations, false),
    COALESCE(s.has_bom, false),
    s.weight_per_unit_lbs,
    s.units_per_pallet,
    s.freight_class,
    s.dim_l_in, s.dim_w_in, s.dim_h_in,
    s.unit_type, s.nmfc_code
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj  ON adj.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  WHERE
    COALESCE(it.type, '') <> 'Category'
    AND (NOT p_managed_only OR COALESCE(s.is_managed, false))
    AND (
      p_search IS NULL OR p_search = '' OR
      it.name ILIKE '%' || p_search || '%' OR
      it.fully_qualified_name ILIKE '%' || p_search || '%' OR
      COALESCE(s.category_override, it.category_path) ILIKE '%' || p_search || '%'
    )
  ORDER BY
    COALESCE(it.active, true) DESC,
    COALESCE(s.category_override, it.category_path) NULLS LAST,
    it.name;
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_items_master(integer, text, boolean) TO authenticated;
