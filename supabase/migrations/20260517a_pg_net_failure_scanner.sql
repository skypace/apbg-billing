-- pg_net failure scanner — catches silent cron→HTTP failures across the system.
--
-- The 2026-05-06 → 2026-05-17 sync-qbo-expenses outage was invisible because:
--   1. pg_cron logged "succeeded" the moment net.http_post enqueued the request
--   2. The actual response (HTTP 500 "table not found") landed in net._http_response
--   3. Nothing read net._http_response, so the error never reached any log/alert
--
-- This function scans net._http_response for non-2xx responses (and timeouts)
-- in a recent window and inserts a row into ops.sync_log per failure. The
-- existing checkOpsSyncFreshness + checkPgNetFailures in
-- netlify/functions/health-watchdog.mjs pick it up and page.

-- Widen the source CHECK to allow 'pg_net' as a synthetic source for the scanner.
ALTER TABLE ops.sync_log DROP CONSTRAINT sync_log_source_check;
ALTER TABLE ops.sync_log ADD CONSTRAINT sync_log_source_check
  CHECK (source = ANY (ARRAY[
    'qbo'::text, 'sf'::text, 'fleet'::text, 'zoho_crm'::text,
    'bambee'::text, 'fleetcomplete'::text, 'pg_net'::text
  ]));

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

    -- Map function name → (source, sync_type). Unknown URL → pg_net/http_failure.
    IF v_func_name IS NULL THEN
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
        AND (metadata->>'pg_net_response_id')::bigint = r.id
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

SELECT cron.schedule(
  'pg-net-failure-scanner',
  '*/5 * * * *',
  $cron$ SELECT ops.fn_scan_pg_net_failures(15); $cron$
);
