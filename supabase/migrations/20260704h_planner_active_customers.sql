-- Planner active-customer boundary.
--
-- The planner UI customer picker already uses active QBO customers only, but
-- the history-based build path could still create lines for customers marked
-- inactive/deleted in QuickBooks if they had source-year sales. Keep reports
-- free to study lost customers, but keep new plan generation clean by default.

ALTER TABLE ops.sales_plan_lines
  ADD COLUMN IF NOT EXISTS qty_growth_pct numeric,
  ADD COLUMN IF NOT EXISTS price_growth_pct numeric,
  ADD COLUMN IF NOT EXISTS baseline_year integer;

CREATE OR REPLACE FUNCTION ops.fn_plan_history_for_items(
  p_item_ids text[],
  p_source_year integer DEFAULT NULL
)
RETURNS TABLE(
  qbo_item_id text,
  item_name text,
  category_path text,
  income_account_name text,
  ly_annual_qty numeric,
  ly_annual_revenue numeric,
  ly_avg_unit_price numeric,
  ly_customer_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH yr AS (
    SELECT COALESCE(p_source_year, EXTRACT(YEAR FROM CURRENT_DATE)::int - 1) AS y
  ),
  item_history AS (
    SELECT
      v.item_ref_id,
      v.customer_ref_id,
      v.quantity,
      v.revenue
    FROM ops.v_sales_lines v
    JOIN ops.qbo_customers qc
      ON qc.qbo_customer_id = v.customer_ref_id
     AND COALESCE(qc.active, true) = true
    WHERE EXTRACT(YEAR FROM v.txn_date)::int = (SELECT y FROM yr)
      AND v.quantity IS NOT NULL
      AND v.quantity > 0
  )
  SELECT
    it.qbo_item_id,
    COALESCE(it.name, it.fully_qualified_name) AS item_name,
    COALESCE(NULLIF(it.category_path, ''), '(no category)') AS category_path,
    it.income_account_name,
    COALESCE(sum(ih.quantity), 0)::numeric AS ly_annual_qty,
    COALESCE(sum(ih.revenue), 0)::numeric AS ly_annual_revenue,
    CASE WHEN COALESCE(sum(ih.quantity), 0) > 0
         THEN (sum(ih.revenue) / sum(ih.quantity))::numeric
         ELSE NULL END AS ly_avg_unit_price,
    COALESCE(count(DISTINCT ih.customer_ref_id), 0)::int AS ly_customer_count
  FROM ops.qbo_items it
  LEFT JOIN item_history ih ON ih.item_ref_id = it.qbo_item_id
  WHERE it.qbo_item_id = ANY(p_item_ids)
  GROUP BY it.qbo_item_id, it.name, it.fully_qualified_name, it.category_path, it.income_account_name
  ORDER BY COALESCE(it.name, it.fully_qualified_name);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_plan_history_for_items(text[], integer) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_plan_build_from_growth(
  p_plan_id uuid,
  p_item_ids text[] DEFAULT NULL,
  p_customer_ids text[] DEFAULT NULL,
  p_qty_growth_pct numeric DEFAULT 0,
  p_price_growth_pct numeric DEFAULT 0,
  p_source_year integer DEFAULT NULL
)
RETURNS TABLE(
  qbo_item_id text,
  item_name text,
  qbo_customer_id text,
  customer_name text,
  ly_annual_qty numeric,
  ly_annual_revenue numeric,
  planned_annual_qty numeric,
  planned_annual_revenue numeric,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
DECLARE
  v_source_year integer;
  v_plan_fy integer;
  v_qty_mult numeric;
  v_price_mult numeric;
  rec record;
  v_qty numeric[];
  v_price numeric[];
  v_cost numeric[];
  v_amounts numeric[];
  v_sort integer := 0;
  v_existed bigint;
BEGIN
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_id required';
  END IF;

  SELECT fiscal_year INTO v_plan_fy
  FROM ops.sales_plans
  WHERE id = p_plan_id;

  IF v_plan_fy IS NULL THEN
    RAISE EXCEPTION 'plan not found';
  END IF;

  v_source_year := COALESCE(p_source_year, v_plan_fy - 1);
  v_qty_mult := 1 + (COALESCE(p_qty_growth_pct, 0) / 100.0);
  v_price_mult := 1 + (COALESCE(p_price_growth_pct, 0) / 100.0);

  SELECT COALESCE(MAX(sort_order), 0)
  INTO v_sort
  FROM ops.sales_plan_lines
  WHERE plan_id = p_plan_id;

  FOR rec IN
    WITH src AS (
      SELECT
        v.item_ref_id AS qbo_item_id,
        v.item_name,
        v.customer_ref_id AS qbo_customer_id,
        v.customer_name,
        EXTRACT(MONTH FROM v.txn_date)::int AS m,
        sum(v.quantity)::numeric AS qty,
        CASE WHEN sum(v.quantity) > 0 THEN (sum(v.revenue) / sum(v.quantity))::numeric ELSE NULL END AS avg_price,
        CASE WHEN sum(v.quantity) > 0 THEN (sum(v.est_cost) / sum(v.quantity))::numeric ELSE NULL END AS avg_cost
      FROM ops.v_sales_lines v
      WHERE EXTRACT(YEAR FROM v.txn_date)::int = v_source_year
        AND v.item_ref_id IS NOT NULL
        AND v.customer_ref_id IS NOT NULL
        AND v.quantity IS NOT NULL
        AND v.quantity > 0
      GROUP BY 1, 2, 3, 4, 5
    ),
    eligible_items AS (
      SELECT
        it.qbo_item_id,
        COALESCE(it.name, it.fully_qualified_name) AS item_name
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
      WHERE COALESCE(qc.active, true) = true
        AND (
          p_customer_ids IS NULL
          OR array_length(p_customer_ids, 1) = 0
          OR qc.qbo_customer_id = ANY(p_customer_ids)
        )
    ),
    combos AS (
      SELECT
        s.qbo_item_id,
        COALESCE(ei.item_name, s.item_name) AS item_name,
        s.qbo_customer_id,
        s.customer_name
      FROM src s
      JOIN eligible_items ei ON ei.qbo_item_id = s.qbo_item_id
      JOIN eligible_customers ec ON ec.qbo_customer_id = s.qbo_customer_id
      GROUP BY 1, 2, 3, 4
    )
    SELECT
      c.qbo_item_id,
      c.item_name,
      c.qbo_customer_id,
      c.customer_name,
      array_agg(COALESCE(s.qty, 0) ORDER BY m_idx.m) AS qty,
      array_agg(COALESCE(s.avg_price, 0) ORDER BY m_idx.m) AS price,
      array_agg(COALESCE(s.avg_cost, 0) ORDER BY m_idx.m) AS cost
    FROM combos c
    CROSS JOIN LATERAL generate_series(1, 12) AS m_idx(m)
    LEFT JOIN src s
      ON s.qbo_item_id = c.qbo_item_id
     AND s.qbo_customer_id = c.qbo_customer_id
     AND s.m = m_idx.m
    GROUP BY c.qbo_item_id, c.item_name, c.qbo_customer_id, c.customer_name
  LOOP
    v_qty := ARRAY(SELECT round(x * v_qty_mult, 4) FROM unnest(rec.qty) AS x);
    v_price := ARRAY(SELECT round(x * v_price_mult, 6) FROM unnest(rec.price) AS x);
    v_cost := rec.cost;
    v_amounts := ARRAY(
      SELECT round(coalesce(q, 0) * coalesce(p, 0), 2)
      FROM unnest(v_qty, v_price) WITH ORDINALITY AS t(q, p, idx)
    );

    UPDATE ops.sales_plan_lines
       SET qty = v_qty,
           unit_price = v_price,
           unit_cost = v_cost,
           amounts = v_amounts,
           item_name = rec.item_name,
           customer_name = rec.customer_name,
           qty_growth_pct = p_qty_growth_pct,
           price_growth_pct = p_price_growth_pct,
           baseline_year = v_source_year,
           updated_at = now()
     WHERE plan_id = p_plan_id
       AND qbo_item_id = rec.qbo_item_id
       AND qbo_customer_id = rec.qbo_customer_id
       AND line_type = 'item';
    GET DIAGNOSTICS v_existed = ROW_COUNT;

    IF v_existed = 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO ops.sales_plan_lines (
        plan_id,
        line_type,
        qbo_item_id,
        item_name,
        qbo_customer_id,
        customer_name,
        qty,
        unit_price,
        unit_cost,
        amounts,
        qty_growth_pct,
        price_growth_pct,
        baseline_year,
        sort_order
      ) VALUES (
        p_plan_id,
        'item',
        rec.qbo_item_id,
        rec.item_name,
        rec.qbo_customer_id,
        rec.customer_name,
        v_qty,
        v_price,
        v_cost,
        v_amounts,
        p_qty_growth_pct,
        p_price_growth_pct,
        v_source_year,
        v_sort
      );
    END IF;

    qbo_item_id := rec.qbo_item_id;
    item_name := rec.item_name;
    qbo_customer_id := rec.qbo_customer_id;
    customer_name := rec.customer_name;
    ly_annual_qty := (SELECT sum(x) FROM unnest(rec.qty) AS x);
    ly_annual_revenue := (
      SELECT sum(coalesce(q, 0) * coalesce(p, 0))
      FROM unnest(rec.qty, rec.price) WITH ORDINALITY AS t(q, p, idx)
    );
    planned_annual_qty := (SELECT sum(x) FROM unnest(v_qty) AS x);
    planned_annual_revenue := (SELECT sum(x) FROM unnest(v_amounts) AS x);
    created := (v_existed = 0);
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_plan_build_from_growth(uuid, text[], text[], numeric, numeric, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
