-- 20260909b — the equipment echo gets a watcher
--
-- ⚠ SUPERSEDED IN PART by 20260909c: the `v_newest is null` branch below is
-- unreachable (ops.equipment_assets.synced_at is NOT NULL DEFAULT now(), so
-- max() is null only when the table is empty, which the branch above it already
-- claims) and was removed there. This file is left as the record of what was
-- actually applied — read 20260909c for the live definition.
--
-- ERLS owns the equipment record; BrixSD (dispatch.fn_customer_equipment,
-- core.fn_customer_profile) and brix-order (the customer Equipment page, the
-- account-closure gate, customer-group-assets) only ever ECHO it through
-- ops.equipment_assets. Neither reads the ERLS project at request time, which
-- is the right shape — and it had been running as designed for exactly two
-- days out of three months.
--
-- MEASURED 2026-09-09, before writing a line:
--   ops.equipment_assets carried TWO distinct synced_at values in its entire
--   life — 2026-05-31 06:44 and 2026-08-20 01:18 — and NEITHER is the
--   10:00 UTC its cron is scheduled for. Both runs were manual. So:
--     · 20 days stale
--     · 9 assets missing, one of them an INSTALLED Manitowoc ice machine at
--       Wences Restaurant, plus ~$1,400/month of rented equipment invisible
--       to both readers
--     · 33 changed upstream and not reflected
--     · 7 phantom rows at 4 BELLS that ERLS deleted long ago (proven by id:
--       zero of the 7 exist in the ERLS project)
--   A technician dispatched to Wences would have seen no equipment on the job.
--
-- ⚠ WHY IT COULD GO ON FOR THREE MONTHS: this mirror was absent from the
-- 31-check ops.sync_health() board. It had frozen ONCE BEFORE — the sync's own
-- header records an 11-week freeze from 2026-06-01 — and the second freeze was
-- found the same way as the first: by somebody happening to look.
--
-- ⚠ IT WATCHES STALENESS, NOT WHETHER A JOB RAN. That is the dispatch-geocode
-- lesson (ops.fn_dispatch_geocode_health): a watcher on its own cron reports
-- what the pipeline thinks of itself, and this pipeline thought it was fine.
-- The number an operator FEELS is "how old is the equipment on the account",
-- so that is what reds. A run log would have stayed green here, because there
-- were no failing runs — there were no runs.
--
-- ⚠ AND IT REDS ON AN EMPTY TABLE RATHER THAN GOING QUIET. Zero rows with a
-- reachable source is not "nothing to mirror" — it is the retire step having
-- eaten the mirror, which is the one failure mode the sync's own ceiling
-- exists to prevent. Postgres cannot see ERLS, so it cannot tell a genuinely
-- empty fleet from a wiped one; it says so instead of guessing.

create or replace function ops.fn_equipment_mirror_health()
returns table(
  check_name     text,
  status         text,
  last_event_at  timestamptz,
  age_seconds    integer,
  detail         text
)
language plpgsql
stable
security definer
set search_path = ops, public
as $fn$
declare
  v_newest   timestamptz;
  v_rows     integer;
  v_age_h    numeric;
  v_status   text;
  v_detail   text;
begin
  -- Every column aliased: `status` is both an OUT parameter here and a column
  -- of ops.equipment_assets, and plpgsql resolves that at EXECUTION — so an
  -- unaliased reference compiles clean, applies clean, and throws 42702 the
  -- moment sync_health() is read. Exactly what fn_sf_job_sync_coverage did on
  -- 2026-09-07 and fn_apply_sales_to_ledger before it.
  select max(e.synced_at), count(*)
    into v_newest, v_rows
    from ops.equipment_assets e;

  v_age_h := case
               when v_newest is null then null
               else extract(epoch from (now() - v_newest)) / 3600.0
             end;

  if v_rows = 0 then
    v_status := 'red';
    v_detail := 'The equipment mirror is EMPTY. ERLS owns the asset record and '
             || 'this table is the only copy BrixSD and the customer portal '
             || 'read, so every account now shows no equipment. Run the sync '
             || '(Company -> "Sync equipment from ERLS") and check its '
             || 'retire step did not delete the fleet.';
  elsif v_newest is null then
    v_status := 'red';
    v_detail := format(
      '%s equipment assets on file and NOT ONE carries a sync timestamp — '
      || 'nothing can tell how old this is. Run the sync from Company -> '
      || '"Sync equipment from ERLS".', v_rows);
  elsif v_age_h > 48 then
    v_status := 'red';
    v_detail := format(
      'The ERLS equipment echo has not run for %s hours (%s assets on file, '
      || 'last synced %s). BrixSD job cards and the customer Equipment page '
      || 'are both showing that snapshot, so an installed machine may be '
      || 'invisible. The nightly cron is sync-equipment-rentals at 10:00 UTC; '
      || 'force it from Company -> "Sync equipment from ERLS".',
      round(v_age_h), v_rows, to_char(v_newest, 'YYYY-MM-DD HH24:MI'));
  elsif v_age_h > 30 then
    -- 30h, not 24h: a daily cron that slips an hour into PST, or a deploy
    -- landing across its window, must not page anybody.
    v_status := 'yellow';
    v_detail := format(
      'The ERLS equipment echo last ran %s hours ago (%s assets). It is daily, '
      || 'so one missed run is expected noise and two is a problem — if this '
      || 'stays amber, force it from Company -> "Sync equipment from ERLS".',
      round(v_age_h), v_rows);
  else
    v_status := 'green';
    v_detail := format('%s equipment assets echoed from ERLS, last synced %s.',
                       v_rows, to_char(v_newest, 'YYYY-MM-DD HH24:MI'));
  end if;

  return query
    select 'equipment_mirror'::text,
           v_status,
           v_newest,
           case when v_newest is null then null
                else (extract(epoch from (now() - v_newest)))::integer end,
           v_detail;
end;
$fn$;

revoke all on function ops.fn_equipment_mirror_health() from public;
grant execute on function ops.fn_equipment_mirror_health() to service_role;


-- Wire it into the board by ANCHORED READ-MODIFY-WRITE of the LIVE definition,
-- never by pasting a body from an older migration. The 2026-08-21 incident
-- deleted somebody's monitor exactly that way: fn_sync_health_extra has been
-- edited by a dozen migrations and no file in this repo holds its current text.
do $wire$
declare
  v_def    text;
  v_anchor text;
  v_new    text;
  v_hits   integer;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';

  if v_def is null then
    raise exception 'ops.fn_sync_health_extra() not found — refusing to guess at its body';
  end if;

  if position('fn_equipment_mirror_health' in v_def) > 0 then
    raise notice 'equipment_mirror already wired into fn_sync_health_extra — nothing to do';
    return;
  end if;

  v_anchor := '  return query select * from ops.fn_account_access_health();';

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      'anchor matched % times in fn_sync_health_extra (expected exactly 1) — '
      'the function has moved; re-read it and re-anchor rather than forcing this',
      v_hits;
  end if;

  v_new := replace(
    v_def,
    v_anchor,
    v_anchor || E'\n\n'
    || E'  -- ERLS owns the equipment record and this is the only copy BrixSD and\n'
    || E'  -- the customer portal read. It had TWO successful runs in three months,\n'
    || E'  -- both manual, and nothing watched it — so an INSTALLED ice machine sat\n'
    || E'  -- invisible to a dispatcher for 20 days. Watches STALENESS, which is the\n'
    || E'  -- number an operator feels; a run log stayed green because the runs were\n'
    || E'  -- not failing, they were not happening.\n'
    || E'  return query select * from ops.fn_equipment_mirror_health();'
  );

  execute v_new;

  -- Assert the edit landed AND that nothing else was lost. Presence is not
  -- proof: 20260909m in apbg-dispatch appended a block AFTER a `return`, the
  -- write succeeded, the text was there, and the code never ran once.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';

  if position('fn_equipment_mirror_health' in v_def) = 0 then
    raise exception 'the equipment_mirror call is not in the rewritten function';
  end if;
  if position('fn_account_access_health' in v_def) = 0
     or position('fn_dispatch_invoice_health' in v_def) = 0
     or position('fn_qbo_time_sync_health' in v_def) = 0 then
    raise exception 'a pre-existing monitor went missing in the rewrite — refusing';
  end if;
end;
$wire$;
