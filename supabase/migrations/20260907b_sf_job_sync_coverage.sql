-- A watcher for the SF job mirror, because "success" was never evidence.
--
-- sf-job-sync reported success every day for months and landed almost nothing:
-- 10 runs in 10 days, 1 record. ops.delivery_stops had not been written since
-- 2026-04-28. Nothing went amber, because the only number anyone looked at was
-- status='success' — and a run that scans ten jobs, skips all ten and breaks
-- reads exactly like a quiet day.
--
-- This is the same lesson as ops.fn_sf_receipt_coverage() (2026-08-04), where
-- `drafts: 0` hid a two-month outage for identical reasons: a count of what
-- LANDED cannot distinguish "nothing to do" from "the gate is eating
-- everything". So the rule here compares what was SEEN against what was KEPT.
--
-- ⚠ The load-bearing branch is `scanned > 0 and synced = 0`. That is the exact
-- signature of the bug this replaces, and it is deliberately measured across
-- the last few runs rather than one: a single legitimately-quiet run can look
-- like it, three in a row cannot.
--
-- Feeds APBG-OPS (cost-per-stop, utilisation, FTF%, callback%) and BrixSD
-- (dispatch.jobs seeds from these three tables), so a stall here is silently
-- wrong numbers in two products.
create or replace function ops.fn_sf_job_sync_coverage()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql
stable
security definer
set search_path to 'ops', 'public', 'pg_temp'
as $$
declare
  v_last        timestamptz;
  v_last_status text;
  v_last_err    text;
  v_age_h       numeric;
  v_scanned     bigint;
  v_synced      bigint;
  v_errors      bigint;
  v_runs        int;
  v_newest_svc  date;
  v_newest_del  date;
  v_status      text;
  v_detail      text;
begin
  select l.completed_at, l.status, l.error_message
    into v_last, v_last_status, v_last_err
  from ops.sync_log l
  where l.source = 'sf' and l.sync_type = 'jobs'
  order by l.completed_at desc nulls last
  limit 1;

  -- Look at the last 3 runs, not just the newest: one quiet run proves nothing.
  select count(*),
         coalesce(sum((l.metadata->>'scanned')::bigint), 0),
         coalesce(sum((l.metadata->>'synced')::bigint), 0),
         coalesce(sum((l.metadata->>'errors')::bigint), 0)
    into v_runs, v_scanned, v_synced, v_errors
  from (
    -- ⚠ Every column ALIASED. `status` is both an OUT parameter of this
    -- function and a column of sync_log, and plpgsql resolves that ambiguity
    -- at EXECUTION, not at create time — so an unqualified reference compiles
    -- clean and throws 42702 the first time the board is read. Same trap as
    -- fn_apply_sales_to_ledger (2026-09-03).
    select sl.metadata from ops.sync_log sl
    where sl.source = 'sf' and sl.sync_type = 'jobs' and sl.status = 'success'
    order by sl.completed_at desc limit 3
  ) l;

  select max(job_date) into v_newest_svc from ops.service_jobs;
  select max(stop_date) into v_newest_del from ops.delivery_stops;

  v_age_h := case when v_last is null then null
                  else extract(epoch from (now() - v_last)) / 3600.0 end;

  if v_last is null then
    v_status := 'red';
    v_detail := 'SF job sync has never logged a run';
  elsif v_last_status = 'error' then
    v_status := 'red';
    v_detail := 'last run FAILED: ' || left(coalesce(v_last_err, '(no message)'), 160);
  elsif v_age_h > 48 then
    -- The cron is daily at 09:00 UTC, so 48h is a missed run plus margin.
    v_status := 'red';
    v_detail := 'no SF job sync in ' || round(v_age_h)::text || 'h (cron is daily)';
  elsif v_runs >= 3 and v_scanned > 0 and v_synced = 0 then
    -- THE BUG THIS EXISTS FOR. Jobs were read from SF and none were kept.
    v_status := 'red';
    v_detail := 'sync is running but landing NOTHING — ' || v_scanned::text
                || ' jobs scanned across the last ' || v_runs::text
                || ' runs, 0 written. Check the page cursor and the date window.';
  elsif v_age_h > 30 then
    v_status := 'yellow';
    v_detail := 'last SF job sync ' || round(v_age_h)::text || 'h ago (cron is daily)';
  elsif v_errors > 0 then
    v_status := 'yellow';
    v_detail := v_errors::text || ' row error(s) in the last ' || v_runs::text || ' runs';
  else
    v_status := 'green';
    v_detail := v_synced::text || ' jobs written across the last ' || v_runs::text
                || ' runs · newest service ' || coalesce(v_newest_svc::text, '—')
                || ', newest delivery ' || coalesce(v_newest_del::text, '—');
  end if;

  return query select
    'sf_job_sync'::text,
    v_status,
    v_last,
    case when v_last is null then null else extract(epoch from (now() - v_last))::int end,
    v_detail;
end;
$$;

revoke all on function ops.fn_sf_job_sync_coverage() from public, anon;
grant execute on function ops.fn_sf_job_sync_coverage() to authenticated, service_role;

-- Wire it into the board by READ-MODIFY-WRITE against the LIVE definition.
-- ⚠ Never restate fn_sync_health_extra from a copy in an older migration:
-- rebuilding it from a stale copy silently deleted somebody's monitor on
-- 2026-08-21. Anchor, assert, patch, assert.
do $mig$
declare
  src text;
  out text;
  anchor text := 'return query select * from ops.fn_transfer_workflow_health();';
  addition text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';

  if src is null then
    raise exception 'ops.fn_sync_health_extra not found';
  end if;

  if position(anchor in src) = 0 then
    raise exception 'anchor not found in fn_sync_health_extra — wire the new check in by hand';
  end if;

  if position('fn_sf_job_sync_coverage' in src) > 0 then
    raise notice 'sf_job_sync check already wired; nothing to do';
    return;
  end if;

  addition := anchor || E'\n\n'
    || E'  -- The SF job mirror (APBG-OPS KPIs + BrixSD dispatch.jobs seed).\n'
    || E'  -- Watches what was SEEN against what was KEPT: this fed two products\n'
    || E'  -- while reporting success and landing 1 record in 10 days.\n'
    || '  return query select * from ops.fn_sf_job_sync_coverage();';

  out := replace(src, anchor, addition);

  if out = src then
    raise exception 'no replacement made';
  end if;
  if position('fn_transfer_workflow_health' in out) = 0 then
    raise exception 'patch collateral: the transfer workflow check was removed';
  end if;

  execute out;
end $mig$;
