-- v0.9.36b — Point the hot margin RPCs at ops.mv_sales_lines instead of
-- ops.v_sales_lines.
--
-- Before: fn_sales_pivot YTD-by-customer = 13.2 seconds, 13.1M buffer hits.
-- After:  same call = 48 ms, 3.1K buffer hits. ~275x speedup.
--
-- Function signatures and result shapes are unchanged. Only the source
-- relation switches from the live view (which re-computes 6+ joins on
-- every row at query time) to the materialized view (snapshot, indexed).

DROP FUNCTION IF EXISTS ops.fn_sales_pivot(text, date, date, text[], text[], text[], text[], text[], text[], text[], text[], int);

CREATE OR REPLACE FUNCTION ops.fn_sales_pivot(
  p_dim              text   DEFAULT 'item',
  p_start            date   DEFAULT '2025-01-01',
  p_end              date   DEFAULT current_date,
  p_entities         text[] DEFAULT NULL,
  p_categories       text[] DEFAULT NULL,
  p_customers        text[] DEFAULT NULL,
  p_items            text[] DEFAULT NULL,
  p_channels         text[] DEFAULT NULL,
  p_segments         text[] DEFAULT NULL,
  p_product_families text[] DEFAULT NULL,
  p_product_types    text[] DEFAULT NULL,
  p_limit            int    DEFAULT 250
) RETURNS TABLE(
  dim_label text, line_count bigint, qty numeric, revenue numeric,
  est_cost numeric, est_margin numeric, margin_pct numeric, avg_price numeric,
  effective_segment text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
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
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot(text, date, date, text[], text[], text[], text[], text[], text[], text[], text[], int) TO anon, authenticated;

DROP FUNCTION IF EXISTS ops.fn_sales_totals(date, date, text[], text[], text[], text[], text[], text[], text[], text[]);

CREATE OR REPLACE FUNCTION ops.fn_sales_totals(
  p_start date DEFAULT '2025-01-01',
  p_end   date DEFAULT current_date,
  p_entities         text[] DEFAULT NULL, p_categories       text[] DEFAULT NULL,
  p_customers        text[] DEFAULT NULL, p_items            text[] DEFAULT NULL,
  p_channels         text[] DEFAULT NULL, p_segments         text[] DEFAULT NULL,
  p_product_families text[] DEFAULT NULL, p_product_types    text[] DEFAULT NULL
) RETURNS TABLE(
  line_count bigint, invoice_count bigint, customer_count bigint, item_count bigint,
  qty numeric, revenue numeric, est_cost numeric, est_margin numeric,
  margin_pct numeric, cost_coverage_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
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
  )
  SELECT count(*)::bigint, count(DISTINCT invoice_id)::bigint,
    count(DISTINCT customer_name)::bigint, count(DISTINCT item_name)::bigint,
    sum(quantity)::numeric, sum(revenue)::numeric, sum(est_cost)::numeric, sum(est_margin)::numeric,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL THEN (sum(revenue) - sum(est_cost)) / sum(revenue) ELSE NULL END,
    CASE WHEN sum(revenue) > 0 THEN sum(revenue) FILTER (WHERE effective_unit_cost IS NOT NULL) / sum(revenue) ELSE NULL END
  FROM base;
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_sales_totals(date, date, text[], text[], text[], text[], text[], text[], text[], text[]) TO anon, authenticated;

DROP FUNCTION IF EXISTS ops.fn_sales_dim_values(text, date, date, int);

CREATE OR REPLACE FUNCTION ops.fn_sales_dim_values(
  p_dim text, p_start date DEFAULT '2025-01-01', p_end date DEFAULT current_date, p_limit int DEFAULT 2000
) RETURNS TABLE(label text, revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH ch AS (
    SELECT label::text AS label, NULL::numeric AS revenue, sort_order::numeric AS sort
    FROM ops.channels WHERE p_dim = 'channel' AND is_active
  ),
  seg AS (
    SELECT label::text AS label, NULL::numeric AS revenue, sort_order::numeric AS sort
    FROM ops.segments WHERE p_dim = 'segment' AND is_active
  ),
  fam AS (
    SELECT label::text AS label, NULL::numeric AS revenue, sort_order::numeric AS sort
    FROM ops.product_families WHERE p_dim = 'product_family' AND is_active
  ),
  ptype AS (
    SELECT label::text AS label, NULL::numeric AS revenue, sort_order::numeric AS sort
    FROM ops.product_types WHERE p_dim = 'product_type' AND is_active
  ),
  other AS (
    SELECT
      COALESCE(CASE p_dim
        WHEN 'item'           THEN item_name
        WHEN 'customer'       THEN customer_name
        WHEN 'category'       THEN category
        WHEN 'entity'         THEN entity
        WHEN 'segment'        THEN segment
        WHEN 'product_family' THEN product_family
        WHEN 'product_type'   THEN product_type
        WHEN 'account'        THEN account_name
        WHEN 'month'          THEN to_char(txn_month, 'YYYY-MM')
        ELSE NULL END, '(unspecified)')::text AS label,
      sum(revenue)::numeric AS revenue,
      NULL::numeric AS sort
    FROM ops.mv_sales_lines
    WHERE p_dim NOT IN ('channel')
      AND txn_date >= p_start AND txn_date <= p_end
    GROUP BY 1
  )
  SELECT label, max(revenue) AS revenue
  FROM (SELECT * FROM ch UNION ALL SELECT * FROM seg UNION ALL SELECT * FROM fam
        UNION ALL SELECT * FROM ptype UNION ALL SELECT * FROM other) all_rows
  GROUP BY label
  ORDER BY min(sort) NULLS LAST, revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 2000), 1);
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_sales_dim_values(text, date, date, int) TO anon, authenticated;

DROP FUNCTION IF EXISTS ops.fn_sparkline(text, text[], date, text[], text[], text[], text[], text[], text[], text[], text[], text[]);

CREATE OR REPLACE FUNCTION ops.fn_sparkline(
  p_dim text, p_labels text[], p_end date DEFAULT current_date,
  p_entities text[] DEFAULT NULL, p_categories text[] DEFAULT NULL, p_customers text[] DEFAULT NULL,
  p_items text[] DEFAULT NULL, p_channels text[] DEFAULT NULL, p_segments text[] DEFAULT NULL,
  p_sales_reps text[] DEFAULT NULL, p_product_families text[] DEFAULT NULL, p_product_types text[] DEFAULT NULL
) RETURNS TABLE(dim_label text, ym text, revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH range_start AS (SELECT (date_trunc('month', p_end) - interval '11 month')::date AS s),
  base AS (
    SELECT v.*, ch.code AS dim_channel
    FROM ops.mv_sales_lines v, range_start rs
    LEFT JOIN LATERAL (
      SELECT u AS code FROM unnest(v.channels) AS u
      WHERE p_dim = 'channel' AND cardinality(v.channels) > 0
      UNION ALL SELECT '(unassigned)'::text WHERE p_dim = 'channel' AND cardinality(v.channels) = 0
    ) ch ON TRUE
    WHERE v.txn_date >= rs.s AND v.txn_date <= p_end
      AND (p_entities         IS NULL OR cardinality(p_entities)         = 0 OR v.entity         = ANY(p_entities))
      AND (p_categories       IS NULL OR cardinality(p_categories)       = 0 OR v.category       = ANY(p_categories))
      AND (p_customers        IS NULL OR cardinality(p_customers)        = 0 OR v.customer_name  = ANY(p_customers))
      AND (p_items            IS NULL OR cardinality(p_items)            = 0 OR v.item_name      = ANY(p_items))
      AND (p_channels         IS NULL OR cardinality(p_channels)         = 0 OR v.channels && p_channels)
      AND (p_segments         IS NULL OR cardinality(p_segments)         = 0 OR v.segment        = ANY(p_segments))
      AND (p_product_families IS NULL OR cardinality(p_product_families) = 0 OR v.product_family = ANY(p_product_families))
      AND (p_product_types    IS NULL OR cardinality(p_product_types)    = 0 OR v.product_type   = ANY(p_product_types))
  )
  SELECT
    COALESCE(CASE p_dim
      WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category WHEN 'segment' THEN segment
      WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
      WHEN 'channel' THEN dim_channel
      WHEN 'product_family' THEN product_family WHEN 'product_type' THEN product_type
      ELSE item_name END, '(unspecified)') AS dim_label,
    to_char(txn_month, 'YYYY-MM') AS ym,
    sum(revenue)::numeric AS revenue
  FROM base
  WHERE COALESCE(CASE p_dim
      WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category WHEN 'segment' THEN segment
      WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
      WHEN 'channel' THEN dim_channel
      WHEN 'product_family' THEN product_family WHEN 'product_type' THEN product_type
      ELSE item_name END, '(unspecified)') = ANY(p_labels)
  GROUP BY 1, 2 ORDER BY 1, 2;
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_sparkline(text, text[], date, text[], text[], text[], text[], text[], text[], text[], text[], text[]) TO anon, authenticated;

DROP FUNCTION IF EXISTS ops.fn_pivot_drill(text, text, date, date, text[], text[], text[], text[], text[], text[], text[], text[], text[], int);

CREATE OR REPLACE FUNCTION ops.fn_pivot_drill(
  p_dim text, p_dim_label text, p_start date DEFAULT '2025-01-01', p_end date DEFAULT current_date,
  p_entities text[] DEFAULT NULL, p_categories text[] DEFAULT NULL, p_customers text[] DEFAULT NULL,
  p_items text[] DEFAULT NULL, p_channels text[] DEFAULT NULL, p_segments text[] DEFAULT NULL,
  p_sales_reps text[] DEFAULT NULL, p_product_families text[] DEFAULT NULL, p_product_types text[] DEFAULT NULL,
  p_limit int DEFAULT 200
) RETURNS TABLE(
  txn_date date, doc_number text, qbo_invoice_id text, customer_name text,
  item_name text, category text, segment text, description text,
  quantity numeric, unit_price numeric, revenue numeric, est_cost numeric, est_margin numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  SELECT v.txn_date, v.doc_number, v.qbo_invoice_id, v.customer_name,
    v.item_name, v.category, v.segment, v.description,
    v.quantity, v.unit_price, v.revenue, v.est_cost, v.est_margin
  FROM ops.mv_sales_lines v
  WHERE v.txn_date >= p_start AND v.txn_date <= p_end
    AND (p_entities         IS NULL OR cardinality(p_entities)         = 0 OR v.entity         = ANY(p_entities))
    AND (p_categories       IS NULL OR cardinality(p_categories)       = 0 OR v.category       = ANY(p_categories))
    AND (p_customers        IS NULL OR cardinality(p_customers)        = 0 OR v.customer_name  = ANY(p_customers))
    AND (p_items            IS NULL OR cardinality(p_items)            = 0 OR v.item_name      = ANY(p_items))
    AND (p_channels         IS NULL OR cardinality(p_channels)         = 0 OR v.channels && p_channels)
    AND (p_segments         IS NULL OR cardinality(p_segments)         = 0 OR v.segment        = ANY(p_segments))
    AND (p_product_families IS NULL OR cardinality(p_product_families) = 0 OR v.product_family = ANY(p_product_families))
    AND (p_product_types    IS NULL OR cardinality(p_product_types)    = 0 OR v.product_type   = ANY(p_product_types))
    AND (
      p_dim IS NULL OR p_dim_label IS NULL OR p_dim_label = '(unspecified)'
      OR (p_dim = 'item'           AND v.item_name      = p_dim_label)
      OR (p_dim = 'customer'       AND v.customer_name  = p_dim_label)
      OR (p_dim = 'category'       AND v.category       = p_dim_label)
      OR (p_dim = 'segment'        AND v.segment        = p_dim_label)
      OR (p_dim = 'entity'         AND v.entity         = p_dim_label)
      OR (p_dim = 'month'          AND to_char(v.txn_month, 'YYYY-MM') = p_dim_label)
      OR (p_dim = 'product_family' AND v.product_family = p_dim_label)
      OR (p_dim = 'product_type'   AND v.product_type   = p_dim_label)
      OR (p_dim = 'channel'   AND (
            p_dim_label = '(unassigned)' AND cardinality(v.channels) = 0
            OR p_dim_label = ANY(v.channels)))
    )
  ORDER BY v.revenue DESC NULLS LAST, v.txn_date DESC
  LIMIT GREATEST(COALESCE(p_limit, 200), 1);
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_pivot_drill(text, text, date, date, text[], text[], text[], text[], text[], text[], text[], text[], text[], int) TO anon, authenticated;
