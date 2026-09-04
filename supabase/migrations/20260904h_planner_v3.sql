-- 20260904h_planner_v3.sql
-- Inventory Planning v3 — anomalies out of the baseline, pars, the smallest
-- order, and a fill plan for the gas cylinders.
--
-- Ask (Sky, 2026-09-04, on top of planner v2):
--   "see if there was a customer that ordered last year a lot and if that
--    customer hasn't ordered this year then don't use those customers … don't
--    use any customers that show large quantities or find a way to say
--    abnormality found, add to exception or keep in report. Also, the smallest
--    order. Also add CO2 20 pounders and mixed gas 20 pounders … see how many
--    tanks we should likely fill for the week. … what you're calling safety I
--    would call a par … give us what our pars should be."
--
-- What this migration does:
--   1. ops.planning_exceptions — one row per anomaly the detector found (or a
--      human added): a LAPSED customer (bought a lot last year, nothing in the
--      last 120 days — J&J Vending on root beer, Canteen Fremont on cola and
--      orange) is excluded from the baseline wholesale; a VOLUME SPIKE (one
--      customer's week far above their own and the item's normal) is excluded
--      for that customer, item and week only. Every row starts 'excluded' and
--      a human can flip it to 'kept' — the report shows both, which is the
--      "add to exception or keep in report" half of the ask.
--   2. ops.v_planning_daily_sales applies those exclusions, so fn_items_master,
--      fn_planning_yoy and fn_planning_weekly all read the cleaned baseline
--      from one place. ⚠ A lapsed customer has no recent sales by definition,
--      so excluding them changes the last-year side only. A spike week inside
--      the last 13 weeks also leaves the recent rate — one bulk order is not a
--      rate, and it would otherwise inflate the buffer and the par as well.
--   3. ops.fn_planning_exceptions_refresh() — the detector. Runs daily
--      (pg_cron, 10:05 UTC, after the 09:45 items sync) and from the Anomalies
--      tab. Logs ops.sync_log so a broken detector is visible, never silent.
--   4. Pars. par_min = the reorder point (order when stock + inbound reaches
--      it); par_max = the level an order brings you back to
--      ((target + lead) × plan rate + buffer). "Safety stock" is renamed
--      BUFFER on screen; the maths is unchanged.
--   5. smallest_order_qty — the smallest quantity we have actually bought of
--      the item in 24 months (QuickBooks bill lines), and inventory_settings.
--      min_order_qty seeded from it for BIB items still at 0. Cans are left at
--      0: their bill lines are Quantum tolling invoices, not run sizes.
--   6. ops.planning_fill_items + ops.fn_planning_fill_plan() — the gas
--      cylinders we FILL rather than stock: 20 lb CO₂ (CO8011) and the small
--      mixed-gas cylinder (BR8021). Per week: what we filled this year, what
--      last year's aligned week did, the forecast for the coming weeks, and a
--      weekly par (forecast + buffer) — "how many tanks to have filled before
--      Monday". Small nitrogen (NI8031) is in the table but inactive.

-- Applied live 2026-09-04 in two steps through the Supabase MCP: part A (tables,
-- view, detector, fill plan) via apply_migration; the fn_items_master__i /
-- wrapper rebuild as a read-modify-write of the LIVE definitions
-- (pg_get_functiondef + replace on three anchors, then EXECUTE) — the same
-- pattern fn_sync_health_extra uses, and the reason this file must stay equal
-- to what is live: it is the copy a reader will trust.

-- ── 1. exceptions ────────────────────────────────────────────────────────
create table if not exists ops.planning_exceptions (
  id              bigserial primary key,
  kind            text not null check (kind in ('lapsed_customer', 'volume_spike', 'manual')),
  qbo_customer_id text not null,
  qbo_item_id     text,          -- null = every planner item
  week_start      date,          -- null = every date; else the Monday of the excluded week
  status          text not null default 'excluded' check (status in ('excluded', 'kept', 'resolved')),
  evidence        jsonb not null default '{}'::jsonb,
  detected_at     timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      text,
  note            text
);
create unique index if not exists planning_exceptions_scope_uq
  on ops.planning_exceptions (kind, qbo_customer_id, coalesce(qbo_item_id, ''), coalesce(week_start, '1900-01-01'::date));
create index if not exists planning_exceptions_active_ix
  on ops.planning_exceptions (qbo_customer_id) where status = 'excluded';
comment on table ops.planning_exceptions is
  'Anomalies kept out of the planner baseline. lapsed_customer = whole customer; volume_spike = one customer × item × week. status excluded (default) / kept (human override — counts again) / resolved (the lapsed customer came back). Read by v_planning_daily_sales.';

alter table ops.planning_exceptions enable row level security;
drop policy if exists planning_exceptions_read on ops.planning_exceptions;
create policy planning_exceptions_read on ops.planning_exceptions for select to authenticated
  using (ops.fn_is_staff() or not ops.fn_is_distributor());
drop policy if exists planning_exceptions_write on ops.planning_exceptions;
create policy planning_exceptions_write on ops.planning_exceptions for all to authenticated
  using (ops.fn_is_staff()) with check (ops.fn_is_staff());
revoke all on ops.planning_exceptions from public, anon;
grant select, insert, update, delete on ops.planning_exceptions to authenticated;
grant all on ops.planning_exceptions to service_role;
grant usage, select on sequence ops.planning_exceptions_id_seq to authenticated, service_role;

-- ── 2. the baseline view applies them ────────────────────────────────────
create or replace view ops.v_planning_daily_sales
with (security_invoker = true) as
select v.item_ref_id as qbo_item_id,
       v.txn_date as d,
       sum(case when i.txn_type in ('CreditMemo', 'RefundReceipt') then -v.quantity else v.quantity end)::numeric as qty
from ops.v_sales_lines v
join ops.qbo_invoices i on i.id = v.invoice_id
join ops.inventory_settings s on s.qbo_item_id = v.item_ref_id and s.is_planner
left join ops.inventory_velocity_excludes e on e.qbo_customer_id = v.customer_ref_id
where e.qbo_customer_id is null
  and v.item_ref_id is not null
  and v.quantity is not null and v.quantity > 0
  and v.txn_date <= current_date
  and not exists (
    select 1 from ops.planning_exceptions x
    where x.status = 'excluded'
      and x.qbo_customer_id = v.customer_ref_id
      and (x.qbo_item_id is null or x.qbo_item_id = v.item_ref_id)
      and (x.week_start is null or v.txn_date between x.week_start and x.week_start + 6)
  )
group by 1, 2;
comment on view ops.v_planning_daily_sales is
  'Planner items only. Invoices/sales receipts add, credit memos/refund receipts subtract; velocity excludes AND planning_exceptions (status excluded) removed; future-dated lines dropped. Read by fn_items_master + fn_planning_yoy + fn_planning_weekly (SECURITY DEFINER).';
revoke all on ops.v_planning_daily_sales from public, anon, authenticated;
grant select on ops.v_planning_daily_sales to service_role;

-- ── 3. the detector ──────────────────────────────────────────────────────
create or replace function ops.fn_planning_exceptions_refresh()
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_lapsed int := 0; v_spikes int := 0; v_resolved int := 0; v_cleared int := 0; v_err text; v_t0 timestamptz := now();
begin
  perform ops.fn_assert_staff_or_service();
  begin
    -- customers who bought ≥10% (and ≥20 units) of an item in the window
    -- 364–728 days ago and have bought NO planner item in the last 120 days
    with cust_last as (
      select v.customer_ref_id, max(v.txn_date) last_dt
      from ops.v_sales_lines v join ops.inventory_settings s on s.qbo_item_id = v.item_ref_id and s.is_planner
      where v.quantity > 0 group by 1),
    ly as (
      select v.item_ref_id, v.customer_ref_id,
             sum(case when i.txn_type in ('CreditMemo','RefundReceipt') then -v.quantity else v.quantity end) qty
      from ops.v_sales_lines v join ops.qbo_invoices i on i.id = v.invoice_id
      join ops.inventory_settings s on s.qbo_item_id = v.item_ref_id and s.is_planner
      where v.txn_date >= current_date - 728 and v.txn_date < current_date - 364 and v.quantity > 0
      group by 1, 2),
    tot as (select item_ref_id, sum(qty) t from ly group by 1),
    lapsed as (
      select ly.customer_ref_id, cl.last_dt,
             jsonb_agg(jsonb_build_object('qbo_item_id', ly.item_ref_id, 'ly_qty', ly.qty,
                       'ly_share_pct', round(100 * ly.qty / nullif(tot.t, 0), 1)) order by ly.qty desc) items
      from ly join tot using (item_ref_id) join cust_last cl on cl.customer_ref_id = ly.customer_ref_id
      where ly.qty >= 20 and ly.qty >= 0.10 * tot.t
        and cl.last_dt < current_date - 120
      group by 1, 2),
    ins as (
      insert into ops.planning_exceptions (kind, qbo_customer_id, qbo_item_id, week_start, status, evidence)
      select 'lapsed_customer', l.customer_ref_id, null, null, 'excluded',
             jsonb_build_object('last_order', l.last_dt, 'days_silent', current_date - l.last_dt, 'items', l.items)
      from lapsed l
      on conflict (kind, qbo_customer_id, coalesce(qbo_item_id, ''), coalesce(week_start, '1900-01-01'::date))
      do update set evidence = excluded.evidence, detected_at = now()
        where ops.planning_exceptions.status <> 'kept'
      returning 1)
    select count(*) into v_lapsed from ins;

    -- a lapsed customer who has ordered again in the last 120 days is resolved
    with back as (
      select x.id from ops.planning_exceptions x
      join (select v.customer_ref_id, max(v.txn_date) last_dt
            from ops.v_sales_lines v join ops.inventory_settings s on s.qbo_item_id = v.item_ref_id and s.is_planner
            where v.quantity > 0 group by 1) cl on cl.customer_ref_id = x.qbo_customer_id
      where x.kind = 'lapsed_customer' and x.status = 'excluded' and cl.last_dt >= current_date - 120)
    update ops.planning_exceptions x set status = 'resolved', decided_at = now(), decided_by = 'detector: customer ordered again'
    from back where back.id = x.id;
    get diagnostics v_resolved = row_count;

    -- A spike is a week that is abnormal FOR THAT CUSTOMER (3× their median
    -- and at least half the item's normal week), or a one-off bulk buyer (≤3
    -- weeks of history, ≥ 2× the item's normal week). A distributor who always
    -- orders 50 is not a spike — that is the demand. (The first cut flagged any
    -- week ≥ 2× the item median regardless of the customer's own history, which
    -- caught every Origins order of a flavour Origins is most of the market for.)
    create temp table _spikes on commit drop as
    with cw as (
      select v.item_ref_id item, v.customer_ref_id cust, date_trunc('week', v.txn_date)::date ws,
             sum(case when i.txn_type in ('CreditMemo','RefundReceipt') then -v.quantity else v.quantity end) qty
      from ops.v_sales_lines v join ops.qbo_invoices i on i.id = v.invoice_id
      join ops.inventory_settings s on s.qbo_item_id = v.item_ref_id and s.is_planner
      left join ops.inventory_velocity_excludes e on e.qbo_customer_id = v.customer_ref_id
      where e.qbo_customer_id is null and v.quantity > 0
        and v.txn_date >= current_date - 728 and v.txn_date <= current_date
      group by 1, 2, 3),
    cust_med as (select item, cust, percentile_cont(0.5) within group (order by qty) med, count(*) n from cw where qty > 0 group by 1, 2),
    item_wk  as (select item, ws, sum(qty) qty from cw group by 1, 2),
    item_med as (select item, percentile_cont(0.5) within group (order by qty) med from item_wk where qty > 0 group by 1)
    select cw.item, cw.cust, cw.ws, cw.qty, cm.med cust_med, cm.n cust_weeks, im.med item_med
    from cw join cust_med cm using (item, cust) join item_med im using (item)
    where cw.qty >= 24
      and ((cw.qty >= 3 * cm.med and cw.qty >= 0.5 * im.med)
           or (cw.qty >= 2 * im.med and cm.n <= 3));

    with ins as (
      insert into ops.planning_exceptions (kind, qbo_customer_id, qbo_item_id, week_start, status, evidence)
      select 'volume_spike', s.cust, s.item, s.ws, 'excluded',
             jsonb_build_object('qty', s.qty, 'customer_median_week', round(s.cust_med::numeric, 1),
                                'customer_weeks', s.cust_weeks, 'item_median_week', round(s.item_med::numeric, 1))
      from _spikes s
      on conflict (kind, qbo_customer_id, coalesce(qbo_item_id, ''), coalesce(week_start, '1900-01-01'::date))
      do update set evidence = excluded.evidence, detected_at = now()
        where ops.planning_exceptions.status <> 'kept'
      returning 1)
    select count(*) into v_spikes from ins;

    -- an auto-detected spike that no longer qualifies is dropped (a human's
    -- 'kept' decision and manual rows are never touched)
    delete from ops.planning_exceptions x
     where x.kind = 'volume_spike' and x.status = 'excluded' and x.decided_at is null
       and not exists (select 1 from _spikes s where s.cust = x.qbo_customer_id and s.item = x.qbo_item_id and s.ws = x.week_start);
    get diagnostics v_cleared = row_count;

    insert into ops.sync_log (source, sync_type, status, started_at, completed_at, records_synced, metadata)
    values ('inventory', 'planning_exceptions', 'success', v_t0, now(), v_lapsed + v_spikes,
            jsonb_build_object('lapsed', v_lapsed, 'spikes', v_spikes, 'resolved', v_resolved, 'cleared', v_cleared));
  exception when others then
    v_err := sqlerrm;
    begin
      insert into ops.sync_log (source, sync_type, status, started_at, completed_at, error_message)
      values ('inventory', 'planning_exceptions', 'error', v_t0, now(), v_err);
    exception when others then null; end;
    raise;
  end;
  return jsonb_build_object('lapsed', v_lapsed, 'spikes', v_spikes, 'resolved', v_resolved, 'cleared', v_cleared);
end$$;
revoke all on function ops.fn_planning_exceptions_refresh() from public, anon;
grant execute on function ops.fn_planning_exceptions_refresh() to authenticated, service_role;

-- the report: every exception with names, newest first
create or replace function ops.fn_planning_exceptions_list()
returns table(id bigint, kind text, qbo_customer_id text, customer_name text, qbo_item_id text, item_name text,
              week_start date, status text, evidence jsonb, detected_at timestamptz, decided_at timestamptz, decided_by text, note text)
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
begin
  perform ops.fn_assert_internal();
  return query
    select x.id, x.kind, x.qbo_customer_id, c.display_name, x.qbo_item_id, i.name,
           x.week_start, x.status, x.evidence, x.detected_at, x.decided_at, x.decided_by, x.note
    from ops.planning_exceptions x
    left join ops.qbo_customers c on c.qbo_customer_id = x.qbo_customer_id
    left join ops.qbo_items i on i.qbo_item_id = x.qbo_item_id
    order by (x.status = 'excluded') desc, x.detected_at desc, x.id desc;
end$$;
revoke all on function ops.fn_planning_exceptions_list() from public, anon;
grant execute on function ops.fn_planning_exceptions_list() to authenticated, service_role;

-- keep / exclude, by a human; the decision is stamped and survives the detector
create or replace function ops.fn_planning_exception_set(p_id bigint, p_status text, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
begin
  perform ops.fn_assert_staff_or_service();
  if p_status not in ('excluded', 'kept') then raise exception 'status must be excluded or kept'; end if;
  update ops.planning_exceptions
     set status = p_status, note = coalesce(p_note, note), decided_at = now(),
         decided_by = coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'email', current_user)
   where id = p_id;
  if not found then raise exception 'exception % not found', p_id; end if;
end$$;
revoke all on function ops.fn_planning_exception_set(bigint, text, text) from public, anon;
grant execute on function ops.fn_planning_exception_set(bigint, text, text) to authenticated, service_role;

-- daily, after the 09:45 UTC items sync
select cron.unschedule(jobid) from cron.job where jobname = 'planning-exceptions-refresh';
select cron.schedule('planning-exceptions-refresh', '5 10 * * *', $cron$select ops.fn_planning_exceptions_refresh()$cron$);

-- ── 5. the smallest order, seeded for BIB ────────────────────────────────
-- BIB bill lines from the last two years run 5, 10, 20, 30, 40 … the smallest
-- one we have placed is the honest floor. Cans are Quantum tolling lines, not
-- run sizes, so they stay at 0 and the recap says so.
update ops.inventory_settings s
   set min_order_qty = so.q, updated_at = now()
  from (select e.item_ref_id, min(e.quantity) q
          from ops.qbo_expense_lines e
         where e.quantity > 0 and e.txn_date >= current_date - 730
         group by 1) so
 where so.item_ref_id = s.qbo_item_id
   and s.is_planner and s.inventory_lane = 'bib_product'
   and coalesce(s.min_order_qty, 0) = 0;

-- ── 6. fill plan — cylinders we fill, not stock ──────────────────────────
create table if not exists ops.planning_fill_items (
  qbo_item_id text primary key,
  label       text not null,
  active      boolean not null default true,
  sort_order  integer not null default 100,
  note        text
);
comment on table ops.planning_fill_items is
  'Gas cylinders the fill plan forecasts by week (no on-hand: we fill to demand). Staff-editable.';
alter table ops.planning_fill_items enable row level security;
drop policy if exists planning_fill_items_read on ops.planning_fill_items;
create policy planning_fill_items_read on ops.planning_fill_items for select to authenticated
  using (ops.fn_is_staff() or not ops.fn_is_distributor());
drop policy if exists planning_fill_items_write on ops.planning_fill_items;
create policy planning_fill_items_write on ops.planning_fill_items for all to authenticated
  using (ops.fn_is_staff()) with check (ops.fn_is_staff());
revoke all on ops.planning_fill_items from public, anon;
grant select, insert, update, delete on ops.planning_fill_items to authenticated;
grant all on ops.planning_fill_items to service_role;

insert into ops.planning_fill_items (qbo_item_id, label, active, sort_order, note) values
  ('145', '20 lb CO₂ cylinder',        true,  10, 'CO8011'),
  ('544', '20 lb mixed gas cylinder',  true,  20, 'BR8021 SMALL MIX GAS'),
  ('546', 'Small nitrogen cylinder',   false, 30, 'NI8031 — not asked for; flip active to plan it')
on conflict (qbo_item_id) do nothing;

-- per fill item per week: actual, last year aligned, forecast, weekly par
create or replace function ops.fn_planning_fill_plan(p_weeks_back integer default 8, p_weeks_ahead integer default 3)
returns table(qbo_item_id text, label text, week_start date, is_current boolean, is_future boolean,
              this_year_qty numeric, last_year_qty numeric, recent_avg numeric, growth_pct numeric,
              forecast_qty numeric, weekly_par numeric, holiday text)
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_this_mon date := date_trunc('week', current_date)::date;
  v_from date := v_this_mon - 7 * greatest(p_weeks_back, 1);
  v_to   date := v_this_mon + 7 * greatest(p_weeks_ahead, 1) - 1;
begin
  perform ops.fn_assert_internal();
  return query
  with fi as (select f.qbo_item_id, f.label, f.sort_order from ops.planning_fill_items f where f.active),
  sales as (
    select v.item_ref_id item, v.txn_date d,
           sum(case when i.txn_type in ('CreditMemo','RefundReceipt') then -v.quantity else v.quantity end) qty
    from ops.v_sales_lines v join ops.qbo_invoices i on i.id = v.invoice_id
    join fi on fi.qbo_item_id = v.item_ref_id
    left join ops.inventory_velocity_excludes e on e.qbo_customer_id = v.customer_ref_id
    where e.qbo_customer_id is null and v.quantity > 0 and v.txn_date <= current_date
      and v.txn_date >= v_from - 800
      and not exists (select 1 from ops.planning_exceptions x
                       where x.status = 'excluded' and x.qbo_item_id is null and x.week_start is null
                         and x.qbo_customer_id = v.customer_ref_id)
    group by 1, 2),
  dm as (select * from ops.fn_planning_daymap(v_from, v_to)),
  weeks as (select generate_series(v_from, v_to, interval '7 days')::date ws),
  grid as (select fi.qbo_item_id, fi.label, fi.sort_order, w.ws from fi cross join weeks w),
  ty as (select g.qbo_item_id, g.ws, sum(s.qty) q from grid g join sales s on s.item = g.qbo_item_id and s.d between g.ws and g.ws + 6 group by 1, 2),
  ly as (select g.qbo_item_id, g.ws, sum(s.qty) q, max(dm.holiday_name) hol
         from grid g join dm on dm.d between g.ws and g.ws + 6
         left join sales s on s.item = g.qbo_item_id and s.d = dm.ref_date group by 1, 2),
  -- the 8 complete weeks before this one
  recent as (
    select g.qbo_item_id, avg(coalesce(ty.q, 0)) avg_q, stddev_samp(coalesce(ty.q, 0)) sd_q
    from grid g left join ty on ty.qbo_item_id = g.qbo_item_id and ty.ws = g.ws
    where g.ws < v_this_mon and g.ws >= v_this_mon - 56 group by 1),
  -- growth: the same 8 weeks vs their aligned weeks last year
  gro as (
    select g.qbo_item_id, sum(coalesce(ty.q, 0)) t, sum(coalesce(ly.q, 0)) l
    from grid g left join ty on ty.qbo_item_id = g.qbo_item_id and ty.ws = g.ws
    left join ly on ly.qbo_item_id = g.qbo_item_id and ly.ws = g.ws
    where g.ws < v_this_mon and g.ws >= v_this_mon - 56 group by 1)
  select g.qbo_item_id, g.label, g.ws,
         g.ws = v_this_mon, g.ws > v_this_mon,
         ty.q, ly.q, round(r.avg_q, 1),
         case when gro.l >= 10 then round(100 * greatest(-0.5, least(0.5, (gro.t - gro.l) / gro.l)), 1) end,
         case when g.ws >= v_this_mon then
           round(case when ly.q is not null and gro.l >= 10
                      then 0.5 * r.avg_q + 0.5 * ly.q * (1 + greatest(-0.5, least(0.5, (gro.t - gro.l) / gro.l)))
                      else r.avg_q end, 0) end,
         case when g.ws >= v_this_mon then
           ceil(case when ly.q is not null and gro.l >= 10
                      then 0.5 * r.avg_q + 0.5 * ly.q * (1 + greatest(-0.5, least(0.5, (gro.t - gro.l) / gro.l)))
                      else r.avg_q end + 1.65 * coalesce(r.sd_q, 0)) end,
         ly.hol
  from grid g
  left join ty on ty.qbo_item_id = g.qbo_item_id and ty.ws = g.ws
  left join ly on ly.qbo_item_id = g.qbo_item_id and ly.ws = g.ws
  left join recent r on r.qbo_item_id = g.qbo_item_id
  left join gro on gro.qbo_item_id = g.qbo_item_id
  order by g.sort_order, g.ws;
end$$;
revoke all on function ops.fn_planning_fill_plan(integer, integer) from public, anon;
grant execute on function ops.fn_planning_fill_plan(integer, integer) to authenticated, service_role;

-- ── 3b. growth clamp ±50% ────────────────────────────────────────────────
-- 20260904g clamped growth to −50%…+100%. The moment a lapsed bulk buyer left
-- the last-year base, every case item hit +100% — a thin base reads as a
-- doubling market. ±50% keeps a real trend and stops a hole in last year from
-- doubling next month's forecast. Same clamp in fn_planning_fill_plan.
create or replace function ops.fn_planning_yoy()
returns table (qbo_item_id text, ty_qty numeric, ly_qty numeric, growth numeric)
language sql stable
set search_path to 'ops', 'public'
as $$
  with win as (
    select (date_trunc('week', current_date)::date - 91) as from_d,
           (date_trunc('week', current_date)::date - 1)  as to_d
  ),
  dm as (select * from ops.fn_planning_daymap((select from_d from win), (select to_d from win))),
  ty as (
    select s.qbo_item_id, sum(s.qty) as qty
    from ops.v_planning_daily_sales s
    where s.d between (select from_d from win) and (select to_d from win)
    group by 1
  ),
  ly as (
    select s.qbo_item_id, sum(s.qty) as qty
    from dm join ops.v_planning_daily_sales s on s.d = dm.ref_date
    group by 1
  ),
  items as (select qbo_item_id from ops.inventory_settings where is_planner)
  select i.qbo_item_id,
         coalesce(ty.qty, 0),
         coalesce(ly.qty, 0),
         case when coalesce(ly.qty, 0) >= 10
              then greatest(-0.5, least(0.5, coalesce(ty.qty, 0) / ly.qty - 1))
              else null end
  from items i
  left join ty on ty.qbo_item_id = i.qbo_item_id
  left join ly on ly.qbo_item_id = i.qbo_item_id;
$$;
revoke all on function ops.fn_planning_yoy() from public, anon, authenticated;
grant execute on function ops.fn_planning_yoy() to service_role;

-- ── 4. pars + smallest order on the items master ─────────────────────────
-- fn_items_master__i is the guarded inner (20260820b rule); it is rebuilt here
-- with three more columns and the wrapper re-minted with an explicit RETURNS
-- TABLE. Body copied from 20260904g with the additions marked 20260904h.
drop function if exists ops.fn_items_master(integer, text, boolean);
drop function if exists ops.fn_items_master__i(integer, text, boolean);

create function ops.fn_items_master__i(p_lookback_days integer default 90, p_search text default null, p_managed_only boolean default false)
returns table(
  qbo_item_id text, item_name text, fully_qualified_name text, active boolean, category_path text, category_override text, category_resolved text,
  income_account_name text, expense_account_name text, on_hand numeric, unit_price numeric, purchase_cost numeric, is_managed boolean, is_planner boolean,
  target_days_supply integer, lead_time_days integer, reorder_point numeric, min_order_qty numeric, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer, purchased_qty numeric, purchased_cost numeric, adjustment_qty numeric, shrinkage_qty numeric,
  qty_on_order numeric, suggested_order_qty numeric, suggested_order_cycle_days numeric, daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text, product_type_code text, product_type_label text, segment_code text, segment_label text, segment_source text,
  track_locations boolean, has_bom boolean, inventory_lane text, inventory_lane_size text, inventory_lane_source text, inventory_lane_reviewed boolean,
  default_receiving_location_id uuid, qbo_on_hand numeric, brix_on_hand numeric, planning_on_hand numeric, on_hand_drift numeric,
  -- 20260904f
  velocity_28d numeric, velocity_lookback numeric, velocity_trend_pct numeric, consumed_qty numeric, qty_inbound numeric, days_of_cover numeric,
  -- 20260904g
  planning_velocity numeric, forecast_daily numeric, forecast_window_days integer, forecast_window_qty numeric, ly_window_qty numeric,
  yoy_growth_pct numeric, weekly_sigma numeric, safety_stock numeric, reorder_point_calc numeric, stockout_date date, order_by_date date,
  par_min numeric, par_max numeric, smallest_order_qty numeric
)
language sql stable security definer
set search_path to 'ops', 'public'
as $$
  WITH params AS (
    SELECT (current_date - GREATEST(p_lookback_days, 1))::date AS d,
           (current_date - LEAST(GREATEST(p_lookback_days, 1), 28))::date AS d28,
           GREATEST(p_lookback_days, 1)::numeric AS lb,
           LEAST(GREATEST(p_lookback_days, 1), 28)::numeric AS lb28
  ),
  excludes AS (SELECT qbo_customer_id FROM ops.inventory_velocity_excludes),
  -- Sales: invoices + sales receipts add, credit memos + refund receipts
  -- subtract (v_sales_lines carries returns with a positive quantity), nothing
  -- dated after today.
  sold AS (
    SELECT v.item_ref_id AS qbo_item_id,
      sum(CASE WHEN i.txn_type IN ('CreditMemo', 'RefundReceipt') THEN -v.quantity ELSE v.quantity END)::numeric AS qty,
      sum(CASE WHEN i.txn_type IN ('CreditMemo', 'RefundReceipt') THEN -v.quantity ELSE v.quantity END)
        FILTER (WHERE v.txn_date >= (SELECT d28 FROM params))::numeric AS qty28,
      sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    JOIN ops.qbo_invoices i ON i.id = v.invoice_id
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM params) AND v.txn_date <= current_date AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  consumed AS (
    SELECT m.qbo_item_id,
      sum(m.qty)::numeric AS qty,
      sum(m.qty) FILTER (WHERE m.occurred_at >= (SELECT d28 FROM params))::numeric AS qty28
    FROM ops.inventory_movements m
    LEFT JOIN ops.inventory_locations tl ON tl.id = m.to_location_id
    WHERE m.occurred_at >= (SELECT d FROM params)
      AND m.qbo_item_id IS NOT NULL
      AND (
        m.movement_type = 'production_consume'
        OR (m.source_doc_type = 'repack' AND m.movement_type = 'adjustment' AND m.from_location_id IS NOT NULL AND tl.kind = 'adjustment')
      )
    GROUP BY 1
  ),
  purch AS (
    SELECT m.qbo_item_id,
      sum(m.qty)::numeric AS qty,
      sum(m.qty * COALESCE(m.unit_cost, 0))::numeric AS cost
    FROM ops.inventory_movements m
    WHERE m.movement_type = 'receipt'
      AND m.occurred_at >= (SELECT d FROM params)
      AND m.qbo_item_id IS NOT NULL
    GROUP BY 1
  ),
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(a.qty_diff)::numeric AS adjustment_qty,
      sum(CASE WHEN a.qty_diff < 0 THEN abs(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL AND a.txn_date >= (SELECT d FROM params)
    GROUP BY 1
  ),
  brix_stock AS (
    SELECT oh.qbo_item_id,
      sum(oh.on_hand)::numeric AS qty_all,
      sum(oh.on_hand) FILTER (WHERE loc.kind IN ('warehouse', 'distributor'))::numeric AS qty_sellable,
      sum(oh.on_hand) FILTER (WHERE loc.kind IN ('co_packer', 'in_transit'))::numeric AS qty_inbound
    FROM ops.v_inventory_on_hand oh
    JOIN ops.inventory_locations loc ON loc.id = oh.location_id
    WHERE loc.kind <> 'adjustment'
    GROUP BY 1
  ),
  on_order AS (
    SELECT l.qbo_item_id,
      sum(GREATEST(l.qty_ordered - l.qty_received, 0))::numeric AS qty_pending
    FROM ops.purchase_order_lines l
    JOIN ops.purchase_orders p ON p.id = l.po_id
    WHERE p.status IN ('draft', 'open', 'partial', 'received')
      AND l.receivable
    GROUP BY 1
  ),
  -- ── planner-only intelligence ───────────────────────────────────────────
  planner AS (
    SELECT s.qbo_item_id,
           COALESCE(s.lead_time_days, 7) AS lead_d,
           COALESCE(s.target_days_supply, 30) AS target_d,
           COALESCE(s.lead_time_days, 7) + COALESCE(s.target_days_supply, 30) AS window_d
    FROM ops.inventory_settings s WHERE s.is_planner
  ),
  daymap AS (
    SELECT * FROM ops.fn_planning_daymap(current_date, current_date + (SELECT COALESCE(max(window_d), 0) FROM planner))
  ),
  ly_window AS (
    -- last year's units over each item's coming lead + target window, aligned
    SELECT p.qbo_item_id,
           sum(s.qty) AS qty,
           bool_and(dm.ref_date >= (SELECT min(x.d) FROM ops.v_planning_daily_sales x)) AS covered
    FROM planner p
    JOIN daymap dm ON dm.d BETWEEN current_date AND current_date + p.window_d - 1
    LEFT JOIN ops.v_planning_daily_sales s ON s.qbo_item_id = p.qbo_item_id AND s.d = dm.ref_date
    GROUP BY 1
  ),
  yoy AS (SELECT * FROM ops.fn_planning_yoy()),
  -- weekly demand over the trailing 13 complete weeks, zero weeks included
  weeks AS (
    SELECT (date_trunc('week', current_date)::date - 7 * g) AS ws FROM generate_series(1, 13) g
  ),
  wk AS (
    SELECT p.qbo_item_id, w.ws, COALESCE(sum(s.qty), 0) AS q
    FROM planner p
    CROSS JOIN weeks w
    LEFT JOIN ops.v_planning_daily_sales s ON s.qbo_item_id = p.qbo_item_id AND s.d BETWEEN w.ws AND w.ws + 6
    GROUP BY 1, 2
  ),
  sigma AS (
    SELECT qbo_item_id, stddev_samp(q) AS sd FROM wk GROUP BY 1
  ),
  base AS (
    SELECT
      it.*,
      s.category_override,
      COALESCE(s.is_managed, false) AS is_managed_resolved,
      COALESCE(s.is_planner, false) AS is_planner_resolved,
      COALESCE(s.target_days_supply, 30) AS target_days_supply_resolved,
      COALESCE(s.lead_time_days, 7) AS lead_time_days_resolved,
      s.reorder_point,
      s.min_order_qty,
      s.notes,
      COALESCE(s.track_locations, false) AS track_locations_resolved,
      COALESCE(s.has_bom, false) AS has_bom_resolved,
      COALESCE(s.inventory_lane, 'excluded') AS inventory_lane_resolved,
      s.inventory_lane_size,
      COALESCE(s.inventory_lane_source, 'auto') AS inventory_lane_source_resolved,
      COALESCE(s.inventory_lane_reviewed, false) AS inventory_lane_reviewed_resolved,
      s.default_receiving_location_id,
      COALESCE(it.qty_on_hand, 0)::numeric AS qbo_on_hand,
      COALESCE(brix_stock.qty_all, 0)::numeric AS brix_on_hand,
      CASE
        WHEN COALESCE(s.track_locations, false) THEN COALESCE(brix_stock.qty_sellable, 0)::numeric
        ELSE COALESCE(it.qty_on_hand, 0)::numeric
      END AS planning_on_hand,
      CASE WHEN COALESCE(s.track_locations, false) THEN COALESCE(brix_stock.qty_inbound, 0)::numeric ELSE 0::numeric END AS stock_inbound
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
    LEFT JOIN brix_stock ON brix_stock.qbo_item_id = it.qbo_item_id
  ),
  calc AS (
    SELECT
      b.*,
      COALESCE(sold.qty, 0) AS sold_qty_c, COALESCE(sold.revenue, 0) AS sold_rev_c, COALESCE(sold.customers_count, 0) AS customers_c,
      COALESCE(consumed.qty, 0) AS consumed_c,
      COALESCE(purch.qty, 0) AS purch_qty_c, COALESCE(purch.cost, 0) AS purch_cost_c,
      COALESCE(adj.adjustment_qty, 0) AS adj_c, COALESCE(adj.shrink_qty, 0) AS shrink_c,
      COALESCE(on_order.qty_pending, 0) AS on_order_c,
      COALESCE(on_order.qty_pending, 0) + b.stock_inbound AS inbound_c,
      (COALESCE(sold.qty, 0) + COALESCE(consumed.qty, 0)) / (SELECT lb FROM params) AS rate_lb,
      (COALESCE(sold.qty28, 0) + COALESCE(consumed.qty28, 0)) / (SELECT lb28 FROM params) AS rate_28,
      -- planner intelligence (NULL on non-planner items)
      p.window_d,
      CASE WHEN p.qbo_item_id IS NOT NULL AND lyw.covered AND lyw.qty IS NOT NULL THEN lyw.qty END AS ly_window_c,
      yoy.growth AS growth_c,
      sigma.sd AS sigma_c
    FROM base b
    LEFT JOIN sold     ON sold.qbo_item_id     = b.qbo_item_id
    LEFT JOIN consumed ON consumed.qbo_item_id = b.qbo_item_id
    LEFT JOIN purch    ON purch.qbo_item_id    = b.qbo_item_id
    LEFT JOIN adj      ON adj.qbo_item_id      = b.qbo_item_id
    LEFT JOIN on_order ON on_order.qbo_item_id = b.qbo_item_id
    LEFT JOIN planner p   ON p.qbo_item_id     = b.qbo_item_id
    LEFT JOIN ly_window lyw ON lyw.qbo_item_id = b.qbo_item_id
    LEFT JOIN yoy      ON yoy.qbo_item_id      = b.qbo_item_id
    LEFT JOIN sigma    ON sigma.qbo_item_id    = b.qbo_item_id
  ),
  vel AS (
    SELECT c.*,
      CASE WHEN (SELECT lb FROM params) > 28 THEN 0.6 * c.rate_28 + 0.4 * c.rate_lb ELSE c.rate_lb END AS velocity,
      CASE WHEN c.ly_window_c IS NOT NULL AND c.window_d > 0
           THEN c.ly_window_c * (1 + COALESCE(c.growth_c, 0)) / c.window_d END AS forecast_daily_c
    FROM calc c
  ),
  -- 20260904h: the smallest quantity we have actually bought in 24 months
  smallest AS (
    SELECT e.item_ref_id, min(e.quantity) AS q
    FROM ops.qbo_expense_lines e
    WHERE e.quantity > 0 AND e.txn_date >= current_date - 730
    GROUP BY 1
  ),
  plan AS (
    SELECT v.*,
      -- the rate the plan runs on: half what we are selling now, half what last
      -- year says the coming weeks look like (grown), when last year is there
      CASE WHEN v.forecast_daily_c IS NOT NULL THEN 0.5 * v.velocity + 0.5 * v.forecast_daily_c ELSE v.velocity END AS prate,
      -- 95% service on the demand seen during one lead time
      CASE WHEN v.sigma_c IS NOT NULL THEN 1.65 * (v.sigma_c / sqrt(7.0)) * sqrt(v.lead_time_days_resolved::numeric) ELSE 0::numeric END AS safety_raw
    FROM vel v
  ),
  fin AS (
    SELECT p.*,
      -- ⚠ capped at one lead time of demand: on an 8-pack selling 1.3 a week,
      -- one 40-pack order makes the weekly σ 11.6 and the raw formula asks for
      -- 33 units of safety stock against a demand of 4 a lead time — months of
      -- "safety" on an item that barely moves. The cap keeps safety stock a
      -- fraction of the plan, never a multiple of it.
      LEAST(p.safety_raw, p.lead_time_days_resolved * p.prate) AS safety_c,
      COALESCE(p.reorder_point, LEAST(p.safety_raw, p.lead_time_days_resolved * p.prate) + p.lead_time_days_resolved * p.prate) AS rop,
      p.planning_on_hand + p.inbound_c AS cover_units
    FROM plan p
  )
  SELECT
    it.qbo_item_id, COALESCE(it.name, it.fully_qualified_name), it.fully_qualified_name,
    COALESCE(it.active, true)::boolean,
    it.category_path, it.category_override,
    COALESCE(it.category_override, it.category_path, 'Uncategorized'),
    it.income_account_name, it.expense_account_name,
    it.planning_on_hand, it.unit_price, it.purchase_cost,
    it.is_managed_resolved, it.is_planner_resolved,
    it.target_days_supply_resolved, it.lead_time_days_resolved,
    it.reorder_point, it.min_order_qty, it.notes,
    it.sold_qty_c, it.sold_rev_c, it.customers_c,
    it.purch_qty_c, it.purch_cost_c,
    it.adj_c, it.shrink_c,
    it.on_order_c AS qty_on_order,
    CASE
      WHEN COALESCE(it.active, true) = false THEN NULL
      WHEN it.prate <= 0 THEN NULL
      -- 20260904h: the minimum order is a FLOOR on an order that is needed, never a
      -- reason to order — an item with cover to spare suggests 0, not its MOQ.
      WHEN ceil((it.target_days_supply_resolved + it.lead_time_days_resolved) * it.prate + it.safety_c - it.planning_on_hand - it.inbound_c) <= 0 THEN 0
      ELSE GREATEST(
        ceil((it.target_days_supply_resolved + it.lead_time_days_resolved) * it.prate + it.safety_c - it.planning_on_hand - it.inbound_c),
        COALESCE(it.min_order_qty, 0), 0)
    END AS suggested_order_qty,
    it.target_days_supply_resolved::numeric AS suggested_order_cycle_days,
    round(it.velocity, 4) AS daily_velocity,
    CASE WHEN it.prate > 0 THEN round(it.planning_on_hand / it.prate, 1) ELSE NULL END AS days_of_supply,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN it.prate <= 0 THEN 'idle'
      WHEN it.planning_on_hand <= 0 THEN 'critical'
      WHEN it.cover_units <= it.rop THEN 'reorder'
      WHEN it.cover_units <= it.rop + 7 * it.prate THEN 'reorder_soon'
      WHEN it.planning_on_hand / it.prate > (it.target_days_supply_resolved + it.lead_time_days_resolved) * 3 THEN 'overstock'
      ELSE 'ok'
    END AS status,
    ipf.family_code, pf.label,
    ipt.type_code, pt.label,
    COALESCE(seg_item.segment_code, seg_cat.segment_code),
    COALESCE(s_item_seg.label, s_cat_seg.label),
    CASE
      WHEN seg_item.segment_code IS NOT NULL THEN 'item'
      WHEN seg_cat.segment_code  IS NOT NULL THEN 'category'
      ELSE NULL
    END,
    it.track_locations_resolved,
    it.has_bom_resolved,
    it.inventory_lane_resolved,
    it.inventory_lane_size,
    it.inventory_lane_source_resolved,
    it.inventory_lane_reviewed_resolved,
    it.default_receiving_location_id,
    it.qbo_on_hand,
    it.brix_on_hand,
    it.planning_on_hand,
    it.brix_on_hand - it.qbo_on_hand AS on_hand_drift,
    round(it.rate_28, 4) AS velocity_28d,
    round(it.rate_lb, 4) AS velocity_lookback,
    CASE WHEN it.rate_lb > 0 THEN round((it.rate_28 - it.rate_lb) / it.rate_lb * 100, 1) ELSE NULL END AS velocity_trend_pct,
    it.consumed_c AS consumed_qty,
    it.inbound_c AS qty_inbound,
    CASE WHEN it.prate > 0 THEN round(it.cover_units / it.prate, 1) ELSE NULL END AS days_of_cover,
    -- 20260904g
    round(it.prate, 4) AS planning_velocity,
    round(it.forecast_daily_c, 4) AS forecast_daily,
    it.window_d AS forecast_window_days,
    CASE WHEN it.forecast_daily_c IS NOT NULL THEN round(it.forecast_daily_c * it.window_d, 0) END AS forecast_window_qty,
    it.ly_window_c AS ly_window_qty,
    CASE WHEN it.growth_c IS NOT NULL THEN round(it.growth_c * 100, 1) END AS yoy_growth_pct,
    CASE WHEN it.sigma_c IS NOT NULL THEN round(it.sigma_c, 2) END AS weekly_sigma,
    CASE WHEN it.is_planner_resolved THEN round(it.safety_c, 1) END AS safety_stock,
    CASE WHEN it.is_planner_resolved AND it.prate > 0 THEN round(it.rop, 1) END AS reorder_point_calc,
    CASE WHEN it.is_planner_resolved AND it.prate > 0
         THEN current_date + floor(it.cover_units / it.prate)::int END AS stockout_date,
    CASE WHEN it.is_planner_resolved AND it.prate > 0
         THEN current_date + floor(it.cover_units / it.prate)::int - it.lead_time_days_resolved - floor(it.safety_c / it.prate)::int END AS order_by_date,
    -- 20260904h: pars. par_min = order when stock + inbound reaches it (the
    -- reorder point); par_max = the level an order brings you back to.
    CASE WHEN it.is_planner_resolved AND it.prate > 0 THEN round(it.rop, 0) END AS par_min,
    CASE WHEN it.is_planner_resolved AND it.prate > 0
         THEN ceil((it.target_days_supply_resolved + it.lead_time_days_resolved) * it.prate + it.safety_c) END AS par_max,
    so.q AS smallest_order_qty
  FROM fin it
  LEFT JOIN smallest so ON so.item_ref_id = it.qbo_item_id
  LEFT JOIN ops.account_settings acct ON acct.account_name = it.income_account_name
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  LEFT JOIN ops.item_segments     seg_item ON seg_item.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.segments        s_item_seg ON s_item_seg.segment_code = seg_item.segment_code AND s_item_seg.is_active
  LEFT JOIN ops.category_segments  seg_cat ON seg_cat.category = COALESCE(it.category_override, it.category_path)
  LEFT JOIN ops.segments         s_cat_seg ON s_cat_seg.segment_code = seg_cat.segment_code AND s_cat_seg.is_active
  WHERE
    COALESCE(it.type, '') NOT IN ('Category', 'Group')
    AND (NOT p_managed_only OR it.is_managed_resolved)
    AND COALESCE(acct.is_active, true)
    AND (
      p_search IS NULL OR p_search = '' OR
      it.name ILIKE '%' || p_search || '%' OR
      it.fully_qualified_name ILIKE '%' || p_search || '%' OR
      COALESCE(it.category_override, it.category_path) ILIKE '%' || p_search || '%'
    )
  ORDER BY
    COALESCE(it.active, true) DESC,
    COALESCE(it.category_override, it.category_path) NULLS LAST,
    it.name;
$$;
revoke all on function ops.fn_items_master__i(integer, text, boolean) from public, anon, authenticated;
grant execute on function ops.fn_items_master__i(integer, text, boolean) to service_role;

-- the guard wrapper, re-minted in the 20260820b shape (fn_assert_internal)
create function ops.fn_items_master(p_lookback_days integer default 90, p_search text default null, p_managed_only boolean default false)
returns table(
  qbo_item_id text, item_name text, fully_qualified_name text, active boolean, category_path text, category_override text, category_resolved text,
  income_account_name text, expense_account_name text, on_hand numeric, unit_price numeric, purchase_cost numeric, is_managed boolean, is_planner boolean,
  target_days_supply integer, lead_time_days integer, reorder_point numeric, min_order_qty numeric, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer, purchased_qty numeric, purchased_cost numeric, adjustment_qty numeric, shrinkage_qty numeric,
  qty_on_order numeric, suggested_order_qty numeric, suggested_order_cycle_days numeric, daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text, product_type_code text, product_type_label text, segment_code text, segment_label text, segment_source text,
  track_locations boolean, has_bom boolean, inventory_lane text, inventory_lane_size text, inventory_lane_source text, inventory_lane_reviewed boolean,
  default_receiving_location_id uuid, qbo_on_hand numeric, brix_on_hand numeric, planning_on_hand numeric, on_hand_drift numeric,
  velocity_28d numeric, velocity_lookback numeric, velocity_trend_pct numeric, consumed_qty numeric, qty_inbound numeric, days_of_cover numeric,
  planning_velocity numeric, forecast_daily numeric, forecast_window_days integer, forecast_window_qty numeric, ly_window_qty numeric,
  yoy_growth_pct numeric, weekly_sigma numeric, safety_stock numeric, reorder_point_calc numeric, stockout_date date, order_by_date date,
  par_min numeric, par_max numeric, smallest_order_qty numeric
)
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$-- GENERATED GUARD WRAPPER (20260820b shape, re-minted 20260904h) — the real body lives in ops.fn_items_master__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN QUERY SELECT * FROM ops.fn_items_master__i($1, $2, $3); END$$;
revoke all on function ops.fn_items_master(integer, text, boolean) from public, anon;
grant execute on function ops.fn_items_master(integer, text, boolean) to authenticated, service_role;
