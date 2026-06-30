-- Replace the brute-force invoice-line POLLING with Change Data Capture.
--
-- Why
-- ---
-- The QuickBooks reads that feed brix-order's invoices / payment status were
-- driven by two high-frequency pollers that re-swept invoice LINES across the
-- whole table regardless of whether anything changed:
--   * backfill-invoice-lines  (*/3 min)  — re-scanned ~14k invoices, 0 records/run
--   * refresh-lines-rolling    (*/10 min) — rolling 90-day line refetch
-- Together they were the dominant consumer of the shared Intuit "CorePlus"
-- (data-out) quota — ~482K calls/30d on the APBG_Billing app, which hit the
-- free Builder-tier 500K monthly cap and BLOCKED all data reads account-wide
-- (incl. the Melt app's payment-advice job). See ARCHITECTURE projects/
-- cron-consolidation/PLAN.md.
--
-- The right model (already half-built):
--   * qbo-webhook (live, 0 errors) — real-time Invoice/Payment header updates
--     so the customer sees "paid" within seconds.
--   * NEW sync-qbo mode=cdc — one /cdc call returns only the sales txns changed
--     since the last run, WITH line detail, upserting header+lines from the
--     payload (no per-invoice reads). Validated: a 7-day window pulled 246
--     changed invoices + 1,452 lines in a single CDC call, 0 errors.
--
-- This migration:
--   1. Schedules qbo-cdc-sync every 15 min (the backstop for missed webhooks +
--      new-invoice lines).
--   2. Disables the two redundant line pollers (idempotent; backfill was already
--      disabled in 20260630a).
--
-- Other nightly entity/P&L/reconcile crons are unchanged (they cover non-invoice
-- data at low frequency, well under quota).

-- 1) CDC backstop every 15 min.
SELECT cron.schedule(
  'qbo-cdc-sync',
  '*/15 * * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo?mode=cdc',
      headers := jsonb_build_object('Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY'),
      timeout_milliseconds := 120000
    );
  $cron$
);

-- 2) Retire the redundant line pollers (idempotent).
DO $$
DECLARE jid bigint;
BEGIN
  FOR jid IN SELECT jobid FROM cron.job WHERE jobname IN ('backfill-invoice-lines','refresh-lines-rolling') LOOP
    PERFORM cron.alter_job(job_id := jid, active := false);
  END LOOP;
END $$;
