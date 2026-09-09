-- WHO IS LOST, AND WHO IS CAUGHT UP IN THE WRONG ARM.  Applied live 2026-09-08.
--
-- Ask (Sky): "we need to insure that brix-users, and refractor outside users,
-- and foodservice outside users dont get lost and caught up."
--
-- Three populations share one Supabase project and one hub, and must not bleed
-- into each other:
--   • brix-order customers  — product + delivery. Their own portal. No hub apps.
--   • Refractor / internal  — margin, Brixpense, compliance. No foodservice.
--   • foodservice outsiders — Boelter, The Hub, Melt staff. Portal, nothing else.
--
-- Two real failures the same day motivated this, and NEITHER was visible
-- anywhere until somebody complained:
--
--   LOST      — eight accounts held a melt-dashboard role the GATEWAY had
--               never heard of (`vendor_tracking`, `hub`, `user`), fell back
--               to `viewer` (which lost `melt` on 2026-08-21), and were offered
--               no portal tile. They had been getting in by deep link, so it
--               presented as "lost access" the moment a bookmark went.
--               Fixed in apbg-gateway PR #79.
--   CAUGHT UP — calli@craftbevsolutions.com is a REFRACTOR user carrying `melt`
--               with no brand scope, so the tile led straight to the
--               "not assigned to a brand yet" wall. A tile that can only
--               disappoint.
--
-- ⚠ WHY A CHECK AND NOT JUST A FIX. Both failures were states the data was
-- already in; nothing computed them, so nothing could report them. The static
-- check in apbg-gateway (tools/check-role-parity.mjs) pins the two gateway role
-- maps to each other — necessary, and blind to a live account that matches
-- neither. This is the half that watches the accounts.
--
-- ⚠ PORTAL_ROLES BELOW IS A MIRROR of apbg-gateway's role maps
-- (public/auth.js ROLES, netlify/functions/apps.mjs ROLE_ACCESS) and of the
-- PORTAL_ROLES list in its tools/check-role-parity.mjs. Adding a portal role
-- means adding it in all four places. A stale list here degrades gracefully —
-- it over-reports rather than going quiet — but keep it in step.
--
-- ⚠ `internal_buckets` deliberately includes `finance` and `equipment` even
-- though no active gateway_apps row uses either today: they are still
-- grantable in Staff & Access, so an account can carry one, and a bucket that
-- grants nothing is exactly the kind of thing that gets handed out casually.

create or replace view ops.v_account_access_audit as
with cfg as (
  select array['melt-super','melt-project','melt-billing','melt-general',
               'vendor_tracking','hub','user']::text[] as portal_roles,
         array['billing','finance','operations','control','equipment','freshpet']::text[] as internal_buckets
), acct as (
  select u.id,
         u.email,
         nullif(u.raw_user_meta_data->>'role','') as role,
         case when jsonb_typeof(u.raw_user_meta_data->'modules') = 'array'
              then array(select jsonb_array_elements_text(u.raw_user_meta_data->'modules'))
              else null end as modules,
         -- Brand scope is what melt-dashboard's tenantScopeOf() reads. Without
         -- it a non-admin hits the "not assigned to a brand yet" wall, however
         -- many tiles they can see.
         (u.raw_user_meta_data->>'customer_id' is not null
          or coalesce(u.raw_user_meta_data->>'allowed_customer_ids','[]') not in ('[]','null')) as has_brand,
         u.last_sign_in_at,
         u.created_at
    from auth.users u
), flagged as (
  select a.*,
         a.role in ('superadmin','admin') as is_admin,
         a.role = any(c.portal_roles) as portal_role,
         coalesce('melt' = any(a.modules), false) as melt_module,
         coalesce(a.modules && c.internal_buckets, false) as internal_module,
         a.role like 'ops-%' as ops_role,
         a.role is null and a.modules is null as plain_customer
    from acct a cross join cfg c
)
select id, email, role, modules, has_brand, last_sign_in_at, created_at,
       (portal_role or melt_module or is_admin) as can_reach_portal,
       case
         when is_admin then 'ok'                       -- global by design
         when plain_customer then 'ok'                 -- ordinary brix-order login
         when role is null and (melt_module or internal_module)
           then 'customer_with_hub_grant'              -- the 2026-08-21 leak
         when (portal_role or melt_module) and not has_brand
           then 'foodservice_no_brand'                 -- tile, then a wall
         when has_brand and not (portal_role or melt_module)
           then 'brand_no_portal'                      -- scoped, but no way in
         when (portal_role or melt_module) and (internal_module or ops_role)
           then 'crossed_arms'                         -- a decision, not a fault
         else 'ok'
       end as verdict
  from flagged;

comment on view ops.v_account_access_audit is
  'One row per auth account with the arm it belongs to and whether its access is coherent. verdict: ok | customer_with_hub_grant (leak) | foodservice_no_brand (tile then wall) | brand_no_portal (scoped but no way in) | crossed_arms (needs a decision). See the header comment for the PORTAL_ROLES mirror warning.';

-- Personal data plus who can reach what: service-role only, both directions.
revoke all on ops.v_account_access_audit from anon, authenticated;

-- Red on a leak, or on somebody who cannot get where their own scope says they
-- belong. Yellow on a crossed grant, which is a judgement rather than a fault.
create or replace function ops.fn_account_access_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds int, detail text)
language plpgsql security definer set search_path to 'ops','public' as $$
declare
  v_leak int; v_wall int; v_lost int; v_crossed int; v_who text;
begin
  select count(*) filter (where verdict='customer_with_hub_grant'),
         count(*) filter (where verdict='foodservice_no_brand'),
         count(*) filter (where verdict='brand_no_portal'),
         count(*) filter (where verdict='crossed_arms')
    into v_leak, v_wall, v_lost, v_crossed
    from ops.v_account_access_audit;

  select string_agg(email || ' (' || verdict || ')', ', ' order by verdict, email)
    into v_who
    from ops.v_account_access_audit
   where verdict <> 'ok';

  check_name := 'account_access';
  last_event_at := now();
  age_seconds := 0;
  status := case when v_leak > 0 or v_wall > 0 or v_lost > 0 then 'red'
                 when v_crossed > 0 then 'yellow'
                 else 'green' end;
  detail := case
    when coalesce(v_leak+v_wall+v_lost+v_crossed,0) = 0
      then 'every account''s hub access matches its arm'
    else v_leak || ' customer account(s) with a hub grant, '
      || v_wall || ' with a portal tile but no brand, '
      || v_lost || ' brand-scoped with no way in, '
      || v_crossed || ' crossed between arms: ' || left(coalesce(v_who,''), 400)
    end;
  return next;
end; $$;

revoke all on function ops.fn_account_access_health() from public, anon, authenticated;

-- ⚠ Wired into the 15-minute health board by READ-MODIFY-WRITE against the
-- LIVE ops.fn_sync_health_extra() definition, anchor-asserted — never from a
-- copy in an older migration. On 2026-08-21 a parallel re-declare from a stale
-- copy silently deleted somebody's monitor. Verified after applying: 31 checks
-- present, all 30 prior monitors intact, account_access green.
do $$
declare
  v_def text;
  v_anchor text := E'  return query select * from ops.fn_qbo_time_sync_health();\n';
  v_add text := E'  return query select * from ops.fn_qbo_time_sync_health();\n\n'
    || E'  -- Who is LOST and who is CAUGHT UP in the wrong arm.\n'
    || E'  return query select * from ops.fn_account_access_health();\n';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';

  if v_def is null then
    raise exception 'ops.fn_sync_health_extra() not found — refusing to guess';
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'anchor line not found in the live definition — it moved; re-read it before editing';
  end if;
  if position('fn_account_access_health' in v_def) > 0 then
    raise notice 'already wired — nothing to do';
    return;
  end if;

  execute replace(v_def, v_anchor, v_add);
end $$;
