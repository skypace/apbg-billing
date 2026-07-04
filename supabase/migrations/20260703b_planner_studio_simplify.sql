-- Planner Studio: keep all plan assumptions when duplicating, and compare to
-- QBO actuals by stable item ids instead of display names.

CREATE OR REPLACE FUNCTION ops.fn_duplicate_sales_plan(p_source_plan_id uuid, p_new_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, public
AS $$
DECLARE
  src ops.sales_plans%ROWTYPE;
  new_id uuid;
BEGIN
  SELECT * INTO src
  FROM ops.sales_plans
  WHERE id = p_source_plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source sales plan not found: %', p_source_plan_id;
  END IF;

  INSERT INTO ops.sales_plans (name, fiscal_year, status, source_budget_id, created_by)
  VALUES (COALESCE(NULLIF(p_new_name, ''), src.name || ' Copy'), src.fiscal_year, 'draft', src.source_budget_id, auth.uid())
  RETURNING id INTO new_id;

  INSERT INTO ops.sales_plan_lines (
    plan_id,
    line_type,
    qbo_item_id,
    item_name,
    qbo_customer_id,
    customer_name,
    qbo_account_id,
    account_name,
    notes,
    amounts,
    qty,
    unit_price,
    unit_cost,
    sort_order
  )
  SELECT
    new_id,
    line_type,
    qbo_item_id,
    item_name,
    qbo_customer_id,
    customer_name,
    qbo_account_id,
    account_name,
    notes,
    amounts,
    qty,
    unit_price,
    unit_cost,
    sort_order
  FROM ops.sales_plan_lines
  WHERE plan_id = p_source_plan_id;

  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_duplicate_sales_plan(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_plan_actuals_by_item(p_plan_id uuid)
RETURNS TABLE (
  qbo_item_id text,
  item_name text,
  m1 numeric,
  m2 numeric,
  m3 numeric,
  m4 numeric,
  m5 numeric,
  m6 numeric,
  m7 numeric,
  m8 numeric,
  m9 numeric,
  m10 numeric,
  m11 numeric,
  m12 numeric,
  total numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH plan_meta AS (
    SELECT fiscal_year
    FROM ops.sales_plans
    WHERE id = p_plan_id
  ),
  planned_items AS (
    SELECT DISTINCT
      l.qbo_item_id,
      COALESCE(l.item_name, i.name, i.fully_qualified_name, l.qbo_item_id) AS item_name
    FROM ops.sales_plan_lines l
    LEFT JOIN ops.qbo_items i ON i.qbo_item_id = l.qbo_item_id
    WHERE l.plan_id = p_plan_id
      AND l.qbo_item_id IS NOT NULL
  ),
  actuals AS (
    SELECT
      v.item_ref_id AS qbo_item_id,
      EXTRACT(MONTH FROM v.txn_date)::int AS month_num,
      SUM(v.revenue)::numeric AS amount
    FROM ops.mv_sales_lines v
    CROSS JOIN plan_meta pm
    WHERE v.txn_date >= make_date(pm.fiscal_year, 1, 1)
      AND v.txn_date < make_date(pm.fiscal_year + 1, 1, 1)
      AND v.item_ref_id IS NOT NULL
    GROUP BY v.item_ref_id, EXTRACT(MONTH FROM v.txn_date)::int
  )
  SELECT
    pi.qbo_item_id,
    pi.item_name,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 1), 0)::numeric AS m1,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 2), 0)::numeric AS m2,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 3), 0)::numeric AS m3,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 4), 0)::numeric AS m4,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 5), 0)::numeric AS m5,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 6), 0)::numeric AS m6,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 7), 0)::numeric AS m7,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 8), 0)::numeric AS m8,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 9), 0)::numeric AS m9,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 10), 0)::numeric AS m10,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 11), 0)::numeric AS m11,
    COALESCE(SUM(a.amount) FILTER (WHERE a.month_num = 12), 0)::numeric AS m12,
    COALESCE(SUM(a.amount), 0)::numeric AS total
  FROM planned_items pi
  LEFT JOIN actuals a ON a.qbo_item_id = pi.qbo_item_id
  GROUP BY pi.qbo_item_id, pi.item_name
  ORDER BY pi.item_name;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_plan_actuals_by_item(uuid) TO authenticated;

DROP FUNCTION IF EXISTS ops.fn_plan_build_from_growth(uuid, text[], text[], numeric, numeric, integer);

CREATE OR REPLACE FUNCTION ops.fn_plan_build_from_growth(
  p_plan_id          uuid,
  p_item_ids         text[]  DEFAULT NULL,
  p_customer_ids     text[]  DEFAULT NULL,
  p_qty_growth_pct   numeric DEFAULT 0,
  p_price_growth_pct numeric DEFAULT 0,
  p_source_year      integer DEFAULT NULL
)
RETURNS TABLE (
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
SET search_path = ops, public
AS $$
DECLARE
  v_plan_fy integer;
  v_source_year integer;
  v_qty_multiplier numeric;
  v_price_multiplier numeric;
  rec record;
  v_qty numeric[];
  v_price numeric[];
  v_cost numeric[];
  v_amounts numeric[];
  v_sort integer := 0;
  v_rows integer;
BEGIN
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_id required';
  END IF;

  SELECT fiscal_year INTO v_plan_fy
  FROM ops.sales_plans
  WHERE id = p_plan_id;

  IF v_plan_fy IS NULL THEN
    RAISE EXCEPTION 'plan not found: %', p_plan_id;
  END IF;

  v_source_year := COALESCE(p_source_year, v_plan_fy - 1);
  v_qty_multiplier := 1 + (COALESCE(p_qty_growth_pct, 0) / 100.0);
  v_price_multiplier := 1 + (COALESCE(p_price_growth_pct, 0) / 100.0);

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
        EXTRACT(MONTH FROM v.txn_date)::int AS month_num,
        SUM(v.quantity)::numeric AS qty,
        SUM(v.revenue)::numeric AS revenue,
        CASE
          WHEN SUM(v.quantity) > 0 THEN (SUM(v.revenue) / SUM(v.quantity))::numeric
          ELSE NULL
        END AS avg_price,
        CASE
          WHEN SUM(v.quantity) > 0 THEN (SUM(v.est_cost) / SUM(v.quantity))::numeric
          ELSE NULL
        END AS avg_cost
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
        COALESCE(it.name, it.fully_qualified_name, it.qbo_item_id) AS item_name,
        it.income_account_ref_id,
        it.income_account_name
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
      WHERE p_customer_ids IS NULL
         OR array_length(p_customer_ids, 1) = 0
         OR qc.qbo_customer_id = ANY(p_customer_ids)
    ),
    combos AS (
      SELECT
        s.qbo_item_id,
        COALESCE(ei.item_name, s.item_name) AS item_name,
        ei.income_account_ref_id,
        ei.income_account_name,
        s.qbo_customer_id,
        s.customer_name
      FROM src s
      JOIN eligible_items ei ON ei.qbo_item_id = s.qbo_item_id
      JOIN eligible_customers ec ON ec.qbo_customer_id = s.qbo_customer_id
      GROUP BY 1, 2, 3, 4, 5, 6
    )
    SELECT
      c.qbo_item_id,
      c.item_name,
      c.income_account_ref_id,
      c.income_account_name,
      c.qbo_customer_id,
      c.customer_name,
      ARRAY_AGG(COALESCE(s.qty, 0) ORDER BY m.month_num) AS qty,
      ARRAY_AGG(COALESCE(s.revenue, 0) ORDER BY m.month_num) AS revenue,
      ARRAY_AGG(COALESCE(s.avg_price, 0) ORDER BY m.month_num) AS price,
      ARRAY_AGG(COALESCE(s.avg_cost, 0) ORDER BY m.month_num) AS cost
    FROM combos c
    CROSS JOIN LATERAL generate_series(1, 12) AS m(month_num)
    LEFT JOIN src s
      ON s.qbo_item_id = c.qbo_item_id
     AND s.qbo_customer_id = c.qbo_customer_id
     AND s.month_num = m.month_num
    GROUP BY c.qbo_item_id, c.item_name, c.income_account_ref_id, c.income_account_name, c.qbo_customer_id, c.customer_name
  LOOP
    v_qty := ARRAY(
      SELECT ROUND(COALESCE(x, 0) * v_qty_multiplier, 2)
      FROM UNNEST(rec.qty) AS x
    );
    v_price := ARRAY(
      SELECT ROUND(COALESCE(x, 0) * v_price_multiplier, 4)
      FROM UNNEST(rec.price) AS x
    );
    v_cost := rec.cost;
    v_amounts := ARRAY(
      SELECT ROUND(COALESCE(q, 0) * COALESCE(p, 0), 2)
      FROM UNNEST(v_qty, v_price) AS t(q, p)
    );

    UPDATE ops.sales_plan_lines
       SET item_name = rec.item_name,
           qbo_account_id = rec.income_account_ref_id,
           account_name = rec.income_account_name,
           customer_name = rec.customer_name,
           qty = v_qty,
           unit_price = v_price,
           unit_cost = v_cost,
           amounts = v_amounts,
           updated_at = now()
     WHERE plan_id = p_plan_id
       AND qbo_item_id = rec.qbo_item_id
       AND qbo_customer_id = rec.qbo_customer_id
       AND line_type = 'item';
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows = 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO ops.sales_plan_lines (
        plan_id,
        line_type,
        qbo_item_id,
        item_name,
        qbo_customer_id,
        customer_name,
        qbo_account_id,
        account_name,
        qty,
        unit_price,
        unit_cost,
        amounts,
        sort_order
      )
      VALUES (
        p_plan_id,
        'item',
        rec.qbo_item_id,
        rec.item_name,
        rec.qbo_customer_id,
        rec.customer_name,
        rec.income_account_ref_id,
        rec.income_account_name,
        v_qty,
        v_price,
        v_cost,
        v_amounts,
        v_sort
      );
    END IF;

    qbo_item_id := rec.qbo_item_id;
    item_name := rec.item_name;
    qbo_customer_id := rec.qbo_customer_id;
    customer_name := rec.customer_name;
    ly_annual_qty := (SELECT SUM(x) FROM UNNEST(rec.qty) AS x);
    ly_annual_revenue := (SELECT SUM(x) FROM UNNEST(rec.revenue) AS x);
    planned_annual_qty := (SELECT SUM(x) FROM UNNEST(v_qty) AS x);
    planned_annual_revenue := (SELECT SUM(x) FROM UNNEST(v_amounts) AS x);
    created := v_rows = 0;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_plan_build_from_growth(uuid, text[], text[], numeric, numeric, integer) TO authenticated;

DROP FUNCTION IF EXISTS ops.fn_plan_forecast(uuid);

CREATE OR REPLACE FUNCTION ops.fn_plan_forecast(p_plan_id uuid)
RETURNS TABLE (
  line_id uuid,
  qbo_item_id text,
  item_name text,
  account_name text,
  full_year_plan numeric,
  ytd_plan numeric,
  actual_ytd numeric,
  months_complete int,
  projected_full_year numeric,
  projected_vs_plan_pct numeric,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH plan_meta AS (
    SELECT
      fiscal_year,
      CASE
        WHEN EXTRACT(YEAR FROM CURRENT_DATE)::int < fiscal_year THEN 0
        WHEN EXTRACT(YEAR FROM CURRENT_DATE)::int > fiscal_year THEN 12
        ELSE LEAST(12, GREATEST(0, EXTRACT(MONTH FROM CURRENT_DATE)::int - 1))
      END AS elapsed_months
    FROM ops.sales_plans
    WHERE id = p_plan_id
  ),
  plan_lines AS (
    SELECT
      MIN(l.id) AS line_id,
      l.qbo_item_id,
      COALESCE(MAX(l.item_name), MAX(i.name), MAX(i.fully_qualified_name), l.qbo_item_id, MIN(l.id)::text) AS item_name,
      COALESCE(MAX(l.account_name), MAX(i.income_account_name), 'Sales') AS account_name,
      SUM(COALESCE(l.amounts[1], 0))::numeric AS m1,
      SUM(COALESCE(l.amounts[2], 0))::numeric AS m2,
      SUM(COALESCE(l.amounts[3], 0))::numeric AS m3,
      SUM(COALESCE(l.amounts[4], 0))::numeric AS m4,
      SUM(COALESCE(l.amounts[5], 0))::numeric AS m5,
      SUM(COALESCE(l.amounts[6], 0))::numeric AS m6,
      SUM(COALESCE(l.amounts[7], 0))::numeric AS m7,
      SUM(COALESCE(l.amounts[8], 0))::numeric AS m8,
      SUM(COALESCE(l.amounts[9], 0))::numeric AS m9,
      SUM(COALESCE(l.amounts[10], 0))::numeric AS m10,
      SUM(COALESCE(l.amounts[11], 0))::numeric AS m11,
      SUM(COALESCE(l.amounts[12], 0))::numeric AS m12
    FROM ops.sales_plan_lines l
    LEFT JOIN ops.qbo_items i ON i.qbo_item_id = l.qbo_item_id
    WHERE l.plan_id = p_plan_id
    GROUP BY COALESCE(l.qbo_item_id, l.id::text), l.qbo_item_id
  ),
  plan_totals AS (
    SELECT
      pl.line_id,
      pl.qbo_item_id,
      pl.item_name,
      pl.account_name,
      (pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12)::numeric AS plan_full_year,
      CASE pm.elapsed_months
        WHEN 0 THEN 0
        WHEN 1 THEN pl.m1
        WHEN 2 THEN pl.m1 + pl.m2
        WHEN 3 THEN pl.m1 + pl.m2 + pl.m3
        WHEN 4 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4
        WHEN 5 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5
        WHEN 6 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6
        WHEN 7 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7
        WHEN 8 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8
        WHEN 9 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9
        WHEN 10 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10
        WHEN 11 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11
        ELSE pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
      END::numeric AS plan_ytd,
      CASE pm.elapsed_months
        WHEN 0 THEN pl.m1 + pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 1 THEN pl.m2 + pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 2 THEN pl.m3 + pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 3 THEN pl.m4 + pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 4 THEN pl.m5 + pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 5 THEN pl.m6 + pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 6 THEN pl.m7 + pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 7 THEN pl.m8 + pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 8 THEN pl.m9 + pl.m10 + pl.m11 + pl.m12
        WHEN 9 THEN pl.m10 + pl.m11 + pl.m12
        WHEN 10 THEN pl.m11 + pl.m12
        WHEN 11 THEN pl.m12
        ELSE 0
      END::numeric AS remaining_plan
    FROM plan_lines pl
    CROSS JOIN plan_meta pm
  ),
  ytd_actual AS (
    SELECT
      v.item_ref_id AS qbo_item_id,
      SUM(v.revenue)::numeric AS actual_ytd
    FROM ops.mv_sales_lines v
    JOIN plan_meta pm ON TRUE
    WHERE v.txn_date >= make_date(pm.fiscal_year, 1, 1)
      AND v.txn_date < (
        make_date(pm.fiscal_year, 1, 1) + ((pm.elapsed_months || ' months')::interval)
      )
      AND v.item_ref_id IS NOT NULL
    GROUP BY v.item_ref_id
  )
  SELECT
    pt.line_id,
    pt.qbo_item_id,
    pt.item_name,
    pt.account_name,
    pt.plan_full_year,
    pt.plan_ytd,
    COALESCE(ya.actual_ytd, 0)::numeric AS actual_ytd,
    (SELECT elapsed_months FROM plan_meta)::int AS months_complete,
    (COALESCE(ya.actual_ytd, 0) + pt.remaining_plan)::numeric AS projected_full_year,
    CASE
      WHEN pt.plan_full_year > 0
        THEN (((COALESCE(ya.actual_ytd, 0) + pt.remaining_plan) - pt.plan_full_year) / pt.plan_full_year)::numeric
      ELSE NULL
    END AS projected_vs_plan_pct,
    CASE
      WHEN pt.plan_full_year <= 0 OR (SELECT elapsed_months FROM plan_meta) <= 0 THEN 'no_data'
      WHEN (((COALESCE(ya.actual_ytd, 0) + pt.remaining_plan) - pt.plan_full_year) / pt.plan_full_year) >= 0.05 THEN 'ahead'
      WHEN (((COALESCE(ya.actual_ytd, 0) + pt.remaining_plan) - pt.plan_full_year) / pt.plan_full_year) <= -0.20 THEN 'critical'
      WHEN (((COALESCE(ya.actual_ytd, 0) + pt.remaining_plan) - pt.plan_full_year) / pt.plan_full_year) <= -0.05 THEN 'behind'
      ELSE 'on_track'
    END AS status
  FROM plan_totals pt
  LEFT JOIN ytd_actual ya ON ya.qbo_item_id = pt.qbo_item_id
  WHERE COALESCE(pt.plan_full_year, 0) > 0
  ORDER BY ABS((COALESCE(ya.actual_ytd, 0) + pt.remaining_plan) - pt.plan_full_year) DESC, pt.item_name;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_plan_forecast(uuid) TO authenticated;
