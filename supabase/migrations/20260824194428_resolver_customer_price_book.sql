-- resolve_prices_for_customer was missing the assigned-price-book rung that
-- ops.resolve_price (the single-item resolver) already has. A customer assigned
-- to a non-default price book via ops.customer_price_book (e.g. BX-2 CANS) kept
-- resolving BX-1 prices in every bulk consumer (brix-order shop display, order
-- billing, admin pricing tab, voice agent). Found live 2026-08-24: DOMENICO'S
-- (qbo 1768) was put on BX-2 CANS in Refractor and the portal kept showing the
-- BX-1 $32 case price — 29 customers were on BX-2 CANS at the time, all
-- affected. Ladder is now identical to resolve_price:
--   contract -> assigned customer price book -> BX-1.
-- source returns the actual book code (e.g. 'BX-2 CANS') for the middle rung.

create or replace function ops.resolve_prices_for_customer(p_qbo_customer_id text, p_on date default current_date)
returns table(qbo_item_id text, item_name text, unit_price numeric, source text)
language sql
stable security definer
set search_path to 'ops', 'public', 'pg_temp'
as $$
  with contract_p as (
    select distinct on (ci.qbo_item_id) ci.qbo_item_id, ci.item_name, ci.unit_price
    from ops.pricing_contracts c
    join ops.pricing_contract_customers cc on cc.contract_id = c.id
    join ops.pricing_contract_items ci on ci.contract_id = c.id
    where cc.qbo_customer_id = p_qbo_customer_id and c.active
      and c.start_date <= p_on and (c.end_date is null or c.end_date >= p_on)
    order by ci.qbo_item_id, ci.unit_price asc
  ),
  cust_book_p as (
    select distinct on (pbi.qbo_item_id) pbi.qbo_item_id, pbi.item_name, pbi.unit_price, pb.code
    from ops.customer_price_book cpb
    join ops.price_books pb on pb.id = cpb.price_book_id
    join ops.price_book_items pbi on pbi.price_book_id = cpb.price_book_id
    where cpb.qbo_customer_id = p_qbo_customer_id
      and pbi.effective_from <= p_on and (pbi.effective_to is null or pbi.effective_to >= p_on)
    order by pbi.qbo_item_id, pbi.effective_from desc
  ),
  book_p as (
    select distinct on (pbi.qbo_item_id) pbi.qbo_item_id, pbi.item_name, pbi.unit_price
    from ops.price_books pb join ops.price_book_items pbi on pbi.price_book_id = pb.id
    where pb.code = 'BX-1'
      and pbi.effective_from <= p_on and (pbi.effective_to is null or pbi.effective_to >= p_on)
    order by pbi.qbo_item_id, pbi.effective_from desc
  ),
  all_ids as (
    select qbo_item_id from contract_p
    union select qbo_item_id from cust_book_p
    union select qbo_item_id from book_p
  )
  select a.qbo_item_id,
         coalesce(cp.item_name, kp.item_name, bp.item_name) as item_name,
         coalesce(cp.unit_price, kp.unit_price, bp.unit_price) as unit_price,
         case when cp.qbo_item_id is not null then 'contract'
              when kp.qbo_item_id is not null then kp.code
              else 'BX-1' end as source
  from all_ids a
  left join contract_p cp on cp.qbo_item_id = a.qbo_item_id
  left join cust_book_p kp on kp.qbo_item_id = a.qbo_item_id
  left join book_p bp on bp.qbo_item_id = a.qbo_item_id;
$$;
