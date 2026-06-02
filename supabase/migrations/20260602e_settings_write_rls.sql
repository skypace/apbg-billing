-- 20260602e_settings_write_rls.sql
-- apbg-billing has no service-role key (by design — see CLAUDE.md). Writes go
-- through the caller's Supabase JWT + RLS, like the Brixpense functions.
-- The earlier settings/sync-customers writes wrongly assumed a service role,
-- so the toggle/link buttons failed with "SUPABASE_SERVICE_ROLE_KEY not
-- configured". This grants superadmin writes via JWT + RLS instead.

-- Superadmin check from the JWT (gateway sets role in app_metadata; fall back
-- to user_metadata to be safe).
create or replace function ops.is_superadmin_jwt() returns boolean
  language sql stable as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata'  ->> 'role'),
    (auth.jwt() -> 'user_metadata' ->> 'role')
  ) = 'superadmin';
$$;

-- PostgREST checks table GRANTs before RLS; ops tables had writes revoked from
-- authenticated (APBG-OPS lockdown 0009), so re-grant on just these two.
grant insert, update on ops.site_settings  to authenticated;
grant insert, update on ops.sync_customers to authenticated;

drop policy if exists site_settings_ins on ops.site_settings;
create policy site_settings_ins on ops.site_settings
  for insert to authenticated with check (ops.is_superadmin_jwt());
drop policy if exists site_settings_upd on ops.site_settings;
create policy site_settings_upd on ops.site_settings
  for update to authenticated using (ops.is_superadmin_jwt()) with check (ops.is_superadmin_jwt());

drop policy if exists sync_customers_ins on ops.sync_customers;
create policy sync_customers_ins on ops.sync_customers
  for insert to authenticated with check (ops.is_superadmin_jwt());
drop policy if exists sync_customers_upd on ops.sync_customers;
create policy sync_customers_upd on ops.sync_customers
  for update to authenticated using (ops.is_superadmin_jwt()) with check (ops.is_superadmin_jwt());
