-- Fix the invoice-line sync regression (recent invoices had headers but no
-- lines from ~Apr 2026 onward).
--
-- Three things were wrong, all of which conspired to starve recent invoices of
-- their qbo_invoice_lines detail:
--
--   1. The nightly QBO sync (cron jobid 2, `nightly-qbo-sync`) runs
--      `?mode=fast`, which the edge function treated as skip_lines=true, so it
--      only upserted headers. Lines for the rolling window were expected to be
--      filled by the two crons below. (Fixed in the edge function: `mode=fast`
--      no longer force-skips lines; sync-qbo v44.)
--
--   2. The `refresh-lines-rolling` cron (jobid 35, migration 20260518c) called
--      sync-qbo with `net.http_get` and NO Authorization header. The Supabase
--      Functions gateway rejected every call with 401, so the rolling line
--      refresh never ran. This migration re-schedules it WITH the anon Bearer
--      token (matching jobid 2 / jobid 3).
--
--   3. The `backfill-invoice-lines` cron (jobid 3) drives its offset off the
--      most recent sync_log row and only ever increments. It has marched past
--      the end of qbo_invoices (offset 556000+ vs ~13.9k rows) and now does
--      nothing. We reset it to wrap modulo the live row count so it keeps
--      sweeping for any zero-line invoices instead of running off the end.
--
-- No data is mutated here — only cron definitions are corrected. Re-running is
-- safe (cron.schedule upserts by jobname).

DO $$
DECLARE
  anon_key text :=
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
BEGIN

  -- (2) Re-schedule refresh-lines-rolling WITH the Authorization header.
  PERFORM cron.schedule(
    'refresh-lines-rolling',
    '*/10 * * * *',
    format($cron$
      WITH adv AS (
        SELECT nextval('ops.refresh_lines_offset_seq') AS n,
               GREATEST(
                 (SELECT COUNT(*) FROM ops.qbo_invoices WHERE txn_date >= current_date - 90),
                 1
               ) AS total
      ),
      off_calc AS (
        SELECT ((adv.n - 1) * 100) %% adv.total AS offset_value FROM adv
      )
      SELECT net.http_get(
        url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo'
            || '?mode=refresh-lines'
            || '&start=' || (current_date - 90)::text
            || '&end='   || current_date::text
            || '&batch=100'
            || '&offset=' || offset_value::text,
        headers := jsonb_build_object('Authorization', 'Bearer %s'),
        timeout_milliseconds := 140000
      ) FROM off_calc;
    $cron$, anon_key)
  );

  -- (3) Reset backfill-invoice-lines so its offset wraps modulo the live row
  -- count (it had run off the end of the table). Keep the anon Bearer it
  -- already had.
  PERFORM cron.schedule(
    'backfill-invoice-lines',
    '*/3 * * * *',
    format($cron$
      SELECT net.http_get(
        url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo?mode=lines&batch=50&offset=' ||
          (
            COALESCE(
              (SELECT (metadata->>'offset')::int + (metadata->>'batch')::int
               FROM ops.sync_log
               WHERE sync_type = 'lines_backfill' AND status = 'success'
               ORDER BY completed_at DESC LIMIT 1),
              0
            ) %% GREATEST((SELECT COUNT(*) FROM ops.qbo_invoices), 1)
          )::text,
        headers := jsonb_build_object('Authorization', 'Bearer %s'),
        timeout_milliseconds := 120000
      );
    $cron$, anon_key)
  );

END $$;
