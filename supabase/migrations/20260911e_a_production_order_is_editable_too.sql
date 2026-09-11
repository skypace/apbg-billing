-- 20260911e — a production ORDER is editable too: its own fields, and each
-- flavour's quantity while the order is still a draft.
--
-- Sky (2026-09-11), on the multi-flavour order: "That's a lot of data to be
-- putting on one work order so I hope you have an innovative way to like keep it
-- all together. Sounds like there needs to be some arrows or something that
-- allows you to expand specifics should also be able to edit the orders."
--
-- The arrows are the screen's job (RunDetailModal: each flavour row folds open
-- onto its materials, lots, cost and actions). This is the "edit the orders" half:
--
--   • ops.fn_run_update(p_run_id, p_patch) — scheduled_date · notes · tank_size_gal
--     on ops.production_runs, whitelisted keys, refused on a void or closed order,
--     a date more than a year out refused by name (the WO-2026-00026 typo), the
--     change recorded in production_doc_events as doc_type 'run'. Same shape as
--     fn_update_work_orders so the two dialogs can share one component.
--   • ops.fn_wo_rescale gains ONE relaxation: a flavour on a run can be resized
--     while the RUN IS A DRAFT. In draft nothing is ordered — no PO line, no
--     reservation, no movement — so the scale touches only the flavour's own
--     materials and recipe lines, and fn_run_generate_pos reads those when the
--     POs are raised. Past draft, one vendor PO line covers several flavours and
--     re-splitting it is not a scale; the refusal says so and names the order.
--     Adding or removing a flavour stays fn_run_add_line / fn_run_remove_line
--     (draft only, same rule).

CREATE OR REPLACE FUNCTION ops.fn_wo_rescale(p_wo_id uuid, p_qty_to_produce numeric, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp
AS $$
DECLARE
  v_wo      ops.work_orders%ROWTYPE;
  v_bom     ops.product_bom%ROWTYPE;
  v_old     numeric;
  v_factor  numeric;
  v_pushed  text;
  v_mov     record;
  v_delta   numeric;
  v_n_mat   int := 0;
  v_n_rec   int := 0;
  v_n_pol   int := 0;
  v_n_res   int := 0;
  v_n_mov   int := 0;
  v_pos     jsonb := '[]';
  v_uid     uuid := auth.uid();
  v_run_status text;
  v_run_number text;
BEGIN
  PERFORM ops.fn_assert_internal();

  IF p_qty_to_produce IS NULL OR p_qty_to_produce <= 0 THEN
    RAISE EXCEPTION 'the new quantity must be greater than zero';
  END IF;

  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work order not found'; END IF;

  IF v_wo.status NOT IN ('draft','ordered','at_copacker','in_production') THEN
    RAISE EXCEPTION '% is %; the plan quantity can only change before the yield is recorded', v_wo.batch_code, v_wo.status;
  END IF;
  -- 20260911e: a flavour on a PRODUCTION ORDER can be resized while the order is
  -- still a DRAFT — nothing is ordered yet, so its materials carry no PO line and
  -- there is nothing merged across flavours to un-merge. Once the order's POs
  -- exist, one vendor line covers several flavours (purchase_order_line_demand)
  -- and re-splitting it is not a scale; the order is voided and raised again.
  IF v_wo.run_id IS NOT NULL THEN
    SELECT status, run_number INTO v_run_status, v_run_number FROM ops.production_runs WHERE id = v_wo.run_id;
    IF v_run_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION '% is a flavour on production order %, which is % — a flavour can only be resized while the order is a draft; void the order and raise it again, or edit the vendor''s PO', v_wo.batch_code, v_run_number, v_run_status;
    END IF;
  END IF;
  IF v_wo.actual_yield_qty IS NOT NULL OR v_wo.yield_recorded_at IS NOT NULL THEN
    RAISE EXCEPTION '% already has a recorded yield; the plan is history now', v_wo.batch_code;
  END IF;

  SELECT string_agg(po_number, ', ' ORDER BY po_number) INTO v_pushed
    FROM ops.purchase_orders
   WHERE work_order_id = p_wo_id AND voided_at IS NULL AND qbo_purchase_order_id IS NOT NULL;
  IF v_pushed IS NOT NULL THEN
    RAISE EXCEPTION '% is already in QuickBooks — edit that PO and push it (or pull it back) before changing the run size', v_pushed;
  END IF;

  v_old := v_wo.qty_to_produce;
  IF p_qty_to_produce = v_old THEN
    RAISE EXCEPTION '% is already planned at %', v_wo.batch_code, v_old;
  END IF;
  v_factor := p_qty_to_produce / v_old;

  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_wo.bom_id;

  -- 1. Materials. per_run lines are one per run and do not move.
  UPDATE ops.work_order_materials
     SET required_qty = round(required_qty * p_qty_to_produce / v_old, 6),
         demand_qty   = round(demand_qty   * p_qty_to_produce / v_old, 6),
         recipe_qty   = round(recipe_qty   * p_qty_to_produce / v_old, 6)
   WHERE wo_id = p_wo_id AND COALESCE(qty_basis, 'per_yield') <> 'per_run';
  GET DIAGNOSTICS v_n_mat = ROW_COUNT;

  -- 2. Recipe detail under the gallon line. order_qty is packs rounded UP
  --    from the need where a pack size is known (the 2026-09-02 rule), else
  --    it scales with the need.
  UPDATE ops.work_order_recipe_lines
     SET recipe_qty = round(recipe_qty * p_qty_to_produce / v_old, 6),
         order_qty  = CASE
                        WHEN order_qty IS NULL THEN NULL
                        WHEN COALESCE(pack_size, 0) > 0 THEN ceil(recipe_qty * p_qty_to_produce / v_old / pack_size)
                        ELSE round(order_qty * p_qty_to_produce / v_old, 6)
                      END
   WHERE wo_id = p_wo_id;
  GET DIAGNOSTICS v_n_rec = ROW_COUNT;

  -- 3. Open reservations against the scaled materials.
  UPDATE ops.inventory_reservations r
     SET qty = round(r.qty * p_qty_to_produce / v_old, 6)
    FROM ops.work_order_materials m
   WHERE m.wo_id = p_wo_id AND r.wo_material_id = m.id
     AND COALESCE(m.qty_basis, 'per_yield') <> 'per_run'
     AND r.resolved_at IS NULL;
  GET DIAGNOSTICS v_n_res = ROW_COUNT;

  -- 4. The PO lines those materials raised (none of these POs is in QuickBooks
  --    — refused above). qty_received follows only where the line was booked
  --    received in full.
  UPDATE ops.purchase_order_lines pl
     SET qty_ordered  = round(pl.qty_ordered * p_qty_to_produce / v_old, 6),
         qty_received = CASE WHEN pl.qty_received > 0 AND pl.qty_received >= pl.qty_ordered
                             THEN round(pl.qty_received * p_qty_to_produce / v_old, 6)
                             ELSE pl.qty_received END,
         demand_total = round(pl.demand_total * p_qty_to_produce / v_old, 6)
    FROM ops.work_order_materials m
   WHERE m.wo_id = p_wo_id AND m.po_line_id = pl.id
     AND COALESCE(m.qty_basis, 'per_yield') <> 'per_run';
  GET DIAGNOSTICS v_n_pol = ROW_COUNT;

  -- subtotal is not trigger-maintained on purchase_orders; recompute it.
  UPDATE ops.purchase_orders p
     SET subtotal   = (SELECT COALESCE(sum(l.qty_ordered * COALESCE(l.unit_cost, 0)), 0)
                         FROM ops.purchase_order_lines l WHERE l.po_id = p.id),
         updated_at = now()
   WHERE p.work_order_id = p_wo_id AND p.voided_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('po_number', po_number, 'subtotal', subtotal) ORDER BY po_number), '[]')
    INTO v_pos
    FROM ops.purchase_orders WHERE work_order_id = p_wo_id AND voided_at IS NULL;

  -- 5. Movements already posted: one NEW row per existing row, for the
  --    difference. Never an UPDATE.
  FOR v_mov IN
    SELECT mv.*
      FROM ops.inventory_movements mv
     WHERE (mv.source_doc_type = 'work_order' AND mv.source_doc_id = p_wo_id
            AND mv.movement_type = 'production_consume'
            AND mv.source_doc_line_id IN (SELECT id FROM ops.work_order_materials
                                            WHERE wo_id = p_wo_id AND COALESCE(qty_basis,'per_yield') <> 'per_run'))
        OR (mv.source_doc_type = 'purchase_order' AND mv.movement_type = 'receipt'
            AND mv.source_doc_line_id IN (SELECT m.po_line_id FROM ops.work_order_materials m
                                            WHERE m.wo_id = p_wo_id AND m.po_line_id IS NOT NULL
                                              AND COALESCE(m.qty_basis,'per_yield') <> 'per_run'))
  LOOP
    v_delta := round(v_mov.qty * (p_qty_to_produce - v_old) / v_old, 6);
    IF v_delta = 0 THEN CONTINUE; END IF;

    IF v_mov.movement_type = 'production_consume' THEN
      IF v_delta > 0 THEN
        INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
                                             source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
        VALUES ('production_consume', v_mov.qbo_item_id, v_delta, v_mov.from_location_id, NULL, v_mov.unit_cost,
                'work_order', p_wo_id, v_mov.source_doc_line_id, now(), v_uid,
                format('WO consume · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
      ELSE
        INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
                                             source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
        VALUES ('adjustment', v_mov.qbo_item_id, -v_delta, NULL, v_mov.from_location_id, v_mov.unit_cost,
                'work_order', p_wo_id, v_mov.source_doc_line_id, now(), v_uid,
                format('WO consume reversed · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
      END IF;
    ELSE  -- receipt
      IF v_delta > 0 THEN
        INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
                                             source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
        VALUES ('receipt', v_mov.qbo_item_id, v_delta, NULL, v_mov.to_location_id, v_mov.unit_cost,
                'purchase_order', v_mov.source_doc_id, v_mov.source_doc_line_id, now(), v_uid,
                format('Co-packer supplied · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
      ELSE
        INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
                                             source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
        VALUES ('receipt_reversal', v_mov.qbo_item_id, -v_delta, v_mov.to_location_id, NULL, v_mov.unit_cost,
                'purchase_order', v_mov.source_doc_id, v_mov.source_doc_line_id, now(), v_uid,
                format('Co-packer supplied reversed · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
      END IF;
    END IF;
    v_n_mov := v_n_mov + 1;
  END LOOP;

  -- 6. The work order itself.
  UPDATE ops.work_orders
     SET qty_to_produce = p_qty_to_produce,
         expected_units = CASE WHEN expected_units IS NULL OR expected_units = v_old THEN p_qty_to_produce
                               ELSE round(expected_units * p_qty_to_produce / v_old, 6) END,
         batch_size_gal = CASE WHEN v_bom.finished_vol_per_yield_gal IS NOT NULL
                               THEN p_qty_to_produce * v_bom.finished_vol_per_yield_gal
                               ELSE round(batch_size_gal * p_qty_to_produce / v_old, 6) END,
         updated_at     = now()
   WHERE id = p_wo_id;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'edit', v_wo.status, v_wo.status,
          format('Plan quantity %s → %s%s', v_old, p_qty_to_produce,
                 CASE WHEN NULLIF(p_reason,'') IS NOT NULL THEN ' — ' || p_reason ELSE '' END),
          jsonb_build_object('field', 'qty_to_produce', 'from', v_old, 'to', p_qty_to_produce, 'factor', v_factor,
                             'reason', p_reason, 'materials', v_n_mat, 'recipe_lines', v_n_rec, 'reservations', v_n_res,
                             'po_lines', v_n_pol, 'movements', v_n_mov, 'purchase_orders', v_pos),
          v_uid);

  RETURN jsonb_build_object('wo_id', p_wo_id, 'batch_code', v_wo.batch_code, 'from', v_old, 'to', p_qty_to_produce,
                            'factor', v_factor, 'materials', v_n_mat, 'recipe_lines', v_n_rec, 'reservations', v_n_res,
                            'po_lines', v_n_pol, 'movements', v_n_mov, 'purchase_orders', v_pos);
END $$;


CREATE OR REPLACE FUNCTION ops.fn_run_update(p_run_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp
AS $$
DECLARE v_run ops.production_runs%ROWTYPE; v_keys text[]; v_date date; v_tank numeric;
BEGIN
  PERFORM ops.fn_assert_internal();
  v_keys := ARRAY(SELECT jsonb_object_keys(coalesce(p_patch, '{}')));
  IF cardinality(v_keys) = 0 THEN RAISE EXCEPTION 'nothing to change'; END IF;
  IF NOT (v_keys <@ ARRAY['scheduled_date', 'notes', 'tank_size_gal']) THEN
    RAISE EXCEPTION 'only scheduled_date, notes and tank_size_gal can be edited on a production order (got %)', array_to_string(v_keys, ', ');
  END IF;
  SELECT * INTO v_run FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'production order not found'; END IF;
  IF v_run.status IN ('void', 'closed') THEN
    RAISE EXCEPTION '% is %; reopen it first', v_run.run_number, v_run.status;
  END IF;
  IF p_patch ? 'scheduled_date' AND NULLIF(p_patch ->> 'scheduled_date', '') IS NOT NULL THEN
    v_date := (p_patch ->> 'scheduled_date')::date;
    IF v_date < current_date - interval '1 year' OR v_date > current_date + interval '1 year' THEN
      RAISE EXCEPTION 'scheduled date % is more than a year from today — check the year', v_date;
    END IF;
  END IF;
  IF p_patch ? 'tank_size_gal' AND NULLIF(p_patch ->> 'tank_size_gal', '') IS NOT NULL THEN
    v_tank := (p_patch ->> 'tank_size_gal')::numeric;
    IF v_tank <= 0 THEN RAISE EXCEPTION 'tank size must be greater than zero'; END IF;
  END IF;

  UPDATE ops.production_runs
     SET scheduled_date = CASE WHEN p_patch ? 'scheduled_date' THEN NULLIF(p_patch ->> 'scheduled_date', '')::date ELSE scheduled_date END,
         notes          = CASE WHEN p_patch ? 'notes'          THEN NULLIF(p_patch ->> 'notes', '')                 ELSE notes          END,
         tank_size_gal  = CASE WHEN p_patch ? 'tank_size_gal'  THEN NULLIF(p_patch ->> 'tank_size_gal', '')::numeric ELSE tank_size_gal END
   WHERE id = p_run_id;

  -- the scheduled date rides down to the flavours that have not started, so the
  -- board and the work-order list agree with the order
  IF p_patch ? 'scheduled_date' THEN
    UPDATE ops.work_orders
       SET scheduled_date = NULLIF(p_patch ->> 'scheduled_date', '')::date, updated_at = now()
     WHERE run_id = p_run_id AND status IN ('draft', 'ordered', 'at_copacker');
  END IF;

  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('run', p_run_id, 'edit', 'Edited', p_patch, auth.uid());

  RETURN jsonb_build_object('done', jsonb_build_array(jsonb_build_object('id', p_run_id, 'number', v_run.run_number)), 'skipped', '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION ops.fn_run_update(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_update(uuid, jsonb) TO authenticated, service_role;

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'ops' AND p.proname = 'fn_run_update') = 1, 'fn_run_update: exactly one overload expected';
  ASSERT (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'ops' AND p.proname = 'fn_wo_rescale') LIKE '%v_run_status IS DISTINCT FROM ''draft''%', 'fn_wo_rescale: the draft-run relaxation did not land';
  ASSERT NOT has_function_privilege('anon', 'ops.fn_run_update(uuid, jsonb)', 'EXECUTE'), 'anon must not execute fn_run_update';
END $$;
