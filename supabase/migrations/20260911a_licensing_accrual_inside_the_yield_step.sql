-- ============================================================================
-- 20260911a — the licensing accrual inside the yield step was staff-only,
--             so a non-staff production user could run a work order up to
--             "in production" and then be refused at Record yield.
--
-- What happened (2026-09-10, Calli, role ops-super, WO-2026-00022):
--   Record yield → sbrpc fn_wo_advance failed: 403 42501
--   "This function requires a staff account"
--
-- Why: ops.fn_wo_advance is a 20260820b guard wrapper carrying
-- fn_assert_internal() — every internal role passes, only distributor logins
-- are refused — and every step of the pipeline honoured that (draft → POs →
-- at co-packer → in production all succeeded for the same login). But the
-- record_yield branch of fn_wo_advance__i calls ops.fn_licensing_accrue_wo
-- (20260903a, the licensing-agreements branch), and THAT function carries an
-- INLINE staff-only guard:
--
--   IF auth.role() = 'authenticated' AND NOT ops.fn_is_staff() THEN
--     RAISE EXCEPTION 'This function requires a staff account' ...
--
-- SECURITY DEFINER changes the executing ROLE, not the JWT — fn_is_staff()
-- still reads the caller's claims three calls deep — so the wall sits behind
-- the door. Reproduced live as the ops-super role in a rolled-back block
-- before writing this.
--
-- Fix — the pattern this repo already uses for exactly this situation
-- (fn_wo_advance__i calls fn_wo_set_lots__i, never the guarded fn_wo_set_lots):
--   1. ops.fn_licensing_accrue_wo becomes fn_licensing_accrue_wo__i with the
--      inline guard REMOVED and EXECUTE revoked from every app role — reachable
--      only through owner chains (a SECURITY DEFINER caller).
--   2. A new ops.fn_licensing_accrue_wo wrapper keeps the STAFF door for direct
--      RPC callers (fn_assert_staff_or_service — recomputing a royalty by hand
--      is a finance action), marked GENERATED GUARD WRAPPER so the 20260820b
--      generator skips it on a re-run.
--   3. fn_wo_advance__i calls the inner. Recording a yield IS the trigger for
--      the accrual; the caller has already passed fn_assert_internal at the
--      door of fn_wo_advance.
--
-- Both function edits are ANCHORED READ-MODIFY-WRITES of the LIVE definitions
-- (pg_get_functiondef), each anchor asserted to match exactly once. Not a
-- pasted body: fn_wo_advance__i's live text carries 20260903d/e/f changes from
-- the production-runs branch that main does not hold, and a rebuild from a
-- repo copy would delete them — the 2026-08-21 incident, in a different table.
--
-- ⚠ fn_licensing_backfill still calls the WRAPPER by name. That is correct:
-- it is a direct staff action, not a consequence of some other write.
--
-- ⚠ The licensing feature itself (20260903a–i on
-- claude/production-runs-moq-licensing) is live on the database and NOT on
-- main. This migration does not recover it — it only reaches into the one
-- function that blocked production — and it assumes the function exists,
-- raising plainly if it does not.
-- ============================================================================

DO $$
DECLARE
  v_def     text;
  v_anchor  text;
  v_n       int;
  v_oid     oid;
BEGIN
  -- ── 0. Preconditions ──────────────────────────────────────────────────────
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_licensing_accrue_wo'
     AND pg_get_function_identity_arguments(p.oid) = 'p_wo_id uuid, p_yield_qty numeric, p_yield_date date';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '20260911a: ops.fn_licensing_accrue_wo(uuid, numeric, date) is not on this database — apply 20260903a (claude/production-runs-moq-licensing) first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'ops' AND p.proname = 'fn_licensing_accrue_wo__i') THEN
    RAISE EXCEPTION '20260911a: ops.fn_licensing_accrue_wo__i already exists — this migration has been applied';
  END IF;

  -- ── 1. Rename the real body to the inner name, strip its inline guard ────
  ALTER FUNCTION ops.fn_licensing_accrue_wo(uuid, numeric, date) RENAME TO fn_licensing_accrue_wo__i;

  v_def := pg_get_functiondef(v_oid);
  v_anchor := E'  IF auth.role() = \'authenticated\' AND NOT ops.fn_is_staff() THEN\n'
           || E'    RAISE EXCEPTION \'This function requires a staff account\' USING ERRCODE = \'42501\';\n'
           || E'  END IF;\n\n';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20260911a: staff-guard anchor matched % times in fn_licensing_accrue_wo__i (expected 1) — read the live definition before editing', v_n;
  END IF;
  v_def := replace(v_def, v_anchor,
    E'  -- 20260911a: no guard here. This is the INNER body; the staff door is the\n'
 || E'  -- ops.fn_licensing_accrue_wo wrapper. fn_wo_advance__i calls this directly\n'
 || E'  -- because recording a yield is what raises the accrual, and the caller has\n'
 || E'  -- already passed fn_assert_internal at the door of fn_wo_advance.\n\n');
  EXECUTE v_def;

  REVOKE ALL ON FUNCTION ops.fn_licensing_accrue_wo__i(uuid, numeric, date) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION ops.fn_licensing_accrue_wo__i(uuid, numeric, date) FROM authenticated, anon;

  -- ── 2. The wrapper keeps the staff door for direct RPC callers ───────────
  EXECUTE $w$
    CREATE FUNCTION ops.fn_licensing_accrue_wo(p_wo_id uuid, p_yield_qty numeric DEFAULT NULL::numeric, p_yield_date date DEFAULT NULL::date)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $f$
      -- GENERATED GUARD WRAPPER (20260911a) — the real body lives in ops.fn_licensing_accrue_wo__i. Edit THAT.
      -- Staff-only on purpose: recomputing a royalty by hand is a finance action. The yield
      -- step of fn_wo_advance__i calls the inner directly and never comes through here.
      BEGIN PERFORM ops.fn_assert_staff_or_service(); RETURN ops.fn_licensing_accrue_wo__i($1, $2, $3); END
    $f$
  $w$;
  REVOKE ALL ON FUNCTION ops.fn_licensing_accrue_wo(uuid, numeric, date) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION ops.fn_licensing_accrue_wo(uuid, numeric, date) TO authenticated, service_role;

  -- ── 3. fn_wo_advance__i calls the inner ──────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_wo_advance__i';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '20260911a: ops.fn_wo_advance__i not found';
  END IF;
  v_anchor := 'v_royalty := ops.fn_licensing_accrue_wo(';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '20260911a: accrual-call anchor matched % times in fn_wo_advance__i (expected 1)', v_n;
  END IF;
  v_def := replace(v_def, v_anchor,
    'v_royalty := ops.fn_licensing_accrue_wo__i(   -- 20260911a: the INNER, so a non-staff production user can record a yield' || E'\n      ');
  EXECUTE v_def;

  -- ── 4. Prove it landed ───────────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_licensing_accrue_wo__i';
  IF v_def LIKE '%requires a staff account%' THEN
    RAISE EXCEPTION '20260911a: the inner still carries the staff guard';
  END IF;
  IF has_function_privilege('authenticated', 'ops.fn_licensing_accrue_wo__i(uuid, numeric, date)', 'EXECUTE') THEN
    RAISE EXCEPTION '20260911a: authenticated can still execute the inner';
  END IF;
  IF NOT has_function_privilege('authenticated', 'ops.fn_licensing_accrue_wo(uuid, numeric, date)', 'EXECUTE') THEN
    RAISE EXCEPTION '20260911a: authenticated lost the wrapper';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_wo_advance__i';
  IF v_def NOT LIKE '%ops.fn_licensing_accrue_wo__i(%' OR v_def LIKE '%ops.fn_licensing_accrue_wo(%' THEN
    RAISE EXCEPTION '20260911a: fn_wo_advance__i does not call the inner (or still calls the wrapper)';
  END IF;
  -- The guard wrapper on fn_wo_advance itself is untouched and still internal.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_wo_advance';
  IF v_def NOT LIKE '%fn_assert_internal()%' THEN
    RAISE EXCEPTION '20260911a: fn_wo_advance wrapper is no longer internal-guarded';
  END IF;
END $$;
