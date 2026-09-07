-- The ops-side half of making dispatch.jobs a continuous feed rather than a
-- one-time snapshot. The feed itself is dispatch.fn_sync_jobs_from_mirrors()
-- and lives in apbg-dispatch, which owns the `dispatch` schema; this migration
-- owns the two things in `ops`: the sync_log allow-list and the health board.
--
-- ⚠ APPLY THIS BEFORE the apbg-dispatch migration. ops.sync_log.source carries
-- a CHECK allow-list, and every writer in this system wraps its log call in a
-- try/catch (correctly — a logging hiccup must not fail a run). So a source
-- that is not on the list has its inserts SILENTLY REJECTED, and the health
-- check that reads them stays green as "has not logged yet" forever. That is
-- exactly what happened to `distributor` and `vendors` (found 2026-08-23):
-- distributor-notify had been running every 15 minutes for three days and
-- vendor-funding-cron daily, and neither could ever have gone any colour but
-- green. Add to the allow-list in the same change that adds a writer.
alter table ops.sync_log drop constraint if exists sync_log_source_check;
alter table ops.sync_log add constraint sync_log_source_check check (
  source is null or source = any (array[
    'qbo','sf','sf-receipt-sync','sf-expense-sweep','sf-inbound','sf-cancel',
    'sf-connect','invoice-inbound','resq-sync-tick','resq-sync-watch',
    'resq-inbound','fleet','fleetcomplete','zoho_crm','bambee','pg_net',
    'brixpense','distributor','vendors','sf-reconcile','inventory',
    'dispatch'   -- NEW: BrixSD's dispatch.jobs feed from the SF mirrors
  ])
) not valid;

-- Watches the feed under BrixSD phase 1: dispatch.jobs is seeded FROM
-- ops.service_jobs / delivery_stops / reman_jobs, so it inherits whatever is
-- wrong upstream and adds its own ways to fail.
--
-- ⚠ It deliberately reports the LAG rather than only the run. A feed that runs
-- happily while the mirror it reads has gone stale is the failure this whole
-- day was about: sf-job-sync reported success for months while landing nothing,
-- and a downstream check that only watched itself would have agreed with it.
-- So `red` includes "the mirrors moved and we did not follow".
create or replace function ops.fn_dispatch_job_seed_health()
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
  v_unresolved  bigint;
  v_unres_names text;
  v_mirror_rows bigint;
  v_job_rows    bigint;
  v_missing     bigint;
  v_status      text;
  v_detail      text;
begin
  select l.completed_at, l.status, l.error_message,
         coalesce((l.metadata->>'unresolved_status')::bigint, 0)
    into v_last, v_last_status, v_last_err, v_unresolved
  from ops.sync_log l
  where l.source = 'dispatch' and l.sync_type = 'job_seed'
  order by l.completed_at desc nulls last
  limit 1;

  -- How far behind the mirrors are we? Counted, not assumed.
  select (select count(*) from ops.service_jobs)
       + (select count(*) from ops.delivery_stops)
       + (select count(*) from ops.reman_jobs)
    into v_mirror_rows;
  select count(*) into v_job_rows
  from dispatch.jobs j where j.source_app = 'sf-mirror';
  v_missing := greatest(0, v_mirror_rows - v_job_rows);

  v_age_h := case when v_last is null then null
                  else extract(epoch from (now() - v_last)) / 3600.0 end;

  if v_last is null then
    -- Not red: the feed may simply not be deployed yet in this environment,
    -- and a permanently-red light is one nobody reads. But say so plainly.
    v_status := 'yellow';
    v_detail := 'dispatch.jobs feed has never logged a run ('
                || v_job_rows::text || ' mirror-sourced jobs on file, '
                || v_mirror_rows::text || ' rows in the mirrors)';
  elsif v_last_status = 'error' then
    v_status := 'red';
    v_detail := 'last run FAILED: ' || left(coalesce(v_last_err, '(no message)'), 160);
  elsif v_age_h > 6 then
    v_status := 'red';
    v_detail := 'no dispatch.jobs feed in ' || round(v_age_h)::text || 'h (cron is hourly)';
  elsif v_missing > 0 then
    -- The mirrors moved and we did not follow. See the note above.
    v_status := 'red';
    v_detail := v_missing::text || ' mirror row(s) have no dispatch.jobs row — the feed is behind';
  elsif v_unresolved > 0 then
    -- An SF status the imported taxonomy does not know. NEVER snapped to the
    -- nearest match (that is how `Completed- Will Call` was misread); the job
    -- keeps its previous status and this says how many.
    --
    -- ⚠ It NAMES the statuses, because the right fix depends on which one it
    -- is and a bare count cannot say. A status SF has genuinely added wants a
    -- re-import of dispatch.sf_job_status; the two live today are the literal
    -- string `Unknown` on two April service jobs written by the OLD sync-sf,
    -- which wants nothing at all. Generic advice would have sent somebody
    -- re-importing a taxonomy that is already complete.
    select string_agg(distinct m.sf_status, ', ' order by m.sf_status)
      into v_unres_names
    from (
      select sf_status from ops.service_jobs
      union all select sf_status from ops.delivery_stops
      union all select sf_status from ops.reman_jobs
    ) m
    where m.sf_status is not null
      and not exists (select 1 from dispatch.sf_job_status t where t.sf_name = m.sf_status);

    v_status := 'yellow';
    v_detail := v_unresolved::text || ' job(s) carry an SF status the taxonomy does not know ('
                || left(coalesce(v_unres_names, '?'), 120)
                || ') — each keeps its previous status; re-import dispatch.sf_job_status if SF has added one';
  elsif v_age_h > 3 then
    v_status := 'yellow';
    v_detail := 'last dispatch.jobs feed ' || round(v_age_h)::text || 'h ago (cron is hourly)';
  else
    v_status := 'green';
    v_detail := v_job_rows::text || ' jobs mirrored into dispatch.jobs, in step with the mirrors';
  end if;

  return query select
    'dispatch_job_seed'::text,
    v_status,
    v_last,
    case when v_last is null then null else extract(epoch from (now() - v_last))::int end,
    v_detail;
end;
$$;

revoke all on function ops.fn_dispatch_job_seed_health() from public, anon;
grant execute on function ops.fn_dispatch_job_seed_health() to authenticated, service_role;

-- Wire it in by READ-MODIFY-WRITE against the LIVE definition, anchored and
-- asserted. ⚠ Never restate fn_sync_health_extra from a copy in an older
-- migration — rebuilding it from a stale copy silently deleted somebody's
-- monitor on 2026-08-21.
do $mig$
declare
  src text;
  out text;
  anchor text := 'return query select * from ops.fn_sf_job_sync_coverage();';
  addition text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';

  if src is null then raise exception 'ops.fn_sync_health_extra not found'; end if;
  if position(anchor in src) = 0 then
    raise exception 'anchor not found — wire the dispatch check in by hand';
  end if;
  if position('fn_dispatch_job_seed_health' in src) > 0 then
    raise notice 'dispatch_job_seed already wired; nothing to do';
    return;
  end if;

  addition := anchor || E'\n\n'
    || E'  -- BrixSD phase 1: dispatch.jobs is fed FROM the three SF mirrors, so\n'
    || E'  -- it inherits anything wrong upstream. Reports the LAG, not just the run.\n'
    || '  return query select * from ops.fn_dispatch_job_seed_health();';

  out := replace(src, anchor, addition);
  if out = src then raise exception 'no replacement made'; end if;
  if position('fn_sf_job_sync_coverage' in out) = 0 then
    raise exception 'patch collateral: the sf_job_sync check was removed';
  end if;

  execute out;
end $mig$;
