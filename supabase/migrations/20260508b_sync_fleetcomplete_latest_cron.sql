-- Cron: refresh ops.fleet_latest_snapshots every 5 minutes.
-- Powers the Fleet live-map page. Cheap (one getLatestSnapshots call,
-- ~9 vehicle UUIDs in, ~2KB JSON out, single upsert).
--
-- The hourly sync-fleetcomplete cron in 20260506h_*.sql handles the slower
-- vehicle-roster refresh; this cron handles the fast-changing live state.

SELECT cron.schedule(
  'fleetcomplete-latest-snapshots',
  '*/5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-fleetcomplete?mode=latest',
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);
