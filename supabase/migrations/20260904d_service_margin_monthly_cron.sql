-- The 3rd-party service margin report, mailed monthly.
--
-- Every ResQ dispatch account (THE MELT RESQ, STARBIRD CHICKEN RESQ, and any
-- future one — apbg-billing's netlify/functions/lib/service-margin.mjs finds
-- them by NAME so a new chain needs no deploy): what we billed the chain last
-- month, what the subcontractors charged us for the same jobs, and the
-- exceptions worth acting on — duplicate vendor bills, jobs billed below cost,
-- vendor cost sitting on jobs with no invoice, bills still in draft.
--
-- ⚠ THE 3rd, NOT THE 1st. Vendor bills for the last week of a month land in
-- the first days of the next one, so a report run at midnight on the 1st is a
-- report that is wrong by lunchtime. Three days is the observed lag on the
-- Service Fusion expense pipeline (sf-receipt-sync runs 3×/day and its
-- invoiced-status hook fires within seconds, but the vendor still has to
-- send the bill). 15:00 UTC is 8am Pacific.
--
-- ⚠ It reports on the month that just ENDED, chosen server-side — the URL
-- carries no month on purpose, so a cron that fires late still reports the
-- right period rather than whatever month the clock happens to be in.
--
-- Operators can run it early, or for any past month, from Master Control →
-- 3rd-Party Service Margin (Preview renders it; Email it now sends it).
--
-- The secret and the /api/ URL shape match every other apbg-billing cron in
-- this database (see 20260826b_sf_reconcile.sql) — the function accepts it OR
-- a superadmin Bearer, which is what the Master Control buttons use.

select cron.unschedule('service-margin-monthly')
where exists (select 1 from cron.job where jobname = 'service-margin-monthly');

select cron.schedule(
  'service-margin-monthly',
  '0 15 3 * *',
  $$
  select net.http_post(
    url := 'https://apbg-billing.netlify.app/api/service-margin-report',
    headers := jsonb_build_object(
      'x-sf-autopost-secret', '1b50240878fe88f031165ed9c22c777628337f8c4a80e816',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
