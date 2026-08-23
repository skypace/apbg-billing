-- Extend ops.fc_token_cache for the Unity (FleetComplete) OAuth-style auth flow:
-- access_token (5 min) + refresh_token (12 hr), both rotated by /login/token
-- and /login/refresh. Plus pre-seed the singleton row with the known
-- base URL and Sky's identifiers (recovered from /login/userinfo on
-- 2026-05-06).
--
-- account_id holds the user UUID (used as the `userId` header on
-- /graphql calls). fleet_id holds the fleet UUID (also acceptable as
-- a header per Powerfleet docs; we use account_id by default).
--
-- The actual username/password for /login/token are NOT stored in the
-- DB — they live in Supabase secrets as FC_USERNAME / FC_PASSWORD env
-- vars and are read by the edge function only.

ALTER TABLE ops.fc_token_cache
  ADD COLUMN IF NOT EXISTS refresh_token text,
  ADD COLUMN IF NOT EXISTS access_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS refresh_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS fleet_id text;

COMMENT ON COLUMN ops.fc_token_cache.api_token IS
  'Unity access_token returned by POST /login/token. Valid for 5 minutes.';
COMMENT ON COLUMN ops.fc_token_cache.refresh_token IS
  'Unity refresh_token returned by POST /login/token. Valid for 12 hours.';
COMMENT ON COLUMN ops.fc_token_cache.account_id IS
  'Unity user UUID from /login/userinfo. Sent as userId header on /graphql calls.';
COMMENT ON COLUMN ops.fc_token_cache.fleet_id IS
  'Unity fleet UUID from /login/userinfo. Acceptable alternative to userId on /graphql calls.';
COMMENT ON COLUMN ops.fc_token_cache.base_url IS
  'API base URL. https://api.fleetcomplete.com/ for the Unity API.';

-- Seed the singleton row.
INSERT INTO ops.fc_token_cache (id, base_url, account_id, fleet_id, updated_at)
VALUES (
  1,
  'https://api.fleetcomplete.com/',
  '82273656-cd69-4044-a431-36288e840181',
  '54bbc497-74a7-4403-9d56-fbcb5823bcca',
  now()
)
ON CONFLICT (id) DO UPDATE SET
  base_url   = EXCLUDED.base_url,
  account_id = COALESCE(ops.fc_token_cache.account_id, EXCLUDED.account_id),
  fleet_id   = COALESCE(ops.fc_token_cache.fleet_id,   EXCLUDED.fleet_id),
  updated_at = now();
