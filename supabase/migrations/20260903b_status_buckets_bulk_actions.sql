-- 20260903b — status buckets + bulk void / delete / edit on the production
-- documents (work orders, purchase orders, transfers)
--
-- Ask (Sky): "delete, edit, and receive multiple items in any table… a void on
-- each that i can select all", and "open, pending, closed and voided on
-- different tabs". Phase 2 of the production overhaul; receive/reopen is P3.
--
-- Rules:
--  * ONE bucket rule, in SQL (`fn_status_bucket`) and exposed on the views as
--    `bucket`; the client mirrors it for rows that come off a bare table
--    (transfers). pending = draft · voided = void · closed = closed/consumed
--    (and a RECEIVED transfer, which is terminal) · everything else is open —
--    a received PO / work order stays OPEN because a click (Close) remains.
--  * Bulk RPCs never half-apply silently: each id runs in its own
--    sub-transaction and the call returns {done[], skipped[{id, number,
--    reason}]} so the screen can say exactly which rows were refused and why.
--    They call the EXISTING single-row inner functions (fn_void_*__i,
--    fn_wo_advance__i 'void'), so the rules for what may be voided live in one
--    place.
--  * Delete is DRAFT ONLY and the only hard delete in the module: no QBO id,
--    no receipts, no dependent document. Anything past draft is voided, never
--    deleted — the void_reason is the record.
--  * Every bulk action writes ops.production_doc_events (POs, transfers; work
--    orders already have work_order_events and fn_wo_advance writes it).
--  * New functions carry the guard INLINE (fn_assert_internal) — the
--    20260820b rule for new SECURITY DEFINER RPCs.

BEGIN;

-- ── 1. The bucket rule ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.fn_status_bucket(p_kind text, p_status text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_status = 'void'                                   THEN 'voided'
    WHEN p_status = 'draft'                                  THEN 'pending'
    WHEN p_status IN ('closed', 'consumed')                  THEN 'closed'
    WHEN p_kind = 'transfer' AND p_status = 'received'       THEN 'closed'
    ELSE 'open'
  END
$$;
GRANT EXECUTE ON FUNCTION ops.fn_status_bucket(text, text) TO authenticated, service_role;

-- ── 2. Audit for documents that had none ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.production_doc_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type    TEXT NOT NULL CHECK (doc_type IN ('purchase_order', 'transfer', 'work_order', 'run')),
  doc_id      UUID NOT NULL,
  event_type  TEXT NOT NULL,          -- void | delete | edit | reopen | receive | close …
  note        TEXT,
  payload     JSONB,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_doc_events_doc_idx
  ON ops.production_doc_events (doc_type, doc_id, created_at DESC);

ALTER TABLE ops.production_doc_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_doc_events_select ON ops.production_doc_events;
CREATE POLICY production_doc_events_select ON ops.production_doc_events
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS production_doc_events_no_distributor ON ops.production_doc_events;
CREATE POLICY production_doc_events_no_distributor ON ops.production_doc_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor());
-- Writes happen only inside the SECURITY DEFINER functions below.
GRANT SELECT ON ops.production_doc_events TO authenticated;
GRANT ALL    ON ops.production_doc_events TO service_role;

-- ── 3. `bucket` on the two views (columns appended, so CREATE OR REPLACE) ────

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
    ops.fn_status_bucket('work_order', w.status) AS bucket
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
    o.po_kind
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

-- ── 4. Bulk void ─────────────────────────────────────────────────────────────
-- Each id in its own sub-transaction; the single-row rules stay where they are.

CREATE OR REPLACE FUNCTION ops.fn_void_work_orders(p_ids uuid[], p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT batch_code INTO v_num FROM ops.work_orders WHERE id = v_id;
    BEGIN
      IF v_num IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
      -- fn_wo_advance's void: refuses once production has started, voids the
      -- work order's open POs (refusing if any carry receipts), writes the event.
      PERFORM ops.fn_wo_advance__i(v_id, 'void', jsonb_build_object('reason', p_reason));
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

CREATE OR REPLACE FUNCTION ops.fn_void_purchase_orders(p_ids uuid[], p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT po_number INTO v_num FROM ops.purchase_orders WHERE id = v_id;
    BEGIN
      IF v_num IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
      PERFORM ops.fn_void_purchase_order__i(v_id, p_reason);
      -- a voided PO releases the work-order materials it was covering, so
      -- "Generate POs" can raise a replacement (found gap, 2026-09-03)
      UPDATE ops.work_order_materials SET po_id = NULL, po_line_id = NULL WHERE po_id = v_id;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
      VALUES ('purchase_order', v_id, 'void', p_reason, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

CREATE OR REPLACE FUNCTION ops.fn_void_transfers(p_ids uuid[], p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT bol_number INTO v_num FROM ops.inventory_transfers WHERE id = v_id;
    BEGIN
      IF v_num IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
      PERFORM ops.fn_void_transfer__i(v_id, p_reason);
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
      VALUES ('transfer', v_id, 'void', p_reason, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

-- ── 5. Delete drafts — the only hard delete ──────────────────────────────────

CREATE OR REPLACE FUNCTION ops.fn_delete_drafts(p_kind text, p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_status text; v_ext text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  IF p_kind NOT IN ('work_order', 'purchase_order', 'transfer') THEN
    RAISE EXCEPTION 'unknown kind %', p_kind;
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    v_num := NULL; v_status := NULL; v_ext := NULL;
    BEGIN
      IF p_kind = 'work_order' THEN
        SELECT batch_code, status, qbo_inventory_adjustment_id INTO v_num, v_status, v_ext
          FROM ops.work_orders WHERE id = v_id FOR UPDATE;
        IF v_num IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
        IF v_status <> 'draft' THEN RAISE EXCEPTION 'is %; only a draft can be deleted — void it instead', v_status; END IF;
        IF v_ext IS NOT NULL THEN RAISE EXCEPTION 'has a QuickBooks inventory adjustment; void it instead'; END IF;
        IF EXISTS (SELECT 1 FROM ops.purchase_orders WHERE work_order_id = v_id) THEN
          RAISE EXCEPTION 'has purchase orders raised from it; void the work order instead (that voids them too)';
        END IF;
        DELETE FROM ops.work_orders WHERE id = v_id;          -- materials, recipe lines, lots, events cascade
      ELSIF p_kind = 'purchase_order' THEN
        SELECT po_number, status, qbo_purchase_order_id INTO v_num, v_status, v_ext
          FROM ops.purchase_orders WHERE id = v_id FOR UPDATE;
        IF v_num IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
        IF v_status <> 'draft' THEN RAISE EXCEPTION 'is %; only a draft can be deleted — void it instead', v_status; END IF;
        IF v_ext IS NOT NULL THEN RAISE EXCEPTION 'is already in QuickBooks (PO %); void it instead', v_ext; END IF;
        IF EXISTS (SELECT 1 FROM ops.purchase_order_lines WHERE po_id = v_id AND qty_received > 0) THEN
          RAISE EXCEPTION 'has receipts booked; it cannot be deleted';
        END IF;
        UPDATE ops.work_order_materials SET po_id = NULL, po_line_id = NULL WHERE po_id = v_id;
        DELETE FROM ops.purchase_orders WHERE id = v_id;      -- lines + line details cascade
      ELSE
        SELECT bol_number, status INTO v_num, v_status
          FROM ops.inventory_transfers WHERE id = v_id FOR UPDATE;
        IF v_num IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
        IF v_status <> 'draft' THEN RAISE EXCEPTION 'is %; only a draft can be deleted — void it instead', v_status; END IF;
        IF EXISTS (SELECT 1 FROM ops.work_orders WHERE transfer_id = v_id) THEN
          RAISE EXCEPTION 'is a work order''s return shipment; void it from the work order';
        END IF;
        IF EXISTS (SELECT 1 FROM ops.sub_distributor_orders WHERE transfer_id = v_id) THEN
          RAISE EXCEPTION 'fulfils a sub-distributor order; void it instead';
        END IF;
        DELETE FROM ops.inventory_transfers WHERE id = v_id;  -- lines cascade
      END IF;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
      VALUES (p_kind, v_id, 'delete', v_num, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

-- ── 6. Bulk edit — a key whitelist per document, never a free patch ─────────

CREATE OR REPLACE FUNCTION ops.fn_update_purchase_orders(p_ids uuid[], p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_status text; v_keys text[]; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  v_keys := ARRAY(SELECT jsonb_object_keys(coalesce(p_patch, '{}')));
  IF cardinality(v_keys) = 0 THEN RAISE EXCEPTION 'nothing to change'; END IF;
  IF NOT (v_keys <@ ARRAY['expected_date', 'notes']) THEN
    RAISE EXCEPTION 'only expected_date and notes can be edited in bulk (got %)', array_to_string(v_keys, ', ');
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT po_number, status INTO v_num, v_status FROM ops.purchase_orders WHERE id = v_id;
    BEGIN
      IF v_num IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
      IF v_status IN ('void', 'closed') THEN RAISE EXCEPTION 'is %; reopen it first', v_status; END IF;
      UPDATE ops.purchase_orders
         SET expected_date = CASE WHEN p_patch ? 'expected_date' THEN NULLIF(p_patch ->> 'expected_date', '')::date ELSE expected_date END,
             notes         = CASE WHEN p_patch ? 'notes'         THEN NULLIF(p_patch ->> 'notes', '')                ELSE notes         END,
             updated_at    = now()
       WHERE id = v_id;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, payload, created_by)
      VALUES ('purchase_order', v_id, 'edit', p_patch, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

CREATE OR REPLACE FUNCTION ops.fn_update_work_orders(p_ids uuid[], p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_status text; v_keys text[]; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  v_keys := ARRAY(SELECT jsonb_object_keys(coalesce(p_patch, '{}')));
  IF cardinality(v_keys) = 0 THEN RAISE EXCEPTION 'nothing to change'; END IF;
  IF NOT (v_keys <@ ARRAY['scheduled_date', 'notes']) THEN
    RAISE EXCEPTION 'only scheduled_date and notes can be edited in bulk (got %)', array_to_string(v_keys, ', ');
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
      VALUES (v_id, 'edit', v_status, v_status, 'Edited in bulk', p_patch, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

CREATE OR REPLACE FUNCTION ops.fn_update_transfers(p_ids uuid[], p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_id uuid; v_num text; v_status text; v_keys text[]; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  v_keys := ARRAY(SELECT jsonb_object_keys(coalesce(p_patch, '{}')));
  IF cardinality(v_keys) = 0 THEN RAISE EXCEPTION 'nothing to change'; END IF;
  IF NOT (v_keys <@ ARRAY['notes', 'special_instructions', 'carrier', 'tracking_number']) THEN
    RAISE EXCEPTION 'only notes, special_instructions, carrier and tracking_number can be edited in bulk (got %)', array_to_string(v_keys, ', ');
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT bol_number, status INTO v_num, v_status FROM ops.inventory_transfers WHERE id = v_id;
    BEGIN
      IF v_num IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
      IF v_status = 'void' THEN RAISE EXCEPTION 'is void'; END IF;
      UPDATE ops.inventory_transfers
         SET notes                = CASE WHEN p_patch ? 'notes'                THEN NULLIF(p_patch ->> 'notes', '')                ELSE notes                END,
             special_instructions = CASE WHEN p_patch ? 'special_instructions' THEN NULLIF(p_patch ->> 'special_instructions', '') ELSE special_instructions END,
             carrier              = CASE WHEN p_patch ? 'carrier'              THEN NULLIF(p_patch ->> 'carrier', '')              ELSE carrier              END,
             tracking_number      = CASE WHEN p_patch ? 'tracking_number'      THEN NULLIF(p_patch ->> 'tracking_number', '')      ELSE tracking_number      END,
             updated_at           = now()
       WHERE id = v_id;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, payload, created_by)
      VALUES ('transfer', v_id, 'edit', p_patch, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;

-- ── 7. Grants (guard is inline; nothing for PUBLIC or anon) ──────────────────

REVOKE ALL ON FUNCTION ops.fn_void_work_orders(uuid[], text),
                       ops.fn_void_purchase_orders(uuid[], text),
                       ops.fn_void_transfers(uuid[], text),
                       ops.fn_delete_drafts(text, uuid[]),
                       ops.fn_update_purchase_orders(uuid[], jsonb),
                       ops.fn_update_work_orders(uuid[], jsonb),
                       ops.fn_update_transfers(uuid[], jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_void_work_orders(uuid[], text),
                          ops.fn_void_purchase_orders(uuid[], text),
                          ops.fn_void_transfers(uuid[], text),
                          ops.fn_delete_drafts(text, uuid[]),
                          ops.fn_update_purchase_orders(uuid[], jsonb),
                          ops.fn_update_work_orders(uuid[], jsonb),
                          ops.fn_update_transfers(uuid[], jsonb)
  TO authenticated, service_role;

COMMIT;
