-- 20260909a — Refractor reads the customer master off the GATEWAY role
--
-- Ownership map (Sky, 2026-09-09):
--   • brix-order  = the store — ordering, incoming service requests, the
--                   customer-FACING billing portal, customer-facing equipment
--   • BrixSD      = CRM, dispatch, invoicing (what Service Fusion did)
--   • Refractor   = purchase orders, inventory, BILLING, the customer master
--
-- This is the first half of moving billing + the customer master into
-- Refractor. Both UIs run against the SAME table during the dual run; the
-- brix-order staff copy is switched off once dispatch is finished and the
-- Refractor billing side has been tested. See docs/OWNERSHIP-AND-MIGRATION.md
-- for the ledger and the preconditions for dumping each piece.
--
-- ⚠ WHY THIS IS NEEDED AT ALL, since it looks like it already works.
-- `orders.customers` authorizes reads on `orders.is_caller_superadmin()`,
-- which reads `orders.customer_users.is_superadmin` — a BRIX-ORDER PORTAL
-- FLAG, not the gateway role. All 7 gateway staff happen to hold that flag
-- today, so Refractor would read the table by luck. Measured as the role that
-- will make the call (set local role authenticated, gateway claims, no portal
-- row): **0 customers, 0 company_settings**. So the first staff member added
-- with a gateway role and no portal row gets an empty Refractor billing page
-- with no explanation — which is exactly the "lost access" failure the
-- 2026-09-08 account audit exists to report, arriving by another door.
-- Every other Refractor screen authorizes off `ops.fn_is_staff()`. This one
-- should too: a Refractor screen must not depend on a brix-order flag.
--
-- ⚠ SELECT ONLY, AND NO GRANT CHANGE. THAT IS THE WHOLE SAFETY STORY.
-- `authenticated` holds SELECT and nothing else on all three tables, so the
-- browser cannot write them from anywhere — every write is service-role
-- through a Netlify function that also pushes the change outward to
-- QuickBooks (brix-order `_lib/push-customer-master`). Refractor's UI calls
-- those same endpoints, so there is ONE writer and one QBO push and the two
-- front doors cannot drift.
-- Granting UPDATE here would let any of the 204 CUSTOMER logins on this
-- shared project PATCH their own payment terms and clear their own credit
-- hold. Do not "tidy this up" by adding a write policy.
--
-- ⚠ Noted, deliberately NOT fixed: `company_settings_update_superadmin` is an
-- UPDATE policy for `authenticated` with no UPDATE grant behind it — dead
-- code that reads as live (Postgres checks grants BEFORE RLS; the same trap
-- as 20260825a). Left alone because the write path is service-role and
-- granting it would be the mistake above.
--
-- Additive by construction: permissive policies OR together, so a customer's
-- own view of their own row is unchanged. Verified before writing that all
-- six existing policies are PERMISSIVE and none is RESTRICTIVE.

begin;

-- ── orders.customers ────────────────────────────────────────────────────────
drop policy if exists customers_select_staff on orders.customers;
create policy customers_select_staff
  on orders.customers
  for select
  to authenticated
  using (ops.fn_is_staff());

comment on policy customers_select_staff on orders.customers is
  'Refractor (apbg-billing) is the customer master + billing home. Gated on the GATEWAY role, like every other Refractor screen — never on orders.customer_users.is_superadmin, which is a brix-order portal flag a staff account need not hold. SELECT only: writes stay service-role so no customer login can PATCH its own terms or credit hold.';

-- ── orders.customer_locations ───────────────────────────────────────────────
-- The bill-to lives here (`is_billing`, one per customer by partial unique
-- index, 20260831193000 in brix-order), so a billing screen cannot render the
-- remit-to address without it.
drop policy if exists customer_locations_select_staff on orders.customer_locations;
create policy customer_locations_select_staff
  on orders.customer_locations
  for select
  to authenticated
  using (ops.fn_is_staff());

comment on policy customer_locations_select_staff on orders.customer_locations is
  'The bill-to address (is_billing) lives here, so Refractor billing reads it. Gateway role, SELECT only.';

-- ── orders.company_settings ─────────────────────────────────────────────────
-- 9 of its 14 columns are company BILLING identity (company_name, from_name,
-- remittance_email, accounting_email, reply_to, statement_send_day, the two
-- global enable flags, reminder_schedule) and belong with billing. Only
-- `order_fees` and `order_desk` are genuinely order-portal and stay there.
drop policy if exists company_settings_select_staff on orders.company_settings;
create policy company_settings_select_staff
  on orders.company_settings
  for select
  to authenticated
  using (ops.fn_is_staff());

comment on policy company_settings_select_staff on orders.company_settings is
  'Company billing identity (letterhead, remit-to, dunning calendar) reads in Refractor. order_fees and order_desk in this same row stay brix-order''s. Gateway role, SELECT only.';

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
    and policyname in ('customers_select_staff',
                       'customer_locations_select_staff',
                       'company_settings_select_staff');
  if v_pol <> 3 then
    raise exception 'expected 3 staff-read policies, found %', v_pol;
  end if;

  -- the safety story: still no write privilege for a browser caller
  select count(*) into v_write
  from information_schema.role_table_grants
  where table_schema='orders'
    and table_name in ('customers','customer_locations','company_settings')
    and grantee in ('anon','authenticated')
    and privilege_type in ('INSERT','UPDATE','DELETE');
  if v_write <> 0 then
    raise exception
      'a browser role gained a write privilege on the customer master (% grants) — that is the one thing this migration must not do',
      v_write;
  end if;

  -- anon must hold nothing at all here
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='orders'
      and table_name in ('customers','customer_locations','company_settings')
      and grantee='anon'
  ) then
    raise exception 'anon holds a privilege on the customer master';
  end if;

  raise notice 'ok: 3 staff-read policies, 0 browser write grants, anon holds nothing';
end $$;
