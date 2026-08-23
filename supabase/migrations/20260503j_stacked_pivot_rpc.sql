-- 2-D pivot for stacked-bar view: returns one row per (primary_dim, stack_dim)
-- combo with revenue. Top-N by primary_dim total. Handles channel/sales_rep
-- M2M fan-out on either axis.
-- Applied to live DB on 2026-05-03.

CREATE OR REPLACE FUNCTION ops.fn_sales_stacked(
  p_dim         text   DEFAULT 'customer',
  p_stack       text   DEFAULT 'segment',
  p_start       date   DEFAULT '2025-01-01',
  p_end         date   DEFAULT current_date,
  p_entities    text[] DEFAULT NULL,
  p_categories  text[] DEFAULT NULL,
  p_customers   text[] DEFAULT NULL,
  p_items       text[] DEFAULT NULL,
  p_channels    text[] DEFAULT NULL,
  p_segments    text[] DEFAULT NULL,
  p_sales_reps  text[] DEFAULT NULL,
  p_limit       int    DEFAULT 30
) RETURNS TABLE (
  dim_label text, stack_label text, revenue numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT * FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities    IS NULL OR cardinality(p_entities)    = 0 OR entity        = ANY(p_entities))
      AND (p_categories  IS NULL OR cardinality(p_categories)  = 0 OR category      = ANY(p_categories))
      AND (p_customers   IS NULL OR cardinality(p_customers)   = 0 OR customer_name = ANY(p_customers))
      AND (p_items       IS NULL OR cardinality(p_items)       = 0 OR item_name     = ANY(p_items))
      AND (p_channels    IS NULL OR cardinality(p_channels)    = 0 OR channels && p_channels)
      AND (p_segments    IS NULL OR cardinality(p_segments)    = 0 OR segment       = ANY(p_segments))
      AND (p_sales_reps  IS NULL OR cardinality(p_sales_reps)  = 0 OR sales_reps && p_sales_reps)
  ),
  expanded AS (
    SELECT b.*, ch.code AS dim_channel, sr.code AS dim_sales_rep
    FROM base b
    LEFT JOIN LATERAL (
      SELECT u AS code FROM unnest(b.channels) AS u
      WHERE (p_dim = 'channel' OR p_stack = 'channel') AND cardinality(b.channels) > 0
      UNION ALL SELECT '(unassigned)'::text
      WHERE (p_dim = 'channel' OR p_stack = 'channel') AND cardinality(b.channels) = 0
    ) ch ON TRUE
    LEFT JOIN LATERAL (
      SELECT u AS code FROM unnest(b.sales_reps) AS u
      WHERE (p_dim = 'sales_rep' OR p_stack = 'sales_rep') AND cardinality(b.sales_reps) > 0
      UNION ALL SELECT '(unassigned)'::text
      WHERE (p_dim = 'sales_rep' OR p_stack = 'sales_rep') AND cardinality(b.sales_reps) = 0
    ) sr ON TRUE
  ),
  agg AS (
    SELECT
      COALESCE(CASE p_dim
        WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category WHEN 'segment' THEN segment
        WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
        WHEN 'channel' THEN dim_channel WHEN 'sales_rep' THEN dim_sales_rep
        ELSE customer_name END, '(unspecified)') AS dim_label,
      COALESCE(CASE p_stack
        WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category WHEN 'segment' THEN segment
        WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
        WHEN 'channel' THEN dim_channel WHEN 'sales_rep' THEN dim_sales_rep
        ELSE segment END, '(unspecified)') AS stack_label,
      sum(revenue)::numeric AS revenue
    FROM expanded GROUP BY 1, 2
  ),
  top_dims AS (
    SELECT dim_label, sum(revenue) AS total_rev
    FROM agg GROUP BY 1
    ORDER BY total_rev DESC NULLS LAST
    LIMIT GREATEST(COALESCE(p_limit, 30), 1)
  )
  SELECT a.dim_label, a.stack_label, a.revenue
  FROM agg a JOIN top_dims t ON t.dim_label = a.dim_label
  ORDER BY t.total_rev DESC NULLS LAST, a.revenue DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_sales_stacked(text, text, date, date, text[], text[], text[], text[], text[], text[], text[], int) TO anon, authenticated;
