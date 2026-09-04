-- 20260903c — bulk receive, reopen after close, and receipt corrections
--
-- Ask (Sky): "When I receive something I should be able to edit it if I
-- closed it and reopen. that should be on all items", and receive "multiple
-- items in any table". Phase 3 of the production overhaul.
--
-- Rules:
--  * The ledger is append-only. A receipt corrected DOWN is a new movement of
--    a new type, `receipt_reversal` (qty stays > 0 by the table CHECK; the
--    direction carries the sign), never an edit of the original row — "why
--    did 12 cases leave the warehouse on the 4th" must stay answerable.
--  * A correction is refused when the goods have already moved on (on-hand at
--    the destination is below the amount being reversed): the stock is
--    somewhere else now, and the fix belongs where it is.
--  * Reopen is a status change with a reason, stamped reopened_at/by/reason on
--    the document; the QuickBooks PurchaseOrder is NOT touched (the dialog says
--    so). A reopened PO's status is recomputed from its lines, never guessed.
--  * A received transfer reopens by reversing every line back to TRANSIT —
--    refused when its work order has already taken the stock (received/closed),
--    because the run's receipt is the record and the correction belongs there.
--  * New functions carry the guard inline (fn_assert_internal, 20260820b).

BEGIN;

-- ── 1. A movement type for receipt corrections ───────────────────────────────
ALTER TABLE ops.inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;
ALTER TABLE ops.inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type = ANY (ARRAY['transfer_ship','transfer_receive','receipt','shipment','adjustment',
                                    'production_consume','production_yield','receipt_reversal']));

-- ── 2. Reopen stamps on every document ───────────────────────────────────────
ALTER TABLE ops.purchase_orders     ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS reopened_by UUID, ADD COLUMN IF NOT EXISTS reopen_reason TEXT;
ALTER TABLE ops.work_orders         ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS reopened_by UUID, ADD COLUMN IF NOT EXISTS reopen_reason TEXT;
ALTER TABLE ops.inventory_transfers ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS reopened_by UUID, ADD COLUMN IF NOT EXISTS reopen_reason TEXT;

-- Views: columns appended (CREATE OR REPLACE can only add at the end).
CREATE OR REPLACE VIEW ops.v_work_orders WITH (security_invoker = on) AS
 SELECT w.id, w.batch_code, w.bom_id, w.finished_qbo_item_id, w.qty_to_produce, w.qty_produced_actual,
    w.production_location_id, w.status, w.scheduled_date, w.consumed_at, w.consumed_by, w.closed_at, w.closed_by,
    w.voided_at, w.voided_by, w.void_reason, w.notes, w.created_by, w.created_at, w.updated_at,
    w.qbo_inventory_adjustment_id, w.qbo_pushed_at, w.qbo_push_error, w.target_uom, w.actual_yield_qty,
    w.actual_yield_uom, w.formula_id, w.copacker_qbo_vendor_id, w.copacker_location_id, w.destination_location_id,
    w.batch_size_gal, w.expected_units, w.yield_pct, w.ordered_at, w.materials_at_copacker_at,
    w.production_started_at, w.yield_recorded_at, w.shipped_at, w.received_at, w.ship_carrier, w.ship_tracking,
    w.ship_bol_number, w.transfer_id,
    b.name AS bom_name, b.version AS bom_version, b.yield_uom AS bom_yield_uom,
    b.cans_per_case AS bom_cans_per_case, b.oz_per_can AS bom_oz_per_can,
    f.name AS formula_name, f.doc_rev AS formula_doc_rev,
    it.name AS finished_item_name,
    cv.display_name AS copacker_vendor_name,
    (cl.code || ' · '::text) || cl.name AS copacker_location_label,
    (dl.code || ' · '::text) || dl.name AS destination_location_label,
    t.bol_number AS transfer_bol_number, t.status AS transfer_status,
    c.total_cost, c.unit_cost, c.components_cost, c.services_cost,
    po.po_count, po.po_open_count,
    ops.fn_status_bucket('work_order', w.status) AS bucket,
    w.reopened_at, w.reopen_reason
   FROM ops.work_orders w
     LEFT JOIN ops.product_bom b ON b.id = w.bom_id
     LEFT JOIN ops.product_formulas f ON f.id = w.formula_id
     LEFT JOIN ops.qbo_items it ON it.qbo_item_id = w.finished_qbo_item_id
     LEFT JOIN ops.qbo_vendors cv ON cv.qbo_vendor_id = w.copacker_qbo_vendor_id
     LEFT JOIN ops.inventory_locations cl ON cl.id = w.copacker_location_id
     LEFT JOIN ops.inventory_locations dl ON dl.id = w.destination_location_id
     LEFT JOIN ops.inventory_transfers t ON t.id = w.transfer_id
     LEFT JOIN ops.work_order_costs c ON c.wo_id = w.id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS po_count,
            count(*) FILTER (WHERE p.status = ANY (ARRAY['open'::text, 'partial'::text]))::integer AS po_open_count
           FROM ops.purchase_orders p
          WHERE p.work_order_id = w.id) po ON true;

CREATE OR REPLACE VIEW ops.v_purchase_orders WITH (security_invoker = on) AS
 SELECT o.id, o.po_number, o.qbo_vendor_id, v.display_name AS vendor_name, o.destination_location_id,
    (loc.code || ' · '::text) || loc.name AS location_label,
    o.status, o.expected_date, o.subtotal, o.notes, o.qbo_purchase_order_id, o.qbo_pushed_at, o.qbo_push_error,
    o.ordered_at, o.received_at, o.closed_at, o.voided_at, o.void_reason, o.work_order_id,
    wo.batch_code AS work_order_batch_code,
    COALESCE(l.line_count, 0) AS line_count,
    COALESCE(l.qty_ordered_total, 0::numeric) AS qty_ordered_total,
    COALESCE(l.qty_received_total, 0::numeric) AS qty_received_total,
    o.created_at, o.updated_at,
    ops.fn_status_bucket('purchase_order', o.status) AS bucket,
    o.po_kind,
    o.reopened_at, o.reopen_reason
   FROM ops.purchase_orders o
     LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = o.qbo_vendor_id
     LEFT JOIN ops.inventory_locations loc ON loc.id = o.destination_location_id
     LEFT JOIN ops.work_orders wo ON wo.id = o.work_order_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS line_count,
            sum(pl.qty_ordered) AS qty_ordered_total,
            sum(pl.qty_received) AS qty_received_total
           FROM ops.purchase_order_lines pl
          WHERE pl.po_id = o.id) l ON true;
GRANT SELECT ON ops.v_work_orders, ops.v_purchase_orders TO authenticated, service_role;

-- ── 3. PO header status is DERIVED from its lines ────────────────────────────
-- Internal helper (called from the SECURITY DEFINER functions below; not an RPC).
CREATE OR REPLACE FUNCTION ops.fn_po_recompute_status(p_po_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = ops, pg_temp AS $$
DECLARE v_status text; v_unrec int; v_anyrec boolean; v_new text;
BEGIN
  SELECT status INTO v_status FROM ops.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
  IF v_status IN ('draft', 'void') THEN RETURN v_status; END IF;
  SELECT count(*) FILTER (WHERE qty_received < qty_ordered), bool_or(qty_received > 0)
    INTO v_unrec, v_anyrec FROM ops.purchase_order_lines WHERE po_id = p_po_id;
  v_new := CASE WHEN v_unrec = 0 THEN (CASE WHEN v_status = 'closed' THEN 'closed' ELSE 'received' END)
                WHEN coalesce(v_anyrec, false) THEN 'partial'
                ELSE 'open' END;
  IF v_new <> v_status THEN
    UPDATE ops.purchase_orders
       SET status = v_new,
           received_at = CASE WHEN v_new = 'received' THEN coalesce(received_at, now()) ELSE received_at END,
           updated_at = now()
     WHERE id = p_po_id;
  END IF;
  RETURN v_new;
END $$;
REVOKE ALL ON FUNCTION ops.fn_po_recompute_status(uuid) FROM PUBLIC, anon, authenticated;

-- ── 4. Bulk receive: many lines, one call, per-line sub-transactions ─────────
CREATE OR REPLACE FUNCTION ops.fn_receive_po_lines(p_lines jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v jsonb; v_id uuid; v_num text; v_qty numeric; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'p_lines must be an array of {po_line_id, qty, unit_cost?, receipt_date?}'; END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_num := NULL;
    BEGIN
      v_id  := (v ->> 'po_line_id')::uuid;
      v_qty := (v ->> 'qty')::numeric;
      SELECT o.po_number || ' · ' || coalesce(nullif(l.description, ''), l.qbo_item_id) INTO v_num
        FROM ops.purchase_order_lines l JOIN ops.purchase_orders o ON o.id = l.po_id WHERE l.id = v_id;
      IF v_num IS NULL THEN RAISE EXCEPTION 'PO line not found'; END IF;
      PERFORM ops.fn_receive_purchase_order_line__i(v_id, v_qty,
        NULLIF(v ->> 'unit_cost', '')::numeric, NULLIF(v ->> 'receipt_date', '')::timestamptz);
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num, 'qty', v_qty);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, payload, created_by)
  SELECT DISTINCT 'purchase_order', l.po_id, 'receive', jsonb_build_object('lines', v_done), auth.uid()
    FROM ops.purchase_order_lines l
   WHERE l.id IN (SELECT (d ->> 'id')::uuid FROM jsonb_array_elements(v_done) d);
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

-- ── 5. Correct a receipt (up or down), even on a closed PO ───────────────────
CREATE OR REPLACE FUNCTION ops.fn_adjust_receipt(p_po_line_id uuid, p_new_qty_received numeric, p_reason text, p_occurred_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_line RECORD; v_delta numeric; v_onhand numeric; v_actor uuid := auth.uid(); v_new_status text;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  IF p_new_qty_received IS NULL OR p_new_qty_received < 0 THEN RAISE EXCEPTION 'received quantity must be 0 or more'; END IF;
  SELECT l.id, l.po_id, l.qbo_item_id, l.qty_ordered, l.qty_received, l.unit_cost,
         o.status AS po_status, o.destination_location_id, o.po_number
    INTO v_line
    FROM ops.purchase_order_lines l JOIN ops.purchase_orders o ON o.id = l.po_id
   WHERE l.id = p_po_line_id FOR UPDATE OF l;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'PO line not found'; END IF;
  IF v_line.po_status IN ('draft', 'void') THEN RAISE EXCEPTION 'PO % is %; nothing has been received on it', v_line.po_number, v_line.po_status; END IF;
  IF p_new_qty_received > v_line.qty_ordered THEN RAISE EXCEPTION 'cannot receive more than the % ordered', v_line.qty_ordered; END IF;
  v_delta := p_new_qty_received - v_line.qty_received;
  IF v_delta = 0 THEN RAISE EXCEPTION 'no change — % is already the received quantity', p_new_qty_received; END IF;

  IF v_delta > 0 THEN
    INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
                                         source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
    VALUES ('receipt', v_line.qbo_item_id, v_delta, NULL, v_line.destination_location_id, v_line.unit_cost,
            'purchase_order', v_line.po_id, p_po_line_id, coalesce(p_occurred_at, now()), v_actor,
            'PO receipt corrected up · ' || v_line.po_number || ' · ' || p_reason);
  ELSE
    SELECT coalesce(sum(on_hand), 0) INTO v_onhand FROM ops.v_inventory_on_hand
     WHERE qbo_item_id = v_line.qbo_item_id AND location_id = v_line.destination_location_id;
    IF v_onhand < -v_delta THEN
      RAISE EXCEPTION 'only % on hand at the destination, % would be reversed — the goods have moved on; correct the stock where it is now', v_onhand, -v_delta;
    END IF;
    INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
                                         source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
    VALUES ('receipt_reversal', v_line.qbo_item_id, -v_delta, v_line.destination_location_id, NULL, v_line.unit_cost,
            'purchase_order', v_line.po_id, p_po_line_id, coalesce(p_occurred_at, now()), v_actor,
            'PO receipt corrected down · ' || v_line.po_number || ' · ' || p_reason);
  END IF;

  UPDATE ops.purchase_order_lines SET qty_received = p_new_qty_received WHERE id = p_po_line_id;
  v_new_status := ops.fn_po_recompute_status(v_line.po_id);
  IF v_line.po_status = 'closed' AND v_new_status <> 'closed' THEN
    UPDATE ops.purchase_orders
       SET reopened_at = now(), reopened_by = v_actor, reopen_reason = 'Receipt corrected: ' || p_reason,
           closed_at = NULL, closed_by = NULL
     WHERE id = v_line.po_id;
  END IF;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('purchase_order', v_line.po_id, 'receipt_adjusted', p_reason,
          jsonb_build_object('po_line_id', p_po_line_id, 'item', v_line.qbo_item_id, 'from', v_line.qty_received,
                             'to', p_new_qty_received, 'delta', v_delta, 'status_after', v_new_status), v_actor);
  RETURN jsonb_build_object('po_id', v_line.po_id, 'from', v_line.qty_received, 'to', p_new_qty_received,
                            'delta', v_delta, 'status', v_new_status);
END $$;

-- ── 6. Reopen ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_reopen_purchase_order(p_po_id uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_status text; v_num text; v_actor uuid := auth.uid(); v_new text;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT status, po_number INTO v_status, v_num FROM ops.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
  IF v_status <> 'closed' THEN RAISE EXCEPTION 'PO % is %; only a closed PO can be reopened', v_num, v_status; END IF;
  UPDATE ops.purchase_orders
     SET status = 'received', closed_at = NULL, closed_by = NULL,
         reopened_at = now(), reopened_by = v_actor, reopen_reason = p_reason, updated_at = now()
   WHERE id = p_po_id;
  v_new := ops.fn_po_recompute_status(p_po_id);
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('purchase_order', p_po_id, 'reopen', p_reason, jsonb_build_object('from', 'closed', 'to', v_new), v_actor);
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION ops.fn_reopen_work_order(p_wo_id uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_status text; v_num text; v_actor uuid := auth.uid();
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT status, batch_code INTO v_status, v_num FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_status <> 'closed' THEN RAISE EXCEPTION 'work order % is %; only a closed run can be reopened', v_num, v_status; END IF;
  UPDATE ops.work_orders
     SET status = 'received', closed_at = NULL, closed_by = NULL,
         reopened_at = now(), reopened_by = v_actor, reopen_reason = p_reason, updated_at = now()
   WHERE id = p_wo_id;
  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
  VALUES (p_wo_id, 'reopen', 'closed', 'received', p_reason, v_actor);
  RETURN 'received';
END $$;

CREATE OR REPLACE FUNCTION ops.fn_reopen_transfer(p_transfer_id uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_status text; v_to uuid; v_num text; v_transit uuid; v_actor uuid := auth.uid(); v_line RECORD; v_onhand numeric; v_wo text;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT status, to_location_id, bol_number INTO v_status, v_to, v_num FROM ops.inventory_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_status <> 'received' THEN RAISE EXCEPTION 'transfer % is %; only a received transfer can be reopened', v_num, v_status; END IF;
  SELECT batch_code INTO v_wo FROM ops.work_orders WHERE transfer_id = p_transfer_id AND status IN ('received', 'closed') LIMIT 1;
  IF v_wo IS NOT NULL THEN
    RAISE EXCEPTION 'this is work order %''s return shipment and that run has already received it — the run''s receipt is the record', v_wo;
  END IF;
  SELECT id INTO v_transit FROM ops.inventory_locations WHERE code = 'TRANSIT';
  IF v_transit IS NULL THEN RAISE EXCEPTION 'TRANSIT location missing'; END IF;
  FOR v_line IN SELECT * FROM ops.inventory_transfer_lines WHERE transfer_id = p_transfer_id LOOP
    SELECT coalesce(sum(on_hand), 0) INTO v_onhand FROM ops.v_inventory_on_hand WHERE qbo_item_id = v_line.qbo_item_id AND location_id = v_to;
    IF v_onhand < v_line.qty THEN
      RAISE EXCEPTION 'only % of % on hand at the destination for item % — the stock has moved on; this receipt cannot be reversed', v_onhand, v_line.qty, v_line.qbo_item_id;
    END IF;
  END LOOP;
  INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
                                       source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
  SELECT 'receipt_reversal', l.qbo_item_id, l.qty, v_to, v_transit, l.unit_cost,
         'transfer', p_transfer_id, l.id, now(), v_actor, 'Transfer receipt reversed · ' || v_num || ' · ' || p_reason
    FROM ops.inventory_transfer_lines l WHERE l.transfer_id = p_transfer_id;
  UPDATE ops.inventory_transfer_lines SET qty_received = 0 WHERE transfer_id = p_transfer_id;
  UPDATE ops.inventory_transfers
     SET status = 'in_transit', received_date = NULL, received_by = NULL,
         receiver_signature_name = NULL, receiver_signature_at = NULL,
         reopened_at = now(), reopened_by = v_actor, reopen_reason = p_reason, updated_at = now()
   WHERE id = p_transfer_id;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('transfer', p_transfer_id, 'reopen', p_reason, v_actor);
  RETURN 'in_transit';
END $$;

-- Bulk reopen / close, same {done, skipped} shape as 20260903b.
CREATE OR REPLACE FUNCTION ops.fn_reopen_docs(p_kind text, p_ids uuid[], p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_new text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  IF p_kind NOT IN ('work_order', 'purchase_order', 'transfer') THEN RAISE EXCEPTION 'unknown kind %', p_kind; END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    v_num := CASE p_kind
      WHEN 'work_order' THEN (SELECT batch_code FROM ops.work_orders WHERE id = v_id)
      WHEN 'purchase_order' THEN (SELECT po_number FROM ops.purchase_orders WHERE id = v_id)
      ELSE (SELECT bol_number FROM ops.inventory_transfers WHERE id = v_id) END;
    BEGIN
      v_new := CASE p_kind
        WHEN 'work_order' THEN ops.fn_reopen_work_order(v_id, p_reason)
        WHEN 'purchase_order' THEN ops.fn_reopen_purchase_order(v_id, p_reason)
        ELSE ops.fn_reopen_transfer(v_id, p_reason) END;
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num, 'status', v_new);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

CREATE OR REPLACE FUNCTION ops.fn_close_purchase_orders(p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT po_number INTO v_num FROM ops.purchase_orders WHERE id = v_id;
    BEGIN
      IF v_num IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
      PERFORM ops.fn_close_purchase_order__i(v_id);
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, created_by) VALUES ('purchase_order', v_id, 'close', auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

-- ── 7. Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION ops.fn_receive_po_lines(jsonb), ops.fn_adjust_receipt(uuid, numeric, text, timestamptz),
  ops.fn_reopen_purchase_order(uuid, text), ops.fn_reopen_work_order(uuid, text), ops.fn_reopen_transfer(uuid, text),
  ops.fn_reopen_docs(text, uuid[], text), ops.fn_close_purchase_orders(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_receive_po_lines(jsonb), ops.fn_adjust_receipt(uuid, numeric, text, timestamptz),
  ops.fn_reopen_purchase_order(uuid, text), ops.fn_reopen_work_order(uuid, text), ops.fn_reopen_transfer(uuid, text),
  ops.fn_reopen_docs(text, uuid[], text), ops.fn_close_purchase_orders(uuid[]) TO authenticated, service_role;

COMMIT;
