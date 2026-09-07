-- 20260904g — Inventory Planning v2: scope, lead times, sampling excluded,
-- last-year-aligned forecast with growth, safety stock, order-by dates.
--
-- ASKS (Sky, 2026-09-04), verbatim where it matters:
--   • "it takes around three weeks to get product back from the Canning
--     company from ordering the raw materials to ordering the cans to having
--     it made and then shipped back."                → cans: lead 21 days.
--   • "We routinely order about every two weeks for Fountain products."
--                                                     → BIB: 14-day cycle.
--   • "I don't need all of the products to have inventory settings we only
--     need the bag in the box items and the 24 pack cans and the eight pack
--     cans to have inventory planning."               → is_planner scope.
--   • "take the prior year totals of each and then get the average growth of
--     each product across the weeks that way you could see what we did last
--     year what we're trending to do this year and put some sort of dynamics
--     to this."                                       → YoY forecast.
--   • "if holidays fall on different days, it would be good to understand
--     that or certain weekends where there's a lot more happening than prior
--     weekends because of day changes."               → weekday + holiday alignment.
--   • "anything that goes to Brix Beverage sampling we wanna leave out."
--                                                     → velocity exclude, qbo 95.
--
-- WHAT THIS BUILDS, in the order it is applied:
--   1. A third lane, cans_8pk. The eight 8PK items sat in lane 'excluded', so
--      the planning page could not show them at all.
--   2. is_planner is TRUE for exactly the active BIB (3G/5G), 24P and 8PK
--      items and FALSE for everything else (47 rows had it on, among them
--      "Shopify Shipping Item" and the SF-prefixed BIBs).
--   3. Lead time + target days by lane. Cans (24P and 8PK — an 8-pack is made
--      from a 24-pack case, so its constraint is the same canning run): lead
--      21, target 30. BIB: lead 7 (unchanged — nobody has timed Calderoni's
--      turnaround; flagged), target 14 (the ordering cycle Sky described).
--   4. BRIX BEVERAGE - SAMPLING (qbo 95) into inventory_velocity_excludes.
--   5. ops.planning_holidays — the dates whose week is matched holiday-to-
--      holiday rather than same-weekday-52-weeks-back. Editable by staff.
--   6. ops.v_planning_daily_sales — per planner item per day: invoices and
--      sales receipts positive, credit memos and refund receipts NEGATIVE
--      (v_sales_lines carries returns with a positive quantity — 58 credit
--      memos and 83 refund receipts were counted as sales), excludes applied,
--      future-dated lines dropped (there is a 2026-09-14 invoice today).
--   7. ops.fn_planning_daymap(from, to) — for every calendar day, the day it
--      is compared to last year: the same weekday 364 days back, EXCEPT in a
--      week holding a holiday, where the whole week shifts so this year's
--      holiday lands on last year's (Labor Day 2026-09-07 → 2025-09-01, not
--      2025-09-08). Floating holidays keep the weekday; a fixed-date holiday
--      shifts by one weekday on purpose — July 4 on a Saturday is compared to
--      July 4 on a Friday, which is the "day changes" effect being asked for.
--   8. ops.fn_planning_yoy() — trailing 13 weeks this year vs the aligned 13
--      weeks last year, per planner item: the growth factor. Clamped to
--      [-50%, +100%] and NULL when last year has fewer than 10 units in the
--      window (a growth rate off a handful of units is noise dressed as a
--      number).
--   9. ops.fn_planning_weekly(item, back, ahead) — the weekly series a human
--      reads: this year, last year aligned, the holiday in the week, and the
--      forecast for the coming weeks (last year × growth). Guarded inline.
--  10. fn_items_master rebuilt (drop + create, wrapper re-minted):
--      • forecast_daily = (last year's units over the coming lead+target
--        window, aligned as above) × (1 + growth) / window days.
--      • planning_velocity = 0.5 × recent velocity + 0.5 × forecast_daily when
--        a forecast exists, else the recent velocity. Days of supply, days of
--        cover, status and the suggested order all use planning_velocity;
--        daily_velocity stays the observed recent rate so both can be read.
--      • safety_stock = 1.65 × (weekly σ over the trailing 13 complete weeks
--        ÷ √7) × √lead_time — 95% service level on the demand seen during a
--        lead time. Weeks with no sales count as zero weeks, not missing ones.
--        Capped at one lead time of demand (see the fin CTE for why).
--      • reorder_point_calc = safety_stock + lead_time × planning_velocity
--        (a reorder_point typed in settings overrides it).
--      • status: critical (nothing sellable) → reorder (sellable + inbound ≤
--        reorder point, i.e. the order is already late) → reorder_soon (will
--        cross the reorder point within 7 days) → overstock → ok.
--      • stockout_date = when sellable + inbound runs out at the planning
--        rate; order_by_date = stockout_date − lead time − the days the
--        safety stock covers. Dates, because "28 days" is not something a
--        person puts on a calendar.
--      • suggested_order_qty = (lead + target) × planning_velocity + safety
--        − sellable − inbound, floored at min_order_qty, never negative.
--
-- ⚠ DELIBERATELY NOT DONE: rounding the suggestion to a canning run size.
-- Nobody has stated a minimum or standard run; min_order_qty is 0 on every
-- planner item. Set it per item in Settings → Items and the suggestion floors
-- to it. BIB lead time is likewise a number to confirm, not a guess made here.

-- 1 ── lane cans_8pk ────────────────────────────────────────────────────────
alter table ops.inventory_settings drop constraint if exists inventory_settings_inventory_lane_check;
alter table ops.inventory_settings add constraint inventory_settings_inventory_lane_check
  check (inventory_lane = any (array['bib_product'::text, 'cans_24pk'::text, 'cans_8pk'::text, 'excluded'::text]));
alter table ops.inventory_settings drop constraint if exists inventory_settings_inventory_lane_size_check;
alter table ops.inventory_settings add constraint inventory_settings_inventory_lane_size_check
  check (inventory_lane_size = any (array['3g'::text, '5g'::text, '24pk'::text, '8pk'::text]) or inventory_lane_size is null);

-- fn_set_inventory_lane is a plain plpgsql function (not SECURITY DEFINER, not
-- wrapped by 20260820b), so CREATE OR REPLACE by name is correct here.
create or replace function ops.fn_set_inventory_lane(
  p_qbo_item_id text, p_inventory_lane text, p_inventory_lane_size text default null,
  p_default_receiving_location_id uuid default null, p_inventory_lane_reviewed boolean default true)
returns void
language plpgsql
set search_path to 'ops', 'public'
as $$
BEGIN
  IF p_inventory_lane NOT IN ('bib_product', 'cans_24pk', 'cans_8pk', 'excluded') THEN
    RAISE EXCEPTION 'invalid inventory lane: %', p_inventory_lane;
  END IF;
  IF p_inventory_lane = 'bib_product' AND p_inventory_lane_size NOT IN ('3g', '5g') THEN
    RAISE EXCEPTION 'BIB Product lane requires inventory_lane_size 3g or 5g';
  END IF;
  IF p_inventory_lane = 'cans_24pk' AND p_inventory_lane_size <> '24pk' THEN
    RAISE EXCEPTION 'Cans 24pks lane requires inventory_lane_size 24pk';
  END IF;
  IF p_inventory_lane = 'cans_8pk' AND p_inventory_lane_size <> '8pk' THEN
    RAISE EXCEPTION 'Cans 8pks lane requires inventory_lane_size 8pk';
  END IF;
  IF p_inventory_lane = 'excluded' THEN
    p_inventory_lane_size := NULL;
  END IF;

  INSERT INTO ops.inventory_settings (
    qbo_item_id, inventory_lane, inventory_lane_size, inventory_lane_source,
    inventory_lane_reviewed, default_receiving_location_id, updated_at)
  VALUES (
    p_qbo_item_id, p_inventory_lane, p_inventory_lane_size, 'manual',
    COALESCE(p_inventory_lane_reviewed, TRUE), p_default_receiving_location_id, now())
  ON CONFLICT (qbo_item_id) DO UPDATE SET
    inventory_lane = EXCLUDED.inventory_lane,
    inventory_lane_size = EXCLUDED.inventory_lane_size,
    inventory_lane_source = 'manual',
    inventory_lane_reviewed = EXCLUDED.inventory_lane_reviewed,
    default_receiving_location_id = EXCLUDED.default_receiving_location_id,
    is_managed = CASE WHEN EXCLUDED.inventory_lane <> 'excluded' THEN TRUE ELSE ops.inventory_settings.is_managed END,
    track_locations = CASE WHEN EXCLUDED.inventory_lane <> 'excluded' THEN TRUE ELSE ops.inventory_settings.track_locations END,
    -- an 8-pack is made by a repack from a 24-pack case, never by a BOM
    has_bom = CASE
      WHEN EXCLUDED.inventory_lane = 'cans_24pk' THEN TRUE
      WHEN EXCLUDED.inventory_lane IN ('bib_product', 'cans_8pk') THEN FALSE
      ELSE ops.inventory_settings.has_bom
    END,
    updated_at = now();
END;
$$;

-- the eight 8PK items move into the new lane (the Variety pack included — it is
-- made from the flavours' cases through the bin, and it sells)
update ops.inventory_settings s
set inventory_lane = 'cans_8pk', inventory_lane_size = '8pk', inventory_lane_source = 'manual',
    inventory_lane_reviewed = true, is_managed = true, track_locations = true, has_bom = false, updated_at = now()
from ops.qbo_items i
where i.qbo_item_id = s.qbo_item_id and i.name ~ '^8PK' and coalesce(i.active, true);

-- 2 ── planner scope: exactly the BIB / 24P / 8PK finished goods ────────────
update ops.inventory_settings s
set is_planner = (
      coalesce(i.active, true)
      and s.inventory_lane in ('bib_product', 'cans_24pk', 'cans_8pk')
      and coalesce(i.type, '') = 'Inventory'          -- drops "3G BIB INCOME GENERAL"
      and i.name ~ '^(3G|5G|24P|8PK)'                -- drops the SF-prefixed rows
    ),
    updated_at = now()
from ops.qbo_items i
where i.qbo_item_id = s.qbo_item_id
  and s.is_planner is distinct from (
      coalesce(i.active, true)
      and s.inventory_lane in ('bib_product', 'cans_24pk', 'cans_8pk')
      and coalesce(i.type, '') = 'Inventory'
      and i.name ~ '^(3G|5G|24P|8PK)');

-- 3 ── lead time + target by lane (only on rows still carrying the seeded 7/30) ──
update ops.inventory_settings
set lead_time_days = 21, target_days_supply = 30, updated_at = now()
where is_planner and inventory_lane in ('cans_24pk', 'cans_8pk')
  and lead_time_days = 7 and target_days_supply = 30;
update ops.inventory_settings
set target_days_supply = 14, updated_at = now()
where is_planner and inventory_lane = 'bib_product'
  and lead_time_days = 7 and target_days_supply = 30;

-- 4 ── sampling never counts as demand ──────────────────────────────────────
insert into ops.inventory_velocity_excludes (qbo_customer_id, reason, added_by)
values ('95', 'BRIX BEVERAGE - SAMPLING: samples and special events, not customer demand (Sky, 2026-09-04)', 'migration 20260904g')
on conflict (qbo_customer_id) do nothing;

-- 5 ── holidays ────────────────────────────────────────────────────────────
create table if not exists ops.planning_holidays (
  holiday_date date primary key,
  name text not null,
  -- floating = set by weekday (Labor Day, Thanksgiving): shifting the week to it
  -- keeps the weekday. fixed = a calendar date (July 4): shifting to it moves
  -- the weekday by one, which is the point. When two holidays share a week the
  -- floating one wins the alignment.
  floating boolean not null default false,
  note text,
  created_at timestamptz not null default now()
);
comment on table ops.planning_holidays is
  'Dates whose week the inventory planner aligns holiday-to-holiday against last year instead of same-weekday-364-days-back. Staff-editable.';

alter table ops.planning_holidays enable row level security;
drop policy if exists planning_holidays_read on ops.planning_holidays;
create policy planning_holidays_read on ops.planning_holidays
  for select to authenticated using (ops.fn_is_staff() or not ops.fn_is_distributor());
drop policy if exists planning_holidays_write on ops.planning_holidays;
create policy planning_holidays_write on ops.planning_holidays
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());
-- GRANTs beside the policies (Postgres checks privileges before RLS)
grant select, insert, update, delete on ops.planning_holidays to authenticated;
grant all on ops.planning_holidays to service_role;
revoke all on ops.planning_holidays from anon;

insert into ops.planning_holidays (holiday_date, name, floating) values
  -- fixed-date
  ('2024-01-01','New Year''s Day',false),('2025-01-01','New Year''s Day',false),('2026-01-01','New Year''s Day',false),('2027-01-01','New Year''s Day',false),
  ('2024-03-17','St. Patrick''s Day',false),('2025-03-17','St. Patrick''s Day',false),('2026-03-17','St. Patrick''s Day',false),('2027-03-17','St. Patrick''s Day',false),
  ('2024-05-05','Cinco de Mayo',false),('2025-05-05','Cinco de Mayo',false),('2026-05-05','Cinco de Mayo',false),('2027-05-05','Cinco de Mayo',false),
  ('2024-06-19','Juneteenth',false),('2025-06-19','Juneteenth',false),('2026-06-19','Juneteenth',false),('2027-06-19','Juneteenth',false),
  ('2024-07-04','Independence Day',false),('2025-07-04','Independence Day',false),('2026-07-04','Independence Day',false),('2027-07-04','Independence Day',false),
  ('2024-10-31','Halloween',false),('2025-10-31','Halloween',false),('2026-10-31','Halloween',false),('2027-10-31','Halloween',false),
  ('2024-12-24','Christmas Eve',false),('2025-12-24','Christmas Eve',false),('2026-12-24','Christmas Eve',false),('2027-12-24','Christmas Eve',false),
  ('2024-12-25','Christmas Day',false),('2025-12-25','Christmas Day',false),('2026-12-25','Christmas Day',false),('2027-12-25','Christmas Day',false),
  ('2024-12-31','New Year''s Eve',false),('2025-12-31','New Year''s Eve',false),('2026-12-31','New Year''s Eve',false),('2027-12-31','New Year''s Eve',false),
  -- floating
  ('2024-01-15','MLK Day',true),('2025-01-20','MLK Day',true),('2026-01-19','MLK Day',true),('2027-01-18','MLK Day',true),
  ('2024-02-11','Super Bowl Sunday',true),('2025-02-09','Super Bowl Sunday',true),('2026-02-08','Super Bowl Sunday',true),('2027-02-14','Super Bowl Sunday',true),
  ('2024-02-19','Presidents Day',true),('2025-02-17','Presidents Day',true),('2026-02-16','Presidents Day',true),('2027-02-15','Presidents Day',true),
  ('2024-03-31','Easter',true),('2025-04-20','Easter',true),('2026-04-05','Easter',true),('2027-03-28','Easter',true),
  ('2024-05-12','Mother''s Day',true),('2025-05-11','Mother''s Day',true),('2026-05-10','Mother''s Day',true),('2027-05-09','Mother''s Day',true),
  ('2024-05-27','Memorial Day',true),('2025-05-26','Memorial Day',true),('2026-05-25','Memorial Day',true),('2027-05-31','Memorial Day',true),
  ('2024-06-16','Father''s Day',true),('2025-06-15','Father''s Day',true),('2026-06-21','Father''s Day',true),('2027-06-20','Father''s Day',true),
  ('2024-09-02','Labor Day',true),('2025-09-01','Labor Day',true),('2026-09-07','Labor Day',true),('2027-09-06','Labor Day',true),
  ('2024-11-28','Thanksgiving',true),('2025-11-27','Thanksgiving',true),('2026-11-26','Thanksgiving',true),('2027-11-25','Thanksgiving',true)
on conflict (holiday_date) do nothing;

-- 6 ── per-day demand for the planner items ────────────────────────────────
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
group by 1, 2;
comment on view ops.v_planning_daily_sales is
  'Planner items only. Invoices/sales receipts add, credit memos/refund receipts subtract, velocity excludes removed, future-dated lines dropped. Read by fn_items_master + fn_planning_weekly (SECURITY DEFINER).';
revoke all on ops.v_planning_daily_sales from public, anon, authenticated;
grant select on ops.v_planning_daily_sales to service_role;

-- 7 ── which day last year does each day compare to ─────────────────────────
create or replace function ops.fn_planning_daymap(p_from date, p_to date)
returns table (d date, ref_date date, holiday_name text, aligned_by text)
language sql stable
set search_path to 'ops', 'public'
as $$
  with days as (
    select gs::date as d, date_trunc('week', gs)::date as week_start
    from generate_series(p_from, p_to, interval '1 day') gs
  ),
  hol_this as (
    select w.d, h.name, h.holiday_date
    from days w
    join lateral (
      select name, holiday_date from ops.planning_holidays
      where holiday_date between w.week_start and w.week_start + 6
      order by floating desc, holiday_date
      limit 1
    ) h on true
  ),
  hol_last as (
    select ht.d, ht.name, ht.holiday_date as this_date, hl.holiday_date as last_date
    from hol_this ht
    join lateral (
      select holiday_date from ops.planning_holidays p
      where p.name = ht.name
        and p.holiday_date between ht.holiday_date - 400 and ht.holiday_date - 330
      order by holiday_date desc
      limit 1
    ) hl on true
  )
  select w.d,
         case when hl.d is not null then w.d - (hl.this_date - hl.last_date) else w.d - 364 end as ref_date,
         hl.name as holiday_name,
         case when hl.d is not null then 'holiday' else 'weekday' end as aligned_by
  from days w
  left join hol_last hl on hl.d = w.d;
$$;
revoke all on function ops.fn_planning_daymap(date, date) from public, anon, authenticated;
grant execute on function ops.fn_planning_daymap(date, date) to service_role;

-- 8 ── year-over-year growth per planner item ──────────────────────────────
-- Trailing 13 complete weeks (Mon–Sun) this year vs the same weeks aligned
-- last year. Clamped and nulled as described in the header.
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
              then greatest(-0.5, least(1.0, coalesce(ty.qty, 0) / ly.qty - 1))
              else null end
  from items i
  left join ty on ty.qbo_item_id = i.qbo_item_id
  left join ly on ly.qbo_item_id = i.qbo_item_id;
$$;
revoke all on function ops.fn_planning_yoy() from public, anon, authenticated;
grant execute on function ops.fn_planning_yoy() to service_role;

-- 9 ── the weekly series a human reads ─────────────────────────────────────
drop function if exists ops.fn_planning_weekly(text, integer, integer);
create function ops.fn_planning_weekly(p_qbo_item_id text, p_weeks_back integer default 13, p_weeks_ahead integer default 8)
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
  v_growth numeric;
BEGIN
  PERFORM ops.fn_assert_internal();   -- staff + internal logins; distributor logins refused
  SELECT y.growth INTO v_growth FROM ops.fn_planning_yoy() y WHERE y.qbo_item_id = p_qbo_item_id;

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
         CASE WHEN wk.ws + 6 >= current_date THEN round(coalesce(wk.ly_qty, 0) * (1 + coalesce(v_growth, 0)), 1) ELSE NULL END,
         wk.hol,
         CASE WHEN v_growth IS NULL THEN NULL ELSE round(v_growth * 100, 1) END
  FROM wk
  ORDER BY wk.ws;
END;
$$;
revoke all on function ops.fn_planning_weekly(text, integer, integer) from public, anon;
grant execute on function ops.fn_planning_weekly(text, integer, integer) to authenticated, service_role;

-- 10 ── fn_items_master rebuilt ────────────────────────────────────────────
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
  yoy_growth_pct numeric, weekly_sigma numeric, safety_stock numeric, reorder_point_calc numeric, stockout_date date, order_by_date date
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
         THEN current_date + floor(it.cover_units / it.prate)::int - it.lead_time_days_resolved - floor(it.safety_c / it.prate)::int END AS order_by_date
  FROM fin it
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
  yoy_growth_pct numeric, weekly_sigma numeric, safety_stock numeric, reorder_point_calc numeric, stockout_date date, order_by_date date
)
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$-- GENERATED GUARD WRAPPER (20260820b shape, re-minted 20260904g) — the real body lives in ops.fn_items_master__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN QUERY SELECT * FROM ops.fn_items_master__i($1, $2, $3); END$$;
revoke all on function ops.fn_items_master(integer, text, boolean) from public, anon;
grant execute on function ops.fn_items_master(integer, text, boolean) to authenticated, service_role;
