-- 20260909e — the view I just made to close an anon hole was itself anon-readable
--
-- ⚠ `revoke all ... from public` DOES NOT REMOVE A ROLE-SPECIFIC GRANT, and
-- Supabase's `ALTER DEFAULT PRIVILEGES` grants SELECT to `anon` on every new
-- object created in `ops`. So 20260909d's
--
--     revoke all on ops.v_equipment_line from public;
--     grant select on ops.v_equipment_line to authenticated, service_role;
--
-- read as a closed door and left `anon` holding SELECT — on a view that exists
-- precisely to serve the fleet, rent and contract numbers whose anon exposure
-- that same migration went to revoke. Caught by reading
-- `information_schema.role_table_grants` back afterwards rather than trusting
-- the revoke, which is this repo's own standing rule about env vars and it
-- applies just as well to grants.
--
-- It was not exploitable, and the reason is worth writing down rather than
-- relying on: the view is `security_invoker = true`, so a caller's own
-- privileges are checked against the BASE tables as well, and 20260909d had
-- already revoked `anon` from `ops.equipment_assets`/`equipment_contracts`.
-- An anon read therefore failed one layer down. ⚠ Which means flipping this
-- view to `security_definer` — a one-word change somebody could make for a
-- perfectly good reason — would silently open the whole fleet to the public
-- anon key. Closing the grant is what makes that no longer true.
--
-- 20260820b F4 already learned this for FUNCTIONS ("EXECUTE revoked from
-- PUBLIC + anon on every ops function"); the same discipline was never applied
-- to views. `ops.fn_equipment_asset(uuid)` is correctly closed
-- (`has_function_privilege('anon', ...)` → false, verified).
--
-- ⚠ FLAGGED, DELIBERATELY NOT SWEPT: **21 views in `ops` are readable with the
-- public anon key today.** Some may be intentional. Working out which is a
-- deliberate pass with its own blast-radius check on every reader — the same
-- shape as 20260820b — and not something to fold into a display change. This
-- migration closes the one view it created.

revoke select on ops.v_equipment_line from anon;

do $assert$
begin
  if has_table_privilege('anon', 'ops.v_equipment_line', 'select') then
    raise exception 'anon can still read ops.v_equipment_line';
  end if;
  if not has_table_privilege('authenticated', 'ops.v_equipment_line', 'select') then
    raise exception 'authenticated LOST its read on ops.v_equipment_line — every '
                    'equipment surface would render empty';
  end if;
  if has_table_privilege('anon', 'ops.equipment_assets', 'select')
     or has_table_privilege('anon', 'ops.equipment_contracts', 'select') then
    raise exception 'anon is back on an echo table — 20260909d was undone';
  end if;
end;
$assert$;
