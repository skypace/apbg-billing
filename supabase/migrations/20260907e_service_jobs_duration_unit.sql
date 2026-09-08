-- 20260907e — ops.service_jobs.duration_min was holding SECONDS
--
-- Service Fusion's job `duration` is documented as "The job's duration (in
-- seconds)". sync-sf wrote it STRAIGHT into a column called `duration_min`, so
-- every service job carried 3600 in a field named minutes.
--
-- That is not a cosmetic mislabel. APBG-OPS costs a service job at
-- `billable_hours || duration_min / 60` (src/lib/operations.ts, src/lib/
-- jobLedger.ts) and `billable_hours` is NULL on every row in this table — so
-- the fallback ran on all of them and every job was costed at SIXTY BILLABLE
-- HOURS, then multiplied by an hourly rate in the Job Ledger.
--
-- ⚠ THE VALUE IS ALSO NOT A MEASUREMENT, and that matters more than the unit.
-- Measured live against 100 jobs on 2026-09-07, `duration` takes exactly two
-- values across the whole account — 3600 and 0, 93 of them 3600. It is Service
-- Fusion's default one-hour booking slot, which nobody has ever changed. So
-- what this column can honestly report is THE LENGTH OF THE BOOKED SLOT, never
-- time worked. sync-sf v35 divides by 60 on the way in; this corrects the rows
-- already on file.
--
-- Why a blanket divide is safe here: nothing but sync-sf has ever written this
-- column, sync-sf only ever wrote `j.duration` verbatim, and before v35 the
-- column held exactly ONE distinct value (3600) across 384 populated rows. A
-- row reading 60 was therefore written by v35 and is already correct; a row
-- reading 3600 is a stale seconds value. Restricting the UPDATE to 3600 makes
-- it idempotent — re-running changes nothing.
--
-- ⚠ billable_hours IS DELIBERATELY LEFT NULL. Service Fusion holds no measured
-- labour time for this account (see the note in sync-sf's upsertJob: every
-- labor_charges row is auto-generated with labor_time_start "00:00", averaging
-- a nonsensical 12.1 hours a job). Filling it from anything available here
-- would replace one invented number with another. The APBG-OPS fallback that
-- fabricated it is removed in the same change.

update ops.service_jobs
   set duration_min = duration_min / 60
 where duration_min = 3600;

update ops.delivery_stops
   set duration_min = duration_min / 60
 where duration_min = 3600;

do $$
declare v_bad int;
begin
  select count(*) into v_bad from ops.service_jobs where duration_min is not null and duration_min <> 60;
  if v_bad > 0 then
    raise exception 'service_jobs.duration_min still holds % rows that are not 60 — check for a new SF slot length before assuming the divide was right', v_bad;
  end if;
  raise notice 'duration_min normalised to minutes';
end $$;
