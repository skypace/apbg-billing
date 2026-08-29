-- Enable Row-Level Security on PostgREST-exposed tables that were missing it.
--
-- Supabase's security advisor flagged these tables with the ERROR-level
-- `rls_disabled_in_public` lint: they live in schemas exposed to PostgREST
-- (ops, orders, public) with RLS disabled, so anyone holding the project's
-- anon key could read, edit, and delete every row. ops.resq_sync_config in
-- particular held a live webhook secret (inbound_secret) that was readable
-- with the anon key.
--
-- All backend writers use the service_role key (Netlify / Supabase edge
-- functions) or SECURITY DEFINER RPCs, both of which bypass RLS. Enabling RLS
-- therefore closes anonymous WRITE access (the actual hole) with no code
-- impact. Where a table carried a pre-existing anon/authenticated SELECT grant
-- (a client read path), a SELECT-only policy mirroring that grant preserves the
-- read so no consumer breaks. Mirrors the sibling ops.sync_customers_read /
-- ops.sync_events_read / public.gateway_apps_read convention.
--
-- Applied out-of-band via the Supabase MCP against project gfsdpwiqzshhexkofiif;
-- this file keeps the repo authoritative.

-- ops.equipment_contracts / ops.equipment_assets — anon + authenticated
-- previously held SELECT; keep read open at the same level, block writes.
ALTER TABLE ops.equipment_contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY equipment_contracts_read ON ops.equipment_contracts
  FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE ops.equipment_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY equipment_assets_read ON ops.equipment_assets
  FOR SELECT TO anon, authenticated USING (true);

-- orders.excluded_qbo_customers — authenticated previously held SELECT (logged
-- in clients read it); keep read open to authenticated only, block writes.
ALTER TABLE orders.excluded_qbo_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY excluded_qbo_customers_read ON orders.excluded_qbo_customers
  FOR SELECT TO authenticated USING (true);

-- ops.resq_sync_config — holds a live webhook secret. Enable RLS with NO policy
-- and revoke the anon/authenticated SELECT grants so the secret is unreachable
-- from the exposed roles. Read only by service_role + SECURITY DEFINER RPCs
-- (resq_sync_set_write / _set_active / _status), which are unaffected.
ALTER TABLE ops.resq_sync_config ENABLE ROW LEVEL SECURITY;
REVOKE SELECT ON ops.resq_sync_config FROM anon, authenticated;

-- public.pm_groups — accessed exclusively via the service_role key in
-- melt-dashboard's pm-groups.mjs (see that repo's companion migration). Enable
-- RLS with NO policy: service_role bypasses RLS, anon/authenticated are fully
-- locked out (the broad public-schema grants are neutralized by RLS).
ALTER TABLE public.pm_groups ENABLE ROW LEVEL SECURITY;
