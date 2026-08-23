-- Nightly cron: geocode the next chunk of qbo_customers in the cohort.
-- Runs at 10:30 UTC = 03:30 PT — after sync-qbo-customers (09:35 UTC) so
-- new customers and address changes from QBO are visible.
--
-- max=80 keeps each invocation under Supabase's 150 s idle timeout
-- (Nominatim takes ~1.6 s per row including the polite 1.1 s spacing). For
-- the initial backfill, ~440 customers takes ~6 nightly runs to fully
-- populate. After that, the daily churn (a few new billing customers, the
-- occasional address change) fits in one run.

SELECT cron.schedule(
  'geocode-customers-nightly',
  '30 10 * * *',
  $$
    SELECT net.http_post(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/geocode-customers?max=80',
      body := '{}'::jsonb,
      timeout_milliseconds := 200000
    );
  $$
);
