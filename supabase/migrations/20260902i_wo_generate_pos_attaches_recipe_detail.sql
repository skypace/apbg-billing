-- fn_wo_generate_pos: after the purchase orders exist, file the ingredient
-- breakdown underneath the gallon line it is billed inside.
--
-- Body otherwise verbatim from 20260902c; the changes are the closing call to
-- fn_wo_attach_recipe_detail and the result shape, which is now
-- {pos: [...], recipe_detail: {attached, orphans}} rather than a bare array.
-- app/src/lib/production.ts GeneratePosResult mirrors that.
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
  v_detail    JSONB;
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

  -- The ingredients are specification, not spend: they are filed UNDER the
  -- gallon line that carries their price, so Refractor and the printed PO show
  -- what the supplier must buy while QuickBooks still sees one gallon line.
  v_detail := ops.fn_wo_attach_recipe_detail(p_wo_id);

  IF v_status = 'draft' THEN
    UPDATE ops.work_orders SET status = 'ordered', ordered_at = now() WHERE id = p_wo_id;
  END IF;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'pos_generated', v_status, 'ordered',
          jsonb_array_length(v_result) || ' purchase order(s) generated',
          jsonb_build_object('pos', v_result, 'recipe_detail', v_detail), v_actor);

  RETURN jsonb_build_object('pos', v_result, 'recipe_detail', v_detail);
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_generate_pos(UUID, DATE) TO authenticated;
