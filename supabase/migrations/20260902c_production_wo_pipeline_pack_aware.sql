-- ============================================================================
-- Work-order pipeline made pack-aware, plus the production purchase order.
--
-- Part 3 of the 2026-09-02 production change (20260902a schema, b math).
-- Every function here is CREATE OR REPLACE with the IDENTICAL signature it had
-- in 20260721a_production_redesign.sql — changing an argument list would leave
-- a zombie overload beside the old one, which this repo has been bitten by
-- twice.
-- ============================================================================

-- ── 12. fn_wo_create_pipeline — same signature, pack-aware materials ────────
-- CREATE OR REPLACE with the IDENTICAL signature from 20260721a: changing the
-- arguments would leave a zombie overload (the trap this repo has hit twice).
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

  -- Material requirements — THE quantity calculation, snapshotted on the WO.
  --   recipe_qty   = runs × qty_per × (1 + scrap)          [lbs of sugar]
  --   required_qty = that, converted to the vendor's pack and rounded UP to a
  --                  whole order multiple                   [bags of sugar]
  -- A material with no pack size is bought in its recipe unit and passes
  -- through unrounded, which keeps cans/trays/labour behaving exactly as before.
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
  ORDER BY l.sort_order;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
  VALUES (v_id, 'created', NULL, 'draft',
          'Work order created for ' || p_qty_to_produce || ' units', v_actor);

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_create_pipeline(UUID, NUMERIC, TEXT, UUID, UUID, DATE, NUMERIC, TEXT) TO authenticated;


-- ── 13. fn_wo_create_production_po — the finished goods coming back ─────────
-- "when we bring the purchase order in from our vendor called Alameda Soda
--  Production, it properly shows the item cost and breaks it down by case."
--
-- This is the OTHER end of the run: one PO to the production vendor for the
-- finished case item, at the merged per-case cost the work order computed from
-- the material POs plus the co-pack fee and freight. Pushing it to QuickBooks
-- (existing push-qbo-item action postPurchaseOrder) is what lands a real
-- per-case cost on the finished item.
--
-- Refuses before a yield is recorded, on purpose: before that there is no
-- merged cost, and a PO written at the ESTIMATE would book a number nobody
-- measured.
CREATE OR REPLACE FUNCTION ops.fn_wo_create_production_po(
  p_wo_id         UUID,
  p_expected_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_wo        ops.work_orders%ROWTYPE;
  v_cost      ops.work_order_costs%ROWTYPE;
  v_vendor    TEXT;
  v_po_id     UUID;
  v_po_number TEXT;
  v_qty       NUMERIC;
  v_unit      NUMERIC;
  v_actor     UUID := auth.uid();
  v_item_name TEXT;
BEGIN
  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;

  IF EXISTS (SELECT 1 FROM ops.purchase_orders
              WHERE work_order_id = p_wo_id AND po_kind = 'production'
                AND status <> 'void') THEN
    RAISE EXCEPTION 'this work order already has a production purchase order';
  END IF;

  SELECT * INTO v_cost FROM ops.work_order_costs WHERE wo_id = p_wo_id;
  IF v_cost.wo_id IS NULL THEN
    RAISE EXCEPTION 'no cost recorded yet — record the yield first, so the '
                    'per-case cost is measured rather than estimated';
  END IF;

  SELECT production_vendor_qbo_id INTO v_vendor FROM ops.production_settings WHERE id;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'no production vendor configured in ops.production_settings';
  END IF;

  v_qty  := COALESCE(v_cost.qty_produced, v_wo.actual_yield_qty, v_wo.qty_to_produce);
  v_unit := COALESCE(v_cost.per_case, v_cost.unit_cost);
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'no yield quantity on this work order'; END IF;
  IF v_unit IS NULL OR v_unit <= 0 THEN RAISE EXCEPTION 'no per-case cost on this work order'; END IF;

  SELECT name INTO v_item_name FROM ops.qbo_items WHERE qbo_item_id = v_wo.finished_qbo_item_id;
  v_po_number := ops.fn_next_po_number();

  INSERT INTO ops.purchase_orders (
    po_number, qbo_vendor_id, destination_location_id, status, po_kind,
    expected_date, notes, work_order_id, created_by, ordered_at, ordered_by, subtotal
  ) VALUES (
    v_po_number, v_vendor,
    COALESCE(v_wo.destination_location_id, v_wo.copacker_location_id), 'open', 'production',
    p_expected_date,
    'Finished goods from work order ' || v_wo.batch_code ||
      ' — merged cost of the material and co-pack purchase orders',
    p_wo_id, v_actor, now(), v_actor, ROUND(v_qty * v_unit, 2)
  )
  RETURNING id INTO v_po_id;

  INSERT INTO ops.purchase_order_lines (
    po_id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order
  ) VALUES (
    v_po_id, v_wo.finished_qbo_item_id,
    COALESCE(v_item_name, v_wo.finished_qbo_item_id),
    v_qty, ROUND(v_unit, 5),
    'WO ' || v_wo.batch_code || ' · per-case cost', 100
  );

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'production_po_created', v_wo.status, v_wo.status,
          'Production PO ' || v_po_number || ' — ' || v_qty || ' cases @ ' || ROUND(v_unit, 4),
          jsonb_build_object('po_id', v_po_id, 'po_number', v_po_number,
                             'qty', v_qty, 'unit_cost', v_unit), v_actor);

  RETURN jsonb_build_object(
    'po_id', v_po_id, 'po_number', v_po_number,
    'qbo_vendor_id', v_vendor, 'qty', v_qty, 'unit_cost', ROUND(v_unit, 5),
    'subtotal', ROUND(v_qty * v_unit, 2)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_create_production_po(UUID, DATE) TO authenticated;


-- ── 14. fn_wo_generate_pos: materials POs only ──────────────────────────────
-- One-line change from 20260721a: stamp po_kind='materials' so the production
-- PO created above is never confused with a vendor spend PO.
CREATE OR REPLACE FUNCTION ops.fn_wo_generate_pos(
  p_wo_id         UUID,
  p_expected_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status    TEXT;
  v_batch     TEXT;
  v_copacker  UUID;
  v_actor     UUID := auth.uid();
  v_vendor    TEXT;
  v_po_id     UUID;
  v_po_number TEXT;
  v_missing   TEXT;
  v_result    JSONB := '[]'::jsonb;
  v_mat       RECORD;
  v_line_id   UUID;
  v_subtotal  NUMERIC;
  v_sort      INTEGER;
BEGIN
  SELECT status, batch_code, copacker_location_id
    INTO v_status, v_batch, v_copacker
    FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_status NOT IN ('draft','ordered') THEN
    RAISE EXCEPTION 'work order is %, POs can only be generated while draft/ordered', v_status;
  END IF;

  SELECT string_agg(DISTINCT COALESCE(item_name, component_qbo_item_id), ', ')
    INTO v_missing
    FROM ops.work_order_materials
    WHERE wo_id = p_wo_id AND po_id IS NULL AND qbo_vendor_id IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'No vendor assigned for: %. Set a vendor on each material first.', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM ops.work_order_materials WHERE wo_id = p_wo_id AND po_id IS NULL) THEN
    RAISE EXCEPTION 'All materials on this work order already have purchase orders';
  END IF;

  FOR v_vendor IN
    SELECT DISTINCT qbo_vendor_id
      FROM ops.work_order_materials
      WHERE wo_id = p_wo_id AND po_id IS NULL
      ORDER BY qbo_vendor_id
  LOOP
    v_po_number := ops.fn_next_po_number();
    v_subtotal  := 0;
    v_sort      := 100;

    INSERT INTO ops.purchase_orders (
      po_number, qbo_vendor_id, destination_location_id, status, po_kind,
      expected_date, notes, work_order_id, created_by, ordered_at, ordered_by
    ) VALUES (
      v_po_number, v_vendor, v_copacker, 'open', 'materials',
      p_expected_date, 'Materials for work order ' || v_batch, p_wo_id,
      v_actor, now(), v_actor
    )
    RETURNING id INTO v_po_id;

    FOR v_mat IN
      SELECT * FROM ops.work_order_materials
        WHERE wo_id = p_wo_id AND po_id IS NULL AND qbo_vendor_id = v_vendor
        ORDER BY sort_order
    LOOP
      INSERT INTO ops.purchase_order_lines (
        po_id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order
      ) VALUES (
        v_po_id, v_mat.component_qbo_item_id, v_mat.item_name,
        v_mat.required_qty, COALESCE(v_mat.unit_cost_est, 0),
        'WO ' || v_batch ||
          CASE WHEN v_mat.recipe_qty IS NOT NULL AND v_mat.pack_size IS NOT NULL
               THEN ' · needs ' || ROUND(v_mat.recipe_qty, 3) || ' ' ||
                    COALESCE(v_mat.recipe_uom, '') ELSE '' END,
        v_sort
      )
      RETURNING id INTO v_line_id;

      UPDATE ops.work_order_materials
         SET po_id = v_po_id, po_line_id = v_line_id
       WHERE id = v_mat.id;

      v_subtotal := v_subtotal + v_mat.required_qty * COALESCE(v_mat.unit_cost_est, 0);
      v_sort := v_sort + 10;
    END LOOP;

    UPDATE ops.purchase_orders SET subtotal = v_subtotal WHERE id = v_po_id;

    v_result := v_result || jsonb_build_object(
      'po_id', v_po_id, 'po_number', v_po_number,
      'qbo_vendor_id', v_vendor, 'subtotal', v_subtotal
    );
  END LOOP;

  IF v_status = 'draft' THEN
    UPDATE ops.work_orders SET status = 'ordered', ordered_at = now() WHERE id = p_wo_id;
  END IF;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'pos_generated', v_status, 'ordered',
          jsonb_array_length(v_result) || ' purchase order(s) generated', v_result, v_actor);

  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_generate_pos(UUID, DATE) TO authenticated;
