-- The functions behind the gallon roll-up (20260902f/g).
--
--   fn_bom_sync_from_formula   recipe lines need no QuickBooks item
--   fn_wo_create_pipeline      stocked lines and recipe lines part company
--   fn_wo_attach_recipe_detail files the breakdown under the gallon line
--
-- fn_wo_create_pipeline is CREATE OR REPLACE with the IDENTICAL signature from
-- 20260721a — changing an argument list leaves a zombie overload beside the
-- old one, which this repo has been bitten by twice.

CREATE OR REPLACE FUNCTION ops.fn_bom_sync_from_formula(p_bom_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_formula_id UUID;
  v_yield      NUMERIC;
  v_gallon     TEXT;
  v_scrap      NUMERIC;
  v_removed    INTEGER := 0;
  v_added      INTEGER := 0;
  v_rolled     INTEGER := 0;
  v_unlinked   JSONB   := '[]'::jsonb;
  v_skipped    JSONB   := '[]'::jsonb;
  v_warnings   JSONB   := '[]'::jsonb;
  v_mode       TEXT;
  v_row        RECORD;
  v_sort       INTEGER := 10;
BEGIN
  SELECT b.formula_id, f.yield_pct, f.gallon_qbo_item_id
    INTO v_formula_id, v_yield, v_gallon
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

  RETURN jsonb_build_object(
    'bom_id',    p_bom_id,
    'removed',   v_removed,
    'added',     v_added,
    'rolled_up', v_rolled,
    'gallon_qbo_item_id', v_gallon,
    'unlinked',  v_unlinked,
    'skipped',   v_skipped,
    'warnings',  v_warnings,
    'scrap_pct', v_scrap
  );
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_bom_sync_from_formula(UUID) TO authenticated;


CREATE OR REPLACE FUNCTION ops.fn_wo_create_pipeline(
  p_bom_id                  UUID,
  p_qty_to_produce          NUMERIC,
  p_copacker_qbo_vendor_id  TEXT,
  p_copacker_location_id    UUID,
  p_destination_location_id UUID,
  p_scheduled_date          DATE DEFAULT NULL,
  p_batch_size_gal          NUMERIC DEFAULT NULL,
  p_notes                   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id               UUID;
  v_batch            TEXT;
  v_finished_item_id TEXT;
  v_yield            NUMERIC;
  v_formula_id       UUID;
  v_kind             TEXT;
  v_actor            UUID := auth.uid();
  v_runs             NUMERIC;
BEGIN
  IF p_qty_to_produce IS NULL OR p_qty_to_produce <= 0 THEN
    RAISE EXCEPTION 'qty_to_produce must be > 0';
  END IF;

  SELECT finished_qbo_item_id, yield_qty, formula_id
    INTO v_finished_item_id, v_yield, v_formula_id
    FROM ops.product_bom WHERE id = p_bom_id AND is_active;
  IF v_finished_item_id IS NULL THEN
    RAISE EXCEPTION 'bom_id not found or inactive';
  END IF;

  SELECT kind INTO v_kind FROM ops.inventory_locations WHERE id = p_copacker_location_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'copacker_location_id not found'; END IF;
  IF v_kind IN ('in_transit','adjustment') THEN
    RAISE EXCEPTION 'Co-packer location cannot be a virtual location';
  END IF;

  SELECT kind INTO v_kind FROM ops.inventory_locations WHERE id = p_destination_location_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'destination_location_id not found'; END IF;
  IF v_kind IN ('in_transit','adjustment') THEN
    RAISE EXCEPTION 'Destination cannot be a virtual location';
  END IF;

  v_runs  := p_qty_to_produce / v_yield;
  v_batch := ops.fn_next_wo_batch_code();

  INSERT INTO ops.work_orders (
    batch_code, bom_id, finished_qbo_item_id, qty_to_produce, expected_units,
    production_location_id, copacker_location_id, destination_location_id,
    copacker_qbo_vendor_id, formula_id, batch_size_gal,
    status, scheduled_date, notes, created_by
  ) VALUES (
    v_batch, p_bom_id, v_finished_item_id, p_qty_to_produce, p_qty_to_produce,
    p_copacker_location_id, p_copacker_location_id, p_destination_location_id,
    p_copacker_qbo_vendor_id, v_formula_id, p_batch_size_gal,
    'draft', p_scheduled_date, p_notes, v_actor
  )
  RETURNING id INTO v_id;

  -- STOCKED lines → what we buy, move and cost.
  INSERT INTO ops.work_order_materials (
    wo_id, bom_line_id, component_qbo_item_id, item_name,
    required_qty, recipe_qty, recipe_uom, pack_size, uom,
    unit_cost_est, qbo_vendor_id, vendor_name, ingredient_id, sort_order, notes
  )
  SELECT
    v_id, l.id, l.component_qbo_item_id,
    COALESCE(qi.name, ri.name, l.component_qbo_item_id),
    CASE
      WHEN ri.pack_size IS NULL OR ri.pack_size <= 0 THEN need.recipe_qty
      ELSE ceil((need.recipe_qty / ri.pack_size) / ri.order_multiple) * ri.order_multiple
    END,
    need.recipe_qty,
    COALESCE(l.qty_uom, 'each'),
    ri.pack_size,
    COALESCE(ri.purchase_uom, l.qty_uom, 'each'),
    COALESCE(l.default_cost, ri.purchase_cost, qi.purchase_cost),
    COALESCE(l.preferred_qbo_vendor_id, ri.qbo_vendor_id),
    (SELECT display_name FROM ops.qbo_vendors
      WHERE qbo_vendor_id = COALESCE(l.preferred_qbo_vendor_id, ri.qbo_vendor_id)),
    l.ingredient_id,
    l.sort_order,
    l.notes
  FROM ops.product_bom_lines l
  LEFT JOIN ops.raw_ingredients ri ON ri.id = l.ingredient_id
  LEFT JOIN ops.qbo_items qi       ON qi.qbo_item_id = l.component_qbo_item_id
  CROSS JOIN LATERAL (
    SELECT v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) AS recipe_qty
  ) need
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component'
    AND l.component_qbo_item_id IS NOT NULL
  ORDER BY l.sort_order;

  -- RECIPE lines → the specification under a gallon. Same arithmetic, but they
  -- are told to the supplier, not bought from one.
  INSERT INTO ops.work_order_recipe_lines (
    wo_id, bom_line_id, ingredient_id, item_name,
    recipe_qty, recipe_uom, order_qty, purchase_uom, pack_size,
    rollup_qbo_item_id, sort_order, notes
  )
  SELECT
    v_id, l.id, l.ingredient_id,
    COALESCE(ri.name, 'ingredient'),
    need.recipe_qty,
    COALESCE(l.qty_uom, 'lbs'),
    CASE
      WHEN ri.pack_size IS NULL OR ri.pack_size <= 0 THEN NULL
      ELSE ceil((need.recipe_qty / ri.pack_size) / ri.order_multiple) * ri.order_multiple
    END,
    ri.purchase_uom,
    ri.pack_size,
    l.rollup_qbo_item_id,
    l.sort_order,
    l.notes
  FROM ops.product_bom_lines l
  LEFT JOIN ops.raw_ingredients ri ON ri.id = l.ingredient_id
  CROSS JOIN LATERAL (
    SELECT v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) AS recipe_qty
  ) need
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component'
    AND l.component_qbo_item_id IS NULL
  ORDER BY l.sort_order;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
  VALUES (v_id, 'created', NULL, 'draft',
          'Work order created for ' || p_qty_to_produce || ' units', v_actor);

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_create_pipeline(UUID, NUMERIC, TEXT, UUID, UUID, DATE, NUMERIC, TEXT) TO authenticated;


-- Called at the end of PO generation. For every recipe line, find the PO line
-- carrying the gallon it rolls into and file the ingredient underneath it with
-- its share of that line's price.
--
-- The allocation is BY WEIGHT within the group, and it is an allocation, not a
-- quote: flavour is a tiny fraction of the weight and a large fraction of the
-- real cost, so this tells you what the gallon breaks down to arithmetically,
-- not what the supplier pays for each drum. quoted_cost carries the real number
-- wherever a material has one on file, which is what makes the two comparable.
CREATE OR REPLACE FUNCTION ops.fn_wo_attach_recipe_detail(p_wo_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_attached INTEGER := 0;
  v_orphans  JSONB   := '[]'::jsonb;
  v_grp      RECORD;
  v_line     RECORD;
  v_po_line  RECORD;
  v_weight   NUMERIC;
  v_amount   NUMERIC;
  v_sort     INTEGER;
BEGIN
  FOR v_grp IN
    SELECT rollup_qbo_item_id, sum(recipe_qty) AS total_weight
      FROM ops.work_order_recipe_lines
     WHERE wo_id = p_wo_id AND rollup_qbo_item_id IS NOT NULL
     GROUP BY rollup_qbo_item_id
  LOOP
    SELECT pl.id, pl.qty_ordered, pl.unit_cost
      INTO v_po_line
      FROM ops.purchase_order_lines pl
      JOIN ops.purchase_orders po ON po.id = pl.po_id
     WHERE po.work_order_id = p_wo_id
       AND po.status <> 'void'
       AND pl.qbo_item_id = v_grp.rollup_qbo_item_id
     ORDER BY pl.sort_order
     LIMIT 1;

    IF v_po_line.id IS NULL THEN
      v_orphans := v_orphans || jsonb_build_object(
        'rollup_qbo_item_id', v_grp.rollup_qbo_item_id,
        'reason', 'no purchase order line carries this item, so its ingredients '
                  || 'have nothing to be billed inside');
      CONTINUE;
    END IF;

    v_weight := NULLIF(v_grp.total_weight, 0);
    v_amount := COALESCE(v_po_line.qty_ordered, 0) * COALESCE(v_po_line.unit_cost, 0);
    v_sort   := 10;

    DELETE FROM ops.purchase_order_line_details WHERE po_line_id = v_po_line.id;

    FOR v_line IN
      SELECT r.*, ri.purchase_cost, ri.pack_size AS ri_pack
        FROM ops.work_order_recipe_lines r
        LEFT JOIN ops.raw_ingredients ri ON ri.id = r.ingredient_id
       WHERE r.wo_id = p_wo_id AND r.rollup_qbo_item_id = v_grp.rollup_qbo_item_id
       ORDER BY r.sort_order
    LOOP
      INSERT INTO ops.purchase_order_line_details (
        po_line_id, ingredient_id, item_name, qty, uom,
        allocated_cost, quoted_cost, notes, sort_order
      ) VALUES (
        v_po_line.id, v_line.ingredient_id, v_line.item_name,
        v_line.recipe_qty, v_line.recipe_uom,
        CASE WHEN v_weight IS NULL THEN NULL
             ELSE ROUND(v_amount * (v_line.recipe_qty / v_weight), 4) END,
        CASE WHEN v_line.purchase_cost IS NULL THEN NULL
             ELSE ROUND(v_line.recipe_qty / NULLIF(COALESCE(v_line.ri_pack, 1), 0)
                        * v_line.purchase_cost, 4) END,
        CASE WHEN v_line.order_qty IS NOT NULL
             THEN 'order ' || ROUND(v_line.order_qty, 3) || ' ' ||
                  COALESCE(v_line.purchase_uom, '') END,
        v_sort
      );
      UPDATE ops.work_order_recipe_lines SET po_line_id = v_po_line.id WHERE id = v_line.id;
      v_attached := v_attached + 1;
      v_sort := v_sort + 10;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('attached', v_attached, 'orphans', v_orphans);
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_attach_recipe_detail(UUID) TO authenticated;
