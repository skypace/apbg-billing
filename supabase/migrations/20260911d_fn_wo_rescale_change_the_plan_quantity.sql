-- 20260911d — a work order's PLAN QUANTITY can be changed after the fact.
--
-- Ask (Sky, 2026-09-11): "I accidentally listed the June diet cola run as
-- 1,500gal instead of 2,000gal and I can't update it. Is it better to delete
-- that entry and start over? It'd be nice to edit."
--
-- Deleting and re-raising loses the number, the POs, the events and whatever
-- the co-packer already received against it. So: ops.fn_wo_rescale changes
-- qty_to_produce on a work order and carries the change through everything
-- that was DERIVED from it — the materials, the recipe detail, the linked PO
-- lines and their PO subtotals, the open reservations, and the inventory
-- movements already posted — as one transaction with one event.
--
-- Rules, and why each one is there:
--   • Allowed while the run is draft / ordered / at_copacker / in_production.
--     Once a yield is recorded the plan is history and the ACTUAL is what the
--     ledger holds; changing the plan then would only make yield_pct lie.
--   • REFUSED when a PO on it is already in QuickBooks. A PO that QuickBooks
--     holds is edited through the PO's own edit → push path (fn_po_update),
--     where the SyncToken conflict is handled; silently changing our copy
--     underneath it is how the two systems drift.
--   • REFUSED on a work order that belongs to a production run — the run owns
--     its lines' quantities (fn_run_add_line / fn_run_remove_line).
--   • per_run materials (a flat compounding fee) do NOT scale — one per run
--     whatever the run size, which is exactly what qty_basis exists to say.
--   • The LEDGER IS NEVER EDITED. A movement already posted stays; the change
--     is a NEW movement for the difference, dated now, pointing at the same
--     source line — the reconcile rule this repo has held since 2026-09-02.
--     Growing a consume is another production_consume; shrinking one is an
--     `adjustment` INTO the location it left (there is no consume-reversal
--     type and inventing one is a CHECK-constraint change on a table the
--     whole estate reads); growing a receipt is another receipt; shrinking
--     one is a receipt_reversal, the type fn_adjust_receipt already uses.
--     On-hand is signed purely by from/to location (v_inventory_on_hand), so
--     the direction is what carries the sign.
--   • Every scaled figure is old × new ÷ old, rounded to 6 dp — multiply FIRST.
--     old × (new ÷ old) turns 249.75 gal into 333.374999999… and that noise
--     then rides into every PO line and subtotal.
--   • qty_received on a PO line scales ONLY where the line was fully
--     "received" — the co-packer-supplied lines that start_production books
--     in one stroke. A line a human has partially received keeps its real
--     count; the ordered quantity moves and the line simply reads as more
--     (or less) still to come.
--
-- Guard: fn_assert_internal() INLINE — a new function, not generator-wrapped
-- (the 20260820b rule). A production user rescales their own run; a
-- distributor login does not.

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
  IF v_wo.run_id IS NOT NULL THEN
    RAISE EXCEPTION '% belongs to a production run — change the flavour line on the run instead', v_wo.batch_code;
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

REVOKE ALL ON FUNCTION ops.fn_wo_rescale(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_wo_rescale(uuid, numeric, text) TO authenticated, service_role;

-- The single-order edit that fn_update_work_orders already provides (notes,
-- scheduled_date) gains a guard against the typo that produced
-- WO-2026-00026's scheduled_date of 0006-09-15: a date more than a year in
-- either direction is refused by name rather than stored.
CREATE OR REPLACE FUNCTION ops.fn_update_work_orders(p_ids uuid[], p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp
AS $$
DECLARE v_id uuid; v_num text; v_status text; v_keys text[]; v_done jsonb := '[]'; v_skip jsonb := '[]'; v_date date;
BEGIN
  PERFORM ops.fn_assert_internal();
  v_keys := ARRAY(SELECT jsonb_object_keys(coalesce(p_patch, '{}')));
  IF cardinality(v_keys) = 0 THEN RAISE EXCEPTION 'nothing to change'; END IF;
  IF NOT (v_keys <@ ARRAY['scheduled_date', 'notes']) THEN
    RAISE EXCEPTION 'only scheduled_date and notes can be edited here (got %)', array_to_string(v_keys, ', ');
  END IF;
  IF p_patch ? 'scheduled_date' AND NULLIF(p_patch ->> 'scheduled_date', '') IS NOT NULL THEN
    v_date := (p_patch ->> 'scheduled_date')::date;
    IF v_date < current_date - interval '1 year' OR v_date > current_date + interval '1 year' THEN
      RAISE EXCEPTION 'scheduled date % is more than a year from today — check the year', v_date;
    END IF;
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT batch_code, status INTO v_num, v_status FROM ops.work_orders WHERE id = v_id;
    BEGIN
      IF v_num IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
      IF v_status IN ('void', 'closed', 'consumed') THEN RAISE EXCEPTION 'is %; reopen it first', v_status; END IF;
      UPDATE ops.work_orders
         SET scheduled_date = CASE WHEN p_patch ? 'scheduled_date' THEN NULLIF(p_patch ->> 'scheduled_date', '')::date ELSE scheduled_date END,
             notes          = CASE WHEN p_patch ? 'notes'          THEN NULLIF(p_patch ->> 'notes', '')                 ELSE notes          END,
             updated_at     = now()
       WHERE id = v_id;
      INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
      VALUES (v_id, 'edit', v_status, v_status,
              CASE WHEN cardinality(p_ids) > 1 THEN 'Edited in bulk' ELSE 'Edited' END, p_patch, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'ops' AND p.proname = 'fn_wo_rescale') = 1, 'fn_wo_rescale: exactly one overload expected';
  ASSERT NOT has_function_privilege('anon', 'ops.fn_wo_rescale(uuid, numeric, text)', 'EXECUTE'), 'anon must not execute fn_wo_rescale';
  ASSERT has_function_privilege('authenticated', 'ops.fn_wo_rescale(uuid, numeric, text)', 'EXECUTE'), 'authenticated must execute fn_wo_rescale';
END $$;
