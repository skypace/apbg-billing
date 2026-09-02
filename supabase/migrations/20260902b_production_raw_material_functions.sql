-- ============================================================================
-- Production raw materials, part 2 — the math and the pipeline functions.
--
-- Split from 20260902a purely so each file is reviewable on its own; they are
-- one change and were applied back to back. 20260902a creates the tables and
-- columns these functions read.
-- ============================================================================

-- ── 7. fn_formula_case_requirements — THE per-case math ─────────────────────
-- Everything downstream (the BOM rebuild, the work order, the Calderoni PO)
-- reads this one function, so there is exactly one answer to "how much sugar
-- is in a case".
--
--   gal per case = cans_per_case × oz_per_can / 128
--   lbs of finished liquid per case = gal per case × density lbs/gal
--   ingredient lbs per case = that × pct_by_weight
--
-- Yield loss is deliberately NOT folded in here: this returns the theoretical
-- recipe weight, which is what the batching sheet says. The loss is carried as
-- scrap on the BOM line so an operator can see it and argue with it.
CREATE OR REPLACE FUNCTION ops.fn_formula_case_requirements(p_bom_id UUID)
RETURNS TABLE (
  ingredient_id      UUID,
  sheet_name         TEXT,          -- what the batching sheet calls it
  material_name      TEXT,          -- canonical master name
  pct_by_weight      NUMERIC,
  recipe_uom         TEXT,
  gal_per_case       NUMERIC,
  lbs_per_case       NUMERIC,       -- of finished liquid, whole case
  qty_per_case       NUMERIC,       -- of THIS ingredient, recipe units
  is_purchased       BOOLEAN,
  qbo_item_id        TEXT,
  qbo_vendor_id      TEXT,
  vendor_name        TEXT,
  pack_size          NUMERIC,
  purchase_uom       TEXT,
  purchase_cost      NUMERIC,
  cost_per_case      NUMERIC,
  sort_order         INTEGER,
  notes              TEXT
)
LANGUAGE sql STABLE SET search_path = ops, pg_temp AS $$
  WITH basis AS (
    SELECT
      b.id                                                       AS bom_id,
      f.id                                                       AS formula_id,
      (b.cans_per_case::numeric * b.oz_per_can) / 128.0          AS gal_per_case,
      COALESCE(f.density_lbs_per_gal, f.water_lbs_per_gal, 8.345) AS density
    FROM ops.product_bom b
    JOIN ops.product_formulas f ON f.id = b.formula_id
    WHERE b.id = p_bom_id
  )
  SELECT
    i.ingredient_id,
    i.ingredient_name,
    COALESCE(r.name, i.ingredient_name),
    i.pct_by_weight,
    COALESCE(r.recipe_uom, i.uom, 'lbs'),
    ROUND(bs.gal_per_case, 6),
    ROUND(bs.gal_per_case * bs.density, 6),
    ROUND(bs.gal_per_case * bs.density * i.pct_by_weight, 8),
    COALESCE(r.is_purchased, TRUE),
    COALESCE(r.qbo_item_id, i.component_qbo_item_id),
    r.qbo_vendor_id,
    v.display_name,
    r.pack_size,
    r.purchase_uom,
    r.purchase_cost,
    CASE
      WHEN r.purchase_cost IS NULL THEN NULL
      ELSE ROUND(
        bs.gal_per_case * bs.density * i.pct_by_weight
          / NULLIF(COALESCE(r.pack_size, 1), 0) * r.purchase_cost, 6)
    END,
    i.sort_order,
    i.notes
  FROM basis bs
  JOIN ops.product_formula_ingredients i ON i.formula_id = bs.formula_id
  LEFT JOIN ops.raw_ingredients r        ON r.id = i.ingredient_id
  LEFT JOIN ops.qbo_vendors v            ON v.qbo_vendor_id = r.qbo_vendor_id
  ORDER BY i.sort_order;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_formula_case_requirements(UUID) TO authenticated;


-- ── 8. fn_bom_sync_from_formula — put the ingredients ON the BOM ────────────
-- Replaces every source='formula' line and touches nothing else. Water and
-- anything else flagged is_purchased=false is skipped: it is in the batch, it
-- is not in the bill of materials.
--
-- An ingredient with no QuickBooks item CANNOT become a line — product_bom_lines
-- requires component_qbo_item_id on a component. Rather than inventing a
-- placeholder id (which would then reach a purchase order), those are returned
-- in `unlinked` so the caller can say which items still need creating. That is
-- a visible gap, not a silent one.
CREATE OR REPLACE FUNCTION ops.fn_bom_sync_from_formula(p_bom_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_formula_id UUID;
  v_yield      NUMERIC;
  v_scrap      NUMERIC;
  v_removed    INTEGER := 0;
  v_added      INTEGER := 0;
  v_unlinked   JSONB   := '[]'::jsonb;
  v_skipped    JSONB   := '[]'::jsonb;
  v_row        RECORD;
  v_sort       INTEGER := 10;
BEGIN
  SELECT b.formula_id, f.yield_pct
    INTO v_formula_id, v_yield
    FROM ops.product_bom b
    LEFT JOIN ops.product_formulas f ON f.id = b.formula_id
   WHERE b.id = p_bom_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'bom % not found', p_bom_id; END IF;
  IF v_formula_id IS NULL THEN
    RAISE EXCEPTION 'this BOM is not linked to a formula — link one first';
  END IF;

  -- scrap that makes qty_per × (1 + scrap) equal qty_per / yield_pct exactly.
  v_scrap := CASE WHEN COALESCE(v_yield, 1) >= 1 THEN 0
                  ELSE (1 - v_yield) / v_yield END;

  DELETE FROM ops.product_bom_lines WHERE bom_id = p_bom_id AND source = 'formula';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  FOR v_row IN SELECT * FROM ops.fn_formula_case_requirements(p_bom_id) LOOP
    IF NOT v_row.is_purchased THEN
      v_skipped := v_skipped || jsonb_build_object(
        'name', v_row.material_name, 'reason', 'not purchased (sourced on site)');
      CONTINUE;
    END IF;
    IF v_row.qbo_item_id IS NULL THEN
      v_unlinked := v_unlinked || jsonb_build_object(
        'name', v_row.material_name, 'qty_per_case', v_row.qty_per_case,
        'uom', v_row.recipe_uom);
      CONTINUE;
    END IF;

    INSERT INTO ops.product_bom_lines (
      bom_id, line_type, component_qbo_item_id, qty_per, qty_uom,
      scrap_pct, default_cost, preferred_qbo_vendor_id,
      source, ingredient_id, sort_order, notes
    ) VALUES (
      p_bom_id, 'component', v_row.qbo_item_id, v_row.qty_per_case, v_row.recipe_uom,
      v_scrap, v_row.purchase_cost, v_row.qbo_vendor_id,
      'formula', v_row.ingredient_id, v_sort,
      'From formula — ' || v_row.sheet_name || ' @ ' ||
        ROUND(v_row.pct_by_weight * 100, 5)::text || '% by weight'
    );
    v_added := v_added + 1;
    v_sort  := v_sort + 10;
  END LOOP;

  RETURN jsonb_build_object(
    'bom_id',   p_bom_id,
    'removed',  v_removed,
    'added',    v_added,
    'unlinked', v_unlinked,
    'skipped',  v_skipped,
    'scrap_pct', v_scrap
  );
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_bom_sync_from_formula(UUID) TO authenticated;


-- ── 9. fn_batch_plan — the tank / MOQ answer ────────────────────────────────
-- "If I put in an order for 500 cases it should tell me you need to put in an
--  extra 30 cases to get to 2500 gallons, that way I can meet MOQs."
--
-- Reports, for each tank this flavour can run in: the cases that tank yields,
-- how many MORE cases that is than asked for, and how much capacity is wasted
-- if the run goes as asked. `recommended` is the smallest tank that holds the
-- request — the honest default, since running a bigger tank part-full is a
-- decision, not an optimisation.
CREATE OR REPLACE FUNCTION ops.fn_batch_plan(p_bom_id UUID, p_cases NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = ops, pg_temp AS $$
DECLARE
  v_gal_per_case NUMERIC;
  v_yield        NUMERIC;
  v_tanks        NUMERIC[];
  v_needed       NUMERIC;
  v_batch        NUMERIC;
  v_tank         NUMERIC;
  v_tank_cases   NUMERIC;
  v_options      JSONB := '[]'::jsonb;
  v_recommended  NUMERIC := NULL;
BEGIN
  SELECT (b.cans_per_case::numeric * b.oz_per_can) / 128.0,
         COALESCE(f.yield_pct, 1),
         COALESCE(f.tank_sizes_gal, '{1500,2000,2500}')
    INTO v_gal_per_case, v_yield, v_tanks
    FROM ops.product_bom b
    LEFT JOIN ops.product_formulas f ON f.id = b.formula_id
   WHERE b.id = p_bom_id;
  IF v_gal_per_case IS NULL THEN RAISE EXCEPTION 'bom % not found', p_bom_id; END IF;
  IF p_cases IS NULL OR p_cases <= 0 THEN RAISE EXCEPTION 'cases must be > 0'; END IF;

  v_needed := p_cases * v_gal_per_case;          -- finished gallons wanted
  v_batch  := v_needed / v_yield;                -- gallons that must go in the tank

  SELECT array_agg(t ORDER BY t) INTO v_tanks FROM unnest(v_tanks) AS t;

  FOREACH v_tank IN ARRAY v_tanks LOOP
    -- whole cases a full tank of this size yields
    v_tank_cases := floor((v_tank * v_yield) / v_gal_per_case);
    v_options := v_options || jsonb_build_object(
      'tank_gal',       v_tank,
      'cases_from_tank', v_tank_cases,
      'extra_cases',    GREATEST(v_tank_cases - p_cases, 0),
      'fits',           v_batch <= v_tank,
      'unused_gal',     ROUND(GREATEST(v_tank - v_batch, 0), 2),
      'over_by_gal',    ROUND(GREATEST(v_batch - v_tank, 0), 2)
    );
    IF v_recommended IS NULL AND v_batch <= v_tank THEN
      v_recommended := v_tank;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'cases_requested',  p_cases,
    'gal_per_case',     ROUND(v_gal_per_case, 6),
    'yield_pct',        v_yield,
    'finished_gal',     ROUND(v_needed, 2),
    'gal_to_batch',     ROUND(v_batch, 2),
    'recommended_tank', v_recommended,
    'tanks',            v_options
  );
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_batch_plan(UUID, NUMERIC) TO authenticated;


-- ── 16. v_raw_ingredients — the master with its readiness stated ────────────
-- A material is only usable on a purchase order when it has an item, a vendor,
-- a pack and a cost. The view says WHICH of those is missing rather than
-- returning a bare boolean, because each one is a different job for a human.
DROP VIEW IF EXISTS ops.v_raw_ingredients;
CREATE VIEW ops.v_raw_ingredients AS
SELECT
  r.*,
  qi.name         AS qbo_item_name,
  qi.active       AS qbo_item_active,
  qi.expense_account_name,
  v.display_name  AS vendor_name,
  (SELECT count(*) FROM ops.product_formula_ingredients fi WHERE fi.ingredient_id = r.id) AS formula_count,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN r.qbo_item_id IS NULL                      THEN 'no QuickBooks item' END,
    CASE WHEN r.is_purchased AND r.qbo_vendor_id IS NULL THEN 'no vendor' END,
    CASE WHEN r.is_purchased AND r.pack_size IS NULL     THEN 'no pack size' END,
    CASE WHEN r.is_purchased AND r.purchase_cost IS NULL THEN 'no cost' END
  ], NULL) AS gaps
FROM ops.raw_ingredients r
LEFT JOIN ops.qbo_items   qi ON qi.qbo_item_id   = r.qbo_item_id
LEFT JOIN ops.qbo_vendors v  ON v.qbo_vendor_id  = r.qbo_vendor_id;

GRANT SELECT ON ops.v_raw_ingredients TO authenticated;
