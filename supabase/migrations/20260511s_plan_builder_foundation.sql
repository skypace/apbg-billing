-- v0.9.31 — Plan Builder foundation.
--
-- 1) Per-item planner flag (separate from is_managed).
-- 2) Item × Customer × Month grain on plan lines (qty[12], unit_price[12], unit_cost[12]).
-- 3) fn_set_inventory_settings extended with p_is_planner.
-- 4) fn_items_master returns is_planner.
-- 5) fn_autofill_plan_from_history — pulls history per item×customer, applies adjustment, upserts.

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS is_planner boolean NOT NULL DEFAULT false;

ALTER TABLE ops.sales_plan_lines
  ADD COLUMN IF NOT EXISTS qbo_customer_id text,
  ADD COLUMN IF NOT EXISTS customer_name   text,
  ADD COLUMN IF NOT EXISTS qty             numeric[],
  ADD COLUMN IF NOT EXISTS unit_price      numeric[],
  ADD COLUMN IF NOT EXISTS unit_cost       numeric[];

CREATE INDEX IF NOT EXISTS idx_spl_plan_item
  ON ops.sales_plan_lines (plan_id, qbo_item_id);
CREATE INDEX IF NOT EXISTS idx_spl_plan_item_customer
  ON ops.sales_plan_lines (plan_id, qbo_item_id, qbo_customer_id);

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
AS $$
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
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_settings(TEXT, BOOLEAN, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) TO authenticated;

DROP FUNCTION IF EXISTS ops.fn_items_master(integer, text, boolean);

CREATE OR REPLACE FUNCTION ops.fn_items_master(
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
  daily_velocity numeric, days_of_supply numeric, status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
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
    END
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj ON adj.qbo_item_id = it.qbo_item_id
  WHERE
    (NOT p_managed_only OR COALESCE(s.is_managed, false))
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


-- Auto-fill plan lines from a source year's actuals.
CREATE OR REPLACE FUNCTION ops.fn_autofill_plan_from_history(
  p_plan_id        uuid,
  p_item_ids       text[]  DEFAULT NULL,
  p_customer_ids   text[]  DEFAULT NULL,
  p_adjustment_pct numeric DEFAULT 0,
  p_source_year    integer DEFAULT NULL
)
RETURNS TABLE(
  qbo_item_id     text,
  item_name       text,
  qbo_customer_id text,
  customer_name   text,
  annual_qty      numeric,
  annual_revenue  numeric,
  created         boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
DECLARE
  v_source_year integer;
  v_plan_fy     integer;
  v_multiplier  numeric;
  rec RECORD;
  v_qty       numeric[];
  v_price     numeric[];
  v_cost      numeric[];
  v_amounts   numeric[];
  v_sort      integer := 0;
  v_existed   boolean;
BEGIN
  IF p_plan_id IS NULL THEN RAISE EXCEPTION 'plan_id required'; END IF;

  SELECT fiscal_year INTO v_plan_fy FROM ops.sales_plans WHERE id = p_plan_id;
  IF v_plan_fy IS NULL THEN RAISE EXCEPTION 'plan not found'; END IF;

  v_source_year := COALESCE(p_source_year, v_plan_fy - 1);
  v_multiplier  := 1 + (COALESCE(p_adjustment_pct, 0) / 100.0);

  FOR rec IN
    WITH src AS (
      SELECT
        v.item_ref_id        AS qbo_item_id,
        v.item_name,
        v.customer_ref_id    AS qbo_customer_id,
        v.customer_name,
        EXTRACT(MONTH FROM v.txn_date)::int AS m,
        sum(v.quantity)::numeric                                   AS qty,
        CASE WHEN sum(v.quantity) > 0
             THEN (sum(v.revenue) / sum(v.quantity))::numeric
             ELSE NULL END                                          AS avg_price,
        CASE WHEN sum(v.quantity) > 0
             THEN (sum(v.est_cost) / sum(v.quantity))::numeric
             ELSE NULL END                                          AS avg_cost
      FROM ops.v_sales_lines v
      WHERE EXTRACT(YEAR FROM v.txn_date)::int = v_source_year
        AND v.item_ref_id IS NOT NULL
        AND v.customer_ref_id IS NOT NULL
        AND v.quantity IS NOT NULL AND v.quantity > 0
      GROUP BY 1, 2, 3, 4, 5
    ),
    eligible_items AS (
      SELECT it.qbo_item_id, COALESCE(it.name, it.fully_qualified_name) AS item_name
      FROM ops.qbo_items it
      LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
      WHERE
        CASE
          WHEN p_item_ids IS NOT NULL AND array_length(p_item_ids, 1) > 0
            THEN it.qbo_item_id = ANY(p_item_ids)
          ELSE COALESCE(s.is_planner, false) = true
        END
    ),
    eligible_customers AS (
      SELECT qc.qbo_customer_id
      FROM ops.qbo_customers qc
      WHERE
        p_customer_ids IS NULL
        OR array_length(p_customer_ids, 1) = 0
        OR qc.qbo_customer_id = ANY(p_customer_ids)
    ),
    combos AS (
      SELECT s.qbo_item_id, s.item_name, s.qbo_customer_id, s.customer_name
      FROM src s
      JOIN eligible_items ei     ON ei.qbo_item_id     = s.qbo_item_id
      JOIN eligible_customers ec ON ec.qbo_customer_id = s.qbo_customer_id
      GROUP BY 1, 2, 3, 4
    )
    SELECT c.qbo_item_id, c.item_name, c.qbo_customer_id, c.customer_name,
           array_agg(COALESCE(s.qty, 0)        ORDER BY m_idx.m) AS qty,
           array_agg(COALESCE(s.avg_price, 0)  ORDER BY m_idx.m) AS price,
           array_agg(COALESCE(s.avg_cost, 0)   ORDER BY m_idx.m) AS cost
    FROM combos c
    CROSS JOIN LATERAL generate_series(1, 12) AS m_idx(m)
    LEFT JOIN src s
           ON s.qbo_item_id = c.qbo_item_id
          AND s.qbo_customer_id = c.qbo_customer_id
          AND s.m = m_idx.m
    GROUP BY c.qbo_item_id, c.item_name, c.qbo_customer_id, c.customer_name
  LOOP
    v_qty := ARRAY(
      SELECT round(x * v_multiplier, 2)
      FROM unnest(rec.qty) AS x
    );
    v_price   := rec.price;
    v_cost    := rec.cost;
    v_amounts := ARRAY(
      SELECT round(coalesce(q, 0) * coalesce(p, 0), 2)
      FROM unnest(v_qty, v_price) WITH ORDINALITY AS t(q, p, idx)
    );

    UPDATE ops.sales_plan_lines
       SET qty = v_qty, unit_price = v_price, unit_cost = v_cost, amounts = v_amounts,
           item_name = rec.item_name, customer_name = rec.customer_name,
           updated_at = now()
     WHERE plan_id = p_plan_id
       AND qbo_item_id     = rec.qbo_item_id
       AND qbo_customer_id = rec.qbo_customer_id
       AND line_type = 'item';
    GET DIAGNOSTICS v_existed = ROW_COUNT;

    IF v_existed = 0 OR v_existed IS NULL THEN
      v_sort := v_sort + 1;
      INSERT INTO ops.sales_plan_lines (
        plan_id, line_type, qbo_item_id, item_name,
        qbo_customer_id, customer_name,
        qty, unit_price, unit_cost, amounts, sort_order
      ) VALUES (
        p_plan_id, 'item', rec.qbo_item_id, rec.item_name,
        rec.qbo_customer_id, rec.customer_name,
        v_qty, v_price, v_cost, v_amounts, v_sort
      );
    END IF;

    qbo_item_id     := rec.qbo_item_id;
    item_name       := rec.item_name;
    qbo_customer_id := rec.qbo_customer_id;
    customer_name   := rec.customer_name;
    annual_qty      := (SELECT sum(x) FROM unnest(v_qty)     AS x);
    annual_revenue  := (SELECT sum(x) FROM unnest(v_amounts) AS x);
    created         := (v_existed = 0 OR v_existed IS NULL);
    RETURN NEXT;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_autofill_plan_from_history(uuid, text[], text[], numeric, integer) TO authenticated;
