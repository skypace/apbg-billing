-- 20260912b · existing work orders can be grouped into a production order
--
-- Sky (2026-09-12), on the three live single-flavour work orders raised before
-- the one-door change: "im wondering if she should clear all the work orders
-- and create a new one thats representative of the actual orders … otherwise
-- give me the ability to tie multiple work orders to the same PO."
--
-- Deleting was the wrong tool: WO-2026-00022 has a recorded yield, lots and a
-- shipped BOL, and 00023 / 00024 have cans landed at Quantum in the ledger.
-- Voiding them means reversal movements and re-typing what Calli already
-- entered. So: ADOPT. ops.fn_run_adopt_work_orders(p_wo_ids, p_notes) creates
-- a production order, stamps run_id on the chosen work orders and
-- production_run_id on their purchase orders, and the order screen shows the
-- flavours, the POs and the run-level actions together. The POs are NOT
-- merged: they are the record of what was actually sent to the vendors, and
-- both of Quantum's already carry received lines. Going forward
-- fn_run_generate_pos raises one PO per vendor for every flavour, so this is a
-- one-time bridge, not the way orders are built.
--
-- Rules, each refused by name:
--   • at least one work order; every id must exist
--   • none may be void, and none may already belong to a production order
--   • all must share the co-packer location AND the destination — a production
--     order is one truck from one co-packer to one warehouse (fn_run_ship
--     builds one BOL from run.copacker_location_id → run.destination_location_id)
--   • the co-packer vendor is taken from the first work order that names one
--   • scheduled_date = the earliest flavour's date; tank size left blank
--
-- Mixed states are fine and were checked against the live run functions before
-- writing this: fn_run_ship ships only yield_recorded flavours and skips ones
-- already in_transit/received; fn_run_receive receives whichever transfers are
-- in transit; fn_run_advance skips flavours already past the step; the
-- tg_work_orders_run_status trigger recomputes the order's status the moment
-- run_id lands. Per-flavour ship/void on an adopted work order is refused (the
-- 20260903f _run_scope rule) — the run does those.
--
-- Guard INLINE (fn_assert_internal): a production user groups their own orders.

CREATE OR REPLACE FUNCTION ops.fn_run_adopt_work_orders(p_wo_ids uuid[], p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_run uuid; v_num text;
  v_bad text; v_n int; v_n2 int;
  v_cop uuid; v_dest uuid; v_vendor text; v_date date;
  v_wo record;
  v_codes text;
BEGIN
  PERFORM ops.fn_assert_internal();

  IF p_wo_ids IS NULL OR cardinality(p_wo_ids) = 0 THEN
    RAISE EXCEPTION 'pick at least one work order to group';
  END IF;

  SELECT count(*) INTO v_n FROM ops.work_orders WHERE id = ANY(p_wo_ids);
  IF v_n <> cardinality(ARRAY(SELECT DISTINCT unnest(p_wo_ids))) THEN
    RAISE EXCEPTION 'one or more work orders were not found';
  END IF;

  SELECT string_agg(batch_code, ', ' ORDER BY batch_code) INTO v_bad
    FROM ops.work_orders WHERE id = ANY(p_wo_ids) AND status = 'void';
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'cannot group a void work order: %', v_bad; END IF;

  SELECT string_agg(w.batch_code || ' (already on ' || r.run_number || ')', ', ' ORDER BY w.batch_code) INTO v_bad
    FROM ops.work_orders w JOIN ops.production_runs r ON r.id = w.run_id
   WHERE w.id = ANY(p_wo_ids);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'already part of a production order: %', v_bad; END IF;

  SELECT count(DISTINCT copacker_location_id), count(DISTINCT destination_location_id) INTO v_n, v_n2
    FROM ops.work_orders WHERE id = ANY(p_wo_ids);
  IF v_n > 1 THEN
    RAISE EXCEPTION 'these work orders are at different co-packers — a production order is one truck from one co-packer';
  END IF;
  IF v_n2 > 1 THEN
    RAISE EXCEPTION 'these work orders ship to different warehouses — a production order is one truck to one destination';
  END IF;

  SELECT copacker_location_id, destination_location_id INTO v_cop, v_dest
    FROM ops.work_orders WHERE id = ANY(p_wo_ids) LIMIT 1;
  IF v_cop IS NULL OR v_dest IS NULL THEN
    RAISE EXCEPTION 'a work order with no co-packer or no destination cannot be grouped';
  END IF;
  SELECT copacker_qbo_vendor_id INTO v_vendor
    FROM ops.work_orders WHERE id = ANY(p_wo_ids) AND copacker_qbo_vendor_id IS NOT NULL ORDER BY created_at LIMIT 1;
  SELECT min(scheduled_date) INTO v_date FROM ops.work_orders WHERE id = ANY(p_wo_ids);

  v_num := ops.fn_next_run_number__i();
  INSERT INTO ops.production_runs (run_number, copacker_qbo_vendor_id, copacker_location_id, destination_location_id,
                                   scheduled_date, tank_size_gal, notes, net_against_stock, created_by)
  VALUES (v_num, v_vendor, v_cop, v_dest, v_date, NULL,
          COALESCE(NULLIF(trim(p_notes), ''), 'Grouped from existing work orders'), TRUE, v_actor)
  RETURNING id INTO v_run;

  -- the trigger on work_orders (UPDATE OF run_id) recomputes the order's status
  UPDATE ops.work_orders SET run_id = v_run WHERE id = ANY(p_wo_ids);

  UPDATE ops.purchase_orders po
     SET production_run_id = v_run,
         notes = COALESCE(po.notes, '') || ' · grouped into production order ' || v_num
   WHERE po.work_order_id = ANY(p_wo_ids) AND po.production_run_id IS NULL;

  FOR v_wo IN SELECT id, batch_code, status FROM ops.work_orders WHERE id = ANY(p_wo_ids) LOOP
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (v_wo.id, 'grouped_into_run', v_wo.status, v_wo.status, 'Grouped into production order ' || v_num, v_actor);
  END LOOP;

  SELECT string_agg(batch_code, ', ' ORDER BY batch_code) INTO v_codes FROM ops.work_orders WHERE run_id = v_run;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('run', v_run, 'adopt', 'Grouped from existing work orders: ' || v_codes,
          jsonb_build_object('work_orders', to_jsonb(p_wo_ids), 'notes', p_notes), v_actor);

  RETURN jsonb_build_object(
    'run_id', v_run, 'run_number', v_num,
    'status', (SELECT status FROM ops.production_runs WHERE id = v_run),
    'work_orders', v_codes,
    'purchase_orders', (SELECT COALESCE(string_agg(po_number, ', ' ORDER BY po_number), '') FROM ops.purchase_orders WHERE production_run_id = v_run));
END $$;

COMMENT ON FUNCTION ops.fn_run_adopt_work_orders(uuid[], text) IS
  '20260912b: group existing single-flavour work orders into ONE production order (run_id on the WOs, production_run_id on their POs). POs are not merged. Refuses void WOs, WOs already on a run, and WOs at different co-packers or destinations. Internal-role guard inline.';

REVOKE ALL ON FUNCTION ops.fn_run_adopt_work_orders(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_adopt_work_orders(uuid[], text) TO authenticated, service_role;
