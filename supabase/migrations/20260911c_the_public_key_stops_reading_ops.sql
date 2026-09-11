-- ============================================================================
-- 20260911c — the public anon key stops reading ops.*
--
-- Measured 2026-09-11: 191 tables, views and materialized views in `ops`
-- granted SELECT to `anon` — the key that ships in every bundle on every
-- APBG site. ~45 of them also carried a permissive `USING (true)` policy FOR
-- anon, so no login was needed to read, among others:
--   ops.team_members        — every employee's annual wage
--   ops.pl_snapshots        — the monthly P&L
--   ops.balance_sheet_snapshots
--   ops.qbo_expense_lines   — every vendor bill line ("qbo_expense_lines_read" TO public)
--   ops.qbo_purchase_orders / _lines, qbo_employees_cache, qbo_pto_cache
--   ops.fleet_trips / fleet_daily / fleet_fuel_transactions / fleet_maintenance
--   ops.crm_deals, customer_groups, customer_tags, rental_contracts, kpi_daily
--   ops.mv_sales_lines      — every sales line (a MATERIALIZED view: RLS cannot apply)
-- and `ops.sales_ledger_config` had RLS switched off entirely.
--
-- Why it was so wide: APBG-OPS migration 0009 (the first RLS lockdown) granted
-- anon SELECT broadly and set a DEFAULT PRIVILEGE so every table created since
-- inherits `anon=r`. The 2026-08-20 hardening revoked anon on the invoice mirror
-- and on functions, and the 2026-08-29 fleet work revoked it on fleet_vehicles;
-- nothing ever revisited the default. So each new table shipped anon-readable.
--
-- Nothing legitimate reads `ops` as anon EXCEPT ERLS (APBG-Leasing-Rental,
-- apps/api/src/services/integrations/refractor.py), which reads two objects
-- over PostgREST with the shared project's anon key:
--   ops.qbo_items      (list price + static COGS)
--   ops.mv_sales_lines (per-customer, per-item actual sales)
-- and calls three SECURITY DEFINER RPCs (fn_customer_directory, fn_item_avg_cost,
-- resolve_prices_for_customer) whose grants this migration does not touch.
-- Every other reader sends a user token: Refractor/BrixSD/Brixpense (the
-- caller's JWT), APBG-OPS (setSession with the gateway token), the compliance
-- page (bearer), the public kiosk/NDA pages (service-role functions).
--
-- So: REVOKE anon SELECT on everything in ops except those two, revoke any
-- stray anon write, and change the DEFAULT so the next table does not inherit
-- it. The permissive anon policies are left in place — Postgres checks the
-- table grant BEFORE RLS, so with the grant gone they are inert, and dropping
-- ~45 policies by name is churn with no security effect.
--
-- ⚠ THE TWO EXCEPTIONS ARE THE NEXT PROBLEM, not a solved one. mv_sales_lines
-- is every sales line readable with a public key, kept only because ERLS has
-- no credential of its own yet (its CLAUDE.md says so). The durable fix is a
-- service credential for ERLS; when it has one, remove both from the
-- allow-list below and re-run.
--
-- Rollback for any one table is one statement: GRANT SELECT ON ops.<t> TO anon.
-- ============================================================================

DO $$
DECLARE r record; n_read int := 0; n_write int := 0;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'ops' AND c.relkind IN ('r','v','m','p','f')
  LOOP
    IF has_table_privilege('anon', ('ops.' || quote_ident(r.relname)), 'SELECT')
       AND r.relname NOT IN ('qbo_items', 'mv_sales_lines') THEN
      EXECUTE format('REVOKE SELECT ON ops.%I FROM anon', r.relname);
      n_read := n_read + 1;
    END IF;
    IF r.relkind IN ('r','p') AND (
         has_table_privilege('anon', ('ops.' || quote_ident(r.relname)), 'INSERT')
      OR has_table_privilege('anon', ('ops.' || quote_ident(r.relname)), 'UPDATE')
      OR has_table_privilege('anon', ('ops.' || quote_ident(r.relname)), 'DELETE')) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON ops.%I FROM anon', r.relname);
      n_write := n_write + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '20260911c: anon SELECT revoked on % objects, anon writes revoked on % tables', n_read, n_write;
END $$;

-- The default that made every new table anon-readable. Grantor is postgres
-- (pg_default_acl showed `anon=r/postgres`), so the revoke names that role.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ops REVOKE SELECT ON TABLES FROM anon;

-- ── Prove it ────────────────────────────────────────────────────────────────
DO $$
DECLARE leftover text; n int;
BEGIN
  SELECT count(*), string_agg(c.relname, ', ') INTO n, leftover
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'ops' AND c.relkind IN ('r','v','m','p','f')
     AND has_table_privilege('anon', c.oid, 'SELECT');
  IF n <> 2 OR leftover NOT LIKE '%qbo_items%' OR leftover NOT LIKE '%mv_sales_lines%' THEN
    RAISE EXCEPTION '20260911c: expected anon SELECT on exactly qbo_items + mv_sales_lines, found % (%)', n, leftover;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
              WHERE ns.nspname = 'ops' AND d.defaclobjtype = 'r' AND d.defaclacl::text LIKE '%anon=%') THEN
    RAISE EXCEPTION '20260911c: the ops default privilege still grants anon';
  END IF;
  -- authenticated is untouched by this migration: it must still read what it read.
  IF NOT has_table_privilege('authenticated', 'ops.team_members', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'ops.pl_snapshots', 'SELECT') THEN
    RAISE EXCEPTION '20260911c: authenticated lost a SELECT it should have kept';
  END IF;
  IF NOT has_schema_privilege('anon', 'ops', 'USAGE') THEN
    RAISE EXCEPTION '20260911c: anon lost schema USAGE — ERLS reads would break';
  END IF;
END $$;
