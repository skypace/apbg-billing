-- Margin health cron hotfix.
--
-- The Margin health panel surfaced three separate conditions as one critical
-- pile-up:
--   1. sync-qbo v45 calls ops.refresh_sales_lines(), but the SQL helper was
--      not created, so mv_sales_lines refreshes could fail forever.
--   2. pg_net Service Fusion token failures were being counted by Margin as
--      QBO/cron failures.
--   3. The Margin health RPC counted generic pg_net errors even when they had
--      no QBO/QuickBooks signal.

CREATE OR REPLACE FUNCTION ops.refresh_sales_lines()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ops.refresh_sales_lines'));
  REFRESH MATERIALIZED VIEW CONCURRENTLY ops.mv_sales_lines;
  RETURN jsonb_build_object(
    'ok', true,
    'relation', 'ops.mv_sales_lines',
    'started_at', v_started_at,
    'completed_at', clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION ops.refresh_sales_lines() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.refresh_sales_lines() TO service_role;

DO $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
BEGIN
  PERFORM ops.refresh_sales_lines();

  INSERT INTO ops.sync_log (
    source, sync_type, status, records_synced,
    started_at, completed_at, metadata
  ) VALUES (
    'qbo', 'mv_refresh', 'success', 0,
    v_started_at, clock_timestamp(),
    jsonb_build_object('relation', 'ops.mv_sales_lines', 'trigger', '20260703i_margin_health_cron_hotfix')
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO ops.sync_log (
    source, sync_type, status, records_synced,
    error_message, started_at, completed_at, metadata
  ) VALUES (
    'qbo', 'mv_refresh', 'error', 0,
    SQLERRM, v_started_at, clock_timestamp(),
    jsonb_build_object('relation', 'ops.mv_sales_lines', 'trigger', '20260703i_margin_health_cron_hotfix')
  );
  RAISE;
END $$;

-- Reclassify recent Service Fusion pg_net rows so Margin does not report them
-- as QBO sync errors. The SF health surface can still report them separately.
UPDATE ops.sync_log
SET
  source = 'sf',
  sync_type = CASE WHEN sync_type = 'http_failure' THEN 'sf_http_failure' ELSE sync_type END
WHERE source = 'pg_net'
  AND status = 'error'
  AND coalesce(started_at, completed_at, now()) >= now() - interval '7 days'
  AND (
    error_message ILIKE '%SF:%'
    OR error_message ILIKE '%Service Fusion%'
    OR error_message ILIKE '%sync-sf%'
  );

CREATE OR REPLACE FUNCTION ops.fn_scan_pg_net_failures(p_lookback_minutes int DEFAULT 15)
RETURNS TABLE(logged_count int, scanned_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, ops, net
AS $$
DECLARE
  v_logged int := 0;
  v_scanned int := 0;
  r RECORD;
  v_source text;
  v_sync_type text;
  v_func_name text;
  v_body text;
BEGIN
  FOR r IN
    SELECT
      resp.id, resp.status_code, resp.timed_out, resp.error_msg,
      LEFT(resp.content, 500) AS body_preview, resp.created,
      q.url
    FROM net._http_response resp
    LEFT JOIN net.http_request_queue q ON q.id = resp.id
    WHERE resp.created > NOW() - (p_lookback_minutes || ' minutes')::interval
      AND (resp.status_code IS NULL OR resp.status_code < 200 OR resp.status_code >= 300 OR resp.timed_out)
  LOOP
    v_scanned := v_scanned + 1;
    v_func_name := substring(r.url FROM 'functions/v1/([^?/]+)');
    v_body := COALESCE(r.error_msg, '') || ' ' || COALESCE(r.body_preview, '');

    -- Map function name/body hints to the owning sync area. pg_net can lose
    -- request URL context, so inspect the error body before falling back to a
    -- generic pg_net/http_failure row.
    IF v_func_name IS NULL AND (v_body ILIKE '%SF:%' OR v_body ILIKE '%Service Fusion%') THEN
      v_source := 'sf';
      v_sync_type := 'sf_http_failure';
    ELSIF v_func_name IS NULL AND (v_body ILIKE '%QBO%' OR v_body ILIKE '%QuickBooks%') THEN
      v_source := 'qbo';
      v_sync_type := 'qbo_http_failure';
    ELSIF v_func_name IS NULL THEN
      v_source := 'pg_net';
      v_sync_type := 'http_failure';
    ELSIF v_func_name LIKE 'sync-qbo%' OR v_func_name LIKE 'push-qbo%' OR v_func_name = 'qbo' THEN
      v_source := 'qbo';
      v_sync_type := v_func_name;
    ELSIF v_func_name LIKE 'sync-fleetcomplete%' THEN
      v_source := 'fleetcomplete';
      v_sync_type := v_func_name;
    ELSIF v_func_name LIKE 'sync-sf%' THEN
      v_source := 'sf';
      v_sync_type := v_func_name;
    ELSE
      v_source := 'pg_net';
      v_sync_type := v_func_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM ops.sync_log
      WHERE source IN ('qbo','sf','fleetcomplete','pg_net')
        AND metadata->>'pg_net_response_id' = r.id::text
    ) THEN
      INSERT INTO ops.sync_log (
        source, sync_type, started_at, completed_at, status,
        records_synced, error_message, metadata
      ) VALUES (
        v_source, v_sync_type,
        r.created, r.created,
        'error', 0,
        LEFT(
          COALESCE(
            r.error_msg,
            'HTTP ' || COALESCE(r.status_code::text, 'null') ||
            CASE WHEN r.body_preview IS NOT NULL THEN ': ' || r.body_preview ELSE '' END
          ),
          1000
        ),
        jsonb_build_object(
          'pg_net_response_id', r.id,
          'status_code', r.status_code,
          'timed_out', r.timed_out,
          'url', r.url
        )
      );
      v_logged := v_logged + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_logged, v_scanned;
END;
$$;

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
  qbo_sync_error_rows AS (
    SELECT *
    FROM ops.sync_log
    WHERE status = 'error'
      AND coalesce(started_at, completed_at, now()) >= now() - interval '2 hours'
      AND (
        source = 'qbo'
        OR (
          source = 'pg_net'
          AND (
            sync_type LIKE 'sync-qbo%'
            OR sync_type LIKE 'push-qbo%'
            OR lower(coalesce(metadata->>'url', '')) LIKE '%/sync-qbo%'
            OR lower(coalesce(metadata->>'url', '')) LIKE '%/push-qbo%'
            OR lower(coalesce(error_message, '')) LIKE '%qbo%'
            OR lower(coalesce(error_message, '')) LIKE '%quickbooks%'
          )
        )
      )
  ),
  sync_errors AS (
    SELECT
      count(*)::bigint AS line_count,
      ARRAY(
        SELECT left(coalesce(sync_type, 'sync') || ': ' || coalesce(error_message, 'error'), 120)
        FROM qbo_sync_error_rows
        ORDER BY coalesce(completed_at, started_at) DESC NULLS LAST
        LIMIT 5
      ) AS samples
    FROM qbo_sync_error_rows
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
      'Recent QBO sync errors'::text AS title,
      line_count::text || ' QBO sync error(s) in the last 2 hours'::text AS detail,
      line_count,
      NULL::numeric AS revenue,
      samples AS sample_labels,
      'Check sync-qbo, QBO token refresh, and pg_net failures before trusting fresh Margin data.'::text AS action
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
