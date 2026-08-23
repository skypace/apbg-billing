-- ============================================================================
-- PRICING CONTROL CENTER — chain contracts + default-book resolver
-- ============================================================================
-- A contract can cover MANY customers (a chain = many locations, e.g. The Melt).
-- Resolver precedence: chain contract (via membership) → explicit customer book
-- assignment → default BX-1 standard book → null (caller falls back to list).
--
-- Applied to live (gfsdpwiqzshhexkofiif) 2026-06-25 via Supabase MCP.
-- The BX-1 standard prices + the chain contracts (The Melt, Starbird, Top Dog,
-- Bronco Billy's, UCSF, Grand Lake, Square Pie Guys, Origins) were seeded by a
-- one-time ETL from the last 180 days of ops.qbo_invoice_lines (modal price per
-- item among standard $82/$87 customers for BX-1; modal among each chain's
-- below-standard locations for contracts). Not replayed here (derived from live
-- history); editable going forward in /margin → Pricing.
-- ============================================================================

alter table ops.pricing_contracts alter column qbo_customer_id drop not null;

create table if not exists ops.pricing_contract_customers (
  contract_id     uuid not null references ops.pricing_contracts(id) on delete cascade,
  qbo_customer_id text not null,
  primary key (contract_id, qbo_customer_id)
);
create index if not exists pricing_contract_customers_cust
  on ops.pricing_contract_customers (qbo_customer_id);
grant select, insert, update, delete on ops.pricing_contract_customers to service_role;

create or replace function ops.resolve_price(
  p_qbo_customer_id text, p_qbo_item_id text, p_on date default current_date
) returns numeric language plpgsql stable security definer
set search_path = ops, public, pg_temp as $$
declare v numeric;
begin
  select ci.unit_price into v
  from ops.pricing_contracts c
  join ops.pricing_contract_customers cc on cc.contract_id = c.id
  join ops.pricing_contract_items ci on ci.contract_id = c.id
  where cc.qbo_customer_id = p_qbo_customer_id and c.active
    and c.start_date <= p_on and (c.end_date is null or c.end_date >= p_on)
    and ci.qbo_item_id = p_qbo_item_id
  order by c.start_date desc limit 1;
  if v is not null then return v; end if;

  select pbi.unit_price into v
  from ops.customer_price_book cpb
  join ops.price_book_items pbi on pbi.price_book_id = cpb.price_book_id
  where cpb.qbo_customer_id = p_qbo_customer_id and pbi.qbo_item_id = p_qbo_item_id
    and pbi.effective_from <= p_on and (pbi.effective_to is null or pbi.effective_to >= p_on)
  order by pbi.effective_from desc limit 1;
  if v is not null then return v; end if;

  select pbi.unit_price into v
  from ops.price_books pb
  join ops.price_book_items pbi on pbi.price_book_id = pb.id
  where pb.code = 'BX-1' and pbi.qbo_item_id = p_qbo_item_id
    and pbi.effective_from <= p_on and (pbi.effective_to is null or pbi.effective_to >= p_on)
  order by pbi.effective_from desc limit 1;
  return v;
end; $$;
