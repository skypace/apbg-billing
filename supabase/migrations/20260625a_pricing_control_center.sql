-- ============================================================================
-- PRICING CONTROL CENTER — shared pricing model
-- ============================================================================
-- Source of truth for Brix pricing, surfaced in BRIX Margin Control (/margin/
-- → Pricing) and read by brix-order + billing. Keyed by QBO ids (the shared
-- identity across apps). Layers (highest precedence first):
--   1 contract (BX-3)        → pricing_contracts + pricing_contract_items (named, dated)
--   2 price book (BX-1 standard) → price_books + price_book_items (per item, dated)
--   3 list price (fallback)  → ops.qbo_items / catalog list price
-- A price increase = insert rows with a future effective_from (no overwrite).
-- See brix-order docs/PRICING.md for the cross-repo design + decision log.
--
-- Applied to live (gfsdpwiqzshhexkofiif) 2026-06-25 via Supabase MCP.
-- ============================================================================

create table if not exists ops.price_books (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,        -- 'BX-1', 'BX-2'
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One standard price book (BX-1). Everyone defaults to it; customer-specific
-- pricing is handled by contracts below (no second universal tier).
insert into ops.price_books (code, name) values
  ('BX-1', 'BX-1 Standard Pricing')
  on conflict (code) do nothing;

create table if not exists ops.price_book_items (
  id             uuid primary key default gen_random_uuid(),
  price_book_id  uuid not null references ops.price_books(id) on delete cascade,
  qbo_item_id    text not null,
  item_name      text,
  unit_price     numeric not null check (unit_price >= 0),
  effective_from date not null default current_date,
  effective_to   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists price_book_items_lookup
  on ops.price_book_items (qbo_item_id, price_book_id, effective_from desc);

create table if not exists ops.customer_price_book (
  qbo_customer_id text primary key,
  price_book_id   uuid references ops.price_books(id),
  updated_at      timestamptz not null default now()
);

create table if not exists ops.pricing_contracts (
  id              uuid primary key default gen_random_uuid(),
  qbo_customer_id text not null,
  name            text not null,            -- e.g. "THE MELT 2026"
  start_date      date not null,
  end_date        date,
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists pricing_contracts_customer
  on ops.pricing_contracts (qbo_customer_id, active, start_date desc);

create table if not exists ops.pricing_contract_items (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references ops.pricing_contracts(id) on delete cascade,
  qbo_item_id text not null,
  item_name   text,
  unit_price  numeric not null check (unit_price >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (contract_id, qbo_item_id)
);

create or replace function ops.resolve_price(
  p_qbo_customer_id text,
  p_qbo_item_id     text,
  p_on              date default current_date
) returns numeric
language plpgsql stable security definer
set search_path = ops, public, pg_temp
as $$
declare v numeric;
begin
  select ci.unit_price into v
  from ops.pricing_contracts c
  join ops.pricing_contract_items ci on ci.contract_id = c.id
  where c.qbo_customer_id = p_qbo_customer_id and c.active
    and c.start_date <= p_on and (c.end_date is null or c.end_date >= p_on)
    and ci.qbo_item_id = p_qbo_item_id
  order by c.start_date desc limit 1;
  if v is not null then return v; end if;

  select pbi.unit_price into v
  from ops.customer_price_book cpb
  join ops.price_book_items pbi on pbi.price_book_id = cpb.price_book_id
  where cpb.qbo_customer_id = p_qbo_customer_id
    and pbi.qbo_item_id = p_qbo_item_id
    and pbi.effective_from <= p_on and (pbi.effective_to is null or pbi.effective_to >= p_on)
  order by pbi.effective_from desc limit 1;
  return v;
end;
$$;

alter table ops.price_books            enable row level security;
alter table ops.price_book_items       enable row level security;
alter table ops.customer_price_book    enable row level security;
alter table ops.pricing_contracts      enable row level security;
alter table ops.pricing_contract_items enable row level security;

grant select, insert, update, delete on
  ops.price_books, ops.price_book_items, ops.customer_price_book,
  ops.pricing_contracts, ops.pricing_contract_items to service_role;
grant execute on function ops.resolve_price(text, text, date) to service_role;
