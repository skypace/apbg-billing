-- 20260903d — what is received, and when a purchase order closes
--
-- Ask (Sky): "certain things can't be received… tolling items and services
-- should just be a part of the order process. nothing needs to ship to
-- Quantum… no need to receive the services PO"; the Quantum PO closes "as a
-- part of the production run when you build the yield and what's getting
-- shipped back"; the Calderoni PO closes when Quantum receives the raw
-- materials. Phase 4 of the production overhaul.
--
-- Model:
--  * purchase_orders.close_rule — 'on_receipt' (the default: closes by itself
--    when every receivable line is fully received) or 'on_run_yield' (the
--    co-packer's own PO: closes when the run SHIPS, nothing is received
--    against it). fn_wo_generate_pos sets it: vendor = the run's co-packer →
--    on_run_yield, anyone else → on_receipt.
--  * purchase_order_lines.receivable — false on every line of an on_run_yield
--    PO and on every Service item anywhere. fn_receive_purchase_order_line
--    refuses a non-receivable line by name; completion counts receivable
--    lines only.
--  * A run PO that completes on receipt CLOSES (closed_reason 'received'), and
--    when the run's last on_receipt PO closes, the work order moves ordered →
--    at_copacker by itself — "the Calderoni PO closes when Quantum receives".
--  * At start_production, what the co-packer supplies to itself (the cans on
--    its own PO) LANDS at the co-packer location once, so consumption has
--    stock to draw on; Service items are never consumed as stock (a tolling
--    charge is not a thing in a warehouse — before this, start_production
--    posted a production_consume for it and Quantum's on-hand went negative).
--  * fn_void_purchase_order releases the work-order materials it covered
--    (the gap 20260903b closed for the bulk path only).
--  * fn_wo_advance__i is edited by ANCHORED replace() on its live definition,
--    each anchor asserted to appear exactly once — never by re-pasting the
--    body (the 20260902t trap: the file and the live function had drifted).

BEGIN;

-- ── 1. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE ops.purchase_orders
  ADD COLUMN IF NOT EXISTS close_rule TEXT NOT NULL DEFAULT 'on_receipt' CHECK (close_rule IN ('on_receipt', 'on_run_yield')),
  ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE ops.purchase_order_lines
  ADD COLUMN IF NOT EXISTS receivable BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill: the co-packer's POs on existing runs, and Service lines everywhere.
UPDATE ops.purchase_orders po SET close_rule = 'on_run_yield'
  FROM ops.work_orders w
 WHERE w.id = po.work_order_id AND po.qbo_vendor_id = w.copacker_qbo_vendor_id;
UPDATE ops.purchase_order_lines pl SET receivable = FALSE
  FROM ops.purchase_orders po
 WHERE po.id = pl.po_id AND po.close_rule = 'on_run_yield';
UPDATE ops.purchase_order_lines pl SET receivable = FALSE
  FROM ops.qbo_items i
 WHERE i.qbo_item_id = pl.qbo_item_id AND i.type = 'Service';

-- ── 2. View: close rule + receivable count (columns appended) ────────────────
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
    o.reopened_at, o.reopen_reason,
    o.close_rule, o.closed_reason,
    COALESCE(l.receivable_line_count, 0) AS receivable_line_count
   FROM ops.purchase_orders o
     LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = o.qbo_vendor_id
     LEFT JOIN ops.inventory_locations loc ON loc.id = o.destination_location_id
     LEFT JOIN ops.work_orders wo ON wo.id = o.work_order_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS line_count,
            count(*) FILTER (WHERE pl.receivable)::integer AS receivable_line_count,
            sum(pl.qty_ordered) AS qty_ordered_total,
            sum(pl.qty_received) AS qty_received_total
           FROM ops.purchase_order_lines pl
          WHERE pl.po_id = o.id) l ON true;
GRANT SELECT ON ops.v_purchase_orders TO authenticated, service_role;

-- ── 3. PO generation stamps the rule and the receivability ───────────────────
CREATE OR REPLACE FUNCTION ops.fn_wo_generate_pos__i(p_wo_id uuid, p_expected_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  v_status    TEXT;
  v_batch     TEXT;
  v_copacker  UUID;
  v_copacker_vendor TEXT;
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
  v_close_rule TEXT;
  v_item_type TEXT;
BEGIN
  SELECT status, batch_code, copacker_location_id, copacker_qbo_vendor_id
    INTO v_status, v_batch, v_copacker, v_copacker_vendor
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
    -- The co-packer's own PO closes with the run; everyone else's closes on receipt.
    v_close_rule := CASE WHEN v_vendor = v_copacker_vendor THEN 'on_run_yield' ELSE 'on_receipt' END;

    INSERT INTO ops.purchase_orders (
      po_number, qbo_vendor_id, destination_location_id, status, po_kind, close_rule,
      expected_date, notes, work_order_id, created_by, ordered_at, ordered_by
    ) VALUES (
      v_po_number, v_vendor, v_copacker, 'open', 'materials', v_close_rule,
      p_expected_date,
      'Materials for work order ' || v_batch ||
        CASE WHEN v_close_rule = 'on_run_yield' THEN ' · closes when the run ships (nothing is received against it)' ELSE '' END,
      p_wo_id, v_actor, now(), v_actor
    )
    RETURNING id INTO v_po_id;

    FOR v_mat IN
      SELECT * FROM ops.work_order_materials
        WHERE wo_id = p_wo_id AND po_id IS NULL AND qbo_vendor_id = v_vendor
        ORDER BY sort_order
    LOOP
      SELECT type INTO v_item_type FROM ops.qbo_items WHERE qbo_item_id = v_mat.component_qbo_item_id;
      INSERT INTO ops.purchase_order_lines (
        po_id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order, receivable
      ) VALUES (
        v_po_id, v_mat.component_qbo_item_id, v_mat.item_name,
        v_mat.required_qty, COALESCE(v_mat.unit_cost_est, 0),
        'WO ' || v_batch ||
          CASE WHEN v_mat.recipe_qty IS NOT NULL AND v_mat.pack_size IS NOT NULL
               THEN ' · needs ' || ROUND(v_mat.recipe_qty, 3) || ' ' ||
                    COALESCE(v_mat.recipe_uom, '') ELSE '' END,
        v_sort,
        (v_close_rule = 'on_receipt' AND COALESCE(v_item_type, '') <> 'Service')
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
      'qbo_vendor_id', v_vendor, 'subtotal', v_subtotal, 'close_rule', v_close_rule
    );
  END LOOP;

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

-- ── 4. Receiving: refuse a non-receivable line; a run PO closes on completion ─
CREATE OR REPLACE FUNCTION ops.fn_receive_purchase_order_line__i(p_po_line_id uuid, p_qty_received numeric, p_unit_cost numeric DEFAULT NULL, p_receipt_date timestamp with time zone DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  v_po_id        UUID;
  v_item_id      TEXT;
  v_already      NUMERIC;
  v_ordered      NUMERIC;
  v_loc_id       UUID;
  v_status       TEXT;
  v_unit_cost    NUMERIC;
  v_actor        UUID := auth.uid();
  v_po_number    TEXT;
  v_unreceived   INTEGER;
  v_receivable   BOOLEAN;
  v_wo_id        UUID;
  v_close_rule   TEXT;
  v_wo_status    TEXT;
  v_batch        TEXT;
BEGIN
  IF p_qty_received IS NULL OR p_qty_received <= 0 THEN
    RAISE EXCEPTION 'qty_received must be > 0';
  END IF;

  SELECT l.po_id, l.qbo_item_id, l.qty_received, l.qty_ordered, l.unit_cost, l.receivable,
         o.destination_location_id, o.status, o.po_number, o.work_order_id, o.close_rule
    INTO v_po_id, v_item_id, v_already, v_ordered, v_unit_cost, v_receivable,
         v_loc_id, v_status, v_po_number, v_wo_id, v_close_rule
    FROM ops.purchase_order_lines l
    JOIN ops.purchase_orders o ON o.id = l.po_id
    WHERE l.id = p_po_line_id
    FOR UPDATE OF l;

  IF v_po_id IS NULL THEN RAISE EXCEPTION 'PO line not found'; END IF;
  IF v_status NOT IN ('open', 'partial') THEN
    RAISE EXCEPTION 'PO % is %, can only receive on open/partial', v_po_number, v_status;
  END IF;
  IF NOT v_receivable THEN
    RAISE EXCEPTION 'this line is not received — %',
      CASE WHEN v_close_rule = 'on_run_yield' THEN 'the co-packer''s PO closes when the run ships'
           ELSE 'it is a service, not stock' END;
  END IF;
  IF v_already + p_qty_received > v_ordered THEN
    RAISE EXCEPTION 'receiving % would exceed qty_ordered (%); already received %',
      p_qty_received, v_ordered, v_already;
  END IF;

  v_unit_cost := COALESCE(p_unit_cost, v_unit_cost);

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  VALUES (
    'receipt', v_item_id, p_qty_received,
    NULL, v_loc_id, v_unit_cost,
    'purchase_order', v_po_id, p_po_line_id,
    COALESCE(p_receipt_date, now()), v_actor,
    'PO receipt · ' || v_po_number
  );

  UPDATE ops.purchase_order_lines
     SET qty_received = qty_received + p_qty_received
   WHERE id = p_po_line_id;

  -- completion counts RECEIVABLE lines only — a service line never arrives
  SELECT count(*) INTO v_unreceived
    FROM ops.purchase_order_lines
    WHERE po_id = v_po_id AND receivable AND qty_received < qty_ordered;

  IF v_unreceived = 0 THEN
    UPDATE ops.purchase_orders
       SET status = 'received', received_at = now()
     WHERE id = v_po_id;
    -- A run's materials PO closes the moment it is fully received — and when
    -- the run's last on_receipt PO closes, the materials are at the co-packer.
    IF v_wo_id IS NOT NULL AND v_close_rule = 'on_receipt' THEN
      UPDATE ops.purchase_orders
         SET status = 'closed', closed_at = now(), closed_by = v_actor, closed_reason = 'received'
       WHERE id = v_po_id;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
      VALUES ('purchase_order', v_po_id, 'close', 'Fully received — closed automatically', v_actor);
      SELECT status, batch_code INTO v_wo_status, v_batch FROM ops.work_orders WHERE id = v_wo_id FOR UPDATE;
      IF v_wo_status = 'ordered' AND NOT EXISTS (
           SELECT 1 FROM ops.purchase_orders
            WHERE work_order_id = v_wo_id AND close_rule = 'on_receipt' AND status NOT IN ('closed', 'void')) THEN
        UPDATE ops.work_orders SET status = 'at_copacker', materials_at_copacker_at = now() WHERE id = v_wo_id;
        INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
        VALUES (v_wo_id, 'materials_at_copacker', 'ordered', 'at_copacker',
                'Raw materials at co-packer — every materials PO fully received', v_actor);
      END IF;
    END IF;
  ELSIF v_status <> 'partial' THEN
    UPDATE ops.purchase_orders SET status = 'partial' WHERE id = v_po_id;
  END IF;
END;
$$;

-- ── 5. Voiding a PO releases the materials it covered ────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_void_purchase_order__i(p_po_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  v_status     TEXT;
  v_actor      UUID := auth.uid();
  v_has_recpt  BOOLEAN;
BEGIN
  SELECT status INTO v_status FROM ops.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
  IF v_status NOT IN ('draft', 'open') THEN
    RAISE EXCEPTION 'PO is %, can only void from draft/open', v_status;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM ops.purchase_order_lines WHERE po_id = p_po_id AND qty_received > 0
  ) INTO v_has_recpt;
  IF v_has_recpt THEN
    RAISE EXCEPTION 'PO has receipt(s) already booked; cannot void';
  END IF;

  UPDATE ops.purchase_orders
     SET status = 'void', voided_at = now(), voided_by = v_actor, void_reason = p_reason
   WHERE id = p_po_id;
  -- release the work-order materials so Generate POs can raise a replacement
  UPDATE ops.work_order_materials SET po_id = NULL, po_line_id = NULL WHERE po_id = p_po_id;
  UPDATE ops.work_order_recipe_lines SET po_line_id = NULL
   WHERE po_line_id IN (SELECT id FROM ops.purchase_order_lines WHERE po_id = p_po_id);
END;
$$;

-- ── 6. fn_wo_advance__i — anchored edits on the LIVE definition ──────────────
DO $$
DECLARE v_src text; v_a text; v_b text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p WHERE p.pronamespace = 'ops'::regnamespace AND p.proname = 'fn_wo_advance__i';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_wo_advance__i not found'; END IF;
  IF v_src LIKE '%20260903d%' THEN RAISE NOTICE 'fn_wo_advance__i already carries 20260903d — skipped'; RETURN; END IF;

  -- (a) start_production: land the co-packer's own supplies once, then consume stock only
  v_a := E'expected ordered/at_copacker\', v_wo.status;\n    END IF;\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (a) found % times', v_n; END IF;
  v_b := v_a || E'\n    -- 20260903d: what the co-packer supplies to itself (cans on its own on_run_yield PO) lands here,\n'
              || E'    -- once, so the consumption below has stock to draw on. Service lines are not stock.\n'
              || E'    INSERT INTO ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,\n'
              || E'                                         source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)\n'
              || E'    SELECT \'receipt\', pl.qbo_item_id, pl.qty_ordered, NULL, po.destination_location_id, pl.unit_cost,\n'
              || E'           \'purchase_order\', po.id, pl.id, now(), v_actor, \'Co-packer supplied · \' || po.po_number\n'
              || E'      FROM ops.purchase_order_lines pl\n'
              || E'      JOIN ops.purchase_orders po ON po.id = pl.po_id\n'
              || E'      LEFT JOIN ops.qbo_items i ON i.qbo_item_id = pl.qbo_item_id\n'
              || E'     WHERE po.work_order_id = p_wo_id AND po.close_rule = \'on_run_yield\' AND po.status <> \'void\'\n'
              || E'       AND COALESCE(i.type, \'\') <> \'Service\'\n'
              || E'       AND NOT EXISTS (SELECT 1 FROM ops.inventory_movements x WHERE x.source_doc_line_id = pl.id AND x.movement_type = \'receipt\');\n'
              || E'    UPDATE ops.purchase_order_lines pl SET qty_received = pl.qty_ordered\n'
              || E'      FROM ops.purchase_orders po\n'
              || E'     WHERE po.id = pl.po_id AND po.work_order_id = p_wo_id AND po.close_rule = \'on_run_yield\' AND po.status <> \'void\'\n'
              || E'       AND pl.qty_received < pl.qty_ordered;\n';
  v_src := replace(v_src, v_a, v_b);

  -- (b) the consume block only — anchored on its notes line, because the SAME
  --     FROM/WHERE appears again in record_yield's component-cost roll-up, and
  --     THAT one must keep Service items: tolling is a cost of the batch even
  --     though it is never stock.
  v_a := E'      \'WO consume · \' || v_wo.batch_code\n    FROM ops.work_order_materials m\n    LEFT JOIN ops.purchase_order_lines pl ON pl.id = m.po_line_id\n    WHERE m.wo_id = p_wo_id;\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (b) found % times', v_n; END IF;
  v_b := E'      \'WO consume · \' || v_wo.batch_code\n    FROM ops.work_order_materials m\n    LEFT JOIN ops.purchase_order_lines pl ON pl.id = m.po_line_id\n'
      || E'    LEFT JOIN ops.qbo_items i ON i.qbo_item_id = m.component_qbo_item_id\n'
      || E'    WHERE m.wo_id = p_wo_id\n      AND COALESCE(i.type, \'\') <> \'Service\';   -- 20260903d: a tolling charge is not stock\n';
  v_src := replace(v_src, v_a, v_b);

  -- (c) ship: the co-packer's PO closes with the run
  v_a := E'           shipped_at = now()\n     WHERE id = p_wo_id;\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (c) found % times', v_n; END IF;
  v_b := v_a
      || E'    -- 20260903d: the co-packer\'s PO closes with the run — nothing is received against it\n'
      || E'    UPDATE ops.purchase_order_lines pl SET qty_received = pl.qty_ordered\n'
      || E'      FROM ops.purchase_orders po\n'
      || E'     WHERE po.id = pl.po_id AND po.work_order_id = p_wo_id AND po.close_rule = \'on_run_yield\'\n'
      || E'       AND po.status <> \'void\' AND pl.qty_received < pl.qty_ordered;\n'
      || E'    INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)\n'
      || E'    SELECT \'purchase_order\', id, \'close\', \'Closed with the run — \' || v_wo.batch_code || \' shipped\', v_actor\n'
      || E'      FROM ops.purchase_orders WHERE work_order_id = p_wo_id AND close_rule = \'on_run_yield\' AND status NOT IN (\'closed\', \'void\');\n'
      || E'    UPDATE ops.purchase_orders\n'
      || E'       SET status = \'closed\', closed_at = now(), closed_by = v_actor, closed_reason = \'run_shipped\',\n'
      || E'           received_at = COALESCE(received_at, now())\n'
      || E'     WHERE work_order_id = p_wo_id AND close_rule = \'on_run_yield\' AND status NOT IN (\'closed\', \'void\');\n';
  v_src := replace(v_src, v_a, v_b);

  EXECUTE v_src;
END $$;

-- The wrapper is untouched (still guards via fn_assert_internal); inner stays revoked.
REVOKE ALL ON FUNCTION ops.fn_wo_advance__i(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.fn_wo_generate_pos__i(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.fn_receive_purchase_order_line__i(uuid, numeric, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.fn_void_purchase_order__i(uuid, text) FROM PUBLIC, anon, authenticated;

COMMIT;
