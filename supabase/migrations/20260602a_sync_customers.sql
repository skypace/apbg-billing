-- 20260602a_sync_customers.sql
-- Phase 1 of ResQ <-> SF sync v2: a single identity map for the RESQ-linked
-- customers. A "linked customer" is a QBO/SF customer with RESQ in its name
-- (today there are exactly two: THE MELT RESQ, STARBIRD CHICKEN RESQ).
--
-- This replaces the hand-maintained string literals that had drifted apart:
--   * resq-sf-sync-background.mjs  SF_CUSTOMERS / FACILITY_MAP  ('STARBIRD CHICKEN: RESQ' — wrong, had a colon)
--   * expense-to-bill.mjs          RESQ_CUSTOMER_MAP            ('STARBIRD CHICKEN RESQ')
-- Both now read ops.sync_customers instead.

create table if not exists ops.sync_customers (
  id                      bigint generated always as identity primary key,
  qbo_customer_id         text unique not null,            -- QBO Customer.Id (e.g. '1945')
  qbo_customer_name       text not null,                   -- QBO DisplayName
  sf_customer_name        text,                            -- seed for resolveSfCustomerName(); null => use qbo name
  resq_facility_keywords  text[] not null default '{}',    -- lowercase substrings that match a ResQ WO facility -> this customer
  qbo_cogs_account_id     text,                            -- per-customer COGS default (nullable; category map remains the fallback)
  entity                  text,                            -- brix|AS|freeflow|FF|shared (nullable)
  linked                  boolean not null default true,   -- is this customer active in the sync
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table ops.sync_customers is
  'Identity map for RESQ-linked customers (ResQ facility <-> SF customer <-> QBO customer). Phase 1 of resq-sf-sync v2. Writer: Netlify function sync-customers.';

alter table ops.sync_customers enable row level security;

-- anon + authenticated may read (the sync dashboard and the Netlify functions
-- read with the public anon key). All writes go through the service-role key
-- in the sync-customers endpoint, which bypasses RLS.
drop policy if exists sync_customers_read on ops.sync_customers;
create policy sync_customers_read on ops.sync_customers
  for select to anon, authenticated using (true);

-- keep updated_at fresh on UPDATE
create or replace function ops.tg_sync_customers_touch() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_sync_customers_touch on ops.sync_customers;
create trigger trg_sync_customers_touch
  before update on ops.sync_customers
  for each row execute function ops.tg_sync_customers_touch();

-- Seed the two live RESQ customers (idempotent on qbo_customer_id).
insert into ops.sync_customers
  (qbo_customer_id, qbo_customer_name, sf_customer_name, resq_facility_keywords, linked, notes)
values
  ('1945', 'STARBIRD CHICKEN RESQ', 'STARBIRD CHICKEN RESQ', array['starbird','star bird'], true, 'Seeded in Phase 1 from QBO (realm 9130352144155116).'),
  ('1944', 'THE MELT RESQ',         'THE MELT RESQ',         array['melt','homeroom'],      true, 'Seeded in Phase 1 from QBO (realm 9130352144155116).')
on conflict (qbo_customer_id) do update set
  qbo_customer_name      = excluded.qbo_customer_name,
  sf_customer_name       = excluded.sf_customer_name,
  resq_facility_keywords = excluded.resq_facility_keywords,
  linked                 = excluded.linked;
