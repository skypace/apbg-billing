-- ============================================================================
-- inventory_settings: add per-item flags + filter QBO Category-type items
--
-- 1. Add two boolean flags to ops.inventory_settings:
--      track_locations  — opts an item into the Stock multi-location ledger
--      has_bom          — flags an item as a manufactured/assembled SKU
--                         (drives Phase 2 BOM editor)
--    Both default false so existing items are unaffected.
--
-- 2. Bump ops.fn_set_inventory_settings to 11-arg canonical, following the
--    DROP-all-sigs pattern from 20260511u (PostgREST can't overload).
--
-- 3. Drop + recreate ops.fn_items_master so it:
--      - returns track_locations + has_bom columns
--      - excludes QBO Category-type items (Type='Category'), which are
--        hierarchy folders, not sellable items. They have no
--        income_account_name so the P&L audit was falsely flagging
--        them as "no_account" before this filter.
--
-- 4. Patch ops.fn_item_pl_audit to apply the same Category filter so
--    auditing isolates only sellable items.
--
-- See architecture/PRODUCT-CONTROL.md §"Per-item Stock toggles".
-- ============================================================================


-- ── 1. inventory_settings columns ──────────────────────────────────────────
ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS track_locations BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS has_bom         BOOLEAN NOT NULL DEFAULT FALSE;


-- ── 2. fn_set_inventory_settings — canonical 11-arg ────────────────────────
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
  p_is_planner         BOOLEAN DEFAULT NULL,
  p_track_locations    BOOLEAN DEFAULT NULL,
  p_has_bom            BOOLEAN DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ops, public
AS $func$
BEGIN
  INSERT INTO ops.inventory_settings (
    qbo_item_id, is_managed, target_days_supply, lead_time_days,
    reorder_point, min_order_qty, notes, category_override, is_planner,
    track_locations, has_bom, updated_at
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
    updated_at         = NOW();
END;
$func$;

GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_settings(
  TEXT, BOOLEAN, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN
) TO authenticated;


-- ── 3. fn_items_master — add flags, filter Category-type items ─────────────
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
  track_locations boolean, has_bom boolean
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
    ipf.family_code,
    pf.label,
    ipt.type_code,
    pt.label,
    COALESCE(s.track_locations, false),
    COALESCE(s.has_bom, false)
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj  ON adj.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  WHERE
    COALESCE(it.type, '') <> 'Category'                       -- skip hierarchy folders
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


-- ── 4. fn_item_pl_audit — apply the same Category filter ──────────────────
CREATE OR REPLACE FUNCTION ops.fn_item_pl_audit(
  p_min_account_items integer DEFAULT 3
)
RETURNS TABLE(
  qbo_item_id                     text,
  item_name                       text,
  active                          boolean,
  income_account_name             text,
  expense_account_name            text,
  current_category                text,
  category_override               text,
  dominant_category_for_account   text,
  account_item_count              integer,
  account_category_consensus_pct  numeric,
  alignment_status                text,
  suggested_category              text
)
LANGUAGE sql STABLE
SET search_path TO 'ops', 'public'
AS $$
  WITH item_cat AS (
    SELECT
      it.qbo_item_id,
      COALESCE(it.name, it.fully_qualified_name) AS item_name,
      COALESCE(it.active, true)                  AS active,
      it.income_account_name,
      it.expense_account_name,
      COALESCE(s.category_override, it.category_path, 'Uncategorized') AS current_category,
      s.category_override
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
    WHERE COALESCE(it.type, '') <> 'Category'        -- skip QBO hierarchy folders
  ),
  account_groups AS (
    SELECT
      ic.income_account_name,
      ic.current_category,
      count(*)::integer AS n
    FROM item_cat ic
    WHERE ic.income_account_name IS NOT NULL AND ic.income_account_name <> ''
      AND ic.active
      AND ic.current_category <> 'Uncategorized'
    GROUP BY 1, 2
  ),
  account_totals AS (
    SELECT
      income_account_name,
      count(*) FILTER (WHERE active)::integer AS total_active
    FROM item_cat
    WHERE income_account_name IS NOT NULL AND income_account_name <> ''
    GROUP BY 1
  ),
  account_dominant AS (
    SELECT DISTINCT ON (g.income_account_name)
      g.income_account_name,
      g.current_category AS dominant_category,
      g.n                AS dominant_count,
      t.total_active     AS account_total
    FROM account_groups g
    JOIN account_totals t USING (income_account_name)
    ORDER BY g.income_account_name, g.n DESC, g.current_category
  )
  SELECT
    ic.qbo_item_id,
    ic.item_name,
    ic.active,
    ic.income_account_name,
    ic.expense_account_name,
    ic.current_category,
    ic.category_override,
    ad.dominant_category,
    ad.account_total,
    CASE WHEN ad.account_total > 0 AND ad.dominant_count IS NOT NULL
         THEN ROUND((ad.dominant_count::numeric / ad.account_total) * 100, 1)
         ELSE NULL END AS account_category_consensus_pct,
    CASE
      WHEN ic.income_account_name IS NULL OR ic.income_account_name = '' THEN 'no_account'
      WHEN ad.dominant_category IS NULL THEN 'unclassified_account'
      WHEN ad.account_total < p_min_account_items THEN 'isolated'
      WHEN ic.current_category = ad.dominant_category THEN 'aligned'
      ELSE 'misaligned'
    END AS alignment_status,
    CASE
      WHEN ad.dominant_category IS NOT NULL
       AND ad.dominant_category <> 'Uncategorized'
       AND ic.current_category <> ad.dominant_category
       AND ad.account_total >= p_min_account_items
       AND (ad.dominant_count::numeric / ad.account_total) >= 0.60
      THEN ad.dominant_category
      ELSE NULL
    END AS suggested_category
  FROM item_cat ic
  LEFT JOIN account_dominant ad USING (income_account_name);
$$;
GRANT EXECUTE ON FUNCTION ops.fn_item_pl_audit(integer) TO authenticated, anon;
