-- Migration applied to live as 20260518d_sales_pivot_exclude_params.
-- See ops.fn_sales_pivot and ops.fn_sales_totals current definitions for
-- the live state. Reproduced here for source-control traceability.
--
-- Adds p_exclude_customers / p_exclude_categories / p_exclude_items params
-- to both RPCs so the Margin app rollup picker can SUBTRACT a chain's
-- revenue from totals ("show me what the numbers look like without Melt")
-- instead of narrowing to it. Backwards-compatible — new params default
-- to NULL (no exclusion).

CREATE OR REPLACE FUNCTION ops.fn_sales_pivot(
  p_dim text DEFAULT 'item',
  p_start date DEFAULT '2025-01-01',
  p_end date DEFAULT CURRENT_DATE,
  p_entities text[] DEFAULT NULL,
  p_categories text[] DEFAULT NULL,
  p_customers text[] DEFAULT NULL,
  p_items text[] DEFAULT NULL,
  p_channels text[] DEFAULT NULL,
  p_segments text[] DEFAULT NULL,
  p_product_families text[] DEFAULT NULL,
  p_product_types text[] DEFAULT NULL,
  p_limit integer DEFAULT 250,
  p_exclude_customers  text[] DEFAULT NULL,
  p_exclude_categories text[] DEFAULT NULL,
  p_exclude_items      text[] DEFAULT NULL
)
RETURNS TABLE(dim_label text, line_count bigint, qty numeric, revenue numeric,
              est_cost numeric, est_margin numeric, margin_pct numeric,
              avg_price numeric, effective_segment text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH base AS (
    SELECT * FROM ops.mv_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities         IS NULL OR cardinality(p_entities)         = 0 OR entity         = ANY(p_entities))
      AND (p_categories       IS NULL OR cardinality(p_categories)       = 0 OR category       = ANY(p_categories))
      AND (p_customers        IS NULL OR cardinality(p_customers)        = 0 OR customer_name  = ANY(p_customers))
      AND (p_items            IS NULL OR cardinality(p_items)            = 0 OR item_name      = ANY(p_items))
      AND (p_channels         IS NULL OR cardinality(p_channels)         = 0 OR channels && p_channels)
      AND (p_segments         IS NULL OR cardinality(p_segments)         = 0 OR segment        = ANY(p_segments))
      AND (p_product_families IS NULL OR cardinality(p_product_families) = 0 OR product_family = ANY(p_product_families))
      AND (p_product_types    IS NULL OR cardinality(p_product_types)    = 0 OR product_type   = ANY(p_product_types))
      AND (p_exclude_customers  IS NULL OR cardinality(p_exclude_customers)  = 0 OR customer_name <> ALL(p_exclude_customers))
      AND (p_exclude_categories IS NULL OR cardinality(p_exclude_categories) = 0 OR category      <> ALL(p_exclude_categories))
      AND (p_exclude_items      IS NULL OR cardinality(p_exclude_items)      = 0 OR item_name     <> ALL(p_exclude_items))
  ),
  expanded AS (
    SELECT b.*, ch.code AS dim_channel FROM base b
    LEFT JOIN LATERAL (
      SELECT u AS code FROM unnest(b.channels) AS u
      WHERE p_dim = 'channel' AND cardinality(b.channels) > 0
      UNION ALL
      SELECT '(unassigned)'::text WHERE p_dim = 'channel' AND cardinality(b.channels) = 0
    ) ch ON TRUE
  )
  SELECT
    COALESCE(CASE p_dim
      WHEN 'item'           THEN item_name
      WHEN 'customer'       THEN customer_name
      WHEN 'category'       THEN category
      WHEN 'segment'        THEN segment
      WHEN 'entity'         THEN entity
      WHEN 'month'          THEN to_char(txn_month, 'YYYY-MM')
      WHEN 'channel'        THEN dim_channel
      WHEN 'account'        THEN account_name
      WHEN 'product_family' THEN product_family
      WHEN 'product_type'   THEN product_type
      ELSE item_name
    END, '(unspecified)')::text AS dim_label,
    count(*)::bigint AS line_count,
    sum(quantity)::numeric AS qty,
    sum(revenue)::numeric AS revenue,
    sum(est_cost)::numeric AS est_cost,
    sum(est_margin)::numeric AS est_margin,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL THEN (sum(revenue) - sum(est_cost)) / sum(revenue) ELSE NULL END::numeric AS margin_pct,
    CASE WHEN sum(quantity) > 0 THEN sum(revenue) / sum(quantity) ELSE NULL END::numeric AS avg_price,
    (mode() WITHIN GROUP (ORDER BY segment))::text AS effective_segment
  FROM expanded GROUP BY 1
  ORDER BY 4 DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 250), 1);
$$;

CREATE OR REPLACE FUNCTION ops.fn_sales_totals(
  p_start date DEFAULT '2025-01-01',
  p_end date DEFAULT CURRENT_DATE,
  p_entities text[] DEFAULT NULL,
  p_categories text[] DEFAULT NULL,
  p_customers text[] DEFAULT NULL,
  p_items text[] DEFAULT NULL,
  p_channels text[] DEFAULT NULL,
  p_segments text[] DEFAULT NULL,
  p_product_families text[] DEFAULT NULL,
  p_product_types text[] DEFAULT NULL,
  p_exclude_customers  text[] DEFAULT NULL,
  p_exclude_categories text[] DEFAULT NULL,
  p_exclude_items      text[] DEFAULT NULL
)
RETURNS TABLE(line_count bigint, invoice_count bigint, customer_count bigint,
              item_count bigint, qty numeric, revenue numeric, est_cost numeric,
              est_margin numeric, margin_pct numeric, cost_coverage_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH base AS (
    SELECT * FROM ops.mv_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities         IS NULL OR cardinality(p_entities)         = 0 OR entity         = ANY(p_entities))
      AND (p_categories       IS NULL OR cardinality(p_categories)       = 0 OR category       = ANY(p_categories))
      AND (p_customers        IS NULL OR cardinality(p_customers)        = 0 OR customer_name  = ANY(p_customers))
      AND (p_items            IS NULL OR cardinality(p_items)            = 0 OR item_name      = ANY(p_items))
      AND (p_channels         IS NULL OR cardinality(p_channels)         = 0 OR channels && p_channels)
      AND (p_segments         IS NULL OR cardinality(p_segments)         = 0 OR segment        = ANY(p_segments))
      AND (p_product_families IS NULL OR cardinality(p_product_families) = 0 OR product_family = ANY(p_product_families))
      AND (p_product_types    IS NULL OR cardinality(p_product_types)    = 0 OR product_type   = ANY(p_product_types))
      AND (p_exclude_customers  IS NULL OR cardinality(p_exclude_customers)  = 0 OR customer_name <> ALL(p_exclude_customers))
      AND (p_exclude_categories IS NULL OR cardinality(p_exclude_categories) = 0 OR category      <> ALL(p_exclude_categories))
      AND (p_exclude_items      IS NULL OR cardinality(p_exclude_items)      = 0 OR item_name     <> ALL(p_exclude_items))
  )
  SELECT count(*)::bigint, count(DISTINCT invoice_id)::bigint,
    count(DISTINCT customer_name)::bigint, count(DISTINCT item_name)::bigint,
    sum(quantity)::numeric, sum(revenue)::numeric, sum(est_cost)::numeric, sum(est_margin)::numeric,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL THEN (sum(revenue) - sum(est_cost)) / sum(revenue) ELSE NULL END,
    CASE WHEN sum(revenue) > 0 THEN sum(revenue) FILTER (WHERE effective_unit_cost IS NOT NULL) / sum(revenue) ELSE NULL END
  FROM base;
$$;
