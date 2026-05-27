-- ============================================================================
-- v0.9.41 — Purchase Orders module
--
-- Closes the procurement side of the production loop. Where work orders
-- consume components from inventory, purchase orders refill that inventory
-- from vendors. End-to-end loop:
--
--     PO created → pushed to QBO (PurchaseOrder)
--          ↓
--     PO received in BRIX → inventory_movements (receipt) → on-hand goes up
--          ↓
--     QBO bill (via existing AP flow) closes the dollar side
--
-- New tables:
--   ops.qbo_vendors            — mirror of QBO Vendor (lazy-synced via push-qbo-item)
--   ops.purchase_orders        — PO header
--   ops.purchase_order_lines   — PO line items
--
-- Reuses ops.inventory_movements with movement_type='receipt' (already
-- provisioned in 20260513a_inventory_stock.sql).
--
-- Status flow:
--   draft → open → (partial → ) received → closed
--   (draft|open|partial) → void
-- ============================================================================


-- ── 1. qbo_vendors ──────────────────────────────────────────────────────────
-- Mirror of QBO Vendor records. Populated by push-qbo-item action=syncVendors.
-- Treated as read-only from the UI — vendor master lives in QBO.
CREATE TABLE IF NOT EXISTS ops.qbo_vendors (
  qbo_vendor_id  TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  company_name   TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  email          TEXT,
  phone          TEXT,
  address_line1  TEXT,
  city           TEXT,
  state          TEXT,
  postal_code    TEXT,
  country        TEXT,
  default_terms  TEXT,
  qbo_updated_at TIMESTAMPTZ,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qbo_vendors_active_idx
  ON ops.qbo_vendors (active, display_name);


-- ── 2. purchase_orders ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.purchase_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number               TEXT NOT NULL UNIQUE,
  qbo_vendor_id           TEXT NOT NULL REFERENCES ops.qbo_vendors(qbo_vendor_id),
  destination_location_id UUID NOT NULL REFERENCES ops.inventory_locations(id) ON DELETE RESTRICT,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','open','partial','received','closed','void')),
  expected_date           DATE,
  ordered_at              TIMESTAMPTZ,
  ordered_by              UUID REFERENCES auth.users(id),
  received_at             TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,
  closed_by               UUID REFERENCES auth.users(id),
  voided_at               TIMESTAMPTZ,
  voided_by               UUID REFERENCES auth.users(id),
  void_reason             TEXT,
  subtotal                NUMERIC NOT NULL DEFAULT 0,
  notes                   TEXT,
  qbo_purchase_order_id   TEXT,
  qbo_pushed_at           TIMESTAMPTZ,
  qbo_push_error          TEXT,
  created_by              UUID REFERENCES auth.users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_orders_status_idx
  ON ops.purchase_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS purchase_orders_vendor_idx
  ON ops.purchase_orders (qbo_vendor_id);

CREATE INDEX IF NOT EXISTS purchase_orders_location_idx
  ON ops.purchase_orders (destination_location_id);

CREATE INDEX IF NOT EXISTS purchase_orders_qbo_pushed_idx
  ON ops.purchase_orders (qbo_pushed_at)
  WHERE qbo_purchase_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ops.tg_purchase_orders_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS purchase_orders_touch ON ops.purchase_orders;
CREATE TRIGGER purchase_orders_touch
  BEFORE UPDATE ON ops.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION ops.tg_purchase_orders_touch();


-- ── 3. purchase_order_lines ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.purchase_order_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         UUID NOT NULL REFERENCES ops.purchase_orders(id) ON DELETE CASCADE,
  qbo_item_id   TEXT NOT NULL,
  description   TEXT,
  qty_ordered   NUMERIC NOT NULL CHECK (qty_ordered > 0),
  qty_received  NUMERIC NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost     NUMERIC NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  sort_order    INTEGER NOT NULL DEFAULT 100,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_order_lines_po_idx
  ON ops.purchase_order_lines (po_id, sort_order);

CREATE INDEX IF NOT EXISTS purchase_order_lines_item_idx
  ON ops.purchase_order_lines (qbo_item_id);


-- ── 4. PO number generator ──────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ops.purchase_order_seq;

CREATE OR REPLACE FUNCTION ops.fn_next_po_number()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  yr  TEXT := to_char(now(), 'YYYY');
  seq BIGINT := nextval('ops.purchase_order_seq');
BEGIN
  RETURN 'PO-' || yr || '-' || lpad(seq::text, 5, '0');
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_next_po_number() TO authenticated;


-- ── 5. fn_create_purchase_order ─────────────────────────────────────────────
-- Args:
--   p_qbo_vendor_id           text   — vendor reference
--   p_destination_location_id uuid   — where the inventory will land
--   p_lines                   jsonb  — [{qbo_item_id, qty_ordered, unit_cost?, description?, notes?}, ...]
--   p_expected_date           date   — optional ETA
--   p_notes                   text   — optional header notes
-- Returns the new PO id. Created in 'draft' status (not pushed to QBO yet).
CREATE OR REPLACE FUNCTION ops.fn_create_purchase_order(
  p_qbo_vendor_id           TEXT,
  p_destination_location_id UUID,
  p_lines                   JSONB,
  p_expected_date           DATE DEFAULT NULL,
  p_notes                   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id        UUID;
  v_number    TEXT;
  v_actor     UUID := auth.uid();
  v_line      JSONB;
  v_sort      INTEGER := 100;
  v_subtotal  NUMERIC := 0;
  v_qty       NUMERIC;
  v_cost      NUMERIC;
  v_loc_kind  TEXT;
BEGIN
  IF p_qbo_vendor_id IS NULL OR p_qbo_vendor_id = '' THEN
    RAISE EXCEPTION 'qbo_vendor_id is required';
  END IF;
  IF p_destination_location_id IS NULL THEN
    RAISE EXCEPTION 'destination_location_id is required';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  SELECT kind INTO v_loc_kind FROM ops.inventory_locations WHERE id = p_destination_location_id;
  IF v_loc_kind IS NULL THEN
    RAISE EXCEPTION 'destination_location_id not found';
  END IF;
  IF v_loc_kind IN ('in_transit', 'adjustment') THEN
    RAISE EXCEPTION 'Destination cannot be a virtual location';
  END IF;

  v_number := ops.fn_next_po_number();

  INSERT INTO ops.purchase_orders (
    po_number, qbo_vendor_id, destination_location_id, status,
    expected_date, notes, created_by, ordered_at, ordered_by
  )
  VALUES (
    v_number, p_qbo_vendor_id, p_destination_location_id, 'open',
    p_expected_date, p_notes, v_actor, now(), v_actor
  )
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (v_line ->> 'qbo_item_id') IS NULL OR (v_line ->> 'qbo_item_id') = '' THEN
      RAISE EXCEPTION 'every line requires qbo_item_id';
    END IF;
    v_qty  := (v_line ->> 'qty_ordered')::numeric;
    v_cost := COALESCE(NULLIF(v_line ->> 'unit_cost', '')::numeric, 0);
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'qty_ordered must be > 0';
    END IF;

    INSERT INTO ops.purchase_order_lines (
      po_id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order
    )
    VALUES (
      v_id, v_line ->> 'qbo_item_id', v_line ->> 'description',
      v_qty, v_cost, v_line ->> 'notes', v_sort
    );
    v_subtotal := v_subtotal + (v_qty * v_cost);
    v_sort := v_sort + 10;
  END LOOP;

  UPDATE ops.purchase_orders SET subtotal = v_subtotal WHERE id = v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_create_purchase_order(TEXT, UUID, JSONB, DATE, TEXT) TO authenticated;


-- ── 6. fn_receive_purchase_order_line ───────────────────────────────────────
-- Marks a line as (partially) received. Posts an inventory_movements
-- 'receipt' row for the qty received at the PO's destination location and
-- bumps the line's qty_received. The PO header transitions to 'partial'
-- after the first receipt; flips to 'received' once every line is full.
CREATE OR REPLACE FUNCTION ops.fn_receive_purchase_order_line(
  p_po_line_id    UUID,
  p_qty_received  NUMERIC,
  p_unit_cost     NUMERIC DEFAULT NULL,
  p_receipt_date  TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
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
BEGIN
  IF p_qty_received IS NULL OR p_qty_received <= 0 THEN
    RAISE EXCEPTION 'qty_received must be > 0';
  END IF;

  SELECT l.po_id, l.qbo_item_id, l.qty_received, l.qty_ordered, l.unit_cost,
         o.destination_location_id, o.status, o.po_number
    INTO v_po_id, v_item_id, v_already, v_ordered, v_unit_cost,
         v_loc_id, v_status, v_po_number
    FROM ops.purchase_order_lines l
    JOIN ops.purchase_orders o ON o.id = l.po_id
    WHERE l.id = p_po_line_id
    FOR UPDATE OF l;

  IF v_po_id IS NULL THEN RAISE EXCEPTION 'PO line not found'; END IF;
  IF v_status NOT IN ('open', 'partial') THEN
    RAISE EXCEPTION 'PO % is %, can only receive on open/partial', v_po_id, v_status;
  END IF;
  IF v_already + p_qty_received > v_ordered THEN
    RAISE EXCEPTION 'receiving % would exceed qty_ordered (%); already received %',
      p_qty_received, v_ordered, v_already;
  END IF;

  v_unit_cost := COALESCE(p_unit_cost, v_unit_cost);

  -- Receipt movement: inventory shows up at destination.
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

  -- Flip PO header status based on remaining receipts.
  SELECT count(*) INTO v_unreceived
    FROM ops.purchase_order_lines
    WHERE po_id = v_po_id AND qty_received < qty_ordered;

  IF v_unreceived = 0 THEN
    UPDATE ops.purchase_orders
       SET status = 'received', received_at = now()
     WHERE id = v_po_id;
  ELSIF v_status <> 'partial' THEN
    UPDATE ops.purchase_orders SET status = 'partial' WHERE id = v_po_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_receive_purchase_order_line(UUID, NUMERIC, NUMERIC, TIMESTAMPTZ) TO authenticated;


-- ── 7. fn_close_purchase_order ──────────────────────────────────────────────
-- Marks the PO as fully closed. Allowed from 'received' (normal close) or
-- 'partial' (force-close with under-receipt — covers a vendor short-ship).
CREATE OR REPLACE FUNCTION ops.fn_close_purchase_order(p_po_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_status TEXT; v_actor UUID := auth.uid();
BEGIN
  SELECT status INTO v_status FROM ops.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PO not found'; END IF;
  IF v_status NOT IN ('received', 'partial') THEN
    RAISE EXCEPTION 'PO is %, can only close from received/partial', v_status;
  END IF;
  UPDATE ops.purchase_orders
     SET status = 'closed', closed_at = now(), closed_by = v_actor
   WHERE id = p_po_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_close_purchase_order(UUID) TO authenticated;


-- ── 8. fn_void_purchase_order ───────────────────────────────────────────────
-- Voids a PO. Allowed from 'draft' (never sent) or 'open' (no receipts yet).
-- Refuses if any receipts have been booked.
CREATE OR REPLACE FUNCTION ops.fn_void_purchase_order(
  p_po_id  UUID,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
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
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_void_purchase_order(UUID, TEXT) TO authenticated;


-- ── 9. v_purchase_orders — list view with vendor + receipt rollup ──────────
CREATE OR REPLACE VIEW ops.v_purchase_orders AS
SELECT
  o.id, o.po_number, o.qbo_vendor_id, v.display_name AS vendor_name,
  o.destination_location_id, l.name AS location_label,
  o.status, o.expected_date, o.subtotal, o.notes,
  o.qbo_purchase_order_id, o.qbo_pushed_at, o.qbo_push_error,
  o.ordered_at, o.received_at, o.closed_at, o.voided_at, o.void_reason,
  COALESCE(line_agg.line_count,    0) AS line_count,
  COALESCE(line_agg.qty_ordered,   0) AS qty_ordered_total,
  COALESCE(line_agg.qty_received,  0) AS qty_received_total,
  o.created_at, o.updated_at
FROM ops.purchase_orders o
LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = o.qbo_vendor_id
LEFT JOIN ops.inventory_locations l ON l.id = o.destination_location_id
LEFT JOIN LATERAL (
  SELECT count(*) AS line_count,
         sum(qty_ordered)::numeric AS qty_ordered,
         sum(qty_received)::numeric AS qty_received
  FROM ops.purchase_order_lines WHERE po_id = o.id
) line_agg ON TRUE;

GRANT SELECT ON ops.v_purchase_orders TO authenticated;


-- ── 10. RLS + grants ────────────────────────────────────────────────────────
ALTER TABLE ops.qbo_vendors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.purchase_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.purchase_order_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qbo_vendors_select ON ops.qbo_vendors;
CREATE POLICY qbo_vendors_select          ON ops.qbo_vendors          FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS purchase_orders_select ON ops.purchase_orders;
CREATE POLICY purchase_orders_select      ON ops.purchase_orders      FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS purchase_order_lines_select ON ops.purchase_order_lines;
CREATE POLICY purchase_order_lines_select ON ops.purchase_order_lines FOR SELECT TO authenticated USING (TRUE);

-- Header notes / expected_date editable directly (low risk; lines go via RPC).
DROP POLICY IF EXISTS purchase_orders_update ON ops.purchase_orders;
CREATE POLICY purchase_orders_update      ON ops.purchase_orders      FOR UPDATE TO authenticated
  USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT          ON ops.qbo_vendors          TO authenticated;
GRANT SELECT          ON ops.purchase_orders      TO authenticated;
GRANT UPDATE          ON ops.purchase_orders      TO authenticated;
GRANT SELECT          ON ops.purchase_order_lines TO authenticated;
