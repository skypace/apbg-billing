-- Replace single-value filter params with text[] arrays so any combination
-- of items × customers × categories × entities can be picked. Also adds
-- fn_sales_dim_values for typeahead pickers.

DROP FUNCTION IF EXISTS ops.fn_sales_pivot(text, date, date, text, text, text, text, int);
DROP FUNCTION IF EXISTS ops.fn_sales_pivot_compare(text, date, date, date, date, text, text, text, text, int);
DROP FUNCTION IF EXISTS ops.fn_sales_totals(date, date, text, text, text, text);

CREATE OR REPLACE FUNCTION ops.fn_sales_pivot(
  p_dim         text   DEFAULT 'item',
  p_start       date   DEFAULT '2025-01-01',
  p_end         date   DEFAULT current_date,
  p_entities    text[] DEFAULT NULL,
  p_categories  text[] DEFAULT NULL,
  p_customers   text[] DEFAULT NULL,
  p_items       text[] DEFAULT NULL,
  p_limit       int    DEFAULT 250
) RETURNS TABLE (
  dim_label   text,
  line_count  bigint,
  qty         numeric,
  revenue     numeric,
  est_cost    numeric,
  est_margin  numeric,
  margin_pct  numeric,
  avg_price   numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR entity        = ANY(p_entities))
      AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR category      = ANY(p_categories))
      AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR customer_name = ANY(p_customers))
      AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR item_name     = ANY(p_items))
  )
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
    )                                                    AS dim_label,
    count(*)::bigint                                     AS line_count,
    sum(quantity)::numeric                               AS qty,
    sum(revenue)::numeric                                AS revenue,
    sum(est_cost)::numeric                               AS est_cost,
    sum(est_margin)::numeric                             AS est_margin,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL
         THEN (sum(revenue) - sum(est_cost)) / sum(revenue)
         ELSE NULL END                                   AS margin_pct,
    CASE WHEN sum(quantity) > 0
         THEN sum(revenue) / sum(quantity)
         ELSE NULL END                                   AS avg_price
  FROM base
  GROUP BY 1
  ORDER BY revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 250), 1);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot(text, date, date, text[], text[], text[], text[], int) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_sales_pivot_compare(
  p_dim         text   DEFAULT 'item',
  p_start       date   DEFAULT '2025-01-01',
  p_end         date   DEFAULT current_date,
  p_prev_start  date   DEFAULT NULL,
  p_prev_end    date   DEFAULT NULL,
  p_entities    text[] DEFAULT NULL,
  p_categories  text[] DEFAULT NULL,
  p_customers   text[] DEFAULT NULL,
  p_items       text[] DEFAULT NULL,
  p_limit       int    DEFAULT 250
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
      COALESCE(CASE p_dim
        WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category WHEN 'entity' THEN entity
        WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
        ELSE item_name END, '(unspecified)') AS dim_label,
      count(*)::bigint AS line_count,
      sum(quantity)::numeric AS qty,
      sum(revenue)::numeric AS revenue,
      sum(est_cost)::numeric AS est_cost,
      sum(est_margin)::numeric AS est_margin
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR entity        = ANY(p_entities))
      AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR category      = ANY(p_categories))
      AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR customer_name = ANY(p_customers))
      AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR item_name     = ANY(p_items))
    GROUP BY 1
  ),
  prev AS (
    SELECT
      COALESCE(CASE p_dim
        WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category WHEN 'entity' THEN entity
        WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
        ELSE item_name END, '(unspecified)') AS dim_label,
      sum(quantity)::numeric AS qty,
      sum(revenue)::numeric AS revenue
    FROM ops.v_sales_lines
    WHERE p_prev_start IS NOT NULL AND p_prev_end IS NOT NULL
      AND txn_date >= p_prev_start AND txn_date <= p_prev_end
      AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR entity        = ANY(p_entities))
      AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR category      = ANY(p_categories))
      AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR customer_name = ANY(p_customers))
      AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR item_name     = ANY(p_items))
    GROUP BY 1
  )
  SELECT
    COALESCE(c.dim_label, p.dim_label) AS dim_label,
    COALESCE(c.line_count, 0) AS line_count,
    c.qty, c.revenue, c.est_cost, c.est_margin,
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

GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot_compare(text, date, date, date, date, text[], text[], text[], text[], int) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_sales_totals(
  p_start       date   DEFAULT '2025-01-01',
  p_end         date   DEFAULT current_date,
  p_entities    text[] DEFAULT NULL,
  p_categories  text[] DEFAULT NULL,
  p_customers   text[] DEFAULT NULL,
  p_items       text[] DEFAULT NULL
) RETURNS TABLE (
  line_count    bigint,
  invoice_count bigint,
  customer_count bigint,
  item_count    bigint,
  qty           numeric,
  revenue       numeric,
  est_cost      numeric,
  est_margin    numeric,
  margin_pct    numeric,
  cost_coverage_pct numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR entity        = ANY(p_entities))
      AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR category      = ANY(p_categories))
      AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR customer_name = ANY(p_customers))
      AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR item_name     = ANY(p_items))
  )
  SELECT
    count(*)::bigint,
    count(DISTINCT invoice_id)::bigint,
    count(DISTINCT customer_name)::bigint,
    count(DISTINCT item_name)::bigint,
    sum(quantity)::numeric,
    sum(revenue)::numeric,
    sum(est_cost)::numeric,
    sum(est_margin)::numeric,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL
         THEN (sum(revenue) - sum(est_cost)) / sum(revenue) ELSE NULL END,
    CASE WHEN sum(revenue) > 0
         THEN sum(revenue) FILTER (WHERE purchase_cost IS NOT NULL) / sum(revenue) ELSE NULL END
  FROM base;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_totals(date, date, text[], text[], text[], text[]) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_sales_dim_values(
  p_dim    text,
  p_start  date DEFAULT '2025-01-01',
  p_end    date DEFAULT current_date,
  p_limit  int  DEFAULT 2000
) RETURNS TABLE (label text, revenue numeric)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  SELECT
    COALESCE(CASE p_dim
      WHEN 'item' THEN item_name
      WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category
      WHEN 'entity' THEN entity
      ELSE NULL END, '(unspecified)') AS label,
    sum(revenue)::numeric AS revenue
  FROM ops.v_sales_lines
  WHERE txn_date >= p_start AND txn_date <= p_end
  GROUP BY 1
  ORDER BY revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 2000), 1);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_dim_values(text, date, date, int) TO anon, authenticated;
