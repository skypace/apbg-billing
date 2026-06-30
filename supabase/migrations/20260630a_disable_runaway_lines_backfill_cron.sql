-- Disable the runaway `backfill-invoice-lines` pg_cron job (was jobid 3).
--
-- Background
-- ----------
-- This cron started life as a ONE-TIME catch-up to fill `ops.qbo_invoice_lines`
-- for invoices that had headers but no line detail. Migration 20260615a (item 3)
-- "fixed" it after it ran off the end of the table by making its offset wrap
-- modulo the live invoice count — which turned a finite backfill into a
-- PERMANENT every-3-minutes full re-sweep of all ~14k invoices (480 runs/day),
-- pulling line items 50 invoices at a time, forever.
--
-- Why it's safe to disable
-- ------------------------
-- By 2026-06-30 the backfill is pure waste: every run logs records_synced = 0
-- (verified across the most recent runs in ops.sync_log). Only 102 of 14,089
-- invoices still have zero lines, and the sweep is NOT filling them — it writes
-- nothing on every pass. Meanwhile `refresh-lines-rolling` (jobid 35, every
-- 10 min over the trailing 90 days) already keeps recent invoices' lines fresh.
--
-- This perpetual sweep was the dominant around-the-clock consumer of the shared
-- QuickBooks realm (9130352144155116), keeping it at Intuit's throttle ceiling.
-- The resulting `ThrottleExceeded` 429s (logged hourly in ops.sync_log) were
-- also breaking the Melt dashboard's hourly payment-advice job, whose QBO
-- queries were being rejected.
--
-- We DISABLE rather than unschedule so the job definition is preserved and can
-- be re-enabled if a targeted re-run is ever wanted. The 102 zero-line invoices
-- should be closed out with a one-shot targeted fill (a separate follow-up),
-- not a 24/7 scan.
--
-- Idempotent: looks the job up by name and no-ops if already absent/disabled.

DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'backfill-invoice-lines';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := jid, active := false);
  END IF;
END $$;
