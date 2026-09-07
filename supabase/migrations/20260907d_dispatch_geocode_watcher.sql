-- 20260907d — a watcher for the hourly dispatch-geocode cron.
--
-- BrixSD's board resolves a service address for every job and pins it from
-- dispatch.geocode_cache, filled hourly by pg_cron `dispatch-geocode`
-- (apbg-dispatch migration 20260907e). This repo owns ops.sync_health(), so the
-- watcher lives here — no pipeline without one.
--
-- ⚠ It watches the number a DISPATCHER FEELS — addresses on the board with no
--    pin — not merely whether the cron ran. The 2026-09-07 sync-sf lesson:
--    `sync-sf` reported success for months while landing nothing, and a check
--    that only watched itself would have agreed with it.
--
-- ⚠ 42702, AND IT BIT ON THE FIRST TRY. `status` is BOTH an OUT parameter of
--    this function and a column of dispatch.geocode_cache; plpgsql resolves that
--    at EXECUTION, so v1 compiled clean, APPLIED clean, and threw the moment
--    ops.sync_health() was read — taking the entire board down until it was
--    fixed. Identical to fn_sf_job_sync_coverage (2026-09-07) and
--    fn_apply_sales_to_ledger (2026-09-03). Every column in every subquery below
--    is aliased, and #variable_conflict use_column is set as a second belt.

create or replace function ops.fn_dispatch_geocode_health()
returns table(check_name text, status text, last_event_at timestamp with time zone,
              age_seconds integer, detail text)
language plpgsql
stable security definer
set search_path to 'ops', 'dispatch', 'public', 'pg_temp'
as $function$
#variable_conflict use_column
declare
  v_last     timestamptz;
  v_run      text;
  v_age_h    numeric;
  v_unpinned bigint;
  v_stuck    bigint;
  v_errors   bigint;
  v_ok       bigint;
begin
  select l.completed_at, l.status into v_last, v_run
  from ops.sync_log l
  where l.source = 'dispatch' and l.sync_type = 'geocode'
  order by l.completed_at desc limit 1;

  v_age_h := extract(epoch from (now() - v_last)) / 3600.0;

  -- The number that matters: what a dispatcher cannot find on a map.
  select count(distinct dispatch.fn_address_key(v.service_address)) into v_unpinned
  from dispatch.v_jobs v where v.service_address is not null and v.lat is null;

  -- ⚠ A request that went out and never came back. pg_net drops responses after
  --    hours, so a row older than that is one nobody will ever collect — and
  --    without this it would sit invisible while the enqueue half kept skipping
  --    that address because it was "already queued".
  select count(*) into v_stuck from dispatch.geocode_queue q
  where q.requested_at < now() - interval '2 hours';

  select count(*) into v_errors from dispatch.geocode_cache c where c.status = 'error';
  select count(*) into v_ok     from dispatch.geocode_cache c where c.status = 'ok';

  if v_last is null then
    -- ⚠ Says the ambiguity out loud. Postgres cannot tell "the cron has never
    --    fired" from "it fired and could not log", and reading one as the other
    --    is how a check goes green on a pipeline that is dead.
    return query select 'dispatch_geocode'::text, 'yellow'::text, null::timestamptz, null::int,
      'no geocode run has ever logged — either the hourly dispatch-geocode cron has not fired yet, or it ran and could not write to ops.sync_log'::text;
  elsif v_run <> 'success' then
    return query select 'dispatch_geocode'::text, 'red'::text, v_last, (v_age_h*3600)::int,
      ('last geocode run reported ' || v_run)::text;
  elsif v_age_h > 6 then
    return query select 'dispatch_geocode'::text, 'red'::text, v_last, (v_age_h*3600)::int,
      ('no geocode run in ' || round(v_age_h) || 'h — the hourly cron is not firing')::text;
  elsif v_stuck > 0 then
    return query select 'dispatch_geocode'::text, 'yellow'::text, v_last, (v_age_h*3600)::int,
      (v_stuck || ' geocode request(s) went out and never came back; pg_net has dropped the response. They re-ask themselves on the next run')::text;
  elsif v_errors > 0 then
    return query select 'dispatch_geocode'::text, 'yellow'::text, v_last, (v_age_h*3600)::int,
      (v_errors || ' address(es) errored at the geocoder — see dispatch.geocode_cache.error')::text;
  elsif v_unpinned > 0 then
    -- ⚠ Yellow, not red, deliberately: an address the US Census geocoder cannot
    --    place is a DATA problem a human fixes upstream, not a broken pipeline.
    --    Red here would be a permanent amber nobody reads.
    return query select 'dispatch_geocode'::text, 'yellow'::text, v_last, (v_age_h*3600)::int,
      (v_unpinned || ' address(es) on the board have no pin — the geocoder could not place them; fix the address on the store record')::text;
  else
    return query select 'dispatch_geocode'::text, 'green'::text, v_last, (v_age_h*3600)::int,
      (v_ok || ' addresses pinned, all resolvable ones placed')::text;
  end if;
end;
$function$;

revoke all on function ops.fn_dispatch_geocode_health() from public, anon;

-- Wire it in by ANCHORED READ-MODIFY-WRITE of the LIVE definition. Never rebuild
-- fn_sync_health_extra from a copy in an older migration — the 2026-08-21
-- incident deleted somebody's monitor exactly that way.
do $do$
declare
  v_def    text;
  v_anchor text := 'return query select * from ops.fn_dispatch_job_seed_health();';
  v_new    text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if v_def is null then raise exception 'fn_sync_health_extra not found — refusing'; end if;

  -- ⚠ LITERAL count, not regexp_matches: the anchor contains . ( ) ; and
  --    half-escaping it is how the first attempt matched zero and (correctly)
  --    refused to write anything.
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then raise exception 'anchor matched % times, expected 1 — refusing', v_hits; end if;

  if position('fn_dispatch_geocode_health' in v_def) > 0 then
    raise notice 'already wired; nothing to do'; return;
  end if;
  -- Assert a pre-existing monitor survives, so a truncated or stale definition
  -- can never be written back over the live one.
  if position('fn_sf_job_sync_coverage' in v_def) = 0 then
    raise exception 'a pre-existing monitor is missing from the live body — refusing';
  end if;

  v_new := v_anchor
    || E'\n\n  -- BrixSD phase 1: the hourly dispatch-geocode cron. Watches the number a\n'
    || E'  -- dispatcher feels — addresses on the board with no pin — not just the run.\n'
    || '  return query select * from ops.fn_dispatch_geocode_health();';

  execute replace(v_def, v_anchor, v_new);
  raise notice 'wired ops.fn_dispatch_geocode_health into fn_sync_health_extra';
end
$do$;
