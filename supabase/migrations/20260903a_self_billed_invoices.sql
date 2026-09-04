-- Self-billing: we raise the vendor's invoice on their behalf.
--
-- WHY THIS EXISTS. Origins Craft Soda does contract labour for us and does not
-- send an invoice — they green-lit us raising the paperwork so they don't have
-- to. Their expenses land from Service Fusion with a real amount, a job number
-- and a line item, and NO bill number, which is precisely what the 2026-08-13
-- OCR gate holds a draft on. So the missing document is the thing blocking the
-- bill, and generating it fixes the blockage and produces the record at once.
--
-- The invoice runs the other way from everything else in this repo: it is FROM
-- the vendor TO us. That is a recipient-created invoice (self-billing), and it
-- is only legitimate because the supplier agreed to it — so the agreement is
-- recorded on the profile rather than assumed, and the document says on its
-- face that we raised it on their behalf. Nobody reading it later should have
-- to guess why our system produced their invoice.
--
-- ⚠ Everything that identifies either party is DATA, not code: addresses, the
-- numbering, which vendor names match, who it is emailed to. A hard-coded
-- address on a legal document is a defect waiting for the counterparty to move.

create table if not exists ops.self_billing_profiles (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  active            boolean not null default true,

  -- Which expenses this profile claims. ILIKE patterns, because the same
  -- supplier arrives spelled three ways: live data carries 'Origins',
  -- 'ORIGINS CRAFT SODA' and 'ORIGINS CRAFT SODA COMPANY'. An exact match
  -- would silently miss two of the three.
  vendor_patterns   text[] not null default '{}',
  qbo_vendor_id     text,

  -- The SELLER — whose invoice this is. Sourced from their QuickBooks vendor
  -- record, never typed from memory.
  seller_name       text not null,
  seller_addr1      text,
  seller_addr2      text,
  seller_city_state_zip text,
  seller_email      text,
  seller_phone      text,

  -- The BUYER — us. NULL means "use ops.production_settings", so the company
  -- address has one home; filled here only when a profile needs to differ.
  buyer_name        text,
  buyer_addr1       text,
  buyer_addr2       text,
  buyer_city_state_zip text,
  buyer_email       text,

  -- Numbering. BX-0012 = prefix 'BX', separator '-', 4 digits, next 12.
  number_prefix     text not null default 'BX',
  number_separator  text not null default '-',
  number_pad        int  not null default 4 check (number_pad between 1 and 10),
  next_number       int  not null default 1 check (next_number >= 0),

  terms             text,
  footer_note       text,

  -- Delivery
  send_to           text[] not null default '{}',
  send_cc           text[] not null default '{}',

  -- ⚠ auto_create generates and files the document; auto_send emails an
  -- OUTSIDE party. They are separate switches on purpose. Generating is
  -- reversible and internal; sending is neither, and an invoice with a wrong
  -- amount reaching a partner is a phone call we cannot take back. Default is
  -- generate automatically, send on a click.
  auto_create       boolean not null default true,
  auto_send         boolean not null default false,

  -- The authority for raising someone else's invoice. Recorded, not assumed.
  authorized_by     text,
  authorized_at     date,
  authority_note    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table ops.self_billing_profiles is
  'Suppliers who authorised us to raise their invoices. Addresses, numbering, '
  'vendor-name matching and recipients are settings so a counterparty moving '
  'house is an edit, not a deploy.';

create table if not exists ops.self_billed_invoices (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references ops.self_billing_profiles(id),
  -- One invoice per expense, enforced: re-running the generator must never
  -- mint a second number for the same money.
  expense_request_id uuid not null unique references ops.expense_requests(id) on delete cascade,
  invoice_number    text not null unique,
  invoice_date      date not null default current_date,
  currency          text not null default 'USD',
  subtotal          numeric(12,2) not null,
  total             numeric(12,2) not null,
  lines             jsonb not null default '[]'::jsonb,

  -- What we produced, kept: the PDF emailed is the PDF filed.
  storage_path      text,
  attachment_id     uuid references ops.expense_request_attachments(id) on delete set null,

  sent_at           timestamptz,
  sent_to           text[],
  send_error        text,

  voided_at         timestamptz,
  voided_by         text,
  void_reason       text,

  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists self_billed_invoices_profile_idx on ops.self_billed_invoices (profile_id, created_at desc);

-- ─── RLS: this is accounts-payable paperwork ────────────────────────────────
-- GRANTs next to the policies (the 20260825a lesson: Postgres checks
-- privileges BEFORE RLS, and a policy with no grant reads as a dead button).

alter table ops.self_billing_profiles enable row level security;
alter table ops.self_billed_invoices  enable row level security;

drop policy if exists self_billing_profiles_ap on ops.self_billing_profiles;
create policy self_billing_profiles_ap on ops.self_billing_profiles
  for all to authenticated
  using (ops.fn_expense_ap_admin()) with check (ops.fn_expense_ap_admin());

drop policy if exists self_billed_invoices_ap on ops.self_billed_invoices;
create policy self_billed_invoices_ap on ops.self_billed_invoices
  for all to authenticated
  using (ops.fn_expense_ap_admin()) with check (ops.fn_expense_ap_admin());

grant select, insert, update on ops.self_billing_profiles to authenticated;
grant select, insert, update on ops.self_billed_invoices  to authenticated;
revoke all on ops.self_billing_profiles from anon;
revoke all on ops.self_billed_invoices  from anon;

-- ─── Number allocation ──────────────────────────────────────────────────────
-- Allocating in SQL under a row lock is the only way two clicks a second apart
-- cannot both take BX-0012. Doing it in the function would read-then-write
-- with a gap in between, which is exactly how duplicate invoice numbers happen.
create or replace function ops.fn_self_bill_next_number(p_profile_id uuid)
returns text language plpgsql security definer set search_path = ops, public as $$
declare p ops.self_billing_profiles%rowtype; n int;
begin
  if not ops.fn_expense_ap_admin() and auth.role() is distinct from 'service_role' then
    raise exception 'not permitted';
  end if;
  select * into p from ops.self_billing_profiles where id = p_profile_id for update;
  if not found then raise exception 'no such self-billing profile'; end if;
  n := p.next_number;
  update ops.self_billing_profiles
     set next_number = n + 1, updated_at = now()
   where id = p_profile_id;
  return p.number_prefix || p.number_separator || lpad(n::text, p.number_pad, '0');
end $$;

revoke execute on function ops.fn_self_bill_next_number(uuid) from public, anon;
grant execute on function ops.fn_self_bill_next_number(uuid) to authenticated, service_role;

-- ─── Origins ────────────────────────────────────────────────────────────────
-- Address and email taken from their QuickBooks vendor record (1428), which
-- already carried both — including the exact address Sky named, which is the
-- corroboration that made it safe to fill in rather than ask for.
insert into ops.self_billing_profiles (
  code, vendor_patterns, qbo_vendor_id,
  seller_name, seller_addr1, seller_city_state_zip, seller_email,
  number_prefix, number_separator, number_pad, next_number,
  send_to, auto_create, auto_send,
  authorized_by, authorized_at, authority_note, footer_note
) values (
  'ORIGINS',
  array['origins%', '%origins craft soda%'],
  '1428',
  'Origins Craft Soda', '1660 Chicago Ave', 'Riverside, CA 92507',
  'stephen.boss@originscraftsoda.com',
  'BX', '-', 4, 12,
  array['stephen.boss@originscraftsoda.com'],
  true, false,
  'Origins Craft Soda', current_date,
  'Origins authorised Alameda Point Beverage Group to raise invoices on their behalf so they do not have to issue them.',
  'This invoice was prepared by Alameda Point Beverage Group on behalf of Origins Craft Soda, by agreement.'
) on conflict (code) do nothing;
