-- v0.9.28 — Nightly QBO push-back cron.
--
-- Three jobs scheduled after the nightly sync-qbo-items (9:30 UTC) so that
-- our local overrides flow back to QuickBooks once QBO's own catalog is
-- refreshed. All push-* edge functions are verify_jwt=false because QBO
-- auth is gated by SUPABASE_SERVICE_ROLE_KEY + QBO_REALM_ID env vars.
--
-- Re-running these cron.schedule() calls is idempotent — they replace the
-- existing schedule for the named job.

SELECT cron.schedule(
  'nightly-push-qbo-categories',
  '0 10 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/push-qbo-item',
    body := '{"action":"bulkSyncCategories","commit":true}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

SELECT cron.schedule(
  'nightly-push-qbo-customer-types',
  '15 10 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/push-qbo-customer-types',
    body := '{"commit":true}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

SELECT cron.schedule(
  'nightly-push-qbo-sales-rep',
  '30 10 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/push-qbo-sales-rep',
    body := '{"commit":true}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
