-- v0.9.34b — Account active/inactive table + supporting RPCs, and filter
-- inactive accounts out of fn_items_master.
--
-- The Margin Control app should let the user hide whole P&L accounts
-- (e.g. legacy SKUs that still have line history). When an account is
-- marked inactive, every item whose income_account_name = that account
-- disappears from the Items master grid. v_sales_lines is untouched
-- so historical revenue and margin reports are unaffected; if you want
-- to exclude an account from a report, use the account filter on the
-- Margin page.

-- 1. account_settings table -----------------------------------------------
CREATE TABLE IF NOT EXISTS ops.account_settings (
  account_name text PRIMARY KEY,
  is_active    boolean NOT NULL DEFAULT true,
  notes        text,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ops.account_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_settings_read  ON ops.account_settings;
DROP POLICY IF EXISTS account_settings_write ON ops.account_settings;
CREATE POLICY account_settings_read  ON ops.account_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY account_settings_write ON ops.account_settings FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.account_settings TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.account_settings TO authenticated;

-- 2. List helper: every distinct income account + item count + is_active --
-- Default: any account not in account_settings is treated as active.
CREATE OR REPLACE FUNCTION ops.fn_list_accounts_for_settings()
RETURNS TABLE(
  account_name text,
  item_count   integer,
  active_item_count integer,
  is_active    boolean,
  notes        text,
  set_at       timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH accts AS (
    SELECT income_account_name AS account_name,
           count(*)::int                                 AS item_count,
           count(*) FILTER (WHERE COALESCE(active, true))::int AS active_item_count
    FROM ops.qbo_items
    WHERE income_account_name IS NOT NULL AND income_account_name <> ''
    GROUP BY 1
  )
  SELECT a.account_name, a.item_count, a.active_item_count,
         COALESCE(s.is_active, true) AS is_active,
         s.notes, s.set_at
  FROM accts a
  LEFT JOIN ops.account_settings s ON s.account_name = a.account_name
  ORDER BY a.item_count DESC, a.account_name;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_list_accounts_for_settings() TO anon, authenticated;

-- 3. Setter ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_set_account_active(
  p_account_name text,
  p_is_active    boolean,
  p_set_by       text DEFAULT 'dashboard'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
BEGIN
  IF p_account_name IS NULL OR p_account_name = '' THEN
    RAISE EXCEPTION 'account_name required';
  END IF;
  INSERT INTO ops.account_settings AS t (account_name, is_active, set_by, set_at)
  VALUES (p_account_name, COALESCE(p_is_active, true), p_set_by, now())
  ON CONFLICT (account_name) DO UPDATE
    SET is_active = EXCLUDED.is_active,
        set_by    = EXCLUDED.set_by,
        set_at    = now();
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_account_active(text, boolean, text) TO authenticated;

-- 4. fn_items_master — filter out items whose income_account is inactive --
-- Adds a JOIN on account_settings (LEFT JOIN, default-active) and a WHERE
-- clause. Everything else is identical to 20260512h.
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
  segment_code text, segment_label text, segment_source text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH start_date AS (SELECT (current_date - p_lookback_days)::date AS d),
  excludes AS (SELECT qbo_customer_id FROM ops.inventory_velocity_excludes),
  sold AS (
    SELECT v.item_ref_id AS qbo_item_id,
      sum(v.quantity)::numeric AS qty, sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM start_date) AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(CASE WHEN a.qty_diff < 0 THEN ABS(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL AND a.txn_date >= (SELECT d FROM start_date)
    GROUP BY 1
  )
  SELECT
    it.qbo_item_id, COALESCE(it.name, it.fully_qualified_name), it.fully_qualified_name,
    COALESCE(it.active, true)::boolean,
    it.category_path, s.category_override,
    COALESCE(s.category_override, it.category_path, 'Uncategorized'),
    it.income_account_name, it.expense_account_name,
    COALESCE(it.qty_on_hand, 0)::numeric, it.unit_price, it.purchase_cost,
    COALESCE(s.is_managed, false), COALESCE(s.is_planner, false),
    COALESCE(s.target_days_supply, 30), COALESCE(s.lead_time_days, 7),
    s.reorder_point, s.min_order_qty, s.notes,
    COALESCE(sold.qty, 0), COALESCE(sold.revenue, 0), COALESCE(sold.customers_count, 0),
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
    ipt.type_code, pt.label,
    COALESCE(seg_item.segment_code, seg_cat.segment_code),
    COALESCE(s_item_seg.label, s_cat_seg.label),
    CASE
      WHEN seg_item.segment_code IS NOT NULL THEN 'item'
      WHEN seg_cat.segment_code  IS NOT NULL THEN 'category'
      ELSE NULL
    END
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.account_settings acct ON acct.account_name = it.income_account_name
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj  ON adj.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  LEFT JOIN ops.item_segments     seg_item ON seg_item.item_name = it.name
  LEFT JOIN ops.segments        s_item_seg ON s_item_seg.segment_code = seg_item.segment_code AND s_item_seg.is_active
  LEFT JOIN ops.category_segments  seg_cat ON seg_cat.category = COALESCE(s.category_override, it.category_path)
  LEFT JOIN ops.segments         s_cat_seg ON s_cat_seg.segment_code = seg_cat.segment_code AND s_cat_seg.is_active
  WHERE
    (NOT p_managed_only OR COALESCE(s.is_managed, false))
    AND COALESCE(acct.is_active, true)
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
