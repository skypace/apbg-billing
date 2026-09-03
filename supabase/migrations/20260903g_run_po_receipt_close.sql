-- 20260903g — a RUN's materials PO closes on full receipt too, and moves every
-- flavour on the run to "materials at co-packer".
--
-- 20260903d taught fn_receive_purchase_order_line__i to close a work order's
-- on_receipt PO the moment its last receivable line lands, and to flip THAT work
-- order ordered → at_copacker once its last such PO closed. A run PO
-- (20260903f) carries production_run_id and work_order_id NULL, so that block
-- never fired: the live proof left the Calderoni PO at `received` and both work
-- orders at `ordered` after a full receipt. This adds the run branch beside the
-- work-order one, as an anchored edit on the live __i body (20260820b rule —
-- the guard wrapper is untouched).
--
-- Rule: when the run's LAST on_receipt PO closes, every work order on the run
-- still at `ordered` moves to `at_copacker`, and the run status is recomputed.
BEGIN;

DO $do$
DECLARE v_src text; v_anchor text; v_add text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_receive_purchase_order_line__i';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_receive_purchase_order_line__i not found'; END IF;
  IF v_src LIKE '%20260903g%' THEN RAISE NOTICE 'already applied'; RETURN; END IF;

  v_anchor := E'    IF v_wo_id IS NOT NULL AND v_close_rule = ''on_receipt'' THEN\n';
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor found % times, expected 1', v_n; END IF;

  v_add := E'    -- 20260903g: the same rule for a RUN''s PO (production_run_id set, work_order_id NULL)\n'
        || E'    DECLARE v_run_id uuid; v_rwo record;\n'
        || E'    BEGIN\n'
        || E'      SELECT production_run_id INTO v_run_id FROM ops.purchase_orders WHERE id = v_po_id;\n'
        || E'      IF v_run_id IS NOT NULL AND v_close_rule = ''on_receipt'' THEN\n'
        || E'        UPDATE ops.purchase_orders\n'
        || E'           SET status = ''closed'', closed_at = now(), closed_by = v_actor, closed_reason = ''received''\n'
        || E'         WHERE id = v_po_id;\n'
        || E'        INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)\n'
        || E'        VALUES (''purchase_order'', v_po_id, ''close'', ''Fully received — closed automatically (run PO)'', v_actor);\n'
        || E'        IF NOT EXISTS (SELECT 1 FROM ops.purchase_orders\n'
        || E'                        WHERE production_run_id = v_run_id AND close_rule = ''on_receipt'' AND status NOT IN (''closed'', ''void'')) THEN\n'
        || E'          FOR v_rwo IN SELECT id, batch_code FROM ops.work_orders WHERE run_id = v_run_id AND status = ''ordered'' LOOP\n'
        || E'            UPDATE ops.work_orders SET status = ''at_copacker'', materials_at_copacker_at = now() WHERE id = v_rwo.id;\n'
        || E'            INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)\n'
        || E'            VALUES (v_rwo.id, ''materials_at_copacker'', ''ordered'', ''at_copacker'',\n'
        || E'                    ''Raw materials at co-packer — every materials PO on the run fully received'', v_actor);\n'
        || E'          END LOOP;\n'
        || E'          PERFORM ops.fn_run_recompute_status__i(v_run_id);\n'
        || E'        END IF;\n'
        || E'      END IF;\n'
        || E'    END;\n';
  v_src := replace(v_src, v_anchor, v_add || v_anchor);
  EXECUTE v_src;
END $do$;

-- the wrapper must still be the guard, and the inner must carry the marker
DO $chk$
DECLARE ok bool;
BEGIN
  SELECT pg_get_functiondef(p.oid) LIKE '%fn_assert_internal%' INTO ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_receive_purchase_order_line';
  IF NOT ok THEN RAISE EXCEPTION 'fn_receive_purchase_order_line wrapper lost its guard'; END IF;
  SELECT pg_get_functiondef(p.oid) LIKE '%20260903g%' INTO ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'fn_receive_purchase_order_line__i';
  IF NOT ok THEN RAISE EXCEPTION 'inner body did not take the 20260903g edit'; END IF;
END $chk$;

COMMIT;
