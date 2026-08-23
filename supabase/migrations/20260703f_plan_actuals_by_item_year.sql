-- Planner copy-from-actuals helper: source a specific fiscal year by stable
-- QBO item id so the UI does not fall back to display-name matching.

CREATE OR REPLACE FUNCTION ops.fn_plan_actuals_by_item_year(
  p_plan_id uuid,
  p_source_year integer
)
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
    SELECT COALESCE(p_source_year, fiscal_year - 1) AS source_year
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
    WHERE v.txn_date >= make_date(pm.source_year, 1, 1)
      AND v.txn_date < make_date(pm.source_year + 1, 1, 1)
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

GRANT EXECUTE ON FUNCTION ops.fn_plan_actuals_by_item_year(uuid, integer) TO authenticated;
