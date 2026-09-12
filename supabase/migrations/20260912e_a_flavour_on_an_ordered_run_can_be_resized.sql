-- 20260912e · a flavour on a production order can be resized AFTER the POs are issued
--
-- Sky (2026-09-12): "for changing the work order from 1500 to 1000 you can do
-- that on each SKU that you are making? is it clear?" — and it was not quite
-- true. 20260911e let a flavour be resized only while the ORDER was a draft,
-- because once POs exist one vendor line covers several flavours and scaling
-- the LINE by one flavour's factor (what the single-work-order path does) would
-- resize every other flavour's share with it.
--
-- The data to do it properly already exists: ops.purchase_order_line_demand
-- (20260903f) maps each merged PO line back to the work_order_materials rows it
-- covers, one row per flavour per line, with that flavour's demand on it. So a
-- resize of one flavour on an ordered run is:
--   1. scale THAT flavour's materials / recipe lines / open reservations, as
--      before (they are per-flavour rows);
--   2. scale THAT flavour's line_demand rows by the same factor;
--   3. for every PO line those rows touch, re-derive the line from its demand:
--        demand_total = Σ demand over every flavour on the line
--        qty_ordered  = fn_order_qty(demand_total − stock reserved against the
--                       line, MOQ, multiple)   — the 20260903f rule, re-applied
--                       to the aggregate, so the MOQ is lifted ONCE on the total
--      (a per_run line — a flat fee — is left alone);
--   4. a line the co-packer already supplied in full at start_production
--      (qty_received ≥ old qty_ordered) is re-booked to the NEW qty_ordered, and
--      the ledger follows by a NEW delta movement on the line — receipt up,
--      receipt_reversal down — never an UPDATE;
--   5. this flavour's own consumption follows by delta movements exactly as the
--      single-work-order path does;
--   6. every touched PO's subtotal is re-summed;
--   7. if the order carries landed costs (20260912c) every flavour's share is
--      re-derived, because the shares are by planned cases and one just moved.
--
-- Still refused, by name: a resize once THIS flavour's yield is recorded (the
-- plan is history); the same quantity; zero; and — on a run — while ANY of the
-- run's POs is already in QuickBooks (edit that PO and push it, or pull it
-- back; the SyncToken conflict is handled on that path, not here).
--
-- The single-work-order path is byte-for-byte the 20260911d behaviour; only the
-- run branch is new. fn_wo_rescale carries its guard inline (fn_assert_internal),
-- so CREATE OR REPLACE of the whole body is the right move — not a 20260820b
-- wrapper.

CREATE OR REPLACE FUNCTION ops.fn_wo_rescale(p_wo_id uuid, p_qty_to_produce numeric, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE
  v_wo      ops.work_orders%ROWTYPE;
  v_bom     ops.product_bom%ROWTYPE;
  v_old     numeric;
  v_factor  numeric;
  v_pushed  text;
  v_mov     record;
  v_line    record;
  v_delta   numeric;
  v_n_mat   int := 0;
  v_n_rec   int := 0;
  v_n_pol   int := 0;
  v_n_res   int := 0;
  v_n_mov   int := 0;
  v_n_dem   int := 0;
  v_pos     jsonb := '[]';
  v_uid     uuid := auth.uid();
  v_run     ops.production_runs%ROWTYPE;
  v_on_run  boolean := false;
  v_moq     numeric; v_mult numeric; v_reserved numeric; v_new_qty numeric; v_new_demand numeric;
  v_recost  jsonb := NULL;
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
  IF v_wo.actual_yield_qty IS NOT NULL OR v_wo.yield_recorded_at IS NOT NULL THEN
    RAISE EXCEPTION '% already has a recorded yield; the plan is history now', v_wo.batch_code;
  END IF;

  IF v_wo.run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM ops.production_runs WHERE id = v_wo.run_id FOR UPDATE;
    -- the run branch applies only where the flavour's materials sit on SHARED vendor lines (purchase_order_line_demand).
    -- A draft run has no PO lines yet, and a flavour GROUPED into an order (20260912b) still carries its own per-work-order
    -- POs — both take the single-work-order path below.
    v_on_run := (v_run.status IS DISTINCT FROM 'draft')
                AND EXISTS (SELECT 1 FROM ops.purchase_order_line_demand d WHERE d.wo_id = p_wo_id);
    SELECT string_agg(po_number, ', ' ORDER BY po_number) INTO v_pushed
      FROM ops.purchase_orders
     WHERE production_run_id = v_wo.run_id AND voided_at IS NULL AND qbo_purchase_order_id IS NOT NULL;
  ELSE
    SELECT string_agg(po_number, ', ' ORDER BY po_number) INTO v_pushed
      FROM ops.purchase_orders
     WHERE work_order_id = p_wo_id AND voided_at IS NULL AND qbo_purchase_order_id IS NOT NULL;
  END IF;
  IF v_pushed IS NOT NULL THEN
    RAISE EXCEPTION '% is already in QuickBooks — edit that PO and push it (or pull it back) before changing the run size', v_pushed;
  END IF;

  v_old := v_wo.qty_to_produce;
  IF p_qty_to_produce = v_old THEN
    RAISE EXCEPTION '% is already planned at %', v_wo.batch_code, v_old;
  END IF;
  v_factor := p_qty_to_produce / v_old;

  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_wo.bom_id;

  -- 1 ── this flavour's own rows -------------------------------------------------------
  UPDATE ops.work_order_materials
     SET required_qty = round(required_qty * p_qty_to_produce / v_old, 6),
         demand_qty   = round(demand_qty   * p_qty_to_produce / v_old, 6),
         recipe_qty   = round(recipe_qty   * p_qty_to_produce / v_old, 6)
   WHERE wo_id = p_wo_id AND COALESCE(qty_basis, 'per_yield') <> 'per_run';
  GET DIAGNOSTICS v_n_mat = ROW_COUNT;

  UPDATE ops.work_order_recipe_lines
     SET recipe_qty = round(recipe_qty * p_qty_to_produce / v_old, 6),
         order_qty  = CASE
                        WHEN order_qty IS NULL THEN NULL
                        WHEN COALESCE(pack_size, 0) > 0 THEN ceil(recipe_qty * p_qty_to_produce / v_old / pack_size)
                        ELSE round(order_qty * p_qty_to_produce / v_old, 6)
                      END
   WHERE wo_id = p_wo_id;
  GET DIAGNOSTICS v_n_rec = ROW_COUNT;

  UPDATE ops.inventory_reservations r
     SET qty = round(r.qty * p_qty_to_produce / v_old, 6)
    FROM ops.work_order_materials m
   WHERE m.wo_id = p_wo_id AND r.wo_material_id = m.id
     AND COALESCE(m.qty_basis, 'per_yield') <> 'per_run'
     AND r.resolved_at IS NULL;
  GET DIAGNOSTICS v_n_res = ROW_COUNT;

  IF NOT v_on_run THEN
    -- 2a ── single work order (or a draft run): the PO lines are this flavour's alone ----------
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

    UPDATE ops.purchase_orders p
       SET subtotal   = (SELECT COALESCE(sum(l.qty_ordered * COALESCE(l.unit_cost, 0)), 0)
                           FROM ops.purchase_order_lines l WHERE l.po_id = p.id),
           updated_at = now()
     WHERE p.work_order_id = p_wo_id AND p.voided_at IS NULL;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('po_number', po_number, 'subtotal', subtotal) ORDER BY po_number), '[]')
      INTO v_pos
      FROM ops.purchase_orders WHERE work_order_id = p_wo_id AND voided_at IS NULL;

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
          INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
          VALUES ('production_consume', v_mov.qbo_item_id, v_delta, v_mov.from_location_id, NULL, v_mov.unit_cost, 'work_order', p_wo_id, v_mov.source_doc_line_id, now(), v_uid,
                  format('WO consume · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
        ELSE
          INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
          VALUES ('adjustment', v_mov.qbo_item_id, -v_delta, NULL, v_mov.from_location_id, v_mov.unit_cost, 'work_order', p_wo_id, v_mov.source_doc_line_id, now(), v_uid,
                  format('WO consume reversed · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
        END IF;
      ELSE
        IF v_delta > 0 THEN
          INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
          VALUES ('receipt', v_mov.qbo_item_id, v_delta, NULL, v_mov.to_location_id, v_mov.unit_cost, 'purchase_order', v_mov.source_doc_id, v_mov.source_doc_line_id, now(), v_uid,
                  format('Co-packer supplied · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
        ELSE
          INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
          VALUES ('receipt_reversal', v_mov.qbo_item_id, -v_delta, v_mov.to_location_id, NULL, v_mov.unit_cost, 'purchase_order', v_mov.source_doc_id, v_mov.source_doc_line_id, now(), v_uid,
                  format('Co-packer supplied reversed · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
        END IF;
      END IF;
      v_n_mov := v_n_mov + 1;
    END LOOP;

  ELSE
    -- 2b ── a flavour on an ORDERED run: re-derive each shared PO line from every flavour's demand ----
    UPDATE ops.purchase_order_line_demand d
       SET demand_qty = round(d.demand_qty * p_qty_to_produce / v_old, 6)
      FROM ops.work_order_materials m
     WHERE d.wo_id = p_wo_id AND d.wo_material_id = m.id
       AND COALESCE(m.qty_basis, 'per_yield') <> 'per_run';
    GET DIAGNOSTICS v_n_dem = ROW_COUNT;

    FOR v_line IN
      SELECT pl.*, po.voided_at, po.production_run_id
        FROM ops.purchase_order_lines pl
        JOIN ops.purchase_orders po ON po.id = pl.po_id
       WHERE pl.id IN (SELECT d.po_line_id FROM ops.purchase_order_line_demand d JOIN ops.work_order_materials m ON m.id = d.wo_material_id
                        WHERE d.wo_id = p_wo_id AND COALESCE(m.qty_basis, 'per_yield') <> 'per_run')
         AND po.voided_at IS NULL
       FOR UPDATE OF pl
    LOOP
      SELECT COALESCE(sum(d.demand_qty), 0) INTO v_new_demand FROM ops.purchase_order_line_demand d WHERE d.po_line_id = v_line.id;
      -- stock at the co-packer claimed against this line's flavours instead of ordered (20260903f netting)
      SELECT COALESCE(sum(r.qty), 0) INTO v_reserved
        FROM ops.inventory_reservations r
       WHERE r.wo_material_id IN (SELECT d.wo_material_id FROM ops.purchase_order_line_demand d WHERE d.po_line_id = v_line.id)
         AND r.status IN ('active', 'consumed');
      SELECT pi.min_order_qty, pi.order_multiple INTO v_moq, v_mult
        FROM ops.production_items pi WHERE pi.qbo_item_id = v_line.qbo_item_id LIMIT 1;
      v_new_qty := ops.fn_order_qty(GREATEST(v_new_demand - v_reserved, 0), v_moq, v_mult);
      IF v_new_qty IS NULL OR v_new_qty <= 0 THEN v_new_qty := v_line.qty_ordered; END IF;   -- never zero a line somebody may have received against

      IF v_new_qty <> v_line.qty_ordered OR v_new_demand <> COALESCE(v_line.demand_total, -1) THEN
        UPDATE ops.purchase_order_lines
           SET qty_ordered  = v_new_qty,
               demand_total = v_new_demand,
               qty_received = CASE WHEN qty_received > 0 AND qty_received >= qty_ordered THEN v_new_qty ELSE qty_received END
         WHERE id = v_line.id;
        v_n_pol := v_n_pol + 1;

        -- a line the co-packer already supplied in full: the ledger follows by a NEW movement on the LINE
        IF v_line.qty_received > 0 AND v_line.qty_received >= v_line.qty_ordered THEN
          v_delta := round(v_new_qty - v_line.qty_ordered, 6);
          SELECT mv.* INTO v_mov FROM ops.inventory_movements mv
           WHERE mv.source_doc_type = 'purchase_order' AND mv.movement_type = 'receipt' AND mv.source_doc_line_id = v_line.id
           ORDER BY mv.occurred_at LIMIT 1;
          IF FOUND AND v_delta <> 0 THEN
            IF v_delta > 0 THEN
              INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
              VALUES ('receipt', v_mov.qbo_item_id, v_delta, NULL, v_mov.to_location_id, v_mov.unit_cost, 'purchase_order', v_mov.source_doc_id, v_line.id, now(), v_uid,
                      format('Co-packer supplied · %s rescaled %s → %s on %s', v_wo.batch_code, v_old, p_qty_to_produce, v_run.run_number));
            ELSE
              INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
              VALUES ('receipt_reversal', v_mov.qbo_item_id, -v_delta, v_mov.to_location_id, NULL, v_mov.unit_cost, 'purchase_order', v_mov.source_doc_id, v_line.id, now(), v_uid,
                      format('Co-packer supplied reversed · %s rescaled %s → %s on %s', v_wo.batch_code, v_old, p_qty_to_produce, v_run.run_number));
            END IF;
            v_n_mov := v_n_mov + 1;
          END IF;
        END IF;
      END IF;
    END LOOP;

    -- this flavour's own consumption follows, per material line, as on the single path
    FOR v_mov IN
      SELECT mv.* FROM ops.inventory_movements mv
       WHERE mv.source_doc_type = 'work_order' AND mv.source_doc_id = p_wo_id AND mv.movement_type = 'production_consume'
         AND mv.source_doc_line_id IN (SELECT id FROM ops.work_order_materials WHERE wo_id = p_wo_id AND COALESCE(qty_basis,'per_yield') <> 'per_run')
    LOOP
      v_delta := round(v_mov.qty * (p_qty_to_produce - v_old) / v_old, 6);
      IF v_delta = 0 THEN CONTINUE; END IF;
      IF v_delta > 0 THEN
        INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
        VALUES ('production_consume', v_mov.qbo_item_id, v_delta, v_mov.from_location_id, NULL, v_mov.unit_cost, 'work_order', p_wo_id, v_mov.source_doc_line_id, now(), v_uid,
                format('WO consume · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
      ELSE
        INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost, source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
        VALUES ('adjustment', v_mov.qbo_item_id, -v_delta, NULL, v_mov.from_location_id, v_mov.unit_cost, 'work_order', p_wo_id, v_mov.source_doc_line_id, now(), v_uid,
                format('WO consume reversed · %s rescaled %s → %s', v_wo.batch_code, v_old, p_qty_to_produce));
      END IF;
      v_n_mov := v_n_mov + 1;
    END LOOP;

    UPDATE ops.purchase_orders p
       SET subtotal   = (SELECT COALESCE(sum(l.qty_ordered * COALESCE(l.unit_cost, 0)), 0) FROM ops.purchase_order_lines l WHERE l.po_id = p.id),
           updated_at = now()
     WHERE p.production_run_id = v_wo.run_id AND p.voided_at IS NULL;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('po_number', po_number, 'subtotal', subtotal) ORDER BY po_number), '[]')
      INTO v_pos
      FROM ops.purchase_orders WHERE production_run_id = v_wo.run_id AND voided_at IS NULL;
  END IF;

  -- 3 ── the work order itself -------------------------------------------------------------
  UPDATE ops.work_orders
     SET qty_to_produce = p_qty_to_produce,
         expected_units = CASE WHEN expected_units IS NULL OR expected_units = v_old THEN p_qty_to_produce
                               ELSE round(expected_units * p_qty_to_produce / v_old, 6) END,
         batch_size_gal = CASE WHEN v_bom.finished_vol_per_yield_gal IS NOT NULL
                               THEN p_qty_to_produce * v_bom.finished_vol_per_yield_gal
                               ELSE round(batch_size_gal * p_qty_to_produce / v_old, 6) END,
         updated_at     = now()
   WHERE id = p_wo_id;

  -- 4 ── landed-cost shares are by planned cases, and one just moved (20260912c)
  IF v_wo.run_id IS NOT NULL AND (COALESCE(v_run.freight_cost,0) + COALESCE(v_run.copack_fee,0) + COALESCE(v_run.other_landed_cost,0)) > 0 THEN
    v_recost := ops.fn_run_recost_landed__i(v_wo.run_id);
  END IF;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'edit', v_wo.status, v_wo.status,
          format('Plan quantity %s → %s%s', v_old, p_qty_to_produce,
                 CASE WHEN NULLIF(p_reason,'') IS NOT NULL THEN ' — ' || p_reason ELSE '' END),
          jsonb_build_object('field', 'qty_to_produce', 'from', v_old, 'to', p_qty_to_produce, 'factor', v_factor,
                             'reason', p_reason, 'materials', v_n_mat, 'recipe_lines', v_n_rec, 'reservations', v_n_res,
                             'po_lines', v_n_pol, 'line_demand', v_n_dem, 'movements', v_n_mov, 'purchase_orders', v_pos,
                             'on_ordered_run', v_on_run, 'landed_recost', v_recost IS NOT NULL),
          v_uid);

  RETURN jsonb_build_object('wo_id', p_wo_id, 'batch_code', v_wo.batch_code, 'from', v_old, 'to', p_qty_to_produce,
                            'factor', v_factor, 'materials', v_n_mat, 'recipe_lines', v_n_rec, 'reservations', v_n_res,
                            'po_lines', v_n_pol, 'line_demand', v_n_dem, 'movements', v_n_mov, 'purchase_orders', v_pos,
                            'on_ordered_run', v_on_run, 'landed_recost', v_recost IS NOT NULL);
END $function$;
