-- Cron schedule for sync-fleetcomplete edge function.
--
-- DISABLED by default (commented out below). Before enabling:
--   1. Set FC_USERNAME + FC_PASSWORD secrets on the Supabase project.
--   2. Deploy the edge function: `supabase functions deploy sync-fleetcomplete`.
--   3. Verify with a manual call:
--        curl '<project>/functions/v1/sync-fleetcomplete?mode=vehicles' \
--          -H 'apikey: <anon>' -H 'Authorization: Bearer <anon>'
--   4. Uncomment the cron.schedule call below and re-apply this migration.
--
-- Cadence rationale: hourly runs at :05 (no clash with the QBO syncs
-- 09:00-09:50 or kpi_daily 11:00). Vehicles + trips don't change often;
-- hourly is generous. Tighten to every 30 min later if needed.

-- Uncomment to enable:
--
-- SELECT cron.schedule('hourly-sync-fleetcomplete', '5 * * * *', $$
--   SELECT net.http_post(
--     url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-fleetcomplete',
--     body := '{}'::jsonb,
--     timeout_milliseconds := 120000
--   );
-- $$);

-- This migration intentionally has no DDL effect when applied with the
-- cron commented out — it exists so the cron schedule lives in a
-- migration file (auditable + replayable) rather than as an out-of-band
-- pg_cron registration. To enable: uncomment, apply via MCP / CLI /
-- Studio.
SELECT 1 AS sync_fleetcomplete_cron_disabled;
