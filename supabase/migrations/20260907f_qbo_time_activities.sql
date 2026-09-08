-- 20260907f — mirror QuickBooks TimeActivity: the labour clock we DO have
--
-- Context (Sky, 2026-09-07): "I don't care about Service Fusion... The drivers
-- are clocking in and out using QuickBooks Time so specific drivers will be
-- associated with specific time that will be able to break down."
--
-- He is right and it is already there. Probed live before writing any of this:
-- 14,694 TimeActivity records in QuickBooks, 718 of them in the last 90 days —
-- 2,564 hours across 9 people, with a REAL COST RATE on 602 of them.
--
-- ⚠ AND IT IS A BETTER RATE THAN THE ONE WE DERIVE. The Job Ledger computes
-- annual_wage / 2080; QuickBooks carries the loaded rate, and it is
-- consistently higher — Kyle McGee $23.68 vs our $20.67, Onate $23.68 vs
-- $22.12, Nadell $24.76 vs $22.60. Where a real rate exists it should win.
--
-- ⚠ WHAT THIS DATA CANNOT DO, AND THE COLUMN NAMES WILL MISLEAD YOU.
-- `CustomerRef` looks like per-customer attribution and is NOT. Over 90 days
-- each person is pinned to ONE constant "customer" for every entry they file —
-- Eric VanRenselaar always "111 MINNA GALLERY", McGee and Onate always "BRIX
-- EMPLOYEE BUY", Nadell and Feliciano always "BRIX BEVERAGE - SAMPLING" —
-- across 649 entries and only FIVE distinct values. Those are defaults stuck on
-- each person's QuickBooks Time profile, not the accounts they served. ItemRef
-- is the literal string "Sales" on every single row, and BillableStatus is
-- Billable on ZERO of them. So the honest grain of this table is
-- PERSON × DAY × HOURS × COST RATE. It is not job costing on its own, and
-- customer_name must never be joined to a real customer without a human first
-- fixing those profiles in QuickBooks Time.
--
-- ⚠ THE FEED RUNS ~14 DAYS BEHIND, BY CONSTRUCTION. Entries are created in QBO
-- at payroll close, not when the clock stops: measured lag 9–20 days, mean 14.
-- So "no hours this week" is normal and a health check must not red on it.
-- Weekly volume is steady at 200–290 hours across 5–8 people.

create table if not exists ops.qbo_time_activities (
  qbo_id            text primary key,
  txn_date          date not null,
  employee_qbo_id   text,
  employee_name     text,
  -- ⚠ A STUCK DEFAULT TODAY — see the note above. Mirrored faithfully so the
  -- day it is fixed in QuickBooks Time it starts working, but nothing should
  -- attribute cost through it until someone has checked it moved.
  customer_qbo_id   text,
  customer_name     text,
  item_qbo_id       text,
  item_name         text,
  -- Decimal hours, derived from QBO's Hours/Minutes/Seconds triple so callers
  -- never re-do that arithmetic three different ways.
  hours             numeric,
  hourly_rate       numeric,
  -- What the hour COSTS us. 0/null on some people (Christopher Fok carries
  -- none at all) — null means unknown, and a consumer should fall back to the
  -- roster wage and say which it used.
  cost_rate         numeric,
  billable_status   text,
  description       text,
  qbo_created_at    timestamptz,
  qbo_updated_at    timestamptz,
  sync_token        text,
  synced_at         timestamptz not null default now()
);

create index if not exists qbo_time_activities_date_idx on ops.qbo_time_activities (txn_date desc);
create index if not exists qbo_time_activities_emp_idx  on ops.qbo_time_activities (employee_qbo_id, txn_date desc);

-- Staff-only both directions. This is payroll: it carries what each named
-- person is paid per hour, on a project that also authenticates brix-order
-- customers and distribution partners.
alter table ops.qbo_time_activities enable row level security;
drop policy if exists qbo_time_activities_staff_read on ops.qbo_time_activities;
create policy qbo_time_activities_staff_read on ops.qbo_time_activities
  for select to authenticated using (ops.fn_is_staff());
grant select on ops.qbo_time_activities to authenticated;
revoke all on ops.qbo_time_activities from anon;

-- The roster link. ⚠ APBG-OPS's CLAUDE.md says team_members links to payroll
-- via `qbo_employee_id`; that column has never existed. Adding it rather than
-- matching on names forever — six of the nine QuickBooks Time names match the
-- roster on a first+last comparison today, and "Kyle W. McGee" vs "Kyle Mcgee"
-- is exactly the kind of match that breaks the first time somebody is hired
-- with a middle initial.
alter table ops.team_members add column if not exists qbo_employee_id text;
create index if not exists team_members_qbo_employee_idx on ops.team_members (qbo_employee_id);

-- Person × day: the grain this data actually supports.
create or replace view ops.v_labour_day as
select ta.txn_date,
       ta.employee_qbo_id,
       ta.employee_name,
       tm.id                              as team_member_id,
       tm.name                            as roster_name,
       tm.role,
       tm.department,
       tm.entity,
       sum(ta.hours)                      as hours,
       -- The rate we would actually cost this day at, and WHICH ONE IT IS.
       -- A number with no provenance is how annual_wage/2080 quietly became
       -- the basis of a margin nobody could audit.
       max(nullif(ta.cost_rate, 0))       as qbo_cost_rate,
       round(tm.annual_wage / 2080.0, 4)  as roster_rate,
       coalesce(max(nullif(ta.cost_rate, 0)), round(tm.annual_wage / 2080.0, 4)) as rate_used,
       case when max(nullif(ta.cost_rate, 0)) is not null then 'quickbooks'
            when tm.annual_wage is not null                then 'roster_wage'
            else 'unknown' end            as rate_source,
       round(sum(ta.hours) * coalesce(max(nullif(ta.cost_rate, 0)),
                                      tm.annual_wage / 2080.0), 2) as labour_cost,
       count(*)                           as entries
from ops.qbo_time_activities ta
left join ops.team_members tm
       on tm.qbo_employee_id = ta.employee_qbo_id
group by ta.txn_date, ta.employee_qbo_id, ta.employee_name,
         tm.id, tm.name, tm.role, tm.department, tm.entity, tm.annual_wage;

grant select on ops.v_labour_day to authenticated;

-- ── Watcher ──────────────────────────────────────────────────────────────────
-- No pipeline without one. The load-bearing subtlety is that this feed is
-- SUPPOSED to be two weeks behind, so a check that reds on "no recent hours"
-- would sit permanently red and teach everyone to ignore it. What it watches
-- instead is whether QuickBooks has CREATED anything lately: the entries
-- appear at payroll close, so a gap in creation time is the real signal.
-- ⚠ FIVE columns. The board's row shape is (check_name, status, last_event_at,
-- age_seconds, detail). This shipped with three, which COMPILED CLEAN, APPLIED
-- CLEAN and threw 42804 on the first read of ops.sync_health() — corrected in
-- 20260907g. A health check is only proven by READING THE BOARD.
create or replace function ops.fn_qbo_time_sync_health()
returns table (check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql security definer set search_path = ops, public as $$
#variable_conflict use_column
declare
  v_rows        bigint;
  v_last_txn    date;
  v_last_create timestamptz;
  v_last_run    timestamptz;
  v_err         text;
  v_days        numeric;
begin
  select count(*), max(t.txn_date), max(t.qbo_created_at)
    into v_rows, v_last_txn, v_last_create
  from ops.qbo_time_activities t;

  select max(l.completed_at), max(l.error_message)
    into v_last_run, v_err
  from ops.sync_log l
  where l.source = 'qbo' and l.sync_type = 'time_activities'
    and l.completed_at > now() - interval '3 days';

  check_name    := 'qbo_time_sync';
  -- The event is when QuickBooks CREATED the entry, not the work day: the work
  -- day is always ~14 days stale and that is correct.
  last_event_at := v_last_create;
  age_seconds   := case when v_last_create is null then null
                        else extract(epoch from (now() - v_last_create))::int end;

  if v_rows = 0 then
    status := 'yellow';
    detail := 'no QuickBooks time entries mirrored yet — run /api/qbo-time-sync';
    return next; return;
  end if;

  if v_last_run is null then
    status := 'yellow';
    detail := 'no time sync run in 3 days (last entry ' || coalesce(v_last_txn::text, '—') || ')';
    return next; return;
  end if;

  if v_err is not null then
    status := 'red';
    detail := 'time sync errored: ' || left(v_err, 160);
    return next; return;
  end if;

  -- ⚠ Measured against CREATION, not the work date. The work date is always
  -- ~14 days stale and that is correct; creation stopping is not.
  v_days := extract(epoch from (now() - v_last_create)) / 86400.0;
  if v_days > 21 then
    status := 'red';
    detail := 'QuickBooks has created no time entries in ' || round(v_days) ||
              ' days (newest work day ' || coalesce(v_last_txn::text, '—') ||
              ') — payroll not run, or the QuickBooks Time sync has stopped';
  elsif v_days > 14 then
    status := 'yellow';
    detail := 'newest time entry was created ' || round(v_days) ||
              ' days ago (work day ' || coalesce(v_last_txn::text, '—') ||
              ') — normal lag is ~14 days, worth a look';
  else
    status := 'green';
    detail := v_rows || ' time entries on file, newest work day ' ||
              coalesce(v_last_txn::text, '—') || ' (entries land ~14 days after the work)';
  end if;
  return next;
end $$;

revoke all on function ops.fn_qbo_time_sync_health() from public, anon;
grant execute on function ops.fn_qbo_time_sync_health() to authenticated, service_role;

-- Anchored read-modify-write of the LIVE definition. Never rebuild
-- fn_sync_health_extra from a copy in an older migration — the 2026-08-21
-- incident deleted somebody's monitor exactly that way.
do $$
declare
  v_def    text;
  v_anchor text := 'return query select * from ops.fn_dispatch_geocode_health();';
  v_new    text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if v_def is null then raise exception 'fn_sync_health_extra not found — refusing'; end if;

  -- Count the anchor as a LITERAL. It contains . ( ) and ; so a regex is a trap.
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then raise exception 'anchor matched % times, expected 1 — refusing', v_hits; end if;

  if position('fn_qbo_time_sync_health' in v_def) > 0 then
    raise notice 'fn_qbo_time_sync_health already wired — nothing to do';
    return;
  end if;

  -- Assert two pre-existing monitors survive, so a bad splice cannot silently
  -- shorten the board.
  if position('fn_sf_job_sync_coverage' in v_def) = 0
     or position('fn_dispatch_job_seed_health' in v_def) = 0 then
    raise exception 'a pre-existing monitor is missing from the live body — refusing';
  end if;

  v_new := v_anchor
        || E'\n  return query select * from ops.fn_qbo_time_sync_health();';
  execute replace(v_def, v_anchor, v_new);
  raise notice 'wired ops.fn_qbo_time_sync_health into fn_sync_health_extra';
end $$;
