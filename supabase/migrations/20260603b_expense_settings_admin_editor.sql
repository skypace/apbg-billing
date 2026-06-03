-- Admin editor for global ops.expense_settings + a department→COGS map for the form cascade.
-- Writes are gated to superadmin/admin (role read from the JWT app_metadata/user_metadata).
-- expense_settings RLS is SELECT-only for clients; this SECURITY DEFINER RPC is the
-- only sanctioned write path for the org-level keys (per-user payment accounts have
-- their own fn_set_user_payment_accounts).
create or replace function ops.fn_set_expense_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'ops','public'
as $$
declare
  v_role text;
  v_allowed text[] := array['approval_threshold','manager_emails','cogs_accounts','tags','departments','department_cogs_map'];
begin
  v_role := coalesce(
    auth.jwt() -> 'app_metadata'  ->> 'role',
    auth.jwt() -> 'user_metadata' ->> 'role',
    ''
  );
  if v_role not in ('superadmin','admin') then
    raise exception 'Only superadmin/admin can edit organization expense settings (role=%)', v_role
      using errcode = '42501';
  end if;
  if not (p_key = any(v_allowed)) then
    raise exception 'Setting "%" is not editable here', p_key using errcode = '22023';
  end if;
  insert into ops.expense_settings (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  return jsonb_build_object('key', p_key, 'ok', true);
end;
$$;

revoke all on function ops.fn_set_expense_setting(text, jsonb) from public;
grant execute on function ops.fn_set_expense_setting(text, jsonb) to authenticated;

-- Seed the department→COGS map so the form + admin editor have a row to read/write.
insert into ops.expense_settings (key, value, updated_at)
values ('department_cogs_map', '{}'::jsonb, now())
on conflict (key) do nothing;
