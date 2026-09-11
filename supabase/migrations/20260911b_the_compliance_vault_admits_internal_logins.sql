-- ============================================================================
-- 20260911b — the compliance vault admits every INTERNAL login, not only
--             superadmin/admin. (Approved by Sky 2026-09-11, decisions 1–4 of
--             the APBG Access Model: a contractor is internal; the vault opens
--             to internal roles; the four new role ids are approved.)
--
-- What happened (2026-09-10, Calli, role ops-super, Refractor → Production →
-- Compliance & Safety → New Document):
--   file upload failed: 400 {"statusCode":"403","error":"Unauthorized",
--     "message":"new row violates row-level security policy"}
--   sbInsert compliance_documents failed: 403
--
-- Why: 20260726a gated ops.compliance_documents / compliance_sds /
-- compliance_training / insured_parties and the compliance-docs bucket on
-- ops.fn_is_staff(), i.e. role IN ('superadmin','admin'). The recorded reason
-- was the SHARED PROJECT — brix-order customers, distribution partners and
-- foodservice outsiders authenticate here and must not read insurance limits
-- or audit findings. Still right. But the gate is narrower than the reason:
-- the gateway defines a family of INTERNAL roles, the account audit (20260908a)
-- already treats `ops-%` as the internal arm, and ops.team_members has admitted
-- ops-super as a writer since APBG-OPS shipped.
--
-- Two plain predicates, the same shape as fn_is_staff():
--   ops.fn_is_internal()        — a gateway INTERNAL role: superadmin, admin,
--                                 finance, operations, dispatcher, production,
--                                 warehouse, sales, or any ops-* role. NOT a
--                                 role-less login (the ~211 brix-order
--                                 customers), viewer, melt-*, vendor_tracking,
--                                 hub or user.
--   ops.fn_is_internal_writer() — the same minus ops-viewer ("Read only").
-- The four vault tables and the four compliance-docs storage policies read
-- them: SELECT for internal, INSERT/UPDATE/DELETE for internal writers.
--
-- ⚠ The role list MIRRORS apbg-gateway public/auth.js ROLES (and apps.mjs
-- ROLE_ACCESS, and APBG-OPS src/lib/auth.ts). `role like 'ops-%'` is
-- deliberate and matches ops.v_account_access_audit's ops_role test. Add an
-- internal role at the gateway, add it here. tools/check-role-parity.mjs in
-- the gateway pins the list.
--
-- ⚠ No GRANT statements: a function created in ops carries Postgres's default
-- PUBLIC EXECUTE (the 20260820b sweep revoked PUBLIC on the functions that
-- existed then, not on future ones), which is what fn_is_staff() effectively
-- has (granted anon + authenticated). The post-apply block asserts it.
--
-- ⚠ NOT changed: fn_is_staff() itself; ops.fleet_vehicles (staff-only writes,
-- its screen is /compliance → Vehicles); compliance_postings (readable by
-- every login — a posting board is public by law); the postings/* bucket read.
-- compliance.html decides staff vs employee mode by whether its vault read
-- succeeds, so it follows this change with no edit.
-- ============================================================================

CREATE OR REPLACE FUNCTION ops.fn_is_internal()
RETURNS boolean LANGUAGE sql STABLE AS $$
  select coalesce(
    (auth.jwt()->'user_metadata'->>'role') in
      ('superadmin','admin','finance','operations','dispatcher','production','warehouse','sales')
    or (auth.jwt()->'user_metadata'->>'role') like 'ops-%',
    false)
$$;
COMMENT ON FUNCTION ops.fn_is_internal() IS
  '20260911b: a gateway INTERNAL role (superadmin, admin, finance, operations, dispatcher, production, warehouse, sales, ops-*). Mirrors apbg-gateway public/auth.js ROLES — add an internal role there, add it here. Not customers (role-less), not viewer, not melt-*/vendor_tracking/hub/user.';

CREATE OR REPLACE FUNCTION ops.fn_is_internal_writer()
RETURNS boolean LANGUAGE sql STABLE AS $$
  select ops.fn_is_internal()
     and coalesce((auth.jwt()->'user_metadata'->>'role'), '') <> 'ops-viewer'
$$;
COMMENT ON FUNCTION ops.fn_is_internal_writer() IS
  '20260911b: fn_is_internal() minus ops-viewer. The write side of the compliance vault.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_documents','compliance_sds','compliance_training','insured_parties'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON ops.%I', t || '_staff_all', t);
    EXECUTE format('CREATE POLICY %I ON ops.%I FOR SELECT TO authenticated USING (ops.fn_is_internal())', t || '_internal_read', t);
    EXECUTE format('CREATE POLICY %I ON ops.%I FOR INSERT TO authenticated WITH CHECK (ops.fn_is_internal_writer())', t || '_internal_insert', t);
    EXECUTE format('CREATE POLICY %I ON ops.%I FOR UPDATE TO authenticated USING (ops.fn_is_internal_writer()) WITH CHECK (ops.fn_is_internal_writer())', t || '_internal_update', t);
    EXECUTE format('CREATE POLICY %I ON ops.%I FOR DELETE TO authenticated USING (ops.fn_is_internal_writer())', t || '_internal_delete', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS compliance_docs_read   ON storage.objects;
DROP POLICY IF EXISTS compliance_docs_insert ON storage.objects;
DROP POLICY IF EXISTS compliance_docs_update ON storage.objects;
DROP POLICY IF EXISTS compliance_docs_delete ON storage.objects;
CREATE POLICY compliance_docs_read   ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'compliance-docs' AND ops.fn_is_internal());
CREATE POLICY compliance_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'compliance-docs' AND ops.fn_is_internal_writer());
CREATE POLICY compliance_docs_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'compliance-docs' AND ops.fn_is_internal_writer())
  WITH CHECK (bucket_id = 'compliance-docs' AND ops.fn_is_internal_writer());
CREATE POLICY compliance_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'compliance-docs' AND ops.fn_is_internal_writer());

-- ── Prove it landed ─────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'ops' AND tablename IN ('compliance_documents','compliance_sds','compliance_training','insured_parties')
     AND (qual LIKE '%fn_is_staff()%' OR with_check LIKE '%fn_is_staff()%');
  IF n <> 0 THEN RAISE EXCEPTION '20260911b: % vault policies still gate on fn_is_staff', n; END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'ops' AND tablename IN ('compliance_documents','compliance_sds','compliance_training','insured_parties');
  IF n <> 16 THEN RAISE EXCEPTION '20260911b: expected 16 vault policies, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('compliance_docs_read','compliance_docs_insert','compliance_docs_update','compliance_docs_delete','compliance_docs_postings_read');
  IF n <> 5 THEN RAISE EXCEPTION '20260911b: expected 5 compliance-docs storage policies, found %', n; END IF;
  IF NOT has_function_privilege('authenticated', 'ops.fn_is_internal()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'ops.fn_is_internal_writer()', 'EXECUTE') THEN
    RAISE EXCEPTION '20260911b: authenticated cannot execute the predicates the policies call';
  END IF;
END $$;
