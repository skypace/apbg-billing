-- Two new crons for sync-fleetcomplete:
--   * fleetcomplete-roster (hourly :05) — vehicles + people + geofences
--   * fleetcomplete-trips  (daily 09:00 UTC = 02:00 PT) — trip reconstruction
--                           + driverBehaviour event extraction over the last 26 h
--
-- The existing fleetcomplete-latest-snapshots cron (every 5 min) stays as-is
-- for live-map state. The disabled hourly cron in 20260506h_sync_fleetcomplete_cron.sql
-- is now superseded by fleetcomplete-roster — this migration takes over the
-- vehicle-list-refresh cadence.

SELECT cron.schedule(
  'fleetcomplete-roster',
  '5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-fleetcomplete?mode=vehicles',
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
    SELECT net.http_post(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-fleetcomplete?mode=people',
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
    SELECT net.http_post(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-fleetcomplete?mode=geofences',
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

SELECT cron.schedule(
  'fleetcomplete-trips',
  '0 9 * * *',
  $$
    SELECT net.http_post(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-fleetcomplete?mode=trips',
      body := '{}'::jsonb,
      timeout_milliseconds := 600000
    );
  $$
);
