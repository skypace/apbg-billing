-- Daily 13:00 UTC (≈ 06:00 PT during PDT, 05:00 during PST) cron for the
-- fleet-morning-digest edge function. Sends Sky a daily email with
-- yesterday's ghost stops + over-billed jobs + driver hot list.
--
-- Pre-req: RESEND_API_KEY secret on the Supabase project (already used by
-- the existing digest-email function, so it's likely already set).
-- Optional: FLEET_DIGEST_RECIPIENTS comma-separated list (defaults to
-- skypace@brixbev.com).

SELECT cron.schedule(
  'fleet-morning-digest',
  '0 13 * * *',
  $$
    SELECT net.http_post(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/fleet-morning-digest',
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);
