-- 20260904i_planner_v4.sql
-- Inventory Planning v4 — the four predictive tools built into the forecast.
--
-- Ask (Sky, 2026-09-04): "Ok build the other stuff into the predictions" — the
-- four tools proposed after v3:
--   1. Customer cadence — who is due to order this week, and what they usually
--      take. Fed into the plan as due_demand_7d and a "Customers Due" tab.
--   2. New-customer ramp — a store that opened this year has no last-year
--      baseline, so the aligned forecast could not see it. 55–66% of the last
--      eight weeks' case sales came from customers new in the last year.
--      Growth is now measured on RETURNING customers only and the new
--      customers' run rate is added on top.
--   3. Lead time from history — measured ordered → received from purchase
--      orders (native and QuickBooks-mirrored) and work orders; used when there
--      are three or more samples, else the typed setting. No history exists
--      yet, so today every item reads 'setting'.
--   4. Forecast accuracy — every Monday the coming week's forecast is written
--      to ops.planning_forecast_log; actuals are scored against it. For the
--      weeks before the log existed a BACKTEST recomputes what the formula
--      would have said using only data before that week.
--
-- Applied live 2026-09-04 in four steps, all via apply_migration:
--   planner_v4_cadence_newcust_leadtime_accuracy  (everything above section 8)
--   planner_v4_items_master_rebuild               (section 8 — as an anchor-checked
--       read-modify-write of the LIVE fn_items_master__i: ten anchors, each
--       asserted to match exactly once, then EXECUTE; wrapper re-minted)
--   planner_v4_materialize_ctes                   (⚠ the first cut of due_demand /
--       cadence ran past 55 s and timed the items master out — the planner
--       estimates v_planning_daily_sales_cust at one row and re-runs it per
--       joined row; every CTE in yoy / cadence / due_demand is MATERIALIZED)
--   planner_v4_suggested_covers_due_demand        (the suggested order is at
--       least due demand − cover; REORDER with a suggestion of 0 was a contradiction)
-- This file is the repo copy of the same end state.

-- ── customer-level daily sales, same exclusions as v_planning_daily_sales ──
create or replace view ops.v_planning_daily_sales_cust
with (security_invoker = true) as
select v.item_ref_id as qbo_item_id,
       v.customer_ref_id,
       v.txn_date as d,
       sum(case when i.txn_type in ('CreditMemo', 'RefundReceipt') then -v.quantity else v.quantity end)::numeric as qty
from ops.v_sales_lines v
join ops.qbo_invoices i on i.id = v.invoice_id
left join ops.inventory_settings s on s.qbo_item_id = v.item_ref_id
left join ops.planning_fill_items f on f.qbo_item_id = v.item_ref_id and f.active
left join ops.inventory_velocity_excludes e on e.qbo_customer_id = v.customer_ref_id
where (s.is_planner or f.qbo_item_id is not null)
  and e.qbo_customer_id is null
  and v.item_ref_id is not null and v.customer_ref_id is not null
  and v.quantity is not null and v.quantity > 0
  and v.txn_date <= current_date
  and not exists (
    select 1 from ops.planning_exceptions x
    where x.status = 'excluded'
      and x.qbo_customer_id = v.customer_ref_id
      and (x.qbo_item_id is null or x.qbo_item_id = v.item_ref_id)
      and (x.week_start is null or v.txn_date between x.week_start and x.week_start + 6)
  )
group by 1, 2, 3;
comment on view ops.v_planning_daily_sales_cust is
  'Planner + fill items, per customer per day, with the same excludes and exceptions as v_planning_daily_sales. Read by the cadence, new-customer and growth functions (SECURITY DEFINER).';
revoke all on ops.v_planning_daily_sales_cust from public, anon, authenticated;
grant select on ops.v_planning_daily_sales_cust to service_role;

-- ── 2. growth on returning customers + the new-customer run rate ──────────
drop function if exists ops.fn_planning_yoy();
create function ops.fn_planning_yoy()
returns table (qbo_item_id text, ty_qty numeric, ly_qty numeric, growth numeric,
               ty_returning_qty numeric, new_customer_qty_56 numeric, new_customer_daily numeric, new_customers integer)
language sql stable
set search_path to 'ops', 'public'
as $$
  with win as (
    select (date_trunc('week', current_date)::date - 91) as from_d,
           (date_trunc('week', current_date)::date - 1)  as to_d
  ),
  dm as (select * from ops.fn_planning_daymap((select from_d from win), (select to_d from win))),
  items as (select qbo_item_id from ops.inventory_settings where is_planner),
  -- who bought this item at all in the last-year YEAR (364–728 days ago)
  ly_year_cust as materialized (
    select distinct s.qbo_item_id, s.customer_ref_id
    from ops.v_planning_daily_sales_cust s
    where s.d >= current_date - 728 and s.d < current_date - 364
  ),
  ty as materialized (
    select s.qbo_item_id,
           sum(s.qty) as qty,
           sum(s.qty) filter (where ly.customer_ref_id is not null) as qty_returning
    from ops.v_planning_daily_sales_cust s
    left join ly_year_cust ly on ly.qbo_item_id = s.qbo_item_id and ly.customer_ref_id = s.customer_ref_id
    where s.d between (select from_d from win) and (select to_d from win)
    group by 1
  ),
  ly as materialized (
    select s.qbo_item_id, sum(s.qty) as qty
    from dm join ops.v_planning_daily_sales_cust s on s.d = dm.ref_date
    group by 1
  ),
  -- customers NEW TO THE ITEM: buying it in the last 56 days, never in the LY year
  newc as materialized (
    select s.qbo_item_id, sum(s.qty) as qty, count(distinct s.customer_ref_id) as n
    from ops.v_planning_daily_sales_cust s
    left join ly_year_cust ly on ly.qbo_item_id = s.qbo_item_id and ly.customer_ref_id = s.customer_ref_id
    where s.d > current_date - 56 and s.d <= current_date and ly.customer_ref_id is null
    group by 1
  )
  select i.qbo_item_id,
         coalesce(ty.qty, 0),
         coalesce(ly.qty, 0),
         -- growth of the customers who were there last year, clamped ±50%
         case when coalesce(ly.qty, 0) >= 10
              then greatest(-0.5, least(0.5, coalesce(ty.qty_returning, 0) / ly.qty - 1))
              else null end,
         coalesce(ty.qty_returning, 0),
         coalesce(newc.qty, 0),
         round(coalesce(newc.qty, 0) / 56.0, 4),
         coalesce(newc.n, 0)::int
  from items i
  left join ty on ty.qbo_item_id = i.qbo_item_id
  left join ly on ly.qbo_item_id = i.qbo_item_id
  left join newc on newc.qbo_item_id = i.qbo_item_id;
$$;
comment on function ops.fn_planning_yoy() is
  '20260904i: growth is measured on RETURNING customers (bought the item 364–728 days ago) so a customer who arrived this year cannot read as growth of last year''s base; their run rate rides separately as new_customer_daily. Both feed the forecast: LY aligned × (1 + growth) + new_customer_daily × days.';
revoke all on function ops.fn_planning_yoy() from public, anon, authenticated;
grant execute on function ops.fn_planning_yoy() to service_role;

-- the weekly view carries the new-customer rate into the forecast too
create or replace function ops.fn_planning_weekly(p_qbo_item_id text, p_weeks_back integer default 13, p_weeks_ahead integer default 8)
returns table (
  week_start date, is_current boolean, is_future boolean,
  this_year_qty numeric, last_year_qty numeric, forecast_qty numeric,
  holiday text, growth_pct numeric
)
language plpgsql stable security definer
set search_path to 'ops', 'pg_temp'
as $$
DECLARE
  v_from date := date_trunc('week', current_date)::date - 7 * greatest(least(p_weeks_back, 60), 0);
  v_to   date := date_trunc('week', current_date)::date + 7 * greatest(least(p_weeks_ahead, 26), 0) + 6;
  v_growth numeric; v_new_daily numeric := 0;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT y.growth, coalesce(y.new_customer_daily, 0) INTO v_growth, v_new_daily FROM ops.fn_planning_yoy() y WHERE y.qbo_item_id = p_qbo_item_id;

  RETURN QUERY
  WITH dm AS (SELECT * FROM ops.fn_planning_daymap(v_from, v_to)),
  ty AS (
    SELECT s.d, s.qty FROM ops.v_planning_daily_sales s
    WHERE s.qbo_item_id = p_qbo_item_id AND s.d BETWEEN v_from AND v_to
  ),
  ly AS (
    SELECT dm.d, s.qty FROM dm JOIN ops.v_planning_daily_sales s
      ON s.qbo_item_id = p_qbo_item_id AND s.d = dm.ref_date
  ),
  wk AS (
    SELECT date_trunc('week', dm.d)::date AS ws,
           sum(ty.qty) AS ty_qty,
           sum(ly.qty) AS ly_qty,
           string_agg(DISTINCT dm.holiday_name, ', ') AS hol
    FROM dm
    LEFT JOIN ty ON ty.d = dm.d
    LEFT JOIN ly ON ly.d = dm.d
    GROUP BY 1
  )
  SELECT wk.ws,
         wk.ws = date_trunc('week', current_date)::date,
         wk.ws > current_date,
         CASE WHEN wk.ws > current_date THEN NULL ELSE coalesce(wk.ty_qty, 0) END,
         coalesce(wk.ly_qty, 0),
         CASE WHEN wk.ws + 6 >= current_date
              THEN round(coalesce(wk.ly_qty, 0) * (1 + coalesce(v_growth, 0)) + coalesce(v_new_daily, 0) * 7, 1) ELSE NULL END,
         wk.hol,
         CASE WHEN v_growth IS NULL THEN NULL ELSE round(v_growth * 100, 1) END
  FROM wk
  ORDER BY wk.ws;
END;
$$;
revoke all on function ops.fn_planning_weekly(text, integer, integer) from public, anon;
grant execute on function ops.fn_planning_weekly(text, integer, integer) to authenticated, service_role;

-- ── 1. customer cadence ──────────────────────────────────────────────────
-- One row per customer buying planner or fill items in the last 365 days:
-- how often they order, when they last did, when they are due, and what they
-- usually take. A cadence needs 3+ orders; fewer reads 'irregular'.
create or replace function ops.fn_planning_customer_cadence()
returns table (
  qbo_customer_id text, customer_name text, orders_365 integer, median_gap_days numeric,
  last_order date, next_expected date, days_until_due integer, cadence_status text,
  usual_items jsonb
)
language plpgsql stable security definer
set search_path to 'ops', 'pg_temp'
as $$
BEGIN
  PERFORM ops.fn_assert_internal();
  RETURN QUERY
  WITH o AS MATERIALIZED (
    SELECT s.customer_ref_id cust, s.d
    FROM ops.v_planning_daily_sales_cust s
    WHERE s.d >= current_date - 365 AND s.qty > 0
    GROUP BY 1, 2
  ),
  g AS MATERIALIZED (SELECT cust, d, d - lag(d) OVER (PARTITION BY cust ORDER BY d) AS gap FROM o),
  c AS MATERIALIZED (
    SELECT cust, count(*)::int AS orders, max(d) AS last_d,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS med_gap
    FROM g GROUP BY 1
  ),
  -- the last 6 orders of each customer × item → their usual per-order quantity
  recent_orders AS MATERIALIZED (
    SELECT s.customer_ref_id cust, s.qbo_item_id item, s.d, sum(s.qty) q,
           dense_rank() OVER (PARTITION BY s.customer_ref_id ORDER BY s.d DESC) rk
    FROM ops.v_planning_daily_sales_cust s
    WHERE s.d >= current_date - 365 AND s.qty > 0
    GROUP BY 1, 2, 3
  ),
  usual AS MATERIALIZED (
    SELECT cust, item,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY q) AS usual_q,
           count(*) AS times
    FROM recent_orders WHERE rk <= 6 GROUP BY 1, 2
  ),
  usual_j AS MATERIALIZED (
    SELECT u.cust,
           jsonb_agg(jsonb_build_object('qbo_item_id', u.item, 'item_name', i.name,
                     'usual_qty', round(u.usual_q::numeric, 1), 'times_in_last_6', u.times)
                     ORDER BY u.usual_q DESC) AS items
    FROM usual u LEFT JOIN ops.qbo_items i ON i.qbo_item_id = u.item
    GROUP BY 1
  )
  SELECT c.cust, cu.display_name, c.orders,
         CASE WHEN c.orders >= 3 THEN round(c.med_gap::numeric, 1) END,
         c.last_d,
         CASE WHEN c.orders >= 3 THEN c.last_d + round(c.med_gap)::int END,
         CASE WHEN c.orders >= 3 THEN (c.last_d + round(c.med_gap)::int) - current_date END,
         CASE
           WHEN c.orders < 3 THEN 'irregular'
           WHEN c.last_d + round(c.med_gap * 1.5)::int < current_date THEN 'lapsing'
           WHEN c.last_d + round(c.med_gap)::int < current_date THEN 'overdue'
           WHEN c.last_d + round(c.med_gap)::int <= current_date + 7 THEN 'due'
           ELSE 'not_due'
         END,
         coalesce(uj.items, '[]'::jsonb)
  FROM c
  LEFT JOIN ops.qbo_customers cu ON cu.qbo_customer_id = c.cust
  LEFT JOIN usual_j uj ON uj.cust = c.cust
  ORDER BY
    CASE WHEN c.orders < 3 THEN 9
         WHEN c.last_d + round(c.med_gap * 1.5)::int < current_date THEN 3
         WHEN c.last_d + round(c.med_gap)::int < current_date THEN 1
         WHEN c.last_d + round(c.med_gap)::int <= current_date + 7 THEN 2
         ELSE 4 END,
    c.last_d + round(coalesce(c.med_gap, 0))::int;
END;
$$;
revoke all on function ops.fn_planning_customer_cadence() from public, anon;
grant execute on function ops.fn_planning_customer_cadence() to authenticated, service_role;

-- the demand those cadences imply in the next N days, per item
-- ⚠ every CTE is MATERIALIZED: the planner estimates v_planning_daily_sales_cust
-- at ONE row, inlines the CTEs and re-runs the whole view per joined row —
-- the un-materialized shape ran past 55 s; materialized it is ~1 s.
create or replace function ops.fn_planning_due_demand(p_days integer default 7)
returns table (qbo_item_id text, due_qty numeric, due_customers integer)
language sql stable
set search_path to 'ops', 'public'
as $$
  with o as materialized (
    select s.customer_ref_id cust, s.d
    from ops.v_planning_daily_sales_cust s
    where s.d >= current_date - 365 and s.qty > 0 group by 1, 2),
  g as materialized (select cust, d, d - lag(d) over (partition by cust order by d) gap from o),
  c as materialized (select cust, count(*) orders, max(d) last_d, percentile_cont(0.5) within group (order by gap) med_gap from g group by 1),
  due as materialized (
    select cust from c
    where orders >= 3
      and last_d + round(med_gap)::int <= current_date + p_days          -- due or overdue …
      and last_d + round(med_gap * 1.5)::int >= current_date            -- … but not lapsing
  ),
  recent_orders as materialized (
    select s.customer_ref_id cust, s.qbo_item_id item, s.d, sum(s.qty) q,
           dense_rank() over (partition by s.customer_ref_id order by s.d desc) rk
    from ops.v_planning_daily_sales_cust s
    where s.d >= current_date - 365 and s.qty > 0 group by 1, 2, 3),
  usual as materialized (
    select cust, item, percentile_cont(0.5) within group (order by q) usual_q
    from recent_orders where rk <= 6 group by 1, 2)
  select u.item, round(sum(u.usual_q)::numeric, 0), count(distinct u.cust)::int
  from usual u join due on due.cust = u.cust
  group by 1;
$$;
revoke all on function ops.fn_planning_due_demand(integer) from public, anon, authenticated;
grant execute on function ops.fn_planning_due_demand(integer) to service_role;

-- ── 3. lead time from history ────────────────────────────────────────────
-- Ordered → received, per item, from every door stock arrives through. The
-- median of the last 24 months; used by the planner when there are 3+
-- samples, else the typed setting. Today there is NO history (no received
-- native PO, no mirrored QuickBooks PO with a linked bill, no received work
-- order), so every item reads 'setting' — the mechanism is here for the day
-- there is.
create or replace function ops.fn_planning_lead_times()
returns table (qbo_item_id text, measured_lead_days numeric, samples integer, last_sample date)
language sql stable
set search_path to 'ops', 'public'
as $$
  with native as (
    -- a Refractor PO: ordered_at → the receipt that carried the line
    select l.qbo_item_id, (r.received_at::date - po.ordered_at::date)::numeric lead_days, r.received_at::date sample_d
    from ops.purchase_orders po
    join ops.purchase_order_lines l on l.po_id = po.id
    join ops.po_receipts r on r.po_id = po.id
    where po.ordered_at is not null and r.received_at is not null and po.voided_at is null
      and r.received_at >= now() - interval '24 months'
  ),
  qbo_po as (
    -- a QuickBooks PO: its date → the bill QuickBooks linked to it
    select e.item_ref_id qbo_item_id, (e.txn_date - po.qbo_txn_date)::numeric, e.txn_date
    from ops.qbo_expense_lines e
    join ops.purchase_orders po on po.qbo_purchase_order_id = e.linked_po_qbo_id
    where po.qbo_txn_date is not null and e.txn_date >= current_date - 730 and e.quantity > 0
  ),
  wo as (
    -- a work order: ordered → finished goods received
    select w.finished_qbo_item_id, (w.received_at::date - w.ordered_at::date)::numeric, w.received_at::date
    from ops.work_orders w
    where w.ordered_at is not null and w.received_at is not null and w.voided_at is null
      and w.received_at >= now() - interval '24 months'
  ),
  all_s as (select * from native union all select * from qbo_po union all select * from wo)
  select qbo_item_id,
         round(percentile_cont(0.5) within group (order by lead_days)::numeric, 1),
         count(*)::int,
         max(sample_d)
  from all_s
  where lead_days between 0 and 180
  group by 1;
$$;
revoke all on function ops.fn_planning_lead_times() from public, anon, authenticated;
grant execute on function ops.fn_planning_lead_times() to service_role;

-- ── 4. forecast accuracy ─────────────────────────────────────────────────
create table if not exists ops.planning_forecast_log (
  week_start   date not null,
  qbo_item_id  text not null,
  kind         text not null check (kind in ('stock', 'fill')),
  forecast_qty numeric not null,
  plan_rate    numeric,
  recent_rate  numeric,
  ly_qty       numeric,
  growth_pct   numeric,
  new_customer_daily numeric,
  snapshot_at  timestamptz not null default now(),
  primary key (week_start, qbo_item_id)
);
comment on table ops.planning_forecast_log is
  'What the planner said a week would sell, written before the week (Mondays 10:20 UTC). Scored against actuals by fn_planning_forecast_accuracy. First write for a week wins — a re-run never rewrites a forecast after the fact.';
alter table ops.planning_forecast_log enable row level security;
drop policy if exists planning_forecast_log_read on ops.planning_forecast_log;
create policy planning_forecast_log_read on ops.planning_forecast_log for select to authenticated
  using (ops.fn_is_staff() or not ops.fn_is_distributor());
revoke all on ops.planning_forecast_log from public, anon;
grant select on ops.planning_forecast_log to authenticated;
grant all on ops.planning_forecast_log to service_role;

create or replace function ops.fn_planning_forecast_snapshot()
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare v_week date := date_trunc('week', current_date)::date; v_stock int := 0; v_fill int := 0; v_t0 timestamptz := now(); v_err text;
begin
  perform ops.fn_assert_staff_or_service();
  begin
    -- the week we are in (if not yet written) and the next one
    with ins as (
      insert into ops.planning_forecast_log (week_start, qbo_item_id, kind, forecast_qty, plan_rate, recent_rate, ly_qty, growth_pct, new_customer_daily)
      select w.ws, m.qbo_item_id, 'stock', round(m.planning_velocity * 7, 1), m.planning_velocity, m.daily_velocity,
             m.ly_window_qty, m.yoy_growth_pct, m.new_customer_daily
      from ops.fn_items_master__i(90, null, false) m
      cross join (values (v_week), (v_week + 7)) as w(ws)
      where m.is_planner and coalesce(m.active, true) and m.planning_velocity is not null
      on conflict (week_start, qbo_item_id) do nothing
      returning 1)
    select count(*) into v_stock from ins;
    with ins as (
      insert into ops.planning_forecast_log (week_start, qbo_item_id, kind, forecast_qty, recent_rate, ly_qty, growth_pct)
      select f.week_start, f.qbo_item_id, 'fill', f.forecast_qty, f.recent_avg, f.last_year_qty, f.growth_pct
      from ops.fn_planning_fill_plan(1, 2) f
      where f.week_start >= v_week and f.forecast_qty is not null
      on conflict (week_start, qbo_item_id) do nothing
      returning 1)
    select count(*) into v_fill from ins;
    insert into ops.sync_log (source, sync_type, status, started_at, completed_at, records_synced, metadata)
    values ('inventory', 'planning_forecast_snapshot', 'success', v_t0, now(), v_stock + v_fill,
            jsonb_build_object('stock', v_stock, 'fill', v_fill, 'week', v_week));
  exception when others then
    v_err := sqlerrm;
    begin
      insert into ops.sync_log (source, sync_type, status, started_at, completed_at, error_message)
      values ('inventory', 'planning_forecast_snapshot', 'error', v_t0, now(), v_err);
    exception when others then null; end;
    raise;
  end;
  return jsonb_build_object('stock', v_stock, 'fill', v_fill, 'week', v_week);
end$$;
revoke all on function ops.fn_planning_forecast_snapshot() from public, anon;
grant execute on function ops.fn_planning_forecast_snapshot() to authenticated, service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'planning-forecast-snapshot';
select cron.schedule('planning-forecast-snapshot', '20 10 * * 1', $cron$select ops.fn_planning_forecast_snapshot()$cron$);

-- per item: logged forecast where one exists, else a BACKTEST that uses only
-- data before the week (4-week recent average, aligned LY × growth measured on
-- the 13 weeks before), against the actual
create or replace function ops.fn_planning_forecast_accuracy(p_qbo_item_id text, p_weeks integer default 13)
returns table (week_start date, forecast_qty numeric, actual_qty numeric, error_qty numeric, abs_pct_error numeric, source text)
language plpgsql stable security definer
set search_path to 'ops', 'pg_temp'
as $$
DECLARE
  v_this date := date_trunc('week', current_date)::date;
  v_n int := greatest(least(p_weeks, 52), 1);
  v_from date;
BEGIN
  PERFORM ops.fn_assert_internal();
  v_from := v_this - 7 * (v_n + 13);   -- room for the 13-week growth window before the first scored week
  RETURN QUERY
  WITH dm AS (SELECT * FROM ops.fn_planning_daymap(v_from, v_this - 1)),
  weeks AS (SELECT generate_series(v_from, v_this - 7, interval '7 days')::date ws),
  ty AS (SELECT w.ws, coalesce(sum(s.qty), 0) q FROM weeks w
         LEFT JOIN ops.v_planning_daily_sales s ON s.qbo_item_id = p_qbo_item_id AND s.d BETWEEN w.ws AND w.ws + 6 GROUP BY 1),
  ly AS (SELECT w.ws, coalesce(sum(s.qty), 0) q FROM weeks w
         JOIN dm ON dm.d BETWEEN w.ws AND w.ws + 6
         LEFT JOIN ops.v_planning_daily_sales s ON s.qbo_item_id = p_qbo_item_id AND s.d = dm.ref_date GROUP BY 1),
  series AS (
    SELECT ty.ws, ty.q ty_q, ly.q ly_q,
           avg(ty.q) OVER (ORDER BY ty.ws ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) recent4,
           sum(ty.q) OVER (ORDER BY ty.ws ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING) ty13,
           sum(ly.q) OVER (ORDER BY ty.ws ROWS BETWEEN 13 PRECEDING AND 1 PRECEDING) ly13,
           row_number() OVER (ORDER BY ty.ws) rn
    FROM ty JOIN ly USING (ws)
  ),
  bt AS (
    SELECT s.ws,
           round(0.5 * coalesce(s.recent4, 0)
               + 0.5 * s.ly_q * (1 + CASE WHEN coalesce(s.ly13, 0) >= 10 THEN greatest(-0.5, least(0.5, s.ty13 / s.ly13 - 1)) ELSE 0 END), 1) fc,
           s.ty_q
    FROM series s WHERE s.rn > 13
  )
  SELECT bt.ws,
         coalesce(l.forecast_qty, bt.fc),
         bt.ty_q,
         round(coalesce(l.forecast_qty, bt.fc) - bt.ty_q, 1),
         CASE WHEN bt.ty_q > 0 THEN round(abs(coalesce(l.forecast_qty, bt.fc) - bt.ty_q) / bt.ty_q * 100, 1) END,
         CASE WHEN l.forecast_qty IS NOT NULL THEN 'logged' ELSE 'backtest' END
  FROM bt
  LEFT JOIN ops.planning_forecast_log l ON l.week_start = bt.ws AND l.qbo_item_id = p_qbo_item_id
  ORDER BY bt.ws;
END;
$$;
revoke all on function ops.fn_planning_forecast_accuracy(text, integer) from public, anon;
grant execute on function ops.fn_planning_forecast_accuracy(text, integer) to authenticated, service_role;

-- ── the items master learns all four (read-modify-write of the live body) ──
-- anchors + replacements are applied by the python block that generated the
-- copied body below; the same edits were EXECUTEd live against
-- pg_get_functiondef. See PRODUCTION.md "Inventory Planning v4".

-- ── 8. the items master learns all four ──────────────────────────────────
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
  par_min numeric, par_max numeric, smallest_order_qty numeric,
  new_customer_daily numeric, new_customers integer, due_demand_7d numeric, due_customers_7d integer,
  lead_time_source text, measured_lead_days numeric, lead_samples integer
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
  -- 20260904i: a measured lead time (>= 3 samples) beats the setting
  lead_times AS (SELECT * FROM ops.fn_planning_lead_times()),
  planner AS (
    SELECT s.qbo_item_id,
           COALESCE(CASE WHEN lt.samples >= 3 THEN round(lt.measured_lead_days)::int END, s.lead_time_days, 7) AS lead_d,
           COALESCE(s.target_days_supply, 30) AS target_d,
           COALESCE(CASE WHEN lt.samples >= 3 THEN round(lt.measured_lead_days)::int END, s.lead_time_days, 7) + COALESCE(s.target_days_supply, 30) AS window_d
    FROM ops.inventory_settings s
    LEFT JOIN lead_times lt ON lt.qbo_item_id = s.qbo_item_id
    WHERE s.is_planner
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
  -- 20260904i: what the customers due to order in the next 7 days usually take
  due_demand AS (SELECT * FROM ops.fn_planning_due_demand(7)),
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
      COALESCE(CASE WHEN lt.samples >= 3 THEN round(lt.measured_lead_days)::int END, s.lead_time_days, 7) AS lead_time_days_resolved,
      CASE WHEN lt.samples >= 3 THEN 'measured' ELSE 'setting' END AS lead_time_source,
      lt.measured_lead_days,
      lt.samples AS lead_samples,
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
    LEFT JOIN lead_times lt ON lt.qbo_item_id = it.qbo_item_id
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
      yoy.new_customer_daily AS new_daily_c,
      yoy.new_customers AS new_customers_c,
      dd.due_qty AS due_qty_c,
      dd.due_customers AS due_customers_c,
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
    LEFT JOIN due_demand dd ON dd.qbo_item_id   = b.qbo_item_id
    LEFT JOIN sigma    ON sigma.qbo_item_id    = b.qbo_item_id
  ),
  vel AS (
    SELECT c.*,
      CASE WHEN (SELECT lb FROM params) > 28 THEN 0.6 * c.rate_28 + 0.4 * c.rate_lb ELSE c.rate_lb END AS velocity,
      CASE WHEN c.ly_window_c IS NOT NULL AND c.window_d > 0
           THEN c.ly_window_c * (1 + COALESCE(c.growth_c, 0)) / c.window_d + COALESCE(c.new_daily_c, 0) END AS forecast_daily_c
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
      -- 20260904i: and the order at least covers what the customers due this week
      -- usually take — a status of reorder with a suggestion of 0 is a contradiction.
      WHEN GREATEST(ceil((it.target_days_supply_resolved + it.lead_time_days_resolved) * it.prate + it.safety_c - it.planning_on_hand - it.inbound_c), ceil(COALESCE(it.due_qty_c, 0) - it.cover_units)) <= 0 THEN 0
      ELSE GREATEST(
        GREATEST(ceil((it.target_days_supply_resolved + it.lead_time_days_resolved) * it.prate + it.safety_c - it.planning_on_hand - it.inbound_c), ceil(COALESCE(it.due_qty_c, 0) - it.cover_units)),
        COALESCE(it.min_order_qty, 0), 0)
    END AS suggested_order_qty,
    it.target_days_supply_resolved::numeric AS suggested_order_cycle_days,
    round(it.velocity, 4) AS daily_velocity,
    CASE WHEN it.prate > 0 THEN round(it.planning_on_hand / it.prate, 1) ELSE NULL END AS days_of_supply,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN it.prate <= 0 THEN 'idle'
      WHEN it.planning_on_hand <= 0 THEN 'critical'
      WHEN COALESCE(it.due_qty_c, 0) > it.cover_units THEN 'reorder'
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
    so.q AS smallest_order_qty,
    -- 20260904i: new-customer ramp, cadence-driven due demand, measured lead
    CASE WHEN it.is_planner_resolved THEN round(COALESCE(it.new_daily_c, 0), 4) END AS new_customer_daily,
    CASE WHEN it.is_planner_resolved THEN COALESCE(it.new_customers_c, 0) END AS new_customers,
    CASE WHEN it.is_planner_resolved THEN round(COALESCE(it.due_qty_c, 0), 1) END AS due_demand_7d,
    CASE WHEN it.is_planner_resolved THEN COALESCE(it.due_customers_c, 0) END AS due_customers_7d,
    it.lead_time_source,
    round(it.measured_lead_days, 1) AS measured_lead_days,
    it.lead_samples
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
  par_min numeric, par_max numeric, smallest_order_qty numeric,
  new_customer_daily numeric, new_customers integer, due_demand_7d numeric, due_customers_7d integer,
  lead_time_source text, measured_lead_days numeric, lead_samples integer
)
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$-- GENERATED GUARD WRAPPER (20260820b shape, re-minted 20260904i) — the real body lives in ops.fn_items_master__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN QUERY SELECT * FROM ops.fn_items_master__i($1, $2, $3); END$$;
revoke all on function ops.fn_items_master(integer, text, boolean) from public, anon;
grant execute on function ops.fn_items_master(integer, text, boolean) to authenticated, service_role;
