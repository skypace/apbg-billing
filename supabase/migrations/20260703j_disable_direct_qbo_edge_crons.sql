-- Disable direct pg_cron -> Supabase Edge QBO sync callers.
--
-- These jobs require an Authorization bearer header when the Edge Function has
-- JWT verification enabled. Keeping that bearer in SQL caused two bad choices:
-- broken 401/timeout cron calls, or hardcoded credentials in migrations.
--
-- QBO invoice, line-backfill, MV refresh, and item-cost syncs are now driven
-- by netlify/functions/qbo-sync-runner.mjs, where Supabase credentials come
-- from Netlify runtime environment variables instead of SQL text.

DO $$
DECLARE
  v_job text;
BEGIN
  FOREACH v_job IN ARRAY ARRAY[
    'nightly-qbo-sync',
    'backfill-invoice-lines',
    'refresh-lines-rolling',
    'nightly-sync-qbo-items'
  ]
  LOOP
    BEGIN
      PERFORM cron.unschedule(v_job);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;
