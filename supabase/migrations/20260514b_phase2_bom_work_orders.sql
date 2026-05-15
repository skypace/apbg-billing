-- ============================================================================
-- Phase 2 — Bill of Materials + Work Orders for co-pack manufacturing
--
-- Solves the "what does a finished can actually cost" problem. Today the
-- balance-sheet hack (raw materials on the books, offset by POs with line
-- items) hides the true unit cost. This module replaces it with proper
-- BOM-driven cost rollup.
--
-- Data model:
--   ops.product_bom          — header per finished SKU
--   ops.product_bom_lines    — components + service-fee lines
--   ops.work_orders          — production batches against a BOM
--   ops.work_order_costs     — rolled-up cost snapshot at close
--
-- Status flow (work orders):
--   draft → consumed → closed
--   (draft) → void
--
-- consumed: posts production_consume movement rows for every component
--           at the production_location (qty = qty_to_produce / yield_qty
--           × qty_per × (1 + scrap_pct))
--   closed: posts production_yield movement row for the finished SKU
--           and snapshots work_order_costs with rolled-up unit cost
--
-- Reuses ops.inventory_movements with movement_type IN
-- ('production_consume','production_yield') already provisioned in
-- 20260513a_inventory_stock.sql.
--
-- QBO writeback (Class tags + journal entries) is Phase 3.
-- See architecture/PRODUCT-CONTROL.md for the full design.
-- ============================================================================


-- ── 1. product_bom ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.product_bom (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finished_qbo_item_id  TEXT NOT NULL,
  version               TEXT NOT NULL DEFAULT '1',
  effective_date        DATE,
  yield_qty             NUMERIC NOT NULL CHECK (yield_qty > 0),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  notes                 TEXT,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (finished_qbo_item_id, version)
);

CREATE INDEX IF NOT EXISTS product_bom_finished_idx
  ON ops.product_bom (finished_qbo_item_id, is_active);

CREATE OR REPLACE FUNCTION ops.tg_product_bom_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS product_bom_touch ON ops.product_bom;
CREATE TRIGGER product_bom_touch
  BEFORE UPDATE ON ops.product_bom
  FOR EACH ROW EXECUTE FUNCTION ops.tg_product_bom_touch();


-- ── 2. product_bom_lines ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.product_bom_lines (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id                 UUID NOT NULL REFERENCES ops.product_bom(id) ON DELETE CASCADE,
  line_type              TEXT NOT NULL CHECK (line_type IN ('component','service')),
  component_qbo_item_id  TEXT,                                    -- null for service
  service_label          TEXT,                                    -- null for component
  qty_per                NUMERIC NOT NULL CHECK (qty_per > 0),
  scrap_pct              NUMERIC NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct < 1),
  default_cost           NUMERIC,
  notes                  TEXT,
  sort_order             INTEGER NOT NULL DEFAULT 100,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (line_type = 'component' AND component_qbo_item_id IS NOT NULL AND service_label IS NULL)
    OR
    (line_type = 'service' AND service_label IS NOT NULL AND component_qbo_item_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS product_bom_lines_bom_idx
  ON ops.product_bom_lines (bom_id, sort_order);

CREATE INDEX IF NOT EXISTS product_bom_lines_component_idx
  ON ops.product_bom_lines (component_qbo_item_id)
  WHERE component_qbo_item_id IS NOT NULL;


-- ── 3. work_orders ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.work_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code              TEXT NOT NULL UNIQUE,
  bom_id                  UUID NOT NULL REFERENCES ops.product_bom(id) ON DELETE RESTRICT,
  finished_qbo_item_id    TEXT NOT NULL,
  qty_to_produce          NUMERIC NOT NULL CHECK (qty_to_produce > 0),
  qty_produced_actual     NUMERIC CHECK (qty_produced_actual IS NULL OR qty_produced_actual >= 0),
  production_location_id  UUID NOT NULL REFERENCES ops.inventory_locations(id) ON DELETE RESTRICT,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','consumed','closed','void')),
  scheduled_date          DATE,
  consumed_at             TIMESTAMPTZ,
  consumed_by             UUID REFERENCES auth.users(id),
  closed_at               TIMESTAMPTZ,
  closed_by               UUID REFERENCES auth.users(id),
  voided_at               TIMESTAMPTZ,
  voided_by               UUID REFERENCES auth.users(id),
  void_reason             TEXT,
  notes                   TEXT,
  created_by              UUID REFERENCES auth.users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_orders_status_idx
  ON ops.work_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS work_orders_finished_idx
  ON ops.work_orders (finished_qbo_item_id);

CREATE INDEX IF NOT EXISTS work_orders_bom_idx
  ON ops.work_orders (bom_id);

CREATE INDEX IF NOT EXISTS work_orders_location_idx
  ON ops.work_orders (production_location_id);

CREATE OR REPLACE FUNCTION ops.tg_work_orders_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS work_orders_touch ON ops.work_orders;
CREATE TRIGGER work_orders_touch
  BEFORE UPDATE ON ops.work_orders
  FOR EACH ROW EXECUTE FUNCTION ops.tg_work_orders_touch();


-- ── 4. work_order_costs (snapshot at close) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.work_order_costs (
  wo_id            UUID PRIMARY KEY REFERENCES ops.work_orders(id) ON DELETE CASCADE,
  components_cost  NUMERIC NOT NULL DEFAULT 0,
  services_cost    NUMERIC NOT NULL DEFAULT 0,
  total_cost       NUMERIC NOT NULL DEFAULT 0,
  unit_cost        NUMERIC,
  qty_produced     NUMERIC NOT NULL,
  detail           JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ── 5. WO batch-code generator ──────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ops.work_order_seq;

CREATE OR REPLACE FUNCTION ops.fn_next_wo_batch_code()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  yr  TEXT := to_char(now(), 'YYYY');
  seq BIGINT := nextval('ops.work_order_seq');
BEGIN
  RETURN 'WO-' || yr || '-' || lpad(seq::text, 5, '0');
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_next_wo_batch_code() TO anon, authenticated;


-- ── 6. fn_create_bom ────────────────────────────────────────────────────────
-- Args:
--   p_finished_qbo_item_id  text   — the SKU this BOM produces
--   p_yield_qty             numeric — units of finished good per "batch"
--   p_lines                 jsonb  — [{line_type, component_qbo_item_id?, service_label?, qty_per, scrap_pct?, default_cost?, notes?}, ...]
--   p_version               text   — defaults to '1'
--   p_effective_date        date   — optional
--   p_notes                 text   — optional
-- Returns the new bom id.
CREATE OR REPLACE FUNCTION ops.fn_create_bom(
  p_finished_qbo_item_id TEXT,
  p_yield_qty            NUMERIC,
  p_lines                JSONB,
  p_version              TEXT DEFAULT '1',
  p_effective_date       DATE DEFAULT NULL,
  p_notes                TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id     UUID;
  v_actor  UUID := auth.uid();
  v_line   JSONB;
  v_lt     TEXT;
  v_sort   INTEGER := 100;
BEGIN
  IF p_finished_qbo_item_id IS NULL OR p_finished_qbo_item_id = '' THEN
    RAISE EXCEPTION 'finished_qbo_item_id is required';
  END IF;
  IF p_yield_qty IS NULL OR p_yield_qty <= 0 THEN
    RAISE EXCEPTION 'yield_qty must be > 0';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  INSERT INTO ops.product_bom (
    finished_qbo_item_id, version, effective_date, yield_qty, notes, created_by
  )
  VALUES (
    p_finished_qbo_item_id, p_version, p_effective_date, p_yield_qty, p_notes, v_actor
  )
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_lt := v_line ->> 'line_type';
    IF v_lt NOT IN ('component', 'service') THEN
      RAISE EXCEPTION 'line_type must be component or service';
    END IF;
    IF (v_line ->> 'qty_per') IS NULL OR (v_line ->> 'qty_per')::numeric <= 0 THEN
      RAISE EXCEPTION 'qty_per must be > 0';
    END IF;
    IF v_lt = 'component' AND (v_line ->> 'component_qbo_item_id') IS NULL THEN
      RAISE EXCEPTION 'component lines require component_qbo_item_id';
    END IF;
    IF v_lt = 'service' AND (v_line ->> 'service_label') IS NULL THEN
      RAISE EXCEPTION 'service lines require service_label';
    END IF;

    INSERT INTO ops.product_bom_lines (
      bom_id, line_type, component_qbo_item_id, service_label,
      qty_per, scrap_pct, default_cost, notes, sort_order
    )
    VALUES (
      v_id, v_lt,
      CASE WHEN v_lt = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_lt = 'service'   THEN v_line ->> 'service_label'   END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'scrap_pct', '')::numeric, 0),
      NULLIF(v_line ->> 'default_cost', '')::numeric,
      v_line ->> 'notes',
      v_sort
    );
    v_sort := v_sort + 10;
  END LOOP;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_create_bom(TEXT, NUMERIC, JSONB, TEXT, DATE, TEXT) TO authenticated;


-- ── 7. fn_replace_bom_lines ─────────────────────────────────────────────────
-- For editing an existing BOM. Drops all lines and re-inserts. Only allowed
-- when no work orders reference this BOM in a non-terminal state.
CREATE OR REPLACE FUNCTION ops.fn_replace_bom_lines(
  p_bom_id UUID,
  p_lines  JSONB
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_active_wos INTEGER;
  v_line       JSONB;
  v_lt         TEXT;
  v_sort       INTEGER := 100;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  SELECT count(*) INTO v_active_wos
    FROM ops.work_orders WHERE bom_id = p_bom_id AND status IN ('draft','consumed');
  IF v_active_wos > 0 THEN
    RAISE EXCEPTION 'Cannot edit lines: % active work order(s) reference this BOM. Close or void them first.', v_active_wos;
  END IF;

  DELETE FROM ops.product_bom_lines WHERE bom_id = p_bom_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_lt := v_line ->> 'line_type';
    IF v_lt NOT IN ('component', 'service') THEN
      RAISE EXCEPTION 'line_type must be component or service';
    END IF;
    INSERT INTO ops.product_bom_lines (
      bom_id, line_type, component_qbo_item_id, service_label,
      qty_per, scrap_pct, default_cost, notes, sort_order
    )
    VALUES (
      p_bom_id, v_lt,
      CASE WHEN v_lt = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_lt = 'service'   THEN v_line ->> 'service_label'   END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'scrap_pct', '')::numeric, 0),
      NULLIF(v_line ->> 'default_cost', '')::numeric,
      v_line ->> 'notes',
      v_sort
    );
    v_sort := v_sort + 10;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_replace_bom_lines(UUID, JSONB) TO authenticated;


-- ── 8. fn_create_work_order ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_create_work_order(
  p_bom_id                 UUID,
  p_qty_to_produce         NUMERIC,
  p_production_location_id UUID,
  p_scheduled_date         DATE DEFAULT NULL,
  p_notes                  TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id               UUID;
  v_batch            TEXT;
  v_finished_item_id TEXT;
  v_loc_kind         TEXT;
  v_actor            UUID := auth.uid();
BEGIN
  IF p_qty_to_produce IS NULL OR p_qty_to_produce <= 0 THEN
    RAISE EXCEPTION 'qty_to_produce must be > 0';
  END IF;

  SELECT finished_qbo_item_id INTO v_finished_item_id
    FROM ops.product_bom WHERE id = p_bom_id AND is_active;
  IF v_finished_item_id IS NULL THEN
    RAISE EXCEPTION 'bom_id not found or inactive';
  END IF;

  SELECT kind INTO v_loc_kind FROM ops.inventory_locations WHERE id = p_production_location_id;
  IF v_loc_kind IS NULL THEN
    RAISE EXCEPTION 'production_location_id not found';
  END IF;
  IF v_loc_kind IN ('in_transit', 'adjustment') THEN
    RAISE EXCEPTION 'Production location cannot be a virtual location';
  END IF;

  v_batch := ops.fn_next_wo_batch_code();

  INSERT INTO ops.work_orders (
    batch_code, bom_id, finished_qbo_item_id, qty_to_produce,
    production_location_id, status, scheduled_date, notes, created_by
  )
  VALUES (
    v_batch, p_bom_id, v_finished_item_id, p_qty_to_produce,
    p_production_location_id, 'draft', p_scheduled_date, p_notes, v_actor
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_create_work_order(UUID, NUMERIC, UUID, DATE, TEXT) TO authenticated;


-- ── 9. fn_consume_work_order — draft → consumed ─────────────────────────────
-- Posts production_consume movement rows for every component line:
--   from_location = production_location  (component disappears from there)
--   to_location   = null                  (consumed for production)
-- Qty per component = (qty_to_produce / yield_qty) × qty_per × (1 + scrap_pct).
-- Service lines don't produce movements (services are cost-only).
CREATE OR REPLACE FUNCTION ops.fn_consume_work_order(p_wo_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status   TEXT;
  v_bom_id   UUID;
  v_qty_prod NUMERIC;
  v_loc_id   UUID;
  v_actor    UUID := auth.uid();
  v_yield    NUMERIC;
BEGIN
  SELECT w.status, w.bom_id, w.qty_to_produce, w.production_location_id, b.yield_qty
    INTO v_status, v_bom_id, v_qty_prod, v_loc_id, v_yield
    FROM ops.work_orders w
    JOIN ops.product_bom b ON b.id = w.bom_id
    WHERE w.id = p_wo_id FOR UPDATE OF w;

  IF v_status IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'work order % is %, can only consume from draft', p_wo_id, v_status;
  END IF;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  SELECT
    'production_consume',
    l.component_qbo_item_id,
    (v_qty_prod / v_yield) * l.qty_per * (1 + l.scrap_pct),
    v_loc_id,
    NULL,
    COALESCE(l.default_cost,
             (SELECT purchase_cost FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id)),
    'work_order', p_wo_id, l.id,
    now(), v_actor,
    'WO consume · ' || COALESCE(l.notes, '')
  FROM ops.product_bom_lines l
  WHERE l.bom_id = v_bom_id AND l.line_type = 'component';

  UPDATE ops.work_orders
     SET status = 'consumed', consumed_at = now(), consumed_by = v_actor
   WHERE id = p_wo_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_consume_work_order(UUID) TO authenticated;


-- ── 10. fn_close_work_order — consumed → closed (yield + cost snapshot) ─────
-- Posts one production_yield movement for the finished SKU and snapshots
-- ops.work_order_costs with the rolled-up unit cost.
CREATE OR REPLACE FUNCTION ops.fn_close_work_order(
  p_wo_id              UUID,
  p_qty_produced_actual NUMERIC,
  p_close_date         DATE DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status           TEXT;
  v_bom_id           UUID;
  v_loc_id           UUID;
  v_finished_item_id TEXT;
  v_qty_to_produce   NUMERIC;
  v_yield            NUMERIC;
  v_actor            UUID := auth.uid();
  v_components_cost  NUMERIC := 0;
  v_services_cost    NUMERIC := 0;
  v_total_cost       NUMERIC;
  v_unit_cost        NUMERIC;
  v_detail           JSONB := '[]'::jsonb;
BEGIN
  IF p_qty_produced_actual IS NULL OR p_qty_produced_actual <= 0 THEN
    RAISE EXCEPTION 'qty_produced_actual must be > 0';
  END IF;

  SELECT w.status, w.bom_id, w.production_location_id, w.finished_qbo_item_id,
         w.qty_to_produce, b.yield_qty
    INTO v_status, v_bom_id, v_loc_id, v_finished_item_id,
         v_qty_to_produce, v_yield
    FROM ops.work_orders w
    JOIN ops.product_bom b ON b.id = w.bom_id
    WHERE w.id = p_wo_id FOR UPDATE OF w;

  IF v_status IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_status <> 'consumed' THEN
    RAISE EXCEPTION 'work order % is %, can only close from consumed', p_wo_id, v_status;
  END IF;

  -- Components: cost = qty consumed × unit_cost (from default_cost or qbo_items.purchase_cost).
  WITH comp AS (
    SELECT
      l.id, l.component_qbo_item_id AS item_id,
      (v_qty_to_produce / v_yield) * l.qty_per * (1 + l.scrap_pct) AS qty_consumed,
      COALESCE(l.default_cost,
               (SELECT purchase_cost FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id)) AS unit_cost,
      (SELECT name FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id) AS item_name,
      l.notes
    FROM ops.product_bom_lines l
    WHERE l.bom_id = v_bom_id AND l.line_type = 'component'
  )
  SELECT
    COALESCE(sum(qty_consumed * COALESCE(unit_cost, 0)), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'kind', 'component',
      'label', COALESCE(item_name, item_id),
      'qbo_item_id', item_id,
      'qty', qty_consumed,
      'unit_cost', unit_cost,
      'extended_cost', qty_consumed * COALESCE(unit_cost, 0),
      'notes', notes
    ) ORDER BY item_name), '[]'::jsonb)
  INTO v_components_cost, v_detail
  FROM comp;

  -- Services: cost = qty_per × default_cost. No movement, just a P&L line.
  WITH svc AS (
    SELECT
      l.id, l.service_label, l.qty_per * (v_qty_to_produce / v_yield) AS qty,
      l.default_cost, l.notes
    FROM ops.product_bom_lines l
    WHERE l.bom_id = v_bom_id AND l.line_type = 'service'
  )
  SELECT
    COALESCE(sum(qty * COALESCE(default_cost, 0)), 0),
    v_detail || COALESCE(jsonb_agg(jsonb_build_object(
      'kind', 'service',
      'label', service_label,
      'qty', qty,
      'unit_cost', default_cost,
      'extended_cost', qty * COALESCE(default_cost, 0),
      'notes', notes
    ) ORDER BY service_label), '[]'::jsonb)
  INTO v_services_cost, v_detail
  FROM svc;

  v_total_cost := v_components_cost + v_services_cost;
  v_unit_cost  := CASE WHEN p_qty_produced_actual > 0
                       THEN v_total_cost / p_qty_produced_actual
                       ELSE NULL END;

  -- Yield movement: finished SKU appears at production location.
  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  VALUES (
    'production_yield', v_finished_item_id, p_qty_produced_actual,
    NULL, v_loc_id, v_unit_cost,
    'work_order', p_wo_id, NULL,
    COALESCE(p_close_date::timestamptz, now()), v_actor,
    'WO yield · ' || (SELECT batch_code FROM ops.work_orders WHERE id = p_wo_id)
  );

  -- Snapshot.
  INSERT INTO ops.work_order_costs (
    wo_id, components_cost, services_cost, total_cost, unit_cost,
    qty_produced, detail, computed_at
  )
  VALUES (
    p_wo_id, v_components_cost, v_services_cost, v_total_cost, v_unit_cost,
    p_qty_produced_actual, v_detail, now()
  )
  ON CONFLICT (wo_id) DO UPDATE SET
    components_cost = EXCLUDED.components_cost,
    services_cost   = EXCLUDED.services_cost,
    total_cost      = EXCLUDED.total_cost,
    unit_cost       = EXCLUDED.unit_cost,
    qty_produced    = EXCLUDED.qty_produced,
    detail          = EXCLUDED.detail,
    computed_at     = now();

  UPDATE ops.work_orders
     SET status              = 'closed',
         qty_produced_actual = p_qty_produced_actual,
         closed_at           = now(),
         closed_by           = v_actor
   WHERE id = p_wo_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_close_work_order(UUID, NUMERIC, DATE) TO authenticated;


-- ── 11. fn_void_work_order — draft → void ──────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_void_work_order(
  p_wo_id  UUID,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_status TEXT; v_actor UUID := auth.uid();
BEGIN
  SELECT status INTO v_status FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'work order % is %, can only void from draft', p_wo_id, v_status;
  END IF;
  UPDATE ops.work_orders
     SET status = 'void', voided_at = now(), voided_by = v_actor, void_reason = p_reason
   WHERE id = p_wo_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_void_work_order(UUID, TEXT) TO authenticated;


-- ── 12. RLS + grants ────────────────────────────────────────────────────────
ALTER TABLE ops.product_bom       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.product_bom_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.work_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.work_order_costs  ENABLE ROW LEVEL SECURITY;

-- Read-only direct access for authenticated users. Writes go via RPCs.
DROP POLICY IF EXISTS product_bom_select         ON ops.product_bom;
CREATE POLICY product_bom_select         ON ops.product_bom         FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS product_bom_lines_select   ON ops.product_bom_lines;
CREATE POLICY product_bom_lines_select   ON ops.product_bom_lines   FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS work_orders_select         ON ops.work_orders;
CREATE POLICY work_orders_select         ON ops.work_orders         FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS work_order_costs_select    ON ops.work_order_costs;
CREATE POLICY work_order_costs_select    ON ops.work_order_costs    FOR SELECT TO authenticated USING (TRUE);

-- Header UPDATE on product_bom (status flips, version/notes edits) — direct.
DROP POLICY IF EXISTS product_bom_update         ON ops.product_bom;
CREATE POLICY product_bom_update         ON ops.product_bom         FOR UPDATE TO authenticated
  USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT         ON ops.product_bom       TO authenticated;
GRANT UPDATE         ON ops.product_bom       TO authenticated;
GRANT SELECT         ON ops.product_bom_lines TO authenticated;
GRANT SELECT         ON ops.work_orders       TO authenticated;
GRANT SELECT         ON ops.work_order_costs  TO authenticated;
