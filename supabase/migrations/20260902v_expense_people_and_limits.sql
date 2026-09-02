-- Brixpense visibility and approval authority, owned by Brixpense.
--
-- THE BUG THIS FIXES. Every expense surface keyed off ops.fn_is_staff(), which
-- reads the GATEWAY's user_metadata.role. All seven of those logins are
-- 'superadmin', so every one of them saw every Service Fusion expense and every
-- emailed bill — vendors, amounts, GL coding, the lot. The RLS on
-- expense_requests was never the problem: own-or-named-approver is correct. The
-- problem is that a flag meaning "can administer the hub" was being read as
-- "may see the company's payables", and those are not the same permission.
--
-- So Brixpense gets its own roster. A person's hub role no longer says anything
-- about what they see here.
--
-- THE MODEL (Sky, 2026-09-02):
--   drivers and office staff approve up to $500
--   techs approve up to $800
--   Marco / Joel / Anthony V / Whitney are managers, up to $2,500
--   anything above $2,500 is Sky's
--   techs route to Anthony V · drivers route to Joel · office routes to Marco
--
-- Two separate things, deliberately separate columns:
--   approval_limit — how much you may approve (yours or a report's)
--   ap_admin       — whether you see the company-wide AP surfaces at all
-- Marco is both. Anthony V is a manager who is NOT an AP admin: he approves his
-- techs without seeing every vendor bill in the company. Collapsing the two is
-- exactly the mistake fn_is_staff() was making.

create table if not exists ops.expense_people (
  email           text primary key check (email = lower(email)),
  full_name       text,
  job             text not null default 'office'
                    check (job in ('driver','office','tech','manager','owner')),
  -- NULL = unlimited. Only 'owner' should carry NULL; the CHECK below enforces
  -- that, because an accidental NULL on an employee is a silent blank cheque.
  approval_limit  numeric(12,2) check (approval_limit is null or approval_limit >= 0),
  approver_email  text,                    -- who it escalates to above the limit
  ap_admin        boolean not null default false,
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint expense_people_unlimited_is_owner
    check (approval_limit is not null or job = 'owner'),
  -- a self-referencing approver is an infinite escalation loop
  constraint expense_people_no_self_approve
    check (approver_email is null or approver_email <> email)
);

comment on table ops.expense_people is
  'Brixpense roster: who may approve how much, who approves them, and who sees '
  'the company-wide AP surfaces. Deliberately NOT derived from the gateway role '
  '— superadmin means "can administer the hub", not "may see every payable".';

create index if not exists expense_people_approver_idx on ops.expense_people (approver_email) where active;

-- ─── helpers ────────────────────────────────────────────────────────────────
-- All SECURITY DEFINER with the guard inline (the 20260820b rule) and EXECUTE
-- revoked from public/anon: this is a shared project that also authenticates
-- brix-order customers and distribution partners.

create or replace function ops.fn_expense_email()
returns text language sql stable as $$
  select lower(nullif(auth.jwt() ->> 'email', ''));
$$;

-- Sees every expense and every emailed bill.
create or replace function ops.fn_expense_ap_admin()
returns boolean language sql stable security definer set search_path = ops, public as $$
  select exists (
    select 1 from ops.expense_people p
    where p.active and p.ap_admin and p.email = ops.fn_expense_email()
  );
$$;

-- What this person may approve. NULL means unlimited; a person with no row at
-- all gets 0 — an unknown login approves nothing, which is the safe default on
-- a project with 187 logins on it.
create or replace function ops.fn_expense_limit(p_email text default null)
returns numeric language sql stable security definer set search_path = ops, public as $$
  -- an inactive person, or one with no row at all, approves nothing; only a
  -- live row may carry NULL, which is what unlimited means
  select case when exists (
           select 1 from ops.expense_people p
           where p.active and p.email = coalesce(lower(p_email), ops.fn_expense_email()))
         then (select p.approval_limit from ops.expense_people p
               where p.active and p.email = coalesce(lower(p_email), ops.fn_expense_email()))
         else 0::numeric end;
$$;

-- Everyone at or below me in the approver chain. Depth-capped: a cycle the two
-- CHECKs cannot catch (a → b → a) must not hang every query on the table.
create or replace function ops.fn_expense_reports(p_email text default null)
returns table (email text) language sql stable security definer set search_path = ops, public as $$
  with recursive me as (
    select coalesce(lower(p_email), ops.fn_expense_email()) as email, 0 as depth
  ), chain as (
    select m.email, m.depth from me m
    union all
    select p.email, c.depth + 1
    from ops.expense_people p
    join chain c on lower(p.approver_email) = c.email
    where p.active and c.depth < 10
  )
  select distinct c.email from chain c;
$$;

revoke execute on function ops.fn_expense_ap_admin(), ops.fn_expense_limit(text),
                          ops.fn_expense_reports(text), ops.fn_expense_email()
  from public, anon;
grant execute on function ops.fn_expense_ap_admin(), ops.fn_expense_limit(text),
                         ops.fn_expense_reports(text), ops.fn_expense_email()
  to authenticated, service_role;

-- ─── the table's own RLS ────────────────────────────────────────────────────
-- ⚠ GRANTs go next to the policies — Postgres checks privileges BEFORE RLS, and
-- a policy with no GRANT behind it reads as a dead button (the 20260825a bug).

alter table ops.expense_people enable row level security;

drop policy if exists expense_people_select on ops.expense_people;
create policy expense_people_select on ops.expense_people
  for select to authenticated
  using (email = ops.fn_expense_email() or ops.fn_expense_ap_admin());

drop policy if exists expense_people_write on ops.expense_people;
create policy expense_people_write on ops.expense_people
  for all to authenticated
  using (ops.fn_expense_ap_admin()) with check (ops.fn_expense_ap_admin());

grant select, insert, update on ops.expense_people to authenticated;
revoke all on ops.expense_people from anon;

-- ─── expense_requests: see your own, your reports', or everything ───────────
-- The old policy pair stays as-is for own + named-approver. What is ADDED is
-- the reports arm; what is REPLACED is the Service Fusion arm, which was
-- fn_is_staff() and is the actual leak.

drop policy if exists expense_requests_select on ops.expense_requests;
create policy expense_requests_select on ops.expense_requests
  for select to authenticated
  using (
    submitted_by = auth.uid()
    or manager_email = ops.fn_expense_email()
    or ops.fn_expense_ap_admin()
    or lower(submitter_email) in (select email from ops.fn_expense_reports())
  );

drop policy if exists expense_requests_select_sf on ops.expense_requests;
create policy expense_requests_select_sf on ops.expense_requests
  for select to authenticated
  using (tag = 'Service Fusion' and ops.fn_expense_ap_admin());

drop policy if exists expense_requests_update_sf_staff on ops.expense_requests;
create policy expense_requests_update_sf_staff on ops.expense_requests
  for update to authenticated
  using (tag = 'Service Fusion' and ops.fn_expense_ap_admin())
  with check (tag = 'Service Fusion' and ops.fn_expense_ap_admin());

-- A manager may act on a report's expense, not just look at it.
drop policy if exists expense_requests_update_reports on ops.expense_requests;
create policy expense_requests_update_reports on ops.expense_requests
  for update to authenticated
  using (lower(submitter_email) in (select email from ops.fn_expense_reports()))
  with check (lower(submitter_email) in (select email from ops.fn_expense_reports()));

-- ─── the emailed-bill queue is an AP surface ────────────────────────────────
-- ⚠ The live policy is named _select_brixpense, not _select. Dropping the name
-- I first assumed would have silently no-opped and left the whole company-wide
-- bill queue readable by every Brixpense login — the leak, still open, with a
-- migration that looked like it had closed it. Read pg_policies, don't guess.
drop policy if exists bill_email_intake_select_brixpense on ops.bill_email_intake;
drop policy if exists bill_email_intake_select on ops.bill_email_intake;
create policy bill_email_intake_select on ops.bill_email_intake
  for select to authenticated using (ops.fn_expense_ap_admin());

-- ─── seed ───────────────────────────────────────────────────────────────────
-- Only the people who actually hold a login today. Drivers and techs have none
-- yet ("when we have drivers"), so their rows are created as they are invited —
-- and until then an unknown login approves nothing and sees nothing.
insert into ops.expense_people (email, full_name, job, approval_limit, approver_email, ap_admin, notes) values
  ('skypace@brixbev.com',      'Sky Pace',            'owner',   null,    null,                  true,  'Everything above $2,500'),
  ('asloan@brixbev.com',       'Anthony Sloan',       'manager', 2500.00, 'skypace@brixbev.com', true,  'Partner'),
  ('marco@brixbev.com',        'Marco',               'manager', 2500.00, 'skypace@brixbev.com', true,  'Ops Manager — office staff route here'),
  ('joel@brixbev.com',         'Joel Sanchez',        'manager', 2500.00, 'skypace@brixbev.com', false, 'Ops Support — drivers route here'),
  ('anthonyv@brixbev.com',     'Anthony VanRenselaar','manager', 2500.00, 'skypace@brixbev.com', false, 'Lead Tech — techs route here'),
  ('whitney@alamedasoda.com',  'Whitney Grandell',    'manager', 2500.00, 'anthonyv@brixbev.com', false, 'Ops/Billing')
on conflict (email) do nothing;
