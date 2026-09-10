-- 20260910a — Refractor reads customer contacts + documents off the GATEWAY role
--
-- Second half of moving the customer master into Refractor (Sky, 2026-09-09
-- → 2026-09-10: "we need to be able to edit the rest of the customer data
-- here too. like addresses, files and attachments, etc … we need to be able
-- to write changes from here then everything syncs back to qbo").
--
-- 20260909a gave Refractor a staff read on `orders.customers`,
-- `customer_locations` and `company_settings`. The customer record has two
-- more tables a person opens the page to see: `orders.customer_contacts`
-- (who runs the account — a name, a role and a phone; NOT logins) and
-- `orders.customer_documents` (the vault: tax id, resale certificate, the
-- signed application, the ACH form). Both carry the SAME shape 20260909a
-- fixed on customers: one SELECT policy keyed on
-- `orders.is_caller_superadmin()` — a brix-order PORTAL flag — so a gateway
-- staff member with no portal row reads 0 rows and gets an empty card with
-- no explanation. Checked live before writing this (pg_policies): exactly
-- that one policy on each table, RLS on, `authenticated` holding SELECT only.
--
-- ⚠ SELECT ONLY, AND NO GRANT CHANGE — the same safety story as 20260909a.
-- `authenticated` holds SELECT and nothing else on both tables. Every write
-- is service-role through brix-order's `admin-customer-contacts` /
-- `admin-customer-documents`, which Refractor now calls cross-origin; the
-- document endpoint is also what pushes a file onto the QuickBooks Customer
-- as an Attachable, and that push must have exactly one implementation.
-- Granting INSERT/UPDATE here would let any of the 204 customer logins on
-- this shared project write contacts and file documents against their own
-- account with no audit row. Do not "tidy this up" by adding a write policy.
--
-- ⚠ The document FILES are not touched by this. `customer_documents.file_path`
-- points into the private `customer-docs` bucket, which stays service-role
-- only; Refractor gets a 1-hour signed URL per row from the brix-order GET,
-- never a bucket grant. A row a staff member can SELECT is a label and a
-- number; the bytes still go through the gate.
--
-- Additive by construction: permissive policies OR together, so the existing
-- superadmin policy keeps working for portal superadmins exactly as before.

begin;

-- ── orders.customer_contacts ────────────────────────────────────────────────
drop policy if exists customer_contacts_select_staff on orders.customer_contacts;
create policy customer_contacts_select_staff
  on orders.customer_contacts
  for select
  to authenticated
  using (ops.fn_is_staff());

comment on policy customer_contacts_select_staff on orders.customer_contacts is
  'Refractor (apbg-billing) shows who runs the account on the customer page. Gated on the GATEWAY role (ops.fn_is_staff), like every other Refractor screen — never on orders.customer_users.is_superadmin, a brix-order portal flag a staff account need not hold. SELECT only: writes stay service-role via brix-order admin-customer-contacts.';

-- ── orders.customer_documents ───────────────────────────────────────────────
drop policy if exists customer_documents_select_staff on orders.customer_documents;
create policy customer_documents_select_staff
  on orders.customer_documents
  for select
  to authenticated
  using (ops.fn_is_staff());

comment on policy customer_documents_select_staff on orders.customer_documents is
  'Refractor lists the customer document vault (tax id, resale cert, application, ACH form) on the customer page. Gateway role, SELECT only. The file bytes stay behind the service-role bucket — Refractor reads signed URLs from brix-order admin-customer-documents, never the bucket.';

commit;

-- ── prove it, rather than trusting a clean apply ────────────────────────────
do $$
declare
  v_pol   int;
  v_write int;
begin
  select count(*) into v_pol
  from pg_policies
  where schemaname='orders'
    and policyname in ('customer_contacts_select_staff',
                       'customer_documents_select_staff');
  if v_pol <> 2 then
    raise exception 'expected 2 staff-read policies, found %', v_pol;
  end if;

  -- the safety story: still no write privilege for a browser caller
  select count(*) into v_write
  from information_schema.role_table_grants
  where table_schema='orders'
    and table_name in ('customer_contacts','customer_documents')
    and grantee in ('anon','authenticated')
    and privilege_type in ('INSERT','UPDATE','DELETE');
  if v_write <> 0 then
    raise exception
      'a browser role gained a write privilege on contacts/documents (% grants) — that is the one thing this migration must not do',
      v_write;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='orders'
      and table_name in ('customer_contacts','customer_documents')
      and grantee='anon'
  ) then
    raise exception 'anon holds a privilege on customer contacts/documents';
  end if;

  raise notice 'ok: 2 staff-read policies, 0 browser write grants, anon holds nothing';
end $$;
