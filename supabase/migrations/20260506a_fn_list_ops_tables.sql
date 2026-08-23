-- §12 #4 follow-up — helper RPC for refreshing architecture/schema-snapshot.json.
--
-- SECURITY DEFINER + anon-callable so the architecture/refresh-snapshot.mjs
-- helper script can run from any developer machine using only the anon key
-- already baked into every JS bundle. Returns the bare list of ops.* base
-- table names; nothing sensitive — schema introspection only.

CREATE OR REPLACE FUNCTION ops.fn_list_ops_tables()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  SELECT array_agg(table_name ORDER BY table_name)
  FROM information_schema.tables
  WHERE table_schema = 'ops' AND table_type = 'BASE TABLE'
$$;

GRANT EXECUTE ON FUNCTION ops.fn_list_ops_tables() TO anon, authenticated;

COMMENT ON FUNCTION ops.fn_list_ops_tables() IS
  'Returns the alphabetized list of base table names in ops schema. Used by architecture/refresh-snapshot.mjs to keep schema-snapshot.json in sync with prod. SECURITY DEFINER so it works without service-role; introspection only.';
