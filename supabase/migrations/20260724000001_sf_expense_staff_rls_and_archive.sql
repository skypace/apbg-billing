-- SF-expense security fix + archive support.
-- Applied live to gfsdpwiqzshhexkofiif on 2026-07-24 via Supabase MCP.
--
-- 1) SECURITY: expense_requests_select_sf previously exposed every
--    tag='Service Fusion' row to ANY authenticated user. This Supabase project's
--    auth is shared with brix-order (customers), vendor-tracking logins
--    (boelter.com), and outside agencies (thehubdesign.com) — all of whom could
--    read internal vendors/amounts/job numbers. Now staff-only via
--    ops.fn_is_staff() (gateway admin tier: user_metadata.role in
--    superadmin/admin — every Brixpense staff user is superadmin today).
-- 2) ARCHIVE: soft-hide columns for SF drafts. Once a bill is in QBO, QBO is the
--    source of truth — historical/orphaned drafts get archived, not deleted, so
--    the sf_expense_id dedup keeps blocking re-landing.

create or replace function ops.fn_is_staff()
returns boolean
language sql stable
as $$
  select coalesce((auth.jwt()->'user_metadata'->>'role') in ('superadmin','admin'), false)
$$;
grant execute on function ops.fn_is_staff() to authenticated, anon;

alter table ops.expense_requests
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text;

drop policy if exists expense_requests_select_sf on ops.expense_requests;
create policy expense_requests_select_sf on ops.expense_requests
  for select to authenticated
  using (tag = 'Service Fusion' and ops.fn_is_staff());

drop policy if exists expense_requests_update_sf_staff on ops.expense_requests;
create policy expense_requests_update_sf_staff on ops.expense_requests
  for update to authenticated
  using (tag = 'Service Fusion' and ops.fn_is_staff())
  with check (tag = 'Service Fusion' and ops.fn_is_staff());
