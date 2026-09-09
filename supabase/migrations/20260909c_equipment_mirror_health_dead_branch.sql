-- 20260909c — the equipment watcher loses a branch it could never reach
--
-- 20260909b shipped ops.fn_equipment_mirror_health() with FOUR failure branches
-- and one of them is dead code:
--
--     elsif v_newest is null then
--       '%s equipment assets on file and NOT ONE carries a sync timestamp'
--
-- ⚠ It cannot happen. Measured on the live table rather than assumed:
--
--     information_schema.columns → ops.equipment_assets.synced_at
--       is_nullable    = NO
--       column_default = now()
--
-- So `max(e.synced_at)` over a non-empty table is never null, and the branch
-- above sits behind `v_rows = 0`, which has already claimed the only case where
-- max() could return null. Every row that exists carries a timestamp BY
-- CONSTRUCTION.
--
-- ⚠ WHY DELETE IT RATHER THAN LEAVE IT. This estate has been here before and
-- settled it the same way: the 2026-09-07 sf_token fix found the CORRECT rule
-- sitting two lines below two branches that always matched first, and that
-- change is recorded as "DELETES dead branches rather than inventing logic".
-- An unreachable branch is worse than clutter — it is a claim about a state the
-- schema forbids, so the next reader either trusts it (and reasons about a
-- condition that cannot arise) or has to re-derive the NOT NULL themselves. It
-- also carries operator advice nobody will ever be given.
--
-- The three reachable branches are unchanged and are what this watcher is for:
--   0 rows           → red  (the retire step ate the mirror)
--   > 48h stale      → red  (the echo is not running; installed kit is invisible)
--   > 30h stale      → yellow (one missed daily run is noise, two is a problem)
--   otherwise        → green
--
-- ⚠ The GUARD that makes this safe to simplify is a NOT NULL constraint, not a
-- convention. If a future migration ever relaxes ops.equipment_assets.synced_at
-- to nullable, this branch has to come BACK — max() would then return null on a
-- table full of rows and the function would fall through to the age comparison
-- with a null age, reading GREEN on a mirror nobody can date. Do not relax that
-- column without re-reading this note.
--
-- Nothing else about the function changes: same signature, same OUT columns,
-- same wording on the surviving branches, same grants. fn_sync_health_extra
-- calls it by name, so CREATE OR REPLACE reaches the board with no re-wiring.

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

  -- synced_at is NOT NULL DEFAULT now(), so v_newest is null only when the
  -- table is empty — which the first branch below catches. See the header.
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


-- Assert the premise this simplification rests on, IN the migration, so a
-- future relaxation of the column fails here rather than silently turning the
-- watcher green on an undateable mirror.
do $assert$
declare
  v_nullable text;
begin
  select c.is_nullable into v_nullable
    from information_schema.columns c
   where c.table_schema = 'ops'
     and c.table_name   = 'equipment_assets'
     and c.column_name  = 'synced_at';

  if v_nullable is null then
    raise exception 'ops.equipment_assets.synced_at not found — the watcher assumes it exists';
  end if;
  if v_nullable <> 'NO' then
    raise exception
      'ops.equipment_assets.synced_at is nullable (%) — the "no timestamp" branch '
      'removed by this migration is reachable again and must be restored', v_nullable;
  end if;
end;
$assert$;
