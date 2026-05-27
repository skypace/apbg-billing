-- Period-comparison pivot for the margin dashboard. Returns one row per
-- dim_label with both current-period and prior-period rollups + delta.
-- Pass NULL for p_prev_start/p_prev_end to skip the comparison join.

CREATE OR REPLACE FUNCTION ops.fn_sales_pivot_compare(
  p_dim         text DEFAULT 'item',
  p_start       date DEFAULT '2025-01-01',
  p_end         date DEFAULT current_date,
  p_prev_start  date DEFAULT NULL,
  p_prev_end    date DEFAULT NULL,
  p_entity      text DEFAULT NULL,
  p_category    text DEFAULT NULL,
  p_customer    text DEFAULT NULL,
  p_item        text DEFAULT NULL,
  p_limit       int  DEFAULT 250
) RETURNS TABLE (
  dim_label     text,
  line_count    bigint,
  qty           numeric,
  revenue       numeric,
  est_cost      numeric,
  est_margin    numeric,
  margin_pct    numeric,
  avg_price     numeric,
  prev_qty      numeric,
  prev_revenue  numeric,
  delta_revenue numeric,
  delta_pct     numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH cur AS (
    SELECT
      COALESCE(
        CASE p_dim
          WHEN 'item'     THEN item_name
          WHEN 'customer' THEN customer_name
          WHEN 'category' THEN category
          WHEN 'entity'   THEN entity
          WHEN 'month'    THEN to_char(txn_month, 'YYYY-MM')
          ELSE item_name
        END, '(unspecified)'
      ) AS dim_label,
      count(*)::bigint AS line_count,
      sum(quantity)::numeric AS qty,
      sum(revenue)::numeric AS revenue,
      sum(est_cost)::numeric AS est_cost,
      sum(est_margin)::numeric AS est_margin
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entity   IS NULL OR entity = p_entity)
      AND (p_category IS NULL OR category = p_category)
      AND (p_customer IS NULL OR customer_name = p_customer)
      AND (p_item     IS NULL OR item_name = p_item)
    GROUP BY 1
  ),
  prev AS (
    SELECT
      COALESCE(
        CASE p_dim
          WHEN 'item'     THEN item_name
          WHEN 'customer' THEN customer_name
          WHEN 'category' THEN category
          WHEN 'entity'   THEN entity
          WHEN 'month'    THEN to_char(txn_month, 'YYYY-MM')
          ELSE item_name
        END, '(unspecified)'
      ) AS dim_label,
      sum(quantity)::numeric AS qty,
      sum(revenue)::numeric AS revenue
    FROM ops.v_sales_lines
    WHERE p_prev_start IS NOT NULL AND p_prev_end IS NOT NULL
      AND txn_date >= p_prev_start AND txn_date <= p_prev_end
      AND (p_entity   IS NULL OR entity = p_entity)
      AND (p_category IS NULL OR category = p_category)
      AND (p_customer IS NULL OR customer_name = p_customer)
      AND (p_item     IS NULL OR item_name = p_item)
    GROUP BY 1
  )
  SELECT
    COALESCE(c.dim_label, p.dim_label) AS dim_label,
    COALESCE(c.line_count, 0) AS line_count,
    c.qty,
    c.revenue,
    c.est_cost,
    c.est_margin,
    CASE WHEN c.revenue > 0 AND c.est_cost IS NOT NULL
         THEN (c.revenue - c.est_cost) / c.revenue ELSE NULL END AS margin_pct,
    CASE WHEN c.qty > 0 THEN c.revenue / c.qty ELSE NULL END AS avg_price,
    p.qty AS prev_qty,
    p.revenue AS prev_revenue,
    COALESCE(c.revenue, 0) - COALESCE(p.revenue, 0) AS delta_revenue,
    CASE WHEN p.revenue IS NOT NULL AND p.revenue <> 0
         THEN (COALESCE(c.revenue, 0) - p.revenue) / p.revenue
         ELSE NULL END AS delta_pct
  FROM cur c
  FULL OUTER JOIN prev p ON p.dim_label = c.dim_label
  ORDER BY COALESCE(c.revenue, 0) DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 250), 1);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot_compare(text, date, date, date, date, text, text, text, text, int)
  TO anon, authenticated;
