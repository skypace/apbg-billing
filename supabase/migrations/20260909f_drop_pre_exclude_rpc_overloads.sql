-- 20260909f — drop the pre-exclude overloads of fn_sparkline and fn_sales_totals
--
-- SYMPTOM (Sky, 2026-09-09, on the customer page's recent invoice lines):
--   sbrpc fn_sparkline failed: 300 PGRST203 "Could not choose the best candidate
--   function between: ops.fn_sparkline(12 args) and ops.fn_sparkline(15 args)"
--
-- WHY. 20260703c added the three p_exclude_* parameters by CREATE OR REPLACE
-- with a NEW signature — which in Postgres creates a second overload rather than
-- replacing the first — and never dropped the old one. Every parameter on both
-- overloads has a default, so a named-argument call that omits the exclude keys
-- matches both and PostgREST refuses to guess. fetchSparkline() strips null
-- arguments before calling, so it hits this on every customer with no exclude
-- filter set. fn_sales_totals carries the identical pair (10 vs 13 args); its
-- one caller happens to send explicit nulls, which is the only reason it has
-- not 300'd yet.
--
-- The 20260820b guard generator then faithfully wrapped BOTH overloads, so each
-- name now has two wrappers and two __i inners. This drops the pre-exclude pair
-- of each — wrapper AND inner — and keeps the exclude-aware pair, whose defaults
-- cover every old-shape call. Checked before writing: no view, rule or function
-- depends on the old oids (pg_depend + pg_rewrite both empty).
--
-- ⚠ DROP BY EXACT SIGNATURE, never by name: DROP FUNCTION ops.fn_sparkline
-- with no argument list is an error when overloaded, and the CASCADE form is
-- how you take the good one with it.

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'fn_sparkline') <> 2 THEN
    RAISE EXCEPTION 'expected exactly two ops.fn_sparkline overloads before this migration';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'fn_sales_totals') <> 2 THEN
    RAISE EXCEPTION 'expected exactly two ops.fn_sales_totals overloads before this migration';
  END IF;
END $$;

DROP FUNCTION ops.fn_sparkline(
  p_dim text, p_labels text[], p_end date, p_entities text[], p_categories text[],
  p_customers text[], p_items text[], p_channels text[], p_segments text[],
  p_sales_reps text[], p_product_families text[], p_product_types text[]);

DROP FUNCTION ops.fn_sparkline__i(
  p_dim text, p_labels text[], p_end date, p_entities text[], p_categories text[],
  p_customers text[], p_items text[], p_channels text[], p_segments text[],
  p_sales_reps text[], p_product_families text[], p_product_types text[]);

DROP FUNCTION ops.fn_sales_totals(
  p_start date, p_end date, p_entities text[], p_categories text[], p_customers text[],
  p_items text[], p_channels text[], p_segments text[], p_product_families text[],
  p_product_types text[]);

DROP FUNCTION ops.fn_sales_totals__i(
  p_start date, p_end date, p_entities text[], p_categories text[], p_customers text[],
  p_items text[], p_channels text[], p_segments text[], p_product_families text[],
  p_product_types text[]);

-- After: one overload each, the exclude-aware one, still guarded, still wired to
-- its inner. Fail loudly if any of that is not true.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(p.proname || '(' || p.pronargs || ')', ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'ops'
    AND p.proname IN ('fn_sparkline', 'fn_sparkline__i', 'fn_sales_totals', 'fn_sales_totals__i')
    AND NOT (
      (p.proname LIKE 'fn_sparkline%' AND p.pronargs = 15)
      OR (p.proname LIKE 'fn_sales_totals%' AND p.pronargs = 13)
    );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected overload survived: %', bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'fn_sparkline'
        AND pg_get_functiondef(p.oid) LIKE '%fn_assert_internal%'
        AND pg_get_functiondef(p.oid) LIKE '%fn_sparkline__i(%') THEN
    RAISE EXCEPTION 'ops.fn_sparkline is no longer the guarded wrapper';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'fn_sales_totals'
        AND pg_get_functiondef(p.oid) LIKE '%fn_assert_internal%'
        AND pg_get_functiondef(p.oid) LIKE '%fn_sales_totals__i(%') THEN
    RAISE EXCEPTION 'ops.fn_sales_totals is no longer the guarded wrapper';
  END IF;
END $$;
