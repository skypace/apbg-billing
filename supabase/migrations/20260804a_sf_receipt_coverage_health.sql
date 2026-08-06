-- 20260804a — sf_receipt_coverage health check
--
-- Why this exists. Between 2026-06 and 2026-08 the SF→Brixpense expense sync ran
-- on schedule, returned HTTP 200, and logged status='success' on every run —
-- while silently discarding every expense it looked at. SF stores the UNIX epoch
-- (not null) in `updated_at` for an expense that has never been edited, the
-- sweep's date gate read `ex.updated_at || ex.created_at`, and so every
-- never-edited expense tested as 1970 < the start-date cutoff and was skipped.
-- Ten expenses landed in two months. Nothing was red. Nothing alerted.
--
-- The existing sf_receipt_sync check could not have caught this: it measures
-- whether the sync RAN, and the sync ran perfectly. What was needed was a check
-- on whether the sync ACCOMPLISHED anything relative to what it saw.
--
-- sf-receipt-sync now reports per-run counters in ops.sync_log.metadata:
--   expensesSeen   — SF expense rows examined
--   skippedEmpty   — blank SF rows (no vendor/amount/notes/category); ~97% of them
--   skippedByDate  — discarded by the start-date cutoff
--   drafts         — new Brixpense drafts landed
--   alreadyLanded  — already present (dedup hit)
--
-- The invariant: of the expenses that carry information (seen - empty), some
-- must be either landing now or already landed. If a whole window's worth are
-- being seen and NONE are accounted for, a filter is eating them — which is the
-- 2026-06 outage exactly, and any future filter with the same bug.
create or replace function ops.fn_sf_receipt_coverage()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds int, detail text)
language plpgsql
security definer
set search_path to 'ops','public'
as $$
declare
  v_runs        int  := 0;
  v_seen        bigint := 0;
  v_empty       bigint := 0;
  v_bydate      bigint := 0;
  v_drafts      bigint := 0;
  v_dup         bigint := 0;
  v_last        timestamptz;
  v_candidates  bigint;
  v_accounted   bigint;
begin
  -- Only instrumented runs count. Pre-2026-08-04 rows have no counters and must
  -- not be read as "saw nothing" — absence of data is not evidence of health.
  select count(*),
         coalesce(sum((s.metadata->>'expensesSeen')::bigint), 0),
         coalesce(sum((s.metadata->>'skippedEmpty')::bigint), 0),
         coalesce(sum((s.metadata->>'skippedByDate')::bigint), 0),
         coalesce(sum((s.metadata->>'drafts')::bigint), 0),
         coalesce(sum((s.metadata->>'alreadyLanded')::bigint), 0),
         max(s.completed_at)
    into v_runs, v_seen, v_empty, v_bydate, v_drafts, v_dup, v_last
    from ops.sync_log s
   where s.source = 'sf-receipt-sync'
     and s.status = 'success'
     and s.completed_at > now() - interval '48 hours'
     and s.metadata ? 'expensesSeen';

  check_name    := 'sf_receipt_coverage';
  last_event_at := v_last;
  age_seconds   := coalesce(extract(epoch from (now() - v_last))::int, null);

  v_candidates := greatest(v_seen - v_empty, 0);
  v_accounted  := v_drafts + v_dup;

  if v_runs = 0 then
    -- Either the instrumented build has not run yet, or no sweep COMPLETED in
    -- 48h. The latter is the "killed before it could log" mode that hid the
    -- broken crawl for nine days, so this is a real yellow, not a shrug.
    status := 'yellow';
    detail := 'no instrumented sf-receipt-sync run completed in 48h — '
           || 'sweep may be dying before it can log (check the 150s edge wall)';
  elsif v_candidates > 0 and v_accounted = 0 then
    status := 'red';
    detail := 'sf-receipt-sync saw ' || v_candidates || ' real expense(s) across '
           || v_runs || ' run(s) and landed NONE of them ('
           || v_bydate || ' dropped by the date gate). A filter is discarding '
           || 'everything — this is the 2026-06 epoch-date failure shape.';
  else
    status := 'green';
    detail := v_runs || ' run(s)/48h: ' || v_seen || ' expense(s) seen, '
           || v_empty || ' blank, ' || v_bydate || ' pre-cutoff, '
           || v_drafts || ' landed, ' || v_dup || ' already on file';
  end if;
  return next;
end;
$$;

comment on function ops.fn_sf_receipt_coverage() is
  'Red when sf-receipt-sync sees informative SF expenses but lands none of them. '
  'Catches silent-discard bugs that a liveness check cannot see (see 2026-08-04).';

grant execute on function ops.fn_sf_receipt_coverage() to service_role;

-- Wire it into ops.sync_health(), which the 15-minute health-alert pg_cron reads
-- and emails on red/yellow. A check nobody reads is not a check — this is the
-- same rule CLAUDE.md already states for new credential stores, applied to a
-- pipeline instead of a token.
create or replace function ops.sync_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds int, detail text)
language sql
security definer
set search_path to 'ops','public'
as $$
  select * from ops.fn_sync_health_core()
  union all
  select * from ops.fn_sync_health_extra()
  union all
  select * from ops.fn_sf_receipt_coverage();
$$;
