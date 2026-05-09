-- Fix Margin page RPCs.
-- ----------------------
-- ops.fn_sales_pivot, fn_sales_totals, fn_sales_dim_values all reference
-- a `sales_reps` column on v_sales_lines (and an ops.sales_reps table)
-- that no longer exist — they were dropped during the rep-table cleanup
-- (PR #42), but the RPCs were never re-baselined. Symptom: every Margin
-- tab fails with "column sales_reps does not exist."
--
-- Also fixes:
--   * fn_sales_dim_values dim CASE was missing 'month', 'segment',
--     'channel', and 'account' branches → fell through to '(unspecified)'
--     for those dims.
--   * fn_sales_pivot dim CASE was missing 'account' → fell through to
--     item_name (wrong values).
--
-- Drops the sales_reps parameter from all three. The Margin page sends
-- nulls for it anyway. Keeps the rest of the signature so the SPA keeps
-- working without redeploy.

-- ---- fn_sales_pivot --------------------------------------------------

DROP FUNCTION IF EXISTS ops.fn_sales_pivot(text, date, date, text[], text[], text[], text[], text[], text[], text[], integer);

CREATE OR REPLACE FUNCTION ops.fn_sales_pivot(
  p_dim        text DEFAULT 'item',
  p_start      date DEFAULT '2025-01-01'::date,
  p_end        date DEFAULT CURRENT_DATE,
  p_entities   text[] DEFAULT NULL::text[],
  p_categories text[] DEFAULT NULL::text[],
  p_customers  text[] DEFAULT NULL::text[],
  p_items      text[] DEFAULT NULL::text[],
  p_channels   text[] DEFAULT NULL::text[],
  p_segments   text[] DEFAULT NULL::text[],
  p_limit      integer DEFAULT 250
)
RETURNS TABLE(
  dim_label text,
  line_count bigint,
  qty numeric,
  revenue numeric,
  est_cost numeric,
  est_margin numeric,
  margin_pct numeric,
  avg_price numeric,
  effective_segment text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'ops','public'
AS $function$
  WITH base AS (
    SELECT * FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities    IS NULL OR cardinality(p_entities)    = 0 OR entity        = ANY(p_entities))
      AND (p_categories  IS NULL OR cardinality(p_categories)  = 0 OR category      = ANY(p_categories))
      AND (p_customers   IS NULL OR cardinality(p_customers)   = 0 OR customer_name = ANY(p_customers))
      AND (p_items       IS NULL OR cardinality(p_items)       = 0 OR item_name     = ANY(p_items))
      AND (p_channels    IS NULL OR cardinality(p_channels)    = 0 OR channels && p_channels)
      AND (p_segments    IS NULL OR cardinality(p_segments)    = 0 OR segment       = ANY(p_segments))
  ),
  -- Channel dim is array-valued on v_sales_lines, so we explode it.
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
      WHEN 'item'     THEN item_name
      WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category
      WHEN 'segment'  THEN segment
      WHEN 'entity'   THEN entity
      WHEN 'month'    THEN to_char(txn_month, 'YYYY-MM')
      WHEN 'channel'  THEN dim_channel
      WHEN 'account'  THEN account_name
      ELSE item_name
    END, '(unspecified)') AS dim_label,
    count(*)::bigint  AS line_count,
    sum(quantity)::numeric AS qty,
    sum(revenue)::numeric  AS revenue,
    sum(est_cost)::numeric AS est_cost,
    sum(est_margin)::numeric AS est_margin,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL
         THEN (sum(revenue) - sum(est_cost)) / sum(revenue) ELSE NULL END AS margin_pct,
    CASE WHEN sum(quantity) > 0 THEN sum(revenue) / sum(quantity) ELSE NULL END AS avg_price,
    mode() WITHIN GROUP (ORDER BY segment) AS effective_segment
  FROM expanded
  GROUP BY 1
  ORDER BY revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 250), 1);
$function$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot(text, date, date, text[], text[], text[], text[], text[], text[], integer) TO anon, authenticated;

-- ---- fn_sales_totals -------------------------------------------------

DROP FUNCTION IF EXISTS ops.fn_sales_totals(date, date, text[], text[], text[], text[], text[], text[], text[]);

CREATE OR REPLACE FUNCTION ops.fn_sales_totals(
  p_start      date DEFAULT '2025-01-01'::date,
  p_end        date DEFAULT CURRENT_DATE,
  p_entities   text[] DEFAULT NULL::text[],
  p_categories text[] DEFAULT NULL::text[],
  p_customers  text[] DEFAULT NULL::text[],
  p_items      text[] DEFAULT NULL::text[],
  p_channels   text[] DEFAULT NULL::text[],
  p_segments   text[] DEFAULT NULL::text[]
)
RETURNS TABLE(
  line_count bigint,
  invoice_count bigint,
  customer_count bigint,
  item_count bigint,
  qty numeric,
  revenue numeric,
  est_cost numeric,
  est_margin numeric,
  margin_pct numeric,
  cost_coverage_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'ops','public'
AS $function$
  WITH base AS (
    SELECT * FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR entity        = ANY(p_entities))
      AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR category      = ANY(p_categories))
      AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR customer_name = ANY(p_customers))
      AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR item_name     = ANY(p_items))
      AND (p_channels   IS NULL OR cardinality(p_channels)   = 0 OR channels && p_channels)
      AND (p_segments   IS NULL OR cardinality(p_segments)   = 0 OR segment       = ANY(p_segments))
  )
  SELECT count(*)::bigint, count(DISTINCT invoice_id)::bigint,
    count(DISTINCT customer_name)::bigint, count(DISTINCT item_name)::bigint,
    sum(quantity)::numeric, sum(revenue)::numeric,
    sum(est_cost)::numeric, sum(est_margin)::numeric,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL
         THEN (sum(revenue) - sum(est_cost)) / sum(revenue) ELSE NULL END,
    CASE WHEN sum(revenue) > 0
         THEN sum(revenue) FILTER (WHERE effective_unit_cost IS NOT NULL) / sum(revenue) ELSE NULL END
  FROM base;
$function$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_totals(date, date, text[], text[], text[], text[], text[], text[]) TO anon, authenticated;

-- ---- fn_sales_dim_values ---------------------------------------------

CREATE OR REPLACE FUNCTION ops.fn_sales_dim_values(
  p_dim   text,
  p_start date DEFAULT '2025-01-01'::date,
  p_end   date DEFAULT CURRENT_DATE,
  p_limit integer DEFAULT 2000
)
RETURNS TABLE(label text, revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'ops','public'
AS $function$
  WITH ch AS (
    SELECT label, NULL::numeric AS revenue, sort_order::numeric AS sort
    FROM ops.channels WHERE p_dim = 'channel' AND is_active
  ),
  seg AS (
    SELECT label, NULL::numeric AS revenue, sort_order::numeric AS sort
    FROM ops.segments WHERE p_dim = 'segment' AND is_active
  ),
  other AS (
    SELECT
      COALESCE(CASE p_dim
        WHEN 'item'     THEN item_name
        WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category
        WHEN 'entity'   THEN entity
        WHEN 'segment'  THEN segment
        WHEN 'account'  THEN account_name
        WHEN 'month'    THEN to_char(txn_month, 'YYYY-MM')
        ELSE NULL END, '(unspecified)') AS label,
      sum(revenue)::numeric AS revenue,
      NULL::numeric AS sort
    FROM ops.v_sales_lines
    WHERE p_dim NOT IN ('channel')
      AND txn_date >= p_start AND txn_date <= p_end
    GROUP BY 1
  )
  SELECT label, revenue
  FROM (SELECT * FROM ch UNION ALL SELECT * FROM seg UNION ALL SELECT * FROM other) all_rows
  ORDER BY sort NULLS LAST, revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 2000), 1);
$function$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_dim_values(text, date, date, integer) TO anon, authenticated;
