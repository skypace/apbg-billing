-- Trailing-12-month sparkline data per dim_label. Used to render a tiny
-- bar chart next to each pivot row.
-- Applied to live DB on 2026-05-03.

CREATE OR REPLACE FUNCTION ops.fn_sparkline(
  p_dim         text,
  p_labels      text[],
  p_end         date   DEFAULT current_date,
  p_entities    text[] DEFAULT NULL,
  p_categories  text[] DEFAULT NULL,
  p_customers   text[] DEFAULT NULL,
  p_items       text[] DEFAULT NULL,
  p_channels    text[] DEFAULT NULL,
  p_segments    text[] DEFAULT NULL
) RETURNS TABLE (
  dim_label text,
  ym        text,
  revenue   numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH range_start AS (
    SELECT (date_trunc('month', p_end) - interval '11 month')::date AS s
  ),
  base AS (
    SELECT v.*, ch.code AS dim_channel
    FROM ops.v_sales_lines v, range_start rs
    LEFT JOIN LATERAL (
      SELECT u AS code FROM unnest(v.channels) AS u
      WHERE p_dim = 'channel' AND cardinality(v.channels) > 0
      UNION ALL SELECT '(unassigned)'::text
      WHERE p_dim = 'channel' AND cardinality(v.channels) = 0
    ) ch ON TRUE
    WHERE v.txn_date >= rs.s AND v.txn_date <= p_end
      AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR v.entity        = ANY(p_entities))
      AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR v.category      = ANY(p_categories))
      AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR v.customer_name = ANY(p_customers))
      AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR v.item_name     = ANY(p_items))
      AND (p_channels   IS NULL OR cardinality(p_channels)   = 0 OR v.channels && p_channels)
      AND (p_segments   IS NULL OR cardinality(p_segments)   = 0 OR v.segment       = ANY(p_segments))
  )
  SELECT
    COALESCE(CASE p_dim
      WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category WHEN 'segment' THEN segment
      WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
      WHEN 'channel' THEN dim_channel ELSE item_name END, '(unspecified)') AS dim_label,
    to_char(txn_month, 'YYYY-MM') AS ym,
    sum(revenue)::numeric AS revenue
  FROM base
  WHERE COALESCE(CASE p_dim
      WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category WHEN 'segment' THEN segment
      WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
      WHEN 'channel' THEN dim_channel ELSE item_name END, '(unspecified)') = ANY(p_labels)
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_sparkline(text, text[], date, text[], text[], text[], text[], text[], text[]) TO anon, authenticated;
