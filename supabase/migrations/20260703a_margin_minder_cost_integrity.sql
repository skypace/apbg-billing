-- Margin Minder cost integrity + QBO freshness.
--
-- Fixes four accounting/data-trust issues:
--   1. CreditMemo / RefundReceipt quantities must reverse with revenue so COGS
--      reverses too.
--   2. Actual item cost should be as-of the sale date, not an all-time average
--      that can rewrite historical margin when later vendor bills arrive.
--   3. Discount lines are zero-cost margin reducers, not missing-cost lines.
--   4. Margin RPCs expose row-level cost coverage and compute margin % only on
--      revenue whose cost is known.
--
-- Also adds fn_qbo_sync_freshness() so the Margin UI can warn when invoice,
-- expense-cost, or materialized-view refresh data is stale.

CREATE INDEX IF NOT EXISTS idx_qel_item_date_actual_cost
  ON ops.qbo_expense_lines (item_ref_id, txn_date)
  WHERE detail_type = 'ItemBasedExpenseLineDetail'
    AND item_ref_id IS NOT NULL
    AND quantity IS NOT NULL
    AND quantity > 0
    AND txn_date IS NOT NULL;

-- Historical correction for rows written before sync-qbo v45.
UPDATE ops.qbo_invoice_lines l
SET quantity = -abs(l.quantity)
FROM ops.qbo_invoices i
WHERE i.id = l.invoice_id
  AND i.txn_type IN ('CreditMemo', 'RefundReceipt')
  AND l.quantity IS NOT NULL
  AND l.quantity > 0;

CREATE OR REPLACE VIEW ops.v_sales_lines AS
WITH effective AS (
  SELECT
    l.id,
    l.invoice_id,
    i.qbo_invoice_id,
    i.doc_number,
    i.txn_date,
    date_trunc('month'::text, i.txn_date::timestamptz)::date AS txn_month,
    EXTRACT(year FROM i.txn_date)::integer AS txn_year,
    i.customer_ref_id,
    i.customer_name,
    i.entity,
    i.department AS invoice_department,
    l.department AS line_department,
    l.item_ref_id,
    COALESCE(it.name, l.item_name) AS item_name,
    l.revenue_line,
    l.account_name,
    l.description,
    l.quantity,
    l.unit_price,
    l.amount,
    it.purchase_cost AS static_unit_cost,
    ac.avg_unit_cost AS actual_unit_cost,
    (
      l.item_ref_id IS NULL
      AND (
        lower(coalesce(l.account_name, '')) LIKE '%discount%'
        OR lower(coalesce(l.revenue_line, '')) LIKE '%discount%'
      )
    ) AS is_discount_line,
    CASE
      WHEN l.item_ref_id IS NULL
        AND (
          lower(coalesce(l.account_name, '')) LIKE '%discount%'
          OR lower(coalesce(l.revenue_line, '')) LIKE '%discount%'
        )
        THEN 0::numeric
      ELSE COALESCE(ac.avg_unit_cost, it.purchase_cost)
    END AS effective_unit_cost,
    CASE
      WHEN l.item_ref_id IS NULL
        AND (
          lower(coalesce(l.account_name, '')) LIKE '%discount%'
          OR lower(coalesce(l.revenue_line, '')) LIKE '%discount%'
        )
        THEN 'discount'
      WHEN ac.avg_unit_cost IS NOT NULL THEN 'actual_asof'
      WHEN it.purchase_cost IS NOT NULL THEN 'static'
      ELSE 'none'
    END AS cost_source,
    it.type AS item_type,
    it.income_account_name,
    it.expense_account_name
  FROM ops.qbo_invoice_lines l
  JOIN ops.qbo_invoices i ON i.id = l.invoice_id
  LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.item_ref_id
  LEFT JOIN LATERAL (
    SELECT
      CASE WHEN sum(el.quantity) > 0 THEN sum(el.amount) / sum(el.quantity) END AS avg_unit_cost
    FROM ops.qbo_expense_lines el
    WHERE el.detail_type = 'ItemBasedExpenseLineDetail'
      AND el.item_ref_id = l.item_ref_id
      AND el.quantity IS NOT NULL
      AND el.quantity > 0
      AND el.txn_date IS NOT NULL
      AND el.txn_date <= i.txn_date
  ) ac ON l.item_ref_id IS NOT NULL
)
SELECT
  e.id AS line_id,
  e.invoice_id,
  e.qbo_invoice_id,
  e.doc_number,
  e.txn_date,
  e.txn_month,
  e.txn_year,
  e.customer_ref_id,
  e.customer_name,
  e.entity,
  e.invoice_department,
  e.line_department,
  e.item_ref_id,
  e.item_name,
  e.revenue_line AS category,
  COALESCE(s_item.label, s_cat.label) AS segment,
  e.account_name,
  e.description,
  e.quantity,
  e.unit_price,
  e.amount AS revenue,
  e.static_unit_cost AS purchase_cost,
  e.actual_unit_cost,
  e.effective_unit_cost,
  e.cost_source,
  e.item_type,
  e.income_account_name,
  e.expense_account_name,
  CASE
    WHEN e.is_discount_line THEN 0::numeric
    WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
      THEN e.effective_unit_cost * e.quantity
  END AS est_cost,
  CASE
    WHEN e.is_discount_line THEN e.amount
    WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
      THEN e.amount - e.effective_unit_cost * e.quantity
  END AS est_margin,
  COALESCE(lc.channels, ARRAY[]::text[]) AS channels,
  lc.primary_channel,
  ARRAY[]::text[] AS sales_reps,
  pf.label AS product_family,
  pt.label AS product_type
FROM effective e
LEFT JOIN ops.item_segments is_map ON is_map.qbo_item_id = e.item_ref_id
LEFT JOIN ops.segments s_item ON s_item.segment_code = is_map.segment_code AND s_item.is_active
LEFT JOIN ops.category_segments cs ON cs.category = e.revenue_line
LEFT JOIN ops.segments s_cat ON s_cat.segment_code = cs.segment_code AND s_cat.is_active
LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = e.item_ref_id
LEFT JOIN ops.product_families pf ON pf.family_code = ipf.family_code AND pf.is_active
LEFT JOIN ops.item_product_types ipt ON ipt.qbo_item_id = e.item_ref_id
LEFT JOIN ops.product_types pt ON pt.type_code = ipt.type_code AND pt.is_active
LEFT JOIN LATERAL (
  SELECT
    array_agg(c.label ORDER BY c.sort_order) AS channels,
    max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
  FROM ops.customer_channels cc
  JOIN ops.channels c ON c.channel_code = cc.channel_code
  WHERE cc.qbo_customer_id = e.customer_ref_id
    AND c.is_active
) lc ON true;

DROP MATERIALIZED VIEW IF EXISTS ops.mv_sales_lines;

CREATE MATERIALIZED VIEW ops.mv_sales_lines AS
  SELECT * FROM ops.v_sales_lines;

CREATE UNIQUE INDEX mv_sales_lines_pkey         ON ops.mv_sales_lines (line_id);
CREATE INDEX mv_sales_lines_txn_date_idx        ON ops.mv_sales_lines (txn_date);
CREATE INDEX mv_sales_lines_customer_ref_idx    ON ops.mv_sales_lines (customer_ref_id);
CREATE INDEX mv_sales_lines_item_ref_idx        ON ops.mv_sales_lines (item_ref_id);
CREATE INDEX mv_sales_lines_category_idx        ON ops.mv_sales_lines (category);
CREATE INDEX mv_sales_lines_segment_idx         ON ops.mv_sales_lines (segment);
CREATE INDEX mv_sales_lines_family_idx          ON ops.mv_sales_lines (product_family);
CREATE INDEX mv_sales_lines_type_idx            ON ops.mv_sales_lines (product_type);
CREATE INDEX mv_sales_lines_entity_idx          ON ops.mv_sales_lines (entity);
CREATE INDEX mv_sales_lines_channels_gin_idx    ON ops.mv_sales_lines USING gin (channels);

GRANT SELECT ON ops.mv_sales_lines TO anon, authenticated;

DROP FUNCTION IF EXISTS ops.fn_sales_pivot(
  text, date, date, text[], text[], text[], text[], text[], text[], text[],
  text[], integer, text[], text[], text[]
);

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
RETURNS TABLE(
  dim_label text,
  line_count bigint,
  qty numeric,
  revenue numeric,
  est_cost numeric,
  est_margin numeric,
  margin_pct numeric,
  cost_coverage_pct numeric,
  avg_price numeric,
  effective_segment text
)
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
  ),
  grouped AS (
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
      (sum(revenue) FILTER (WHERE est_cost IS NOT NULL))::numeric AS costed_revenue,
      (sum(abs(revenue)) FILTER (WHERE est_cost IS NOT NULL))::numeric AS costed_abs_revenue,
      sum(abs(revenue))::numeric AS abs_revenue,
      (mode() WITHIN GROUP (ORDER BY segment))::text AS effective_segment
    FROM expanded
    GROUP BY 1
  )
  SELECT
    dim_label,
    line_count,
    qty,
    revenue,
    est_cost,
    est_margin,
    CASE WHEN costed_revenue IS NOT NULL AND costed_revenue <> 0
      THEN est_margin / costed_revenue ELSE NULL END::numeric AS margin_pct,
    CASE WHEN abs_revenue > 0
      THEN COALESCE(costed_abs_revenue, 0) / abs_revenue ELSE NULL END::numeric AS cost_coverage_pct,
    CASE WHEN qty <> 0 THEN revenue / qty ELSE NULL END::numeric AS avg_price,
    effective_segment
  FROM grouped
  ORDER BY revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 250), 1);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot(
  text, date, date, text[], text[], text[], text[], text[], text[], text[],
  text[], integer, text[], text[], text[]
) TO anon, authenticated;

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
  agg AS (
    SELECT
      count(*)::bigint AS line_count,
      count(DISTINCT invoice_id)::bigint AS invoice_count,
      count(DISTINCT customer_name)::bigint AS customer_count,
      count(DISTINCT item_name)::bigint AS item_count,
      sum(quantity)::numeric AS qty,
      sum(revenue)::numeric AS revenue,
      sum(est_cost)::numeric AS est_cost,
      sum(est_margin)::numeric AS est_margin,
      (sum(revenue) FILTER (WHERE est_cost IS NOT NULL))::numeric AS costed_revenue,
      (sum(abs(revenue)) FILTER (WHERE est_cost IS NOT NULL))::numeric AS costed_abs_revenue,
      sum(abs(revenue))::numeric AS abs_revenue
    FROM base
  )
  SELECT
    line_count,
    invoice_count,
    customer_count,
    item_count,
    qty,
    revenue,
    est_cost,
    est_margin,
    CASE WHEN costed_revenue IS NOT NULL AND costed_revenue <> 0
      THEN est_margin / costed_revenue ELSE NULL END::numeric AS margin_pct,
    CASE WHEN abs_revenue > 0
      THEN COALESCE(costed_abs_revenue, 0) / abs_revenue ELSE NULL END::numeric AS cost_coverage_pct
  FROM agg;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_totals(
  date, date, text[], text[], text[], text[], text[], text[], text[], text[],
  text[], text[], text[]
) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_qbo_sync_freshness()
RETURNS TABLE(
  status text,
  warnings text[],
  invoice_cache_at timestamptz,
  item_cache_at timestamptz,
  expense_line_cache_at timestamptz,
  last_invoice_sync_at timestamptz,
  last_line_backfill_at timestamptz,
  last_mv_refresh_at timestamptz,
  recent_qbo_errors bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH times AS (
    SELECT
      (SELECT max(synced_at) FROM ops.qbo_invoices) AS invoice_cache_at,
      (SELECT max(synced_at) FROM ops.qbo_items) AS item_cache_at,
      (SELECT max(synced_at) FROM ops.qbo_expense_lines) AS expense_line_cache_at,
      (SELECT max(completed_at) FROM ops.sync_log WHERE source = 'qbo' AND sync_type = 'invoices' AND status = 'success') AS last_invoice_sync_at,
      (SELECT max(completed_at) FROM ops.sync_log WHERE source = 'qbo' AND sync_type IN ('lines_backfill', 'invoices') AND status = 'success') AS last_line_backfill_at,
      (SELECT max(completed_at) FROM ops.sync_log WHERE source = 'qbo' AND sync_type = 'mv_refresh' AND status = 'success') AS last_mv_refresh_at,
      (SELECT count(*)::bigint FROM ops.sync_log
        WHERE source = 'qbo'
          AND status = 'error'
          AND coalesce(started_at, completed_at, now()) >= now() - interval '2 hours') AS recent_qbo_errors
  ),
  checked AS (
    SELECT
      times.*,
      array_remove(ARRAY[
        CASE WHEN invoice_cache_at IS NULL THEN 'No QBO invoice cache timestamp'
             WHEN invoice_cache_at < now() - interval '30 hours' THEN 'QBO invoice cache is older than 30h' END,
        CASE WHEN item_cache_at IS NULL THEN 'No QBO item-cost cache timestamp'
             WHEN item_cache_at < now() - interval '30 hours' THEN 'QBO item-cost cache is older than 30h' END,
        CASE WHEN expense_line_cache_at IS NULL THEN 'No QBO expense-cost cache timestamp'
             WHEN expense_line_cache_at < now() - interval '30 hours' THEN 'QBO expense-cost cache is older than 30h' END,
        CASE WHEN last_invoice_sync_at IS NULL THEN 'No successful QBO invoice sync logged'
             WHEN last_invoice_sync_at < now() - interval '30 hours' THEN 'Last successful QBO invoice sync is older than 30h' END,
        CASE WHEN last_line_backfill_at IS NULL THEN 'No successful QBO line backfill logged'
             WHEN last_line_backfill_at < now() - interval '2 hours' THEN 'QBO invoice-line backfill is older than 2h' END,
        CASE WHEN last_mv_refresh_at IS NULL THEN 'No successful Margin materialized-view refresh logged'
             WHEN last_mv_refresh_at < now() - interval '30 hours' THEN 'Margin materialized view is older than 30h' END,
        CASE WHEN recent_qbo_errors > 0 THEN recent_qbo_errors::text || ' QBO sync error(s) in the last 2h' END
      ]::text[], NULL) AS warnings
    FROM times
  )
  SELECT
    CASE WHEN cardinality(warnings) > 0 THEN 'warn' ELSE 'ok' END,
    warnings,
    invoice_cache_at,
    item_cache_at,
    expense_line_cache_at,
    last_invoice_sync_at,
    last_line_backfill_at,
    last_mv_refresh_at,
    recent_qbo_errors
  FROM checked;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_qbo_sync_freshness() TO anon, authenticated;
