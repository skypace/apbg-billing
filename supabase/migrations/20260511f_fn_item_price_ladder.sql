-- fn_item_price_ladder — per-customer price distribution for a single item
-- in a date window. Powers the Row Detail Modal's Price Ladder tab to
-- show which customers are paying below the median price for that item.

CREATE OR REPLACE FUNCTION ops.fn_item_price_ladder(
  p_item  TEXT,
  p_start DATE,
  p_end   DATE
)
RETURNS TABLE (
  customer_name   TEXT,
  invoices        INTEGER,
  qty             NUMERIC,
  revenue         NUMERIC,
  avg_price       NUMERIC,
  median_overall  NUMERIC,
  delta_to_median NUMERIC
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ops, public
AS $$
  WITH lines AS (
    SELECT customer_name,
           COUNT(DISTINCT qbo_invoice_id) AS invoices,
           SUM(quantity)                  AS qty,
           SUM(revenue)                   AS revenue
    FROM ops.v_sales_lines
    WHERE item_name = p_item
      AND txn_date BETWEEN p_start AND p_end
      AND quantity IS NOT NULL AND quantity > 0
    GROUP BY customer_name
  ),
  priced AS (
    SELECT customer_name, invoices, qty, revenue,
           (revenue / qty)::NUMERIC AS avg_price
    FROM lines
    WHERE qty > 0
  ),
  stats AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY avg_price) AS median_p
    FROM priced
  )
  SELECT
    p.customer_name,
    p.invoices::INTEGER,
    ROUND(p.qty::NUMERIC, 2)          AS qty,
    ROUND(p.revenue::NUMERIC, 2)      AS revenue,
    ROUND(p.avg_price::NUMERIC, 4)    AS avg_price,
    ROUND(stats.median_p::NUMERIC, 4) AS median_overall,
    ROUND((p.avg_price - stats.median_p)::NUMERIC, 4) AS delta_to_median
  FROM priced p, stats
  ORDER BY p.revenue DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_item_price_ladder(TEXT, DATE, DATE) TO authenticated;
