-- 20260908b — per-app grants: `user_metadata.modules` may carry 'app:<app_key>'
--
-- WHY. The account audit shipped this morning (20260908a) found the leak and
-- the tile-then-wall, and named the structural problem it could not fix:
-- `billing` is ONE access bucket carrying FIFTEEN apps — Refractor, Brix Order,
-- ERLS, Brixpense, the internal Trello board, the compliance vault, the visitor
-- log, the sub-distributor portal, Service Fusion — so there was no way to
-- grant an outside Refractor consultant Refractor ALONE, and every outside
-- Refractor user was over-granted by construction. That is the "caught up" half
-- of Sky's ask: brix-order customers, Refractor outsiders and foodservice
-- outsiders each need their own arm, and one grab-bag bucket cannot express it.
--
-- apbg-gateway's grantsAccess() now understands a second `modules` shape:
--
--   'billing'         — an access BUCKET: every app whose access_id is that
--   'app:marginCtrl'  — a PER-APP grant: exactly that one registry row
--
-- This migration makes the DATABASE agree with that, in the two places that
-- read `modules`:
--
--   1. ops.fn_has_brixpense()      — the RLS gate. A gateway grant decides the
--                                    TILE; this decides whether someone is
--                                    actually let in. Without 'app:brixpense'
--                                    here, granting Brixpense alone would be a
--                                    tile leading straight to a wall — the very
--                                    failure 20260908a exists to report.
--   2. ops.v_account_access_audit  — the arm verdicts. An account holding only
--                                    per-app grants must not read as a customer
--                                    who has been handed a hub grant.
--
-- ⚠ THE VIEW RESOLVES 'app:<key>' BY JOINING public.gateway_apps, not by
-- carrying a copy of which app sits in which bucket. That mapping already
-- exists, in the registry, in this same database — and this file's own header
-- comment (20260908a) warns that PORTAL_ROLES here is a FOURTH mirror of the
-- gateway's role maps. Adding a fifth would be the same mistake on purpose.
-- The consequence to know: an app_key that has left the registry resolves to
-- NO bucket, so a stale grant counts for nothing rather than for everything.
-- That matches the gateway, where a grant naming a vanished app grants nothing.

-- ── 1. The Brixpense gate ───────────────────────────────────────────────────
-- Not SECURITY DEFINER and not guard-wrapped, so CREATE OR REPLACE is safe
-- here — it does NOT hit the 20260820b wrapper trap (replacing a wrapped name
-- silently discards its guard). Verified against pg_get_functiondef first.
--
-- ⚠ Keep in step with apbg-billing netlify/functions/lib/ap-inbox.mjs
-- `hasBrixpenseAccess()`, which applies the identical predicate in JS for the
-- API. The two are a deliberate pair: RLS decides the rows, that decides the
-- endpoint, and a login that passes one must pass the other.
create or replace function ops.fn_has_brixpense()
returns boolean language sql stable as $$
  select coalesce(
    case
      when (auth.jwt()->'user_metadata'->>'role') = 'superadmin' then true
      when jsonb_typeof(auth.jwt()->'user_metadata'->'modules') = 'array'
        -- ?| is "contains ANY of": the whole `billing` bucket, or the single
        -- per-app grant for Brixpense itself.
        then (auth.jwt()->'user_metadata'->'modules') ?| array['billing','app:brixpense']
      else (auth.jwt()->'user_metadata'->>'role') in ('admin','finance')
    end, false)
$$;

comment on function ops.fn_has_brixpense() is
  'Does this JWT have Brixpense access? superadmin | modules contains ''billing'' or ''app:brixpense'' | legacy role admin/finance. Mirrors apbg-gateway grantsAccess() and apbg-billing lib/ap-inbox.mjs hasBrixpenseAccess().';

-- ── 2. The audit view understands per-app grants ────────────────────────────
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
), granted as (
  -- Every bucket this account effectively holds: the bucket entries as typed,
  -- PLUS the bucket behind each 'app:<app_key>' grant, resolved through the
  -- registry. An account with no modules stays NULL (a legacy role-only login),
  -- because "no explicit grants" and "explicitly granted nothing" are different
  -- states and the verdicts below turn on which one it is.
  select a.id,
         case when a.modules is null then null else coalesce((
           select array_agg(distinct b) from (
             select m as b from unnest(a.modules) m where m not like 'app:%'
             union
             select ga.access_id from unnest(a.modules) m
               join public.gateway_apps ga on ga.app_key = substring(m from 5)
              where m like 'app:%'
           ) z where b is not null
         ), '{}'::text[]) end as buckets
    from acct a
), flagged as (
  select a.*,
         g.buckets,
         a.role in ('superadmin','admin') as is_admin,
         a.role = any(c.portal_roles) as portal_role,
         coalesce('melt' = any(g.buckets), false) as melt_module,
         coalesce(g.buckets && c.internal_buckets, false) as internal_module,
         a.role like 'ops-%' as ops_role,
         a.role is null and a.modules is null as plain_customer
    from acct a
    join granted g on g.id = a.id
    cross join cfg c
)
-- ⚠ `effective_buckets` is APPENDED, not slotted in beside `modules` where it
-- reads best: CREATE OR REPLACE VIEW cannot insert a column into the middle of
-- an existing view ("cannot change name of view column"), and the alternative
-- — DROP then CREATE — would silently drop this view's grants at the one moment
-- nobody is looking at them. Column order is cosmetic; the revoke is not.
select id, email, role, modules,
       has_brand, last_sign_in_at, created_at,
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
       end as verdict,
       buckets as effective_buckets
  from flagged;

comment on view ops.v_account_access_audit is
  'One row per auth account with the arm it belongs to and whether its access is coherent. effective_buckets expands per-app grants (modules ''app:<app_key>'') through public.gateway_apps, so a narrow grant is not read as a wide one. verdict: ok | customer_with_hub_grant (leak) | foodservice_no_brand (tile then wall) | brand_no_portal (scoped but no way in) | crossed_arms (needs a decision). See the header comment for the PORTAL_ROLES mirror warning.';

-- Personal data plus who can reach what: service-role only, both directions.
-- Re-asserted because CREATE OR REPLACE VIEW keeps existing grants and a
-- future rebuild of this file must not be the moment they come back.
revoke all on ops.v_account_access_audit from anon, authenticated;
