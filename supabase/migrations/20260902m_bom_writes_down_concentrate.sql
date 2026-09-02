-- fn_bom_sync_from_formula writes the DERIVED concentrate volume onto the
-- gallon line, so the number on the BOM is computed rather than typed.
--
-- It was 1 gal/case — a placeholder that was neither of the two defensible
-- readings (2.25 gal if the gallon were finished soda, 0.375 gal at 5:1) and
-- that multiplied the entire ingredient bill. It is now finished volume
-- divided by (1 + throw ratio), recomputed on every rebuild, with the change
-- reported back so nobody has to notice it silently.
--
-- The vendor, the price and the item on that line stay the operator's; only
-- the quantity and its unit are derived. Body is otherwise 20260902h's.

CREATE OR REPLACE FUNCTION ops.fn_bom_sync_from_formula(p_bom_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_formula_id UUID;
  v_yield      NUMERIC;
  v_gallon     TEXT;
  v_throw      NUMERIC;
  v_scrap      NUMERIC;
  v_removed    INTEGER := 0;
  v_added      INTEGER := 0;
  v_rolled     INTEGER := 0;
  v_unlinked   JSONB   := '[]'::jsonb;
  v_skipped    JSONB   := '[]'::jsonb;
  v_warnings   JSONB   := '[]'::jsonb;
  v_basis      JSONB;
  v_conc       NUMERIC;
  v_was        NUMERIC;
  v_mode       TEXT;
  v_row        RECORD;
  v_sort       INTEGER := 10;
BEGIN
  SELECT b.formula_id, f.yield_pct, f.gallon_qbo_item_id, COALESCE(f.dilution_ratio, 0)
    INTO v_formula_id, v_yield, v_gallon, v_throw
    FROM ops.product_bom b
    LEFT JOIN ops.product_formulas f ON f.id = b.formula_id
   WHERE b.id = p_bom_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'bom % not found', p_bom_id; END IF;
  IF v_formula_id IS NULL THEN
    RAISE EXCEPTION 'this BOM is not linked to a formula — link one first';
  END IF;

  v_scrap := CASE WHEN COALESCE(v_yield, 1) >= 1 THEN 0
                  ELSE (1 - v_yield) / v_yield END;

  IF v_gallon IS NULL THEN
    v_warnings := v_warnings || to_jsonb(
      'This flavour has no 1-gallon item on its formula, so the ingredients have '
      || 'nothing to roll up into. They are written as specification only and will '
      || 'not reach a purchase order.'::text);
  ELSIF NOT EXISTS (
    SELECT 1 FROM ops.product_bom_lines
     WHERE bom_id = p_bom_id AND line_type = 'component'
       AND component_qbo_item_id = v_gallon
  ) THEN
    v_warnings := v_warnings || to_jsonb(
      'The flavour 1-gallon item is not a line on this BOM, so there is nothing '
      || 'for the ingredients to be billed inside. Add it as a stocked line.'::text);
  END IF;

  DELETE FROM ops.product_bom_lines WHERE bom_id = p_bom_id AND source = 'formula';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  FOR v_row IN SELECT * FROM ops.fn_formula_case_requirements(p_bom_id) LOOP
    IF NOT v_row.is_purchased THEN
      v_skipped := v_skipped || jsonb_build_object(
        'name', v_row.material_name, 'reason', 'not purchased (sourced on site)');
      CONTINUE;
    END IF;

    SELECT purchase_mode INTO v_mode FROM ops.raw_ingredients WHERE id = v_row.ingredient_id;
    v_mode := COALESCE(v_mode, 'rollup');

    IF v_mode = 'direct' AND v_row.qbo_item_id IS NULL THEN
      v_unlinked := v_unlinked || jsonb_build_object(
        'name', v_row.material_name, 'qty_per_case', v_row.qty_per_case,
        'uom', v_row.recipe_uom,
        'reason', 'bought directly but has no QuickBooks item');
      CONTINUE;
    END IF;

    INSERT INTO ops.product_bom_lines (
      bom_id, line_type, component_qbo_item_id, qty_per, qty_uom,
      scrap_pct, default_cost, preferred_qbo_vendor_id,
      source, ingredient_id, rollup_qbo_item_id, sort_order, notes
    ) VALUES (
      p_bom_id, 'component',
      CASE WHEN v_mode = 'direct' THEN v_row.qbo_item_id END,
      v_row.qty_per_case, v_row.recipe_uom,
      v_scrap, v_row.purchase_cost, v_row.qbo_vendor_id,
      'formula', v_row.ingredient_id,
      CASE WHEN v_mode = 'rollup' THEN v_gallon END,
      v_sort,
      'From formula — ' || v_row.sheet_name || ' @ ' ||
        ROUND(v_row.pct_by_weight * 100, 5)::text || '% by weight'
    );
    v_added  := v_added + 1;
    IF v_mode = 'rollup' THEN v_rolled := v_rolled + 1; END IF;
    v_sort := v_sort + 10;
  END LOOP;

  -- The gallon quantity is DERIVED: finished volume / (1 + throw ratio).
  v_basis := ops.fn_formula_batch_basis(p_bom_id);
  v_conc  := (v_basis ->> 'concentrate_gal_per_case')::numeric;

  UPDATE ops.product_bom SET dilution_ratio = v_throw
   WHERE id = p_bom_id AND dilution_ratio IS DISTINCT FROM v_throw;

  IF v_gallon IS NOT NULL AND v_conc > 0 THEN
    SELECT qty_per INTO v_was FROM ops.product_bom_lines
     WHERE bom_id = p_bom_id AND line_type = 'component'
       AND component_qbo_item_id = v_gallon;

    UPDATE ops.product_bom_lines
       SET qty_per = v_conc, qty_uom = 'gal'
     WHERE bom_id = p_bom_id AND line_type = 'component'
       AND component_qbo_item_id = v_gallon
       AND (qty_per IS DISTINCT FROM v_conc OR qty_uom IS DISTINCT FROM 'gal');

    IF FOUND AND v_was IS DISTINCT FROM v_conc THEN
      v_warnings := v_warnings || to_jsonb(
        ('Concentrate per case recomputed from the ' || v_throw || ':1 throw ratio: '
         || COALESCE(v_was::text, 'unset') || ' → ' || v_conc || ' gal.')::text);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'bom_id',    p_bom_id,
    'removed',   v_removed,
    'added',     v_added,
    'rolled_up', v_rolled,
    'gallon_qbo_item_id', v_gallon,
    'basis',     v_basis,
    'unlinked',  v_unlinked,
    'skipped',   v_skipped,
    'warnings',  v_warnings,
    'scrap_pct', v_scrap
  );
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_bom_sync_from_formula(UUID) TO authenticated;

-- Apply it to the seven live BOMs: 1 gal/case → 0.375 gal/case.
DO $$
DECLARE v_bom UUID;
BEGIN
  FOR v_bom IN SELECT id FROM ops.product_bom WHERE formula_id IS NOT NULL AND is_active LOOP
    PERFORM ops.fn_bom_sync_from_formula(v_bom);
  END LOOP;
END $$;
