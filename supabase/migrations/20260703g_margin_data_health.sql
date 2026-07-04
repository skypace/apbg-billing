-- Margin Data Health: compact diagnostics for stale syncs, unmapped revenue,
-- and missing-cost coverage in the current Margin view.

-- Keep receipt/blob sync progress visible. sf-receipt-sync reads its own last
-- successful cursor from ops.sync_log, so rejecting this source makes the job
-- look stateless and much harder to diagnose.
--
-- NOT VALID keeps historical sync_log rows from blocking deployment while this
-- check still protects new writes going forward.
ALTER TABLE ops.sync_log DROP CONSTRAINT IF EXISTS sync_log_source_check;
ALTER TABLE ops.sync_log ADD CONSTRAINT sync_log_source_check
  CHECK (
    source IS NULL OR source = ANY (ARRAY[
      'qbo'::text, 'sf'::text, 'sf-receipt-sync'::text, 'fleet'::text,
      'sf-expense-sweep'::text, 'zoho_crm'::text, 'bambee'::text,
      'fleetcomplete'::text, 'pg_net'::text
    ])
  ) NOT VALID;

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
LANGUAGE sql
STABLE
SECURITY DEFINER
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
      max(coalesce(completed_at, started_at)) AS last_seen_at,
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
  unspecified_item AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(account_name, category, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE NULLIF(trim(COALESCE(item_name, '')), '') IS NULL
             OR lower(item_name) IN ('(unspecified)', 'unspecified')
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE NULLIF(trim(COALESCE(item_name, '')), '') IS NULL
       OR lower(item_name) IN ('(unspecified)', 'unspecified')
  ),
  unspecified_account AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, category, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE NULLIF(trim(COALESCE(account_name, '')), '') IS NULL
             OR lower(account_name) IN ('(unspecified)', 'unspecified')
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE NULLIF(trim(COALESCE(account_name, '')), '') IS NULL
       OR lower(account_name) IN ('(unspecified)', 'unspecified')
  ),
  unspecified_segment AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, category, account_name, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE NULLIF(trim(COALESCE(segment, '')), '') IS NULL
             OR lower(segment) IN ('(unspecified)', 'unspecified')
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE NULLIF(trim(COALESCE(segment, '')), '') IS NULL
       OR lower(segment) IN ('(unspecified)', 'unspecified')
  ),
  unspecified_family AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, category, account_name, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE NULLIF(trim(COALESCE(product_family, '')), '') IS NULL
             OR lower(product_family) IN ('(unspecified)', 'unspecified')
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE NULLIF(trim(COALESCE(product_family, '')), '') IS NULL
       OR lower(product_family) IN ('(unspecified)', 'unspecified')
  ),
  unspecified_type AS (
    SELECT
      count(*)::bigint AS line_count,
      COALESCE(sum(abs(revenue)), 0)::numeric AS revenue,
      ARRAY(
        SELECT label
        FROM (
          SELECT COALESCE(item_name, category, account_name, doc_number, line_id::text) AS label,
                 sum(abs(revenue)) AS rev
          FROM base
          WHERE NULLIF(trim(COALESCE(product_type, '')), '') IS NULL
             OR lower(product_type) IN ('(unspecified)', 'unspecified')
          GROUP BY 1
          ORDER BY rev DESC NULLS LAST
          LIMIT 5
        ) s
      ) AS samples
    FROM base
    WHERE NULLIF(trim(COALESCE(product_type, '')), '') IS NULL
       OR lower(product_type) IN ('(unspecified)', 'unspecified')
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
    SELECT 'invoice_cache_stale',
      CASE WHEN invoice_cache_at IS NULL OR invoice_cache_at < now() - interval '36 hours' THEN 'critical' ELSE 'warn' END,
      'QBO invoice cache stale',
      'Newest cached invoice sync timestamp: ' || COALESCE(to_char(invoice_cache_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['QBO invoices']::text[],
      'Run or inspect nightly-qbo-sync; Margin may be reading old invoices.'
    FROM sync_times
    WHERE invoice_cache_at IS NULL OR invoice_cache_at < now() - interval '30 hours'

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
    SELECT 'sync_lines_stale',
      CASE WHEN last_line_backfill_at IS NULL OR last_line_backfill_at < now() - interval '4 hours' THEN 'critical' ELSE 'warn' END,
      'Invoice-line data stale',
      'Last successful invoice-line refresh: ' || COALESCE(to_char(last_line_backfill_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['QBO invoice lines']::text[],
      'Run or inspect sync-qbo; invoice headers without line detail make Margin incomplete.'
    FROM sync_times
    WHERE last_line_backfill_at IS NULL OR last_line_backfill_at < now() - interval '2 hours'

    UNION ALL
    SELECT 'sync_line_cron_stale',
      CASE WHEN last_line_cron_at IS NULL OR last_line_cron_at < now() - interval '2 hours' THEN 'critical' ELSE 'warn' END,
      'Line backfill cron stale',
      'Last successful backfill-invoice-lines run: ' || COALESCE(to_char(last_line_cron_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
      0::bigint, NULL::numeric, ARRAY['backfill-invoice-lines']::text[],
      'Inspect backfill-invoice-lines and pg-net-failure-scanner for stuck or rejected cron calls.'
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
    SELECT 'unspecified_item',
      'warn',
      'Unspecified item',
      'Sales lines have no item name or QBO item reference.',
      unspecified_item.line_count,
      unspecified_item.revenue,
      unspecified_item.samples,
      'Inspect invoice lines and QBO item sync for missing item refs.'
    FROM unspecified_item
    WHERE unspecified_item.line_count > 0

    UNION ALL
    SELECT 'unspecified_account',
      'warn',
      'Unspecified account',
      'Sales lines have no income account mapping.',
      unspecified_account.line_count,
      unspecified_account.revenue,
      unspecified_account.samples,
      'Map income accounts in QBO item master or revenue-line map.'
    FROM unspecified_account
    WHERE unspecified_account.line_count > 0

    UNION ALL
    SELECT 'unspecified_segment',
      'warn',
      'Unspecified segment',
      'Sales lines are not assigned to a segment.',
      unspecified_segment.line_count,
      unspecified_segment.revenue,
      unspecified_segment.samples,
      'Map item or category to a segment in taxonomy settings.'
    FROM unspecified_segment
    WHERE unspecified_segment.line_count > 0

    UNION ALL
    SELECT 'unspecified_family',
      'warn',
      'Unspecified product family',
      'Sales lines are not assigned to a product family.',
      unspecified_family.line_count,
      unspecified_family.revenue,
      unspecified_family.samples,
      'Map these items to a product family.'
    FROM unspecified_family
    WHERE unspecified_family.line_count > 0

    UNION ALL
    SELECT 'unspecified_type',
      'warn',
      'Unspecified product type',
      'Sales lines are not assigned to a product type.',
      unspecified_type.line_count,
      unspecified_type.revenue,
      unspecified_type.samples,
      'Map these items to a product type.'
    FROM unspecified_type
    WHERE unspecified_type.line_count > 0

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
