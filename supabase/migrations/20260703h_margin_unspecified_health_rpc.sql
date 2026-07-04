-- Follow-up for Margin Minder data health + unspecified category cleanup.
--
-- Live was still missing ops.fn_margin_data_health in the PostgREST schema
-- cache, and real Melt revenue could still collapse into (unspecified) when
-- invoice-line revenue_line was blank. Recreate the RPC with the exact UI
-- signature, backfill known revenue maps, and make v_sales_lines resolve a
-- category from revenue_line, known Melt account names, item category_path,
-- then account name as a last resort.

ALTER TABLE ops.sync_log DROP CONSTRAINT IF EXISTS sync_log_source_check;
ALTER TABLE ops.sync_log ADD CONSTRAINT sync_log_source_check
  CHECK (
    source IS NULL OR source = ANY (ARRAY[
      'qbo'::text, 'sf'::text, 'sf-receipt-sync'::text, 'fleet'::text,
      'zoho_crm'::text, 'bambee'::text, 'fleetcomplete'::text, 'pg_net'::text
    ])
  );

INSERT INTO ops.category_segments (category, segment_code, set_by) VALUES
  ('The Melt Equipment', 'foodservice_equipment', 'codex'),
  ('Subleased Space', 'rental', 'codex'),
  ('Discounts', 'other', 'codex'),
  ('Sales Tax', 'other', 'codex')
ON CONFLICT (category) DO UPDATE SET
  segment_code = EXCLUDED.segment_code,
  set_by = EXCLUDED.set_by,
  set_at = now();

INSERT INTO ops.revenue_account_map (
  qbo_income_account_id,
  qbo_income_account_name,
  revenue_line,
  category
) VALUES
  ('1150040025', 'Equipment Sales:The Melt', 'Equipment Sales', 'EQ SALES'),
  ('1150040027', 'Service Income:Melt Service Income', 'Service - General', 'SERVICE'),
  ('1150040030', 'Shipping Income:Melt Shipping Income', 'Shipping Income', 'OTHER'),
  ('1150040032', 'Service Income:PM and Contract Service Income:Melt PM', 'Service - PM Contract', 'SERVICE'),
  ('1150040029', 'Sublet Rental Income:Melt Equipment Rent', 'Subleased Space', 'OTHER'),
  ('38',  'Discounts', 'Discounts', 'OTHER'),
  ('308', 'Channel Discount:Shopify Discount', 'Discounts', 'OTHER'),
  ('314', 'Channel Sales Tax Payable:Shopify Sales Tax', 'Sales Tax', 'OTHER')
ON CONFLICT (qbo_income_account_id) DO UPDATE SET
  qbo_income_account_name = EXCLUDED.qbo_income_account_name,
  revenue_line = EXCLUDED.revenue_line,
  category = EXCLUDED.category,
  updated_at = now();

UPDATE ops.qbo_invoice_lines l
SET revenue_line = m.revenue_line
FROM ops.revenue_account_map m
WHERE l.account_ref_id = m.qbo_income_account_id
  AND (
    l.revenue_line IS NULL
    OR l.revenue_line <> m.revenue_line
  );

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
    CASE
      WHEN NULLIF(trim(COALESCE(l.revenue_line, '')), '') IS NOT NULL
        THEN l.revenue_line
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%pm%'
        THEN 'Service - PM Contract'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%shipping%'
        THEN 'Shipping Income'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%sublet%'
        THEN 'Subleased Space'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%rent%'
        THEN 'Subleased Space'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%service%'
        THEN 'Service - General'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%equipment%'
        THEN 'Equipment Sales'
      ELSE COALESCE(
        NULLIF(trim(COALESCE(it.category_path, '')), ''),
        NULLIF(trim(COALESCE(l.account_name, '')), ''),
        NULLIF(trim(COALESCE(it.income_account_name, '')), '')
      )
    END AS resolved_category,
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
  e.resolved_category AS category,
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
LEFT JOIN ops.category_segments cs ON cs.category = e.resolved_category
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

REFRESH MATERIALIZED VIEW CONCURRENTLY ops.mv_sales_lines;

DROP FUNCTION IF EXISTS ops.fn_margin_data_health(
  date, date, text[], text[], text[], text[], text[], text[], text[], text[],
  text[], text[], text[]
);

CREATE OR REPLACE FUNCTION ops.fn_margin_data_health(
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
  p_exclude_customers text[] DEFAULT NULL,
  p_exclude_categories text[] DEFAULT NULL,
  p_exclude_items text[] DEFAULT NULL
)
RETURNS TABLE(
  issue_key text,
  severity text,
  title text,
  detail text,
  line_count bigint,
  revenue numeric,
  sample_labels text[],
  action text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH base AS (
    SELECT *
    FROM ops.mv_sales_lines
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
  total AS (
    SELECT COALESCE(sum(abs(revenue)), 0)::numeric AS abs_revenue
    FROM base
  ),
  sync_times AS (
    SELECT
      (SELECT max(synced_at) FROM ops.qbo_invoices) AS invoice_cache_at,
      (SELECT max(synced_at) FROM ops.qbo_items) AS item_cache_at,
      (SELECT max(synced_at) FROM ops.qbo_expense_lines) AS expense_line_cache_at,
      (SELECT max(completed_at) FROM ops.sync_log WHERE source = 'qbo' AND sync_type = 'invoices' AND status IN ('success', 'ok')) AS last_invoice_sync_at,
      (SELECT max(completed_at) FROM ops.sync_log WHERE source = 'qbo' AND sync_type = 'lines_backfill' AND status IN ('success', 'ok')) AS last_line_cron_at,
      (SELECT max(completed_at) FROM ops.sync_log WHERE source = 'qbo' AND sync_type IN ('lines_backfill', 'invoices') AND status IN ('success', 'ok')) AS last_line_backfill_at,
      (SELECT max(completed_at) FROM ops.sync_log WHERE source = 'qbo' AND sync_type = 'mv_refresh' AND status IN ('success', 'ok')) AS last_mv_refresh_at
  ),
  sync_errors AS (
    SELECT
      count(*)::bigint AS line_count,
      ARRAY(
        SELECT left(sync_type || ': ' || coalesce(error_message, 'error'), 120)
        FROM ops.sync_log
        WHERE source IN ('qbo', 'pg_net')
          AND status = 'error'
          AND coalesce(started_at, completed_at, now()) >= now() - interval '2 hours'
        ORDER BY coalesce(completed_at, started_at) DESC NULLS LAST
        LIMIT 5
      ) AS samples
    FROM ops.sync_log
    WHERE source IN ('qbo', 'pg_net')
      AND status = 'error'
      AND coalesce(started_at, completed_at, now()) >= now() - interval '2 hours'
  ),
  missing_cost AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, account_name, category, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE est_cost IS NULL
            AND abs(COALESCE(revenue, 0)) > 0
            AND COALESCE(cost_source, 'none') <> 'discount'
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE est_cost IS NULL
      AND abs(COALESCE(revenue, 0)) > 0
      AND COALESCE(cost_source, 'none') <> 'discount'
  ),
  unspecified_category AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, account_name, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE NULLIF(trim(COALESCE(category, '')), '') IS NULL
             OR lower(category) IN ('(unspecified)', 'unspecified')
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE NULLIF(trim(COALESCE(category, '')), '') IS NULL
       OR lower(category) IN ('(unspecified)', 'unspecified')
  ),
  melt_unclassified AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, category, account_name, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE lower(
            COALESCE(item_name, '') || ' ' ||
            COALESCE(category, '') || ' ' ||
            COALESCE(account_name, '') || ' ' ||
            COALESCE(description, '')
          ) LIKE '%melt%'
            AND (
              NULLIF(trim(COALESCE(category, '')), '') IS NULL
              OR lower(category) IN ('(unspecified)', 'unspecified')
              OR NULLIF(trim(COALESCE(segment, '')), '') IS NULL
              OR NULLIF(trim(COALESCE(product_family, '')), '') IS NULL
              OR NULLIF(trim(COALESCE(product_type, '')), '') IS NULL
            )
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE lower(
      COALESCE(item_name, '') || ' ' ||
      COALESCE(category, '') || ' ' ||
      COALESCE(account_name, '') || ' ' ||
      COALESCE(description, '')
    ) LIKE '%melt%'
      AND (
        NULLIF(trim(COALESCE(category, '')), '') IS NULL
        OR lower(category) IN ('(unspecified)', 'unspecified')
        OR NULLIF(trim(COALESCE(segment, '')), '') IS NULL
        OR NULLIF(trim(COALESCE(product_family, '')), '') IS NULL
        OR NULLIF(trim(COALESCE(product_type, '')), '') IS NULL
      )
  ),
  negative_margin AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, category, account_name, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE revenue > 0
            AND est_margin < 0
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE revenue > 0
      AND est_margin < 0
  ),
  issues AS (
    SELECT
      'sync_recent_errors'::text AS issue_key,
      'critical'::text AS severity,
      'Recent sync errors'::text AS title,
      line_count::text || ' QBO/cron error(s) in the last 2 hours'::text AS detail,
      line_count,
      NULL::numeric AS revenue,
      samples AS sample_labels,
      'Check sync log and pg_net failures before trusting fresh Margin data.'::text AS action
    FROM sync_errors
    WHERE line_count > 0

    UNION ALL
    SELECT 'sync_invoice_stale',
      CASE WHEN last_invoice_sync_at IS NULL OR last_invoice_sync_at < now() - interval '36 hours' THEN 'critical' ELSE 'warn' END,
      'Invoice sync stale',
      'Last successful invoice sync: ' || COALESCE(to_char(last_invoice_sync_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['QBO invoices']::text[],
      'Run or inspect nightly-qbo-sync.'
    FROM sync_times
    WHERE last_invoice_sync_at IS NULL OR last_invoice_sync_at < now() - interval '30 hours'

    UNION ALL
    SELECT 'sync_line_cron_stale',
      CASE WHEN last_line_cron_at IS NULL OR last_line_cron_at < now() - interval '2 hours' THEN 'critical' ELSE 'warn' END,
      'Line backfill cron stale',
      'Last successful backfill-invoice-lines run: ' || COALESCE(to_char(last_line_cron_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['backfill-invoice-lines']::text[],
      'Inspect backfill-invoice-lines and pg-net-failure-scanner for stuck cron calls.'
    FROM sync_times
    WHERE last_line_cron_at IS NULL OR last_line_cron_at < now() - interval '30 minutes'

    UNION ALL
    SELECT 'sync_margin_view_stale',
      CASE WHEN last_mv_refresh_at IS NULL OR last_mv_refresh_at < now() - interval '36 hours' THEN 'critical' ELSE 'warn' END,
      'Margin view stale',
      'Last materialized-view refresh: ' || COALESCE(to_char(last_mv_refresh_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['mv_sales_lines']::text[],
      'Refresh ops.mv_sales_lines after invoice-line sync.'
    FROM sync_times
    WHERE last_mv_refresh_at IS NULL OR last_mv_refresh_at < now() - interval '30 hours'

    UNION ALL
    SELECT 'item_cache_stale',
      CASE WHEN item_cache_at IS NULL OR item_cache_at < now() - interval '36 hours' THEN 'critical' ELSE 'warn' END,
      'Item-cost cache stale',
      'Last item master sync: ' || COALESCE(to_char(item_cache_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['QBO items']::text[],
      'Run Sync item costs before reading margin.'
    FROM sync_times
    WHERE item_cache_at IS NULL OR item_cache_at < now() - interval '30 hours'

    UNION ALL
    SELECT 'expense_cost_cache_stale',
      CASE WHEN expense_line_cache_at IS NULL OR expense_line_cache_at < now() - interval '36 hours' THEN 'critical' ELSE 'warn' END,
      'Actual-cost cache stale',
      'Newest cached purchase/expense cost timestamp: ' || COALESCE(to_char(expense_line_cache_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['QBO expense lines']::text[],
      'Inspect the QBO expense sync before trusting actual-cost-based margin.'
    FROM sync_times
    WHERE expense_line_cache_at IS NULL OR expense_line_cache_at < now() - interval '30 hours'

    UNION ALL
    SELECT 'missing_cost',
      CASE WHEN total.abs_revenue > 0 AND missing_cost.revenue / total.abs_revenue >= 0.10 THEN 'critical' ELSE 'warn' END,
      'Missing item cost',
      'Revenue without usable item cost: $' || to_char(missing_cost.revenue, 'FM999,999,999,990') ||
        CASE WHEN total.abs_revenue > 0 THEN ' (' || round((missing_cost.revenue / total.abs_revenue) * 100, 1)::text || '%)' ELSE '' END,
      missing_cost.line_count,
      missing_cost.revenue,
      missing_cost.samples,
      'Update QBO purchase cost or actual purchase history for these items.'
    FROM missing_cost CROSS JOIN total
    WHERE missing_cost.line_count > 0

    UNION ALL
    SELECT 'unspecified_category',
      'warn',
      'Unspecified revenue category',
      'Sales lines are missing a revenue category/account mapping.',
      unspecified_category.line_count,
      unspecified_category.revenue,
      unspecified_category.samples,
      'Map the source QBO item/account so this revenue leaves (unspecified).'
    FROM unspecified_category
    WHERE unspecified_category.line_count > 0

    UNION ALL
    SELECT 'melt_unclassified',
      'critical',
      'Melt classification incomplete',
      'Melt-related revenue is still missing category, segment, family, or type.',
      melt_unclassified.line_count,
      melt_unclassified.revenue,
      melt_unclassified.samples,
      'Finish Melt item/category mappings so Margin does not group it as unspecified.'
    FROM melt_unclassified
    WHERE melt_unclassified.line_count > 0

    UNION ALL
    SELECT 'negative_margin',
      'warn',
      'Negative margin lines',
      'Positive-revenue lines are showing negative estimated margin.',
      negative_margin.line_count,
      negative_margin.revenue,
      negative_margin.samples,
      'Review price, quantity, and item cost for the sample lines.'
    FROM negative_margin
    WHERE negative_margin.line_count > 0
  )
  SELECT issue_key, severity, title, detail, line_count, revenue, sample_labels, action
  FROM issues
  ORDER BY
    CASE severity WHEN 'critical' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
    COALESCE(revenue, 0) DESC,
    line_count DESC,
    title;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_margin_data_health(
  date, date, text[], text[], text[], text[], text[], text[], text[], text[],
  text[], text[], text[]
) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
