-- Nightly cron schedule for the four QBO refresh syncs we built into
-- the dashboard. Spaced 5-10 min apart starting at 09:30 UTC (~2:30 AM
-- Pacific) so they don't all hit QBO API simultaneously and they run
-- AFTER the existing nightly-qbo-sync (which fires at 09:00 UTC).
-- Applied to live DB on 2026-05-03.

SELECT cron.schedule('nightly-sync-qbo-items', '30 9 * * *', $$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo-items',
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

SELECT cron.schedule('nightly-sync-qbo-customers', '35 9 * * *', $$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo-customers',
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

SELECT cron.schedule('nightly-sync-qbo-expenses', '40 9 * * *', $$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo-expenses',
    body := '{"since":"2025-01-01"}'::jsonb,
    timeout_milliseconds := 300000
  );
$$);

SELECT cron.schedule('nightly-sync-qbo-inv-adj', '50 9 * * *', $$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo-inventory-adjustments',
    body := '{"since":"2024-01-01"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
