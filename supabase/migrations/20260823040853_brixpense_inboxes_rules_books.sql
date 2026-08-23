-- Brixpense: the Vendor Inbox opens to everyone in Brixpense, bill rules,
-- and expense report books.

-- ── 1. "Everyone in Brixpense" as a SQL predicate ─────────────────────────
--
-- Sky: the vendor inbox is the master inbox and "everybody should have that
-- access as well". On a SHARED Supabase project "everybody" cannot mean every
-- login — brix-order customers, sub-distributor partners and melt users all
-- authenticate here, and vendor invoices carry our costs. So it means everyone
-- with BRIXPENSE access, which is the gateway's 'billing' bucket.
--
-- This mirrors hasBrixpenseAccess() in netlify/functions/lib/ap-inbox.mjs and
-- the gateway's grantsAccess(): superadmin always; an explicit modules array
-- must contain 'billing'; otherwise the legacy role map.
create or replace function ops.fn_has_brixpense()
returns boolean language sql stable as $$
  select coalesce(
    case
      when (auth.jwt()->'user_metadata'->>'role') = 'superadmin' then true
      when jsonb_typeof(auth.jwt()->'user_metadata'->'modules') = 'array'
        then (auth.jwt()->'user_metadata'->'modules') ? 'billing'
      else (auth.jwt()->'user_metadata'->>'role') in ('admin','finance')
    end, false)
$$;
revoke execute on function ops.fn_has_brixpense() from public;
grant execute on function ops.fn_has_brixpense() to authenticated, service_role, anon;

drop policy if exists bill_email_intake_select_staff on ops.bill_email_intake;
drop policy if exists bill_email_intake_select_brixpense on ops.bill_email_intake;
create policy bill_email_intake_select_brixpense
  on ops.bill_email_intake for select to authenticated
  using (ops.fn_has_brixpense());

-- ── 2. Bill rules ─────────────────────────────────────────────────────────
--
-- "build rules for specific bills so that if you have specific bills from
-- specific vendors or some kind of things that they recognize like recurring,
-- we can have it all auto populate."
--
-- A rule MATCHES on what we can see about an inbound bill and SETS the coding
-- fields. It never posts anything — auto-populate fills the form, a human
-- still clicks Post to QuickBooks.
create table if not exists ops.expense_rules (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  active              boolean not null default true,
  priority            integer not null default 100,   -- lower runs first

  -- match (all non-null conditions must hold)
  match_vendor        text,      -- case-insensitive substring of the vendor
  match_sender        text,      -- sender address or bare domain
  match_text          text,      -- substring of subject / memo / line text
  match_min_amount    numeric(14,2),
  match_max_amount    numeric(14,2),

  -- auto-populate
  set_department      text,
  set_entity          text,
  set_cogs_account_id text,
  set_cogs_account_label text,
  set_tag             text,
  set_job_number      text,
  set_customer_name   text,
  set_owner_email     text,      -- routing override, beats the ladder
  set_memo            text,

  -- recurring recognition
  recurring           boolean not null default false,
  recurring_period    text,      -- weekly | monthly | quarterly | annual
  expected_amount     numeric(14,2),
  amount_tolerance_pct numeric(5,2) not null default 10,

  -- observed
  match_count         integer not null default 0,
  last_matched_at     timestamptz,
  last_amount         numeric(14,2),

  notes               text,
  created_by_email    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,
  constraint expense_rules_period_ck check (
    recurring_period is null
    or recurring_period in ('weekly','monthly','quarterly','annual')
  ),
  -- A rule with no conditions would silently claim every bill.
  constraint expense_rules_has_a_condition_ck check (
    match_vendor is not null or match_sender is not null or match_text is not null
    or match_min_amount is not null or match_max_amount is not null
  )
);
create index if not exists expense_rules_active_idx
  on ops.expense_rules (active, priority) where archived_at is null;

-- Which rule coded a bill — so "why is this account on here" is answerable.
alter table ops.expense_requests
  add column if not exists applied_rule_id uuid references ops.expense_rules(id) on delete set null;

alter table ops.expense_rules enable row level security;
drop policy if exists expense_rules_select on ops.expense_rules;
create policy expense_rules_select on ops.expense_rules for select to authenticated
  using (ops.fn_has_brixpense());
drop policy if exists expense_rules_write on ops.expense_rules;
create policy expense_rules_write on ops.expense_rules for all to authenticated
  using (ops.fn_is_staff()) with check (ops.fn_is_staff());
grant select on ops.expense_rules to authenticated;
grant all    on ops.expense_rules to service_role;

-- ── 3. Expense report books ───────────────────────────────────────────────
--
-- "build reports and in those reports you could build multiple books, you
-- could tie multiple expenses together across different payment types and
-- then link it to a tag/job so you could run expense reports."
--
-- A book is a named bundle of expense_requests. Membership is explicit rather
-- than a saved filter, because the point is to tie together things a filter
-- would not naturally group — a card charge, a check and an emailed bill that
-- all belong to one job.
create table if not exists ops.expense_books (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  status         text not null default 'open',   -- open | closed
  period_start   date,
  period_end     date,
  tag            text,
  job_number     text,
  customer_name  text,
  entity         text,
  created_by     uuid,
  created_by_email text,
  closed_at      timestamptz,
  closed_by      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint expense_books_status_ck check (status in ('open','closed'))
);

create table if not exists ops.expense_book_items (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references ops.expense_books(id) on delete cascade,
  expense_id  uuid not null references ops.expense_requests(id) on delete cascade,
  note        text,
  added_by    text,
  added_at    timestamptz not null default now(),
  unique (book_id, expense_id)
);
create index if not exists expense_book_items_book_idx on ops.expense_book_items (book_id);
create index if not exists expense_book_items_expense_idx on ops.expense_book_items (expense_id);

alter table ops.expense_books      enable row level security;
alter table ops.expense_book_items enable row level security;

drop policy if exists expense_books_select on ops.expense_books;
create policy expense_books_select on ops.expense_books for select to authenticated
  using (ops.fn_has_brixpense());
-- Staff manage any book; anyone in Brixpense manages their own.
drop policy if exists expense_books_write on ops.expense_books;
create policy expense_books_write on ops.expense_books for all to authenticated
  using (ops.fn_is_staff() or created_by = auth.uid())
  with check (ops.fn_is_staff() or created_by = auth.uid());

drop policy if exists expense_book_items_select on ops.expense_book_items;
create policy expense_book_items_select on ops.expense_book_items for select to authenticated
  using (ops.fn_has_brixpense());
drop policy if exists expense_book_items_write on ops.expense_book_items;
create policy expense_book_items_write on ops.expense_book_items for all to authenticated
  using (exists (select 1 from ops.expense_books b
                  where b.id = book_id and (ops.fn_is_staff() or b.created_by = auth.uid())))
  with check (exists (select 1 from ops.expense_books b
                  where b.id = book_id and (ops.fn_is_staff() or b.created_by = auth.uid())));

grant select on ops.expense_books, ops.expense_book_items to authenticated;
grant all    on ops.expense_books, ops.expense_book_items to service_role;

drop trigger if exists expense_rules_touch on ops.expense_rules;
create trigger expense_rules_touch before update on ops.expense_rules
  for each row execute function ops.touch_updated_at();
drop trigger if exists expense_books_touch on ops.expense_books;
create trigger expense_books_touch before update on ops.expense_books
  for each row execute function ops.touch_updated_at();

-- What a book is worth, split the way an expense report has to be read:
-- by how it was paid. security_invoker so the caller's RLS applies.
create or replace view ops.v_expense_book_totals
with (security_invoker = true) as
select
  b.id                                as book_id,
  count(i.id)                         as item_count,
  coalesce(sum(r.total_amount), 0)    as total_amount,
  coalesce(sum(r.total_amount) filter (where r.as_bill),                   0) as bills_amount,
  coalesce(sum(r.total_amount) filter (where not r.as_bill),               0) as paid_amount,
  coalesce(sum(r.total_amount) filter (where r.qbo_bill_id is not null
                                          or r.qbo_purchase_id is not null), 0) as posted_amount,
  coalesce(sum(r.total_amount) filter (where r.qbo_bill_id is null
                                         and r.qbo_purchase_id is null),   0) as unposted_amount
from ops.expense_books b
left join ops.expense_book_items i on i.book_id = b.id
left join ops.expense_requests   r on r.id = i.expense_id
group by b.id;
grant select on ops.v_expense_book_totals to authenticated, service_role;
