-- 20260909f — Cylinder counts, once, keyed on the QuickBooks customer id.
--
-- Ask (Sky, 2026-09-09): "We need to make sure cylinder count is on the
-- dispatch just echo'd and on refractor as well so that both sides can see
-- whats happening with customer cylinders."
--
-- ⚠ A CYLINDER BALANCE IS DERIVED, NOT STORED. There is no tank table: the
-- count is the latest BTRF-* rental invoice's printed "New Balance", plus every
-- delivery and minus every pickup invoiced since, classified by QuickBooks item
-- name. So "echo it" cannot mean copying a number — it means every surface
-- running the SAME arithmetic. This file is that arithmetic, written once.
--
-- ⚠ THE EXISTING DERIVATION COULD NOT BE ECHOED AS IT STANDS, and this is the
-- finding. `orders.cylinder_inventory_for_customer(uuid)` and
-- `orders.v_cylinder_inventory` are keyed on the PORTAL customer uuid and reach
-- QuickBooks by joining through `orders.customers`. Measured 2026-09-09:
--
--     343 QuickBooks customers have cylinder activity
--     142 of them are portal customers        →   903 cylinders out
--     201 are NOT                             →   858 cylinders out
--
-- Half the fleet is invisible to it — and invisible in the worst direction: a
-- dispatch board reading it would tell a technician that a customer with tanks
-- on site has none. Same shape as the equipment echo three weeks ago, where an
-- installed ice machine at WENCES RESTAURANT was missing and a technician sent
-- there would have seen no equipment on the job.
--
-- So the key is `qbo_customer_id` — the one identity brix-order, BrixSD,
-- Refractor and QuickBooks all already agree on. It is what
-- `core.fn_customer_profile`, `dispatch.fn_customer_equipment`,
-- `ops.v_equipment_line` and `orders.payment_tracking_settings` are keyed on,
-- and it exists whether or not anybody ever gave the customer a portal login.
--
-- ⚠ CLASSIFICATION IS NOT RE-IMPLEMENTED. `orders.cylinder_label_from_item`
-- and `orders.cylinder_label_from_btrf` stay the one rule and are CALLED from
-- here. Copying those CASE ladders into `ops` would be a second answer to "is
-- this line a cylinder", and the day somebody adds a gas it would be right in
-- one schema and wrong in the other.
--
-- ⚠ Guard-wrapped per 20260820b: `__i` holds the arithmetic and is executable
-- by nobody, `ops.fn_customer_cylinders` is the staff door. A definer function
-- that takes any customer id and answers without a gate is the shape that
-- hardening pass existed to remove — and `orders.cylinder_inventory_for_customer`
-- is still exactly that today (PUBLIC EXECUTE, reachable with the anon key);
-- 20260909g closes it.

-- ---------------------------------------------------------------------------
-- The arithmetic. No gate — the wrappers below carry it.
-- ---------------------------------------------------------------------------
create or replace function ops.fn_customer_cylinders__i(p_qbo_customer_id text)
returns table (
  label            text,
  on_hand          integer,
  balance_at_btrf  integer,
  deliveries_since integer,
  pickups_since    integer,
  btrf_doc_number  text,
  btrf_date        date,
  last_activity    date,
  unit_price       numeric,
  monthly_rent     numeric
)
language sql
stable
security definer
set search_path to 'ops', 'orders', 'public', 'pg_temp'
as $fn$
  with anchors as (
    -- The most recent BTRF-* rental invoice per gas, and the balance it printed.
    select distinct on (label) label, doc_number, txn_date, balance_at_btrf, unit_price
    from (
      select
        orders.cylinder_label_from_btrf(l.description, l.item_name) as label,
        i.doc_number,
        i.txn_date,
        (regexp_match(l.description, 'New Balance:\s*(-?\d+)'))[1]::int as balance_at_btrf,
        l.unit_price::numeric as unit_price,
        l.line_num
      from ops.qbo_invoices i
      join ops.qbo_invoice_lines l on l.invoice_id = i.id
      where i.customer_ref_id = p_qbo_customer_id
        and i.doc_number ilike 'BTRF-%'
        and orders.cylinder_label_from_btrf(l.description, l.item_name) is not null
    ) ranked
    order by label, txn_date desc, line_num
  ),
  -- Every non-rental line that moves a cylinder, with its direction.
  -- ⚠ `PU*` is a PICKUP and comes back off the count. Getting that sign wrong
  --    is a customer told they hold tanks they returned.
  activity as (
    select
      orders.cylinder_label_from_item(l.item_name) as label,
      i.txn_date,
      case when l.item_name ~* '^PU' then 0 else coalesce(l.quantity, 0) end as delivered,
      case when l.item_name ~* '^PU' then coalesce(l.quantity, 0) else 0 end as picked_up
    from ops.qbo_invoices i
    join ops.qbo_invoice_lines l on l.invoice_id = i.id
    where i.customer_ref_id = p_qbo_customer_id
      and i.doc_number not ilike 'BTRF-%'
      and orders.cylinder_label_from_item(l.item_name) is not null
  ),
  -- A gas the customer has moved but never been rent-billed for still counts.
  -- Anchoring only on BTRF rows would show nothing at all for a brand-new
  -- account whose first rental invoice has not run yet.
  labels as (
    select label from anchors
    union
    select label from activity
  ),
  rolled as (
    select
      lb.label,
      a.doc_number,
      a.txn_date as btrf_date,
      coalesce(a.balance_at_btrf, 0) as balance_at_btrf,
      a.unit_price as btrf_price,
      coalesce((select sum(x.delivered)::int   from activity x
                 where x.label = lb.label
                   and (a.txn_date is null or x.txn_date > a.txn_date)), 0) as deliveries_since,
      coalesce((select sum(x.picked_up)::int   from activity x
                 where x.label = lb.label
                   and (a.txn_date is null or x.txn_date > a.txn_date)), 0) as pickups_since,
      (select max(x.txn_date) from activity x where x.label = lb.label) as last_activity
    from labels lb
    left join anchors a on a.label = lb.label
  )
  select
    r.label,
    (r.balance_at_btrf + r.deliveries_since - r.pickups_since)::int as on_hand,
    r.balance_at_btrf,
    r.deliveries_since,
    r.pickups_since,
    r.doc_number as btrf_doc_number,
    r.btrf_date,
    r.last_activity,
    -- The live rate wins over whatever the last rental invoice happened to
    -- charge; the BTRF price is the fallback so a retired item still prices.
    coalesce(qi.unit_price::numeric, r.btrf_price, 0) as unit_price,
    round(
      greatest(r.balance_at_btrf + r.deliveries_since - r.pickups_since, 0)
      * coalesce(qi.unit_price::numeric, r.btrf_price, 0), 2) as monthly_rent
  from rolled r
  left join ops.qbo_items qi
    on qi.active = true
   and qi.name = case r.label
         when '20LB CO2' then '1000TRF-C'
         when '10LB CO2' then '1000TRF-S'
         when '5LB CO2'  then '1000TRF-S'
         when '50LB CO2' then '1000TRF-C 50LB'
         when 'Mix gas'  then '1000TRF-B'
         when 'Nitrogen' then '1000TRF-N'
       end
  order by r.label;
$fn$;

revoke all on function ops.fn_customer_cylinders__i(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The staff door. One read, the customer's own tanks plus its stores'.
-- ---------------------------------------------------------------------------
-- ⚠ IT ROLLS UP THE CHAIN, and it has to. THE MELT MAIN holds cylinders at 20
--   of its stores and none on its own record — a page reading only the
--   customer's own id would tell its operator that a chain with a hundred
--   tanks out has none. Same trap `ops.v_equipment_line`'s readers hit with
--   TAQUERIAS EL FAROLITOS MASTER, and the membership link is the same one:
--   `ops.qbo_customers.parent_ref_id`, never a second definition of which
--   customers count.
-- ⚠ Sub rows are STAMPED with the store rather than merged into the parent's,
--   because "who do I collect these from" is the question being asked.
create or replace function ops.fn_customer_cylinders(
  p_qbo_customer_id text,
  p_include_subs    boolean default true
)
returns table (
  qbo_customer_id  text,
  customer_name    text,
  is_sub           boolean,
  label            text,
  on_hand          integer,
  balance_at_btrf  integer,
  deliveries_since integer,
  pickups_since    integer,
  btrf_doc_number  text,
  btrf_date        date,
  last_activity    date,
  unit_price       numeric,
  monthly_rent     numeric
)
language plpgsql
stable
security definer
set search_path to 'ops', 'orders', 'public', 'pg_temp'
as $fn$
begin
  if not ops.fn_is_staff() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  with scope as (
    select p_qbo_customer_id as id, false as is_sub
    union all
    select c.qbo_customer_id::text, true
    from ops.qbo_customers c
    where p_include_subs
      and c.parent_ref_id = p_qbo_customer_id
      and c.qbo_customer_id::text <> p_qbo_customer_id
  )
  select
    s.id,
    (select c.display_name from ops.qbo_customers c
      where c.qbo_customer_id::text = s.id limit 1),
    s.is_sub,
    r.label, r.on_hand, r.balance_at_btrf, r.deliveries_since, r.pickups_since,
    r.btrf_doc_number, r.btrf_date, r.last_activity, r.unit_price, r.monthly_rent
  from scope s
  cross join lateral ops.fn_customer_cylinders__i(s.id) r
  -- ⚠ A settled gas is dropped from a SUB but KEPT on the customer's own
  --    record. On the account you are looking at, "20lb CO2: none out" is an
  --    answer; repeated across 26 stores it is noise that buries the two
  --    stores that do hold tanks.
  where not s.is_sub
     or r.on_hand <> 0
     or r.deliveries_since <> 0
     or r.pickups_since <> 0
  order by s.is_sub, 2, r.label;
end;
$fn$;

revoke all on function ops.fn_customer_cylinders(text, boolean) from public, anon;
grant execute on function ops.fn_customer_cylinders(text, boolean) to authenticated, service_role;
