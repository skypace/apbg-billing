-- Driver-based cost allocation. Each cost bucket can specify which segments
-- it allocates to; rows in those segments share the bucket pro-rata, rows
-- in other segments get 0. NULL applies_to_segments = "applies to all"
-- (the fallback for management / rent / insurance / OH).
-- Applied to live DB on 2026-05-03.

ALTER TABLE ops.expense_bucket_types
  ADD COLUMN IF NOT EXISTS applies_to_segments text[];

UPDATE ops.expense_bucket_types
   SET applies_to_segments = ARRAY['service', 'equipment_sales', 'scrapping', 'reman']
 WHERE bucket_code = 'labor_service';

UPDATE ops.expense_bucket_types
   SET applies_to_segments = ARRAY['fountain', 'packaged', 'foodservice_gas']
 WHERE bucket_code IN ('labor_delivery', 'fuel');

DROP FUNCTION IF EXISTS ops.fn_period_cost_buckets(date, date);
DROP FUNCTION IF EXISTS ops.fn_sales_pivot(text, date, date, text[], text[], text[], text[], text[], text[], int);

-- fn_period_cost_buckets now also returns applies_to_segments + applicable_revenue
-- (period revenue summed within the bucket's segment set) so the dashboard
-- can compute set-restricted allocation rates.
CREATE OR REPLACE FUNCTION ops.fn_period_cost_buckets(
  p_start date DEFAULT '2025-01-01',
  p_end   date DEFAULT current_date
) RETURNS TABLE (
  bucket_code         text,
  label               text,
  sort_order          int,
  total               numeric,
  account_count       bigint,
  applies_to_segments text[],
  applicable_revenue  numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH period AS (
    SELECT pl.account_name, sum(pl.amount)::numeric AS amount
    FROM ops.pl_snapshots pl
    WHERE pl.period::date >= p_start AND pl.period::date <= p_end
      AND pl.account_type IN ('Expense', 'Cost of Goods Sold', 'Other Expense')
    GROUP BY 1
  ),
  bucketed AS (
    SELECT COALESCE(eb.bucket_code, 'oh') AS bucket_code,
           p.account_name, ABS(p.amount)::numeric AS amount
    FROM period p
    LEFT JOIN ops.expense_buckets eb ON eb.account_name = p.account_name
  ),
  seg_labels AS (
    SELECT bt.bucket_code,
           CASE WHEN bt.applies_to_segments IS NULL OR cardinality(bt.applies_to_segments) = 0
                THEN NULL
                ELSE (SELECT array_agg(s.label) FROM ops.segments s WHERE s.segment_code = ANY(bt.applies_to_segments))
           END AS labels
    FROM ops.expense_bucket_types bt
  ),
  seg_rev AS (
    SELECT sl.bucket_code, sum(v.revenue)::numeric AS applicable_rev
    FROM seg_labels sl
    LEFT JOIN ops.v_sales_lines v
      ON v.txn_date >= p_start AND v.txn_date <= p_end
      AND (sl.labels IS NULL OR v.segment = ANY(sl.labels))
    GROUP BY sl.bucket_code
  )
  SELECT bt.bucket_code, bt.label, bt.sort_order,
    COALESCE(sum(b.amount), 0)::numeric, count(b.account_name)::bigint,
    bt.applies_to_segments, COALESCE(sr.applicable_rev, 0)::numeric
  FROM ops.expense_bucket_types bt
  LEFT JOIN bucketed b ON b.bucket_code = bt.bucket_code
  LEFT JOIN seg_rev sr ON sr.bucket_code = bt.bucket_code
  GROUP BY bt.bucket_code, bt.label, bt.sort_order, bt.applies_to_segments, sr.applicable_rev
  ORDER BY bt.sort_order;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_period_cost_buckets(date, date) TO anon, authenticated;

-- fn_sales_pivot now also returns effective_segment per row (most-common
-- segment under each dim_label) so the dashboard can apply driver-based
-- allocation when the row's segment is unambiguous.
CREATE OR REPLACE FUNCTION ops.fn_sales_pivot(
  p_dim         text   DEFAULT 'item',
  p_start       date   DEFAULT '2025-01-01',
  p_end         date   DEFAULT current_date,
  p_entities    text[] DEFAULT NULL,
  p_categories  text[] DEFAULT NULL,
  p_customers   text[] DEFAULT NULL,
  p_items       text[] DEFAULT NULL,
  p_channels    text[] DEFAULT NULL,
  p_segments    text[] DEFAULT NULL,
  p_limit       int    DEFAULT 250
) RETURNS TABLE (
  dim_label text, line_count bigint, qty numeric, revenue numeric,
  est_cost numeric, est_margin numeric, margin_pct numeric, avg_price numeric,
  effective_segment text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT * FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR entity        = ANY(p_entities))
      AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR category      = ANY(p_categories))
      AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR customer_name = ANY(p_customers))
      AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR item_name     = ANY(p_items))
      AND (p_channels   IS NULL OR cardinality(p_channels)   = 0 OR channels && p_channels)
      AND (p_segments   IS NULL OR cardinality(p_segments)   = 0 OR segment       = ANY(p_segments))
  ),
  expanded AS (
    SELECT b.*, ch.code AS dim_channel FROM base b
    LEFT JOIN LATERAL (
      SELECT u AS code FROM unnest(b.channels) AS u
      WHERE p_dim = 'channel' AND cardinality(b.channels) > 0
      UNION ALL SELECT '(unassigned)'::text WHERE p_dim = 'channel' AND cardinality(b.channels) = 0
    ) ch ON TRUE
  )
  SELECT
    COALESCE(CASE p_dim
      WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category WHEN 'segment' THEN segment
      WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
      WHEN 'channel' THEN dim_channel ELSE item_name END, '(unspecified)') AS dim_label,
    count(*)::bigint, sum(quantity)::numeric, sum(revenue)::numeric,
    sum(est_cost)::numeric, sum(est_margin)::numeric,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL
         THEN (sum(revenue) - sum(est_cost)) / sum(revenue) ELSE NULL END,
    CASE WHEN sum(quantity) > 0 THEN sum(revenue) / sum(quantity) ELSE NULL END,
    mode() WITHIN GROUP (ORDER BY segment) AS effective_segment
  FROM expanded GROUP BY 1
  ORDER BY revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 250), 1);
$$;
GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot(text, date, date, text[], text[], text[], text[], text[], text[], int) TO anon, authenticated;
