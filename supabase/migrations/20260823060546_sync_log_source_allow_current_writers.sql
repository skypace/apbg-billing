-- ops.sync_log.source has a CHECK allow-list that three live writers are not on,
-- so their inserts have been rejected — silently, because each wraps the log
-- write in a try/catch (correctly: a logging hiccup must not fail the run).
--
-- Found while exercising the new ap_inbox health check against synthetic rows,
-- which is the only reason it surfaced: the check itself passes its own tests,
-- and a monitor whose feed never arrives looks exactly like a pipeline that has
-- not run yet.
--
-- Affected, and all three read GREEN today for the wrong reason:
--
--   brixpense/ap_inbox            new in this change — would never have logged
--   distributor/distributor_notify  "has not logged yet" since 2026-08-20
--   vendors/vendor_funding          "has not reported yet" since 2026-08-21
--
-- Confirmed against the live table: `select distinct source from ops.sync_log`
-- returns eight values and none of these three is among them, despite
-- distributor-notify running every 15 minutes.
--
-- The list is extended rather than dropped. An allow-list on this column is
-- worth keeping — it is what stops a typo'd source silently orphaning a health
-- check, which is the same failure this migration is fixing. The lesson is to
-- ADD to it in the same change that adds a writer.
alter table ops.sync_log drop constraint if exists sync_log_source_check;

alter table ops.sync_log add constraint sync_log_source_check
  check (source is null or source = any (array[
    -- QuickBooks + Service Fusion pipelines
    'qbo', 'sf', 'sf-receipt-sync', 'sf-expense-sweep', 'sf-inbound',
    'sf-cancel', 'sf-connect', 'invoice-inbound',
    -- ResQ sync
    'resq-sync-tick', 'resq-sync-watch', 'resq-inbound',
    -- Fleet / HR / CRM
    'fleet', 'fleetcomplete', 'zoho_crm', 'bambee',
    -- Infrastructure
    'pg_net',
    -- Brixpense + the vendor programme (added 2026-08-23; these writers
    -- existed and were being rejected)
    'brixpense', 'distributor', 'vendors'
  ])) not valid;

-- NOT VALID matches the original: the column has historical rows this list was
-- never checked against, and validating it now would fail the migration over
-- data nobody is going to fix. New writes are checked either way, which is the
-- part that matters.
