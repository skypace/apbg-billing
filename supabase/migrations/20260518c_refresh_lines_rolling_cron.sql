-- Self-healing rolling line refresh.
--
-- The nightly-qbo-sync (jobid 2) uses mode=fast which skips line fetching.
-- The 3-min lines_backfill cron (jobid 3) only fetches lines for invoices
-- with ZERO lines, so it never catches STALE lines (e.g. an invoice that
-- was edited in QBO after we cached it).
--
-- This cron fills that gap. Every 10 min it calls sync-qbo?mode=refresh-lines
-- for the last 90 days, processing 100 invoices per run via UPSERT (added
-- in 20260518b). The offset wraps around when it hits the end of the window.
-- Over ~6 hours we sweep the entire 90-day population. Any line edited in
-- QBO is caught within that window without needing a manual backfill.
--
-- A monotonically-increasing sequence drives the offset so we don't need a
-- state table; modulo against the current 90-day row count wraps cleanly.

CREATE SEQUENCE IF NOT EXISTS ops.refresh_lines_offset_seq;

SELECT cron.schedule(
  'refresh-lines-rolling',
  '*/10 * * * *',
  $cron$
  WITH adv AS (
    SELECT nextval('ops.refresh_lines_offset_seq') AS n,
           GREATEST(
             (SELECT COUNT(*) FROM ops.qbo_invoices WHERE txn_date >= current_date - 90),
             1
           ) AS total
  ),
  off_calc AS (
    SELECT ((adv.n - 1) * 100) % adv.total AS offset_value FROM adv
  )
  SELECT net.http_get(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo'
        || '?mode=refresh-lines'
        || '&start=' || (current_date - 90)::text
        || '&end='   || current_date::text
        || '&batch=100'
        || '&offset=' || offset_value::text,
    timeout_milliseconds := 140000
  ) FROM off_calc;
  $cron$
);
