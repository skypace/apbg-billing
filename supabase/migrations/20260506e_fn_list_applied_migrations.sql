-- Helper RPC for the migration-apply drift checker. Returns the list of
-- migration names recorded in supabase_migrations.schema_migrations (the
-- internal Supabase-managed history table), so a script using only the
-- anon key can compare to the migration files in supabase/migrations/.
--
-- SECURITY DEFINER because anon doesn't have direct read on
-- supabase_migrations.schema_migrations. Returns names only — no SQL
-- bodies, no version timestamps that could leak credentials.
--
-- Naming follows ops.fn_list_ops_tables() (the schema-snapshot helper).

CREATE OR REPLACE FUNCTION ops.fn_list_applied_migrations()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  SELECT array_agg(DISTINCT name ORDER BY name)
  FROM supabase_migrations.schema_migrations
$$;

GRANT EXECUTE ON FUNCTION ops.fn_list_applied_migrations() TO anon, authenticated;

COMMENT ON FUNCTION ops.fn_list_applied_migrations() IS
  'Returns the alphabetized DISTINCT list of migration names recorded in supabase_migrations.schema_migrations. Used by architecture/check-pending-migrations.mjs to flag migration files that haven''t been applied yet. SECURITY DEFINER because anon can''t read the system migrations table.';
