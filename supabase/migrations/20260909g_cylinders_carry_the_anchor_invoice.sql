-- 20260909g — the shared derivation carries the anchor invoice's id.
--
-- `20260909f` returned the anchor's DOC NUMBER but not its QuickBooks id, and
-- brix-order's `orders.v_cylinder_inventory` has always returned
-- `btrf_qbo_invoice_id` — selected and mapped by `useCylinders.ts`. Converging
-- the portal onto the shared function without it would have meant nulling a
-- column a page already reads.
--
-- ⚠ It is not rendered TODAY, and that is not a reason to drop it: the doc
-- number identifies the invoice to a human and the id is what a link would need,
-- so the moment somebody makes that anchor clickable the column has to be back.
-- Carrying one more column off a row we already read costs nothing; dropping it
-- costs a migration and a deploy later.
--
-- ⚠ `20260909f` IS LEFT EXACTLY AS APPLIED. Editing an applied migration's body
-- makes the repo lie about its own history — the same rule `20260909b`/`c`
-- followed a day earlier.
--
-- The return type changes, so this DROPs rather than REPLACEs. Both callers
-- (`ops.fn_customer_cylinders`, and through it `core.fn_customer_profile`)
-- resolve `__i` BY NAME at execution time, so neither needs rebuilding — but
-- both are asserted below, because "it should still work" is not evidence.

drop function if exists ops.fn_customer_cylinders__i(text);

create function ops.fn_customer_cylinders__i(p_qbo_customer_id text)
returns table (
  label               text,
  on_hand             integer,
  balance_at_btrf     integer,
  deliveries_since    integer,
  pickups_since       integer,
  btrf_qbo_invoice_id text,
  btrf_doc_number     text,
  btrf_date           date,
  last_activity       date,
  unit_price          numeric,
  monthly_rent        numeric
)
language sql
stable
security definer
set search_path to 'ops', 'orders', 'public', 'pg_temp'
as $fn$
  with anchors as (
    select distinct on (label)
           label, qbo_invoice_id, doc_number, txn_date, balance_at_btrf, unit_price
    from (
      select
        orders.cylinder_label_from_btrf(l.description, l.item_name) as label,
        i.qbo_invoice_id,
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
  labels as (
    select label from anchors
    union
    select label from activity
  ),
  rolled as (
    select
      lb.label,
      a.qbo_invoice_id,
      a.doc_number,
      a.txn_date as btrf_date,
      coalesce(a.balance_at_btrf, 0) as balance_at_btrf,
      a.unit_price as btrf_price,
      coalesce((select sum(x.delivered)::int from activity x
                 where x.label = lb.label
                   and (a.txn_date is null or x.txn_date > a.txn_date)), 0) as deliveries_since,
      coalesce((select sum(x.picked_up)::int from activity x
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
    r.qbo_invoice_id as btrf_qbo_invoice_id,
    r.doc_number     as btrf_doc_number,
    r.btrf_date,
    r.last_activity,
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

-- Both callers still resolve, and the guard survived the drop.
do $$
begin
  if has_function_privilege('authenticated', 'ops.fn_customer_cylinders__i(text)', 'execute')
     or has_function_privilege('anon', 'ops.fn_customer_cylinders__i(text)', 'execute') then
    raise exception 'the inner function is reachable by a caller — the guard did not survive';
  end if;

  -- ⚠ CLAIMS MUST BE SET. A migration runs as `postgres` with no JWT, so
  -- `ops.fn_is_staff()` reads null and the staff door refuses 42501 — which is
  -- the gate WORKING, and is how this block failed on its first apply. Any
  -- migration that exercises a staff-gated function has to say who it is.
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","user_metadata":{"role":"superadmin"}}', true);

  perform 1 from ops.fn_customer_cylinders('1379', true) limit 1;   -- the staff door
  perform core.fn_customer_profile('1379');                          -- and BrixSD's read
end $$;
