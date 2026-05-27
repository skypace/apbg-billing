-- ============================================================================
-- BRIX Stock (Product Control Phase 1) — locations, transfers (BOL),
-- movement ledger, on-hand view, transition RPCs.
--
-- See architecture/PRODUCT-CONTROL.md for the full design.
--
-- Tables created:
--   ops.inventory_locations         — warehouses + virtual TRANSIT/ADJUSTMENT
--   ops.inventory_transfers         — BOL header
--   ops.inventory_transfer_lines    — BOL lines (one per item moved)
--   ops.inventory_movements         — append-only ledger; source of truth for on-hand
--
-- View created:
--   ops.v_inventory_on_hand         — derived (qbo_item_id, location_id) -> on_hand
--
-- RPCs created (SECURITY DEFINER):
--   ops.fn_create_transfer          — insert draft transfer + lines
--   ops.fn_ship_transfer            — draft -> in_transit, write transfer_ship rows
--   ops.fn_receive_transfer         — in_transit -> received, write transfer_receive rows
--   ops.fn_void_transfer            — draft -> void
--   ops.fn_next_bol_number          — BOL-<yyyy>-<seq> generator
--
-- Idempotent: re-running this migration is safe.
-- ============================================================================


-- ── 1. inventory_locations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.inventory_locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('warehouse','van','co_packer','customer_consigned','in_transit','adjustment')),
  entity          TEXT NOT NULL DEFAULT 'shared'
                    CHECK (entity IN ('brix','freeflow','shared')),
  address_line1   TEXT,
  address_line2   TEXT,
  city            TEXT,
  state           TEXT,
  postal_code     TEXT,
  country         TEXT DEFAULT 'US',
  contact_name    TEXT,
  contact_phone   TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_locations_kind_idx
  ON ops.inventory_locations (kind, is_active);

CREATE INDEX IF NOT EXISTS inventory_locations_entity_idx
  ON ops.inventory_locations (entity, is_active);

CREATE OR REPLACE FUNCTION ops.tg_inventory_locations_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_locations_touch ON ops.inventory_locations;
CREATE TRIGGER inventory_locations_touch
  BEFORE UPDATE ON ops.inventory_locations
  FOR EACH ROW EXECUTE FUNCTION ops.tg_inventory_locations_touch();

-- Seed the two virtual singletons. Operators never create these from the UI.
INSERT INTO ops.inventory_locations (code, name, kind, entity, is_active, notes)
VALUES
  ('TRANSIT',    'In Transit',          'in_transit', 'shared', TRUE,
   'Virtual location. Counterparty for the ship/receive halves of a transfer. Do not delete.'),
  ('ADJUSTMENT', 'Adjustment Counter',  'adjustment', 'shared', TRUE,
   'Virtual location. Counterparty for write-offs, shrinkage, cycle-count variance. Do not delete.')
ON CONFLICT (code) DO NOTHING;


-- ── 2. inventory_transfers — BOL header ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.inventory_transfers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bol_number        TEXT NOT NULL UNIQUE,
  from_location_id  UUID NOT NULL REFERENCES ops.inventory_locations(id) ON DELETE RESTRICT,
  to_location_id    UUID NOT NULL REFERENCES ops.inventory_locations(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','in_transit','received','void')),
  carrier           TEXT,
  tracking_number   TEXT,
  ship_date         DATE,
  received_date     DATE,
  shipped_by        UUID REFERENCES auth.users(id),
  received_by       UUID REFERENCES auth.users(id),
  voided_by         UUID REFERENCES auth.users(id),
  voided_at         TIMESTAMPTZ,
  void_reason       TEXT,
  notes             TEXT,
  created_by        UUID REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_location_id <> to_location_id)
);

CREATE INDEX IF NOT EXISTS inventory_transfers_status_idx
  ON ops.inventory_transfers (status, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_transfers_from_idx
  ON ops.inventory_transfers (from_location_id);

CREATE INDEX IF NOT EXISTS inventory_transfers_to_idx
  ON ops.inventory_transfers (to_location_id);

CREATE OR REPLACE FUNCTION ops.tg_inventory_transfers_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_transfers_touch ON ops.inventory_transfers;
CREATE TRIGGER inventory_transfers_touch
  BEFORE UPDATE ON ops.inventory_transfers
  FOR EACH ROW EXECUTE FUNCTION ops.tg_inventory_transfers_touch();


-- ── 3. inventory_transfer_lines ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.inventory_transfer_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   UUID NOT NULL REFERENCES ops.inventory_transfers(id) ON DELETE CASCADE,
  qbo_item_id   TEXT NOT NULL,
  qty           NUMERIC NOT NULL CHECK (qty > 0),
  qty_received  NUMERIC CHECK (qty_received IS NULL OR qty_received >= 0),
  unit_cost     NUMERIC,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_transfer_lines_transfer_idx
  ON ops.inventory_transfer_lines (transfer_id);

CREATE INDEX IF NOT EXISTS inventory_transfer_lines_item_idx
  ON ops.inventory_transfer_lines (qbo_item_id);


-- ── 4. inventory_movements — append-only ledger ─────────────────────────────
CREATE TABLE IF NOT EXISTS ops.inventory_movements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type       TEXT NOT NULL CHECK (movement_type IN
                        ('transfer_ship','transfer_receive','receipt','shipment',
                         'adjustment','production_consume','production_yield')),
  qbo_item_id         TEXT NOT NULL,
  qty                 NUMERIC NOT NULL CHECK (qty > 0),
  from_location_id    UUID REFERENCES ops.inventory_locations(id) ON DELETE RESTRICT,
  to_location_id      UUID REFERENCES ops.inventory_locations(id) ON DELETE RESTRICT,
  unit_cost           NUMERIC,
  source_doc_type     TEXT,
  source_doc_id       UUID,
  source_doc_line_id  UUID,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes               TEXT,
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  CHECK (from_location_id IS NULL OR to_location_id IS NULL
         OR from_location_id <> to_location_id)
);

CREATE INDEX IF NOT EXISTS inventory_movements_item_idx
  ON ops.inventory_movements (qbo_item_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS inventory_movements_from_idx
  ON ops.inventory_movements (from_location_id) WHERE from_location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_movements_to_idx
  ON ops.inventory_movements (to_location_id) WHERE to_location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_movements_source_doc_idx
  ON ops.inventory_movements (source_doc_type, source_doc_id);

CREATE INDEX IF NOT EXISTS inventory_movements_occurred_idx
  ON ops.inventory_movements (occurred_at DESC);


-- ── 5. v_inventory_on_hand — derived on-hand by (item, location) ────────────
CREATE OR REPLACE VIEW ops.v_inventory_on_hand AS
SELECT
  qbo_item_id,
  location_id,
  SUM(qty_signed)::numeric AS on_hand
FROM (
  SELECT qbo_item_id, to_location_id   AS location_id,  qty AS qty_signed
    FROM ops.inventory_movements
    WHERE to_location_id IS NOT NULL
  UNION ALL
  SELECT qbo_item_id, from_location_id AS location_id, -qty AS qty_signed
    FROM ops.inventory_movements
    WHERE from_location_id IS NOT NULL
) m
GROUP BY qbo_item_id, location_id;


-- ── 6. BOL number generator ─────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ops.inventory_bol_seq;

CREATE OR REPLACE FUNCTION ops.fn_next_bol_number()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  yr  TEXT := to_char(now(), 'YYYY');
  seq BIGINT;
BEGIN
  seq := nextval('ops.inventory_bol_seq');
  RETURN 'BOL-' || yr || '-' || lpad(seq::text, 5, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_next_bol_number() TO anon, authenticated;


-- ── 7. fn_create_transfer ───────────────────────────────────────────────────
-- Args:
--   p_from_location_id  uuid
--   p_to_location_id    uuid
--   p_lines             jsonb  [{ "qbo_item_id": "...", "qty": 12, "unit_cost": 1.23, "notes": "..." }]
--   p_carrier           text   nullable
--   p_tracking_number   text   nullable
--   p_notes             text   nullable
-- Returns the new transfer id.
CREATE OR REPLACE FUNCTION ops.fn_create_transfer(
  p_from_location_id UUID,
  p_to_location_id   UUID,
  p_lines            JSONB,
  p_carrier          TEXT DEFAULT NULL,
  p_tracking_number  TEXT DEFAULT NULL,
  p_notes            TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id           UUID;
  v_bol          TEXT;
  v_from_kind    TEXT;
  v_to_kind      TEXT;
  v_actor        UUID := auth.uid();
  v_line         JSONB;
BEGIN
  IF p_from_location_id IS NULL OR p_to_location_id IS NULL THEN
    RAISE EXCEPTION 'from_location_id and to_location_id are required';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'from and to locations must differ';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  SELECT kind INTO v_from_kind FROM ops.inventory_locations WHERE id = p_from_location_id;
  SELECT kind INTO v_to_kind   FROM ops.inventory_locations WHERE id = p_to_location_id;
  IF v_from_kind IS NULL THEN RAISE EXCEPTION 'from_location_id not found'; END IF;
  IF v_to_kind   IS NULL THEN RAISE EXCEPTION 'to_location_id not found';   END IF;
  IF v_from_kind = 'in_transit' OR v_to_kind = 'in_transit' THEN
    RAISE EXCEPTION 'Cannot transfer directly to/from the TRANSIT virtual location';
  END IF;

  v_bol := ops.fn_next_bol_number();

  INSERT INTO ops.inventory_transfers (
    bol_number, from_location_id, to_location_id, status,
    carrier, tracking_number, notes, created_by
  )
  VALUES (
    v_bol, p_from_location_id, p_to_location_id, 'draft',
    p_carrier, p_tracking_number, p_notes, v_actor
  )
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    IF (v_line ->> 'qbo_item_id') IS NULL OR (v_line ->> 'qty') IS NULL THEN
      RAISE EXCEPTION 'each line requires qbo_item_id and qty';
    END IF;
    IF (v_line ->> 'qty')::numeric <= 0 THEN
      RAISE EXCEPTION 'qty must be > 0';
    END IF;
    INSERT INTO ops.inventory_transfer_lines (
      transfer_id, qbo_item_id, qty, unit_cost, notes
    )
    VALUES (
      v_id,
      v_line ->> 'qbo_item_id',
      (v_line ->> 'qty')::numeric,
      NULLIF(v_line ->> 'unit_cost','')::numeric,
      v_line ->> 'notes'
    );
  END LOOP;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_create_transfer(UUID, UUID, JSONB, TEXT, TEXT, TEXT)
  TO authenticated;


-- ── 8. fn_ship_transfer — draft -> in_transit + ledger rows ─────────────────
CREATE OR REPLACE FUNCTION ops.fn_ship_transfer(
  p_transfer_id UUID,
  p_ship_date   DATE DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status   TEXT;
  v_from     UUID;
  v_transit  UUID;
  v_actor    UUID := auth.uid();
BEGIN
  SELECT status, from_location_id INTO v_status, v_from
    FROM ops.inventory_transfers WHERE id = p_transfer_id FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'transfer % is %, can only ship from draft', p_transfer_id, v_status;
  END IF;

  SELECT id INTO v_transit FROM ops.inventory_locations WHERE code = 'TRANSIT';
  IF v_transit IS NULL THEN RAISE EXCEPTION 'TRANSIT location missing'; END IF;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  SELECT
    'transfer_ship', l.qbo_item_id, l.qty,
    v_from, v_transit, l.unit_cost,
    'transfer', p_transfer_id, l.id,
    COALESCE(p_ship_date::timestamptz, now()), v_actor, l.notes
  FROM ops.inventory_transfer_lines l
  WHERE l.transfer_id = p_transfer_id;

  UPDATE ops.inventory_transfers
     SET status     = 'in_transit',
         ship_date  = COALESCE(p_ship_date, CURRENT_DATE),
         shipped_by = v_actor
   WHERE id = p_transfer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_ship_transfer(UUID, DATE) TO authenticated;


-- ── 9. fn_receive_transfer — in_transit -> received + ledger rows ───────────
CREATE OR REPLACE FUNCTION ops.fn_receive_transfer(
  p_transfer_id    UUID,
  p_received_date  DATE DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status   TEXT;
  v_to       UUID;
  v_transit  UUID;
  v_actor    UUID := auth.uid();
BEGIN
  SELECT status, to_location_id INTO v_status, v_to
    FROM ops.inventory_transfers WHERE id = p_transfer_id FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_status <> 'in_transit' THEN
    RAISE EXCEPTION 'transfer % is %, can only receive from in_transit', p_transfer_id, v_status;
  END IF;

  SELECT id INTO v_transit FROM ops.inventory_locations WHERE code = 'TRANSIT';
  IF v_transit IS NULL THEN RAISE EXCEPTION 'TRANSIT location missing'; END IF;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  SELECT
    'transfer_receive', l.qbo_item_id, l.qty,
    v_transit, v_to, l.unit_cost,
    'transfer', p_transfer_id, l.id,
    COALESCE(p_received_date::timestamptz, now()), v_actor, l.notes
  FROM ops.inventory_transfer_lines l
  WHERE l.transfer_id = p_transfer_id;

  UPDATE ops.inventory_transfer_lines
     SET qty_received = qty
   WHERE transfer_id = p_transfer_id;

  UPDATE ops.inventory_transfers
     SET status        = 'received',
         received_date = COALESCE(p_received_date, CURRENT_DATE),
         received_by   = v_actor
   WHERE id = p_transfer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_receive_transfer(UUID, DATE) TO authenticated;


-- ── 10. fn_void_transfer — draft -> void ────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_void_transfer(
  p_transfer_id UUID,
  p_reason      TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_actor  UUID := auth.uid();
BEGIN
  SELECT status INTO v_status FROM ops.inventory_transfers
    WHERE id = p_transfer_id FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'transfer % is %, can only void from draft', p_transfer_id, v_status;
  END IF;

  UPDATE ops.inventory_transfers
     SET status      = 'void',
         voided_by   = v_actor,
         voided_at   = now(),
         void_reason = p_reason
   WHERE id = p_transfer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_void_transfer(UUID, TEXT) TO authenticated;


-- ── 11. RLS + grants ────────────────────────────────────────────────────────
ALTER TABLE ops.inventory_locations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.inventory_transfers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.inventory_transfer_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.inventory_movements       ENABLE ROW LEVEL SECURITY;

-- inventory_locations: any authenticated user can read; insert/update directly
-- (low volume CRUD). Deletes are blocked by FK from movements/transfers and
-- by the virtual-row check in the UI.
DROP POLICY IF EXISTS inv_locations_select ON ops.inventory_locations;
CREATE POLICY inv_locations_select ON ops.inventory_locations
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS inv_locations_insert ON ops.inventory_locations;
CREATE POLICY inv_locations_insert ON ops.inventory_locations
  FOR INSERT TO authenticated WITH CHECK (TRUE);

DROP POLICY IF EXISTS inv_locations_update ON ops.inventory_locations;
CREATE POLICY inv_locations_update ON ops.inventory_locations
  FOR UPDATE TO authenticated
  USING (kind NOT IN ('in_transit','adjustment'))
  WITH CHECK (kind NOT IN ('in_transit','adjustment'));

-- transfers, lines, movements: read-only directly from clients. Writes go
-- through SECURITY DEFINER RPCs above. No client INSERT/UPDATE/DELETE policy.
DROP POLICY IF EXISTS inv_transfers_select ON ops.inventory_transfers;
CREATE POLICY inv_transfers_select ON ops.inventory_transfers
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS inv_transfer_lines_select ON ops.inventory_transfer_lines;
CREATE POLICY inv_transfer_lines_select ON ops.inventory_transfer_lines
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS inv_movements_select ON ops.inventory_movements;
CREATE POLICY inv_movements_select ON ops.inventory_movements
  FOR SELECT TO authenticated USING (TRUE);

-- Schema-level grants. The view + base tables need explicit SELECT for
-- authenticated; INSERT/UPDATE on locations is the only direct write surface.
GRANT USAGE ON SCHEMA ops TO authenticated;
GRANT SELECT ON ops.inventory_locations      TO authenticated;
GRANT INSERT, UPDATE ON ops.inventory_locations TO authenticated;
GRANT SELECT ON ops.inventory_transfers      TO authenticated;
GRANT SELECT ON ops.inventory_transfer_lines TO authenticated;
GRANT SELECT ON ops.inventory_movements      TO authenticated;
GRANT SELECT ON ops.v_inventory_on_hand      TO authenticated;
