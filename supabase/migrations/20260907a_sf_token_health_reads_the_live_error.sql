-- sf_token health: judge the error by its TIMESTAMP, not by a flag nobody clears.
--
-- Symptom (2026-09-07): Sky re-authorised Service Fusion, the token wrote
-- cleanly, the sweep ran green against the live API — and the board still said
-- "refresh FAILING". It would have said that forever.
--
-- Cause: two near-identical columns. ops.sf_token_cache has BOTH `last_error`
-- and `last_refresh_error`. The billing path (netlify/functions/sf-helpers.mjs)
-- writes the row directly rather than through ops.sf_token_persist, so it
-- clears `last_refresh_error` on success and has never touched `last_error`.
-- This check read `last_error`. One bad refresh therefore pinned the check
-- yellow permanently, including immediately after a successful re-auth — the
-- moment the board most needs to be believable.
--
-- ⚠ The correct rule was ALREADY HERE and unreachable: the
-- `last_refresh_error_at > updated_at` branch sat two lines below two
-- `last_error` branches that always matched first. So this deletes dead
-- branches rather than inventing logic.
--
-- Why timestamps and not a flag: an error that predates the last successful
-- write is history — a re-auth or a later refresh already fixed it. Comparing
-- timestamps self-heals no matter which writer forgets to clear a column,
-- and there are four writers.
--
-- ⚠ Edits ops.fn_sync_health_core__i, the INNER function. The public name is a
-- generated guard wrapper (20260820b); CREATE OR REPLACE on it would drop the
-- fn_assert_internal() guard. And it patches the LIVE definition read from
-- pg_get_functiondef rather than restating a body from an older migration —
-- rebuilding this function from a stale copy silently deleted somebody's
-- monitor once already (2026-08-21).
do $mig$
declare
  src text;
  out text;
  n   int;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'ops' and p.proname = 'fn_sync_health_core__i';

  if src is null then
    raise exception 'ops.fn_sync_health_core__i not found — has the guard generator been run?';
  end if;

  -- Prove we are editing what we think we are before changing a monitor.
  select count(*) into n from regexp_matches(src, 'v_sf\.last_error', 'g');
  if n <> 4 then
    raise exception 'expected 4 v_sf.last_error references, found % — definition has moved, edit by hand', n;
  end if;
  -- qbo_token legitimately uses last_error (its persist RPC maintains it).
  -- Nothing below may touch it.
  select count(*) into n from regexp_matches(src, 'v_token\.last_error', 'g');
  if n < 1 then
    raise exception 'qbo_token last_error branch missing — wrong function?';
  end if;

  out := src;

  out := regexp_replace(
    out,
    $pat$when v_sf\.updated_at is null then 'red'.*?else 'green' end;$pat$,
    $rep$when v_sf.updated_at is null then 'red'
      -- An error OLDER than the last successful write is history, not a fault.
      -- Compare timestamps rather than testing a flag: four different writers
      -- touch this row and only some of them clear an error column.
      when v_sf.last_refresh_error_at is not null and v_sf.last_refresh_error_at > v_sf.updated_at then 'red'
      when v_sf.updated_at < now() - interval '30 hours' then 'red'
      when v_sf.updated_at < now() - interval '8 hours' then 'yellow'
      else 'green' end;$rep$);

  out := regexp_replace(
    out,
    $pat$detail := 'SF token last written '.*?else '' end;$pat$,
    $rep$detail := 'SF token last written ' || coalesce(greatest(0, extract(epoch from (now() - v_sf.updated_at))::int / 3600)::text, '?') || 'h ago' ||
      case when v_sf.last_refresh_error_at is not null and v_sf.last_refresh_error_at > v_sf.updated_at
           then ' [refresh FAILING: ' || left(coalesce(v_sf.last_refresh_error, ''), 160) || ' — re-auth per CLAUDE.md → Service Fusion OAuth]'
           else '' end;$rep$);

  if out = src then
    raise exception 'no replacement made — the anchors have moved';
  end if;

  select count(*) into n from regexp_matches(out, 'v_sf\.last_error', 'g');
  if n <> 0 then
    raise exception 'still % v_sf.last_error reference(s) after patch', n;
  end if;
  select count(*) into n from regexp_matches(out, 'v_token\.last_error', 'g');
  if n < 1 then
    raise exception 'patch collateral: qbo_token last_error branch was removed';
  end if;

  execute out;
end $mig$;
