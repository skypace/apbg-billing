-- 20260911g · the receipt guard names the item by its real column
--
-- 20260911f added a guard to the start_production branch of fn_wo_advance__i:
-- a work order may not start while any on_receipt purchase order behind it
-- still has receivable quantity outstanding. The refusal message lists the
-- outstanding lines by item name, and the join spelled that column
-- `i.item_name`. ops.qbo_items has no such column — the name column is `name`
-- (fully_qualified_name beside it). plpgsql resolves the column at EXECUTION,
-- so 20260911f applied clean and every start_production then failed with
-- 42703 "column i.item_name does not exist" — found by the rolled-back probe
-- as the `production` role, before anything shipped or any real order reached
-- the step. (The 20260903d block in the same function reads `i.type` and was
-- never affected.)
--
-- Same shape as 20260909c: the applied file (20260911f) is left as the record
-- of what was applied, with a pointer here; this migration is the correction.
-- Anchored read-modify-write of the LIVE inner (the 20260820b wrapper rule —
-- never CREATE OR REPLACE the guarded name), the anchor asserted to match
-- exactly once before and zero times after.

DO $mig$
DECLARE
  v_def   TEXT;
  v_new   TEXT;
  a_bad   TEXT := 'COALESCE(i.item_name, pl.qbo_item_id)';
  s_good  TEXT := 'COALESCE(i.name, pl.qbo_item_id)';
  n       INT;
BEGIN
  SELECT pg_get_functiondef('ops.fn_wo_advance__i'::regproc) INTO v_def;

  SELECT count(*) INTO n FROM regexp_matches(v_def, replace(replace(a_bad, '(', '\('), ')', '\)'), 'g');
  IF n <> 1 THEN
    RAISE EXCEPTION '20260911g: expected the item_name anchor exactly once in fn_wo_advance__i, found %', n;
  END IF;

  -- guard against the wrapper having been replaced by a body (the 20260820b trap)
  IF pg_get_functiondef('ops.fn_wo_advance'::regproc) NOT LIKE '%fn_assert_internal%' THEN
    RAISE EXCEPTION '20260911g: ops.fn_wo_advance no longer carries fn_assert_internal — the guard wrapper has been overwritten; fix that first';
  END IF;

  v_new := replace(v_def, a_bad, s_good);
  EXECUTE v_new;

  SELECT pg_get_functiondef('ops.fn_wo_advance__i'::regproc) INTO v_def;
  IF v_def LIKE '%i.item_name%' THEN
    RAISE EXCEPTION '20260911g: i.item_name still present after apply';
  END IF;
  IF v_def NOT LIKE '%COALESCE(i.name, pl.qbo_item_id)%' THEN
    RAISE EXCEPTION '20260911g: corrected column reference not found after apply';
  END IF;
  -- the column must actually exist, or this is the same bug with a different name
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'ops' AND table_name = 'qbo_items' AND column_name = 'name') THEN
    RAISE EXCEPTION '20260911g: ops.qbo_items.name does not exist';
  END IF;
END
$mig$;
