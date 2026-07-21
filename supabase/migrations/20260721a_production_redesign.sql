-- ============================================================================
-- Production redesign — formula-driven BOM → Work Order → PO pipeline
--
-- Redesign requested 2026-07-21: the formula / product spec sheet becomes the
-- driver of everything, the BOM becomes a pure parts list, and ALL quantity /
-- cost calculations move onto the work order and its purchase orders.
--
--   product spec sheet (formula)        ops.product_formulas (+ ingredients,
--     │                                  revisions) — the driver
--     ▼
--   BOM = sellable item + sub-items     ops.product_bom(+lines) gains
--     │   (no calculations here)         formula_id; each line gains a
--     ▼                                  preferred vendor
--   WORK ORDER for qty to make          ops.work_orders gains the pipeline;
--     │   materials calc happens HERE    ops.work_order_materials = the
--     ▼                                  computed requirements, per vendor
--   POs generated FROM the WO           one PO per vendor, linked back via
--     │                                  purchase_orders.work_order_id
--     ▼
--   PRODUCTION PIPELINE on the WO:
--     draft → ordered → at_copacker → in_production → yield_recorded
--           → in_transit → received → closed          (void from pre-consume)
--
--   ordered           POs issued to vendors (raw materials en route)
--   at_copacker       raw materials received at the co-packer (PO receipts
--                     land at the co-packer location, so on-hand is truthful)
--   in_production     components consumed (production_consume movements)
--   yield_recorded    actual yield entered; production_yield movement +
--                     cost snapshot (ops.work_order_costs)
--   in_transit        shipping record — a real BOL transfer from the
--                     co-packer back to our warehouse
--   received          finished goods received into our inventory
--
-- The legacy in-house flow (draft → consumed → closed) is retired: the live
-- tables held ZERO work orders / POs / co-pack orders at redesign time, so
-- no data migration is needed. Legacy RPCs are left in place but the new UI
-- no longer calls them.
-- ============================================================================


-- ── 1. product_formulas — the spec sheet / formula library ──────────────────
CREATE TABLE IF NOT EXISTS ops.product_formulas (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL UNIQUE,          -- "Hangar 25 Cola"
  code                   TEXT,                          -- co-packer doc code, e.g. "Q0XXX"
  title                  TEXT,                          -- sheet title, e.g. "Quantum Canning Batching Data"
  doc_rev                TEXT NOT NULL DEFAULT '1.0',
  effective_date         DATE,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('draft','active','archived')),
  default_batch_size_gal NUMERIC,
  can_size_oz            NUMERIC,
  density_lbs_per_gal    NUMERIC,                       -- finished product density
  water_lbs_per_gal      NUMERIC DEFAULT 8.345,
  qc_specs               JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"pH":"2.50-2.60","Brix":"11.8+/-0.2",...}
  batching_instructions  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ordered step strings
  comments               TEXT,
  attachment_path        TEXT,                          -- storage path in bucket product-formulas
  source_file_name       TEXT,                          -- original spreadsheet filename
  created_by             UUID REFERENCES auth.users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ops.tg_product_formulas_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS product_formulas_touch ON ops.product_formulas;
CREATE TRIGGER product_formulas_touch
  BEFORE UPDATE ON ops.product_formulas
  FOR EACH ROW EXECUTE FUNCTION ops.tg_product_formulas_touch();


-- ── 2. product_formula_ingredients ──────────────────────────────────────────
-- Percent-by-weight recipe rows. Weights for a given batch are DERIVED
-- (batch gal × density lbs/gal × pct), never stored — the calc happens where
-- it's used (work order batching sheet / formula viewer).
CREATE TABLE IF NOT EXISTS ops.product_formula_ingredients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id            UUID NOT NULL REFERENCES ops.product_formulas(id) ON DELETE CASCADE,
  ingredient_name       TEXT NOT NULL,
  pct_by_weight         NUMERIC NOT NULL CHECK (pct_by_weight > 0 AND pct_by_weight <= 1),
  uom                   TEXT NOT NULL DEFAULT 'lbs',
  component_qbo_item_id TEXT,                           -- optional link to the raw-material item
  sort_order            INTEGER NOT NULL DEFAULT 100,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_formula_ingredients_formula_idx
  ON ops.product_formula_ingredients (formula_id, sort_order);


-- ── 3. product_formula_revisions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.product_formula_revisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id  UUID NOT NULL REFERENCES ops.product_formulas(id) ON DELETE CASCADE,
  rev         TEXT NOT NULL,
  note        TEXT,
  rev_date    DATE,
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_formula_revisions_formula_idx
  ON ops.product_formula_revisions (formula_id, created_at DESC);


-- ── 4. BOM: attach to formula; lines carry their vendor ─────────────────────
ALTER TABLE ops.product_bom
  ADD COLUMN IF NOT EXISTS formula_id UUID REFERENCES ops.product_formulas(id) ON DELETE SET NULL;

ALTER TABLE ops.product_bom_lines
  ADD COLUMN IF NOT EXISTS preferred_qbo_vendor_id TEXT;

CREATE INDEX IF NOT EXISTS product_bom_formula_idx
  ON ops.product_bom (formula_id) WHERE formula_id IS NOT NULL;


-- ── 5. work_orders: the production pipeline ─────────────────────────────────
ALTER TABLE ops.work_orders
  ADD COLUMN IF NOT EXISTS formula_id                UUID REFERENCES ops.product_formulas(id),
  ADD COLUMN IF NOT EXISTS copacker_qbo_vendor_id    TEXT,
  ADD COLUMN IF NOT EXISTS copacker_location_id      UUID REFERENCES ops.inventory_locations(id),
  ADD COLUMN IF NOT EXISTS destination_location_id   UUID REFERENCES ops.inventory_locations(id),
  ADD COLUMN IF NOT EXISTS batch_size_gal            NUMERIC,
  ADD COLUMN IF NOT EXISTS expected_units            NUMERIC,
  ADD COLUMN IF NOT EXISTS yield_pct                 NUMERIC,
  ADD COLUMN IF NOT EXISTS ordered_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS materials_at_copacker_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS production_started_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS yield_recorded_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shipped_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ship_carrier              TEXT,
  ADD COLUMN IF NOT EXISTS ship_tracking             TEXT,
  ADD COLUMN IF NOT EXISTS ship_bol_number           TEXT,
  ADD COLUMN IF NOT EXISTS transfer_id               UUID REFERENCES ops.inventory_transfers(id);

-- New status pipeline. The table is empty (verified live 2026-07-21), so the
-- CHECK can be replaced wholesale. 'consumed' stays valid so the legacy
-- consume/close RPCs fail cleanly at their own guards rather than at the
-- constraint if anything still calls them.
ALTER TABLE ops.work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE ops.work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN (
    'draft','ordered','at_copacker','in_production','yield_recorded',
    'in_transit','received','closed','void',
    'consumed'  -- legacy value
  ));


-- ── 6. work_order_materials — the calc lives on the WORK ORDER ──────────────
-- Snapshotted at WO creation: every sub-item, its total required quantity,
-- and the vendor it should be purchased from. When POs are generated the
-- rows link to their PO line.
CREATE TABLE IF NOT EXISTS ops.work_order_materials (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id                  UUID NOT NULL REFERENCES ops.work_orders(id) ON DELETE CASCADE,
  bom_line_id            UUID REFERENCES ops.product_bom_lines(id) ON DELETE SET NULL,
  component_qbo_item_id  TEXT NOT NULL,
  item_name              TEXT,
  required_qty           NUMERIC NOT NULL CHECK (required_qty > 0),
  uom                    TEXT NOT NULL DEFAULT 'each',
  unit_cost_est          NUMERIC,
  qbo_vendor_id          TEXT,
  vendor_name            TEXT,
  po_id                  UUID REFERENCES ops.purchase_orders(id) ON DELETE SET NULL,
  po_line_id             UUID REFERENCES ops.purchase_order_lines(id) ON DELETE SET NULL,
  sort_order             INTEGER NOT NULL DEFAULT 100,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_order_materials_wo_idx
  ON ops.work_order_materials (wo_id, sort_order);


-- ── 7. work_order_events — pipeline audit trail ─────────────────────────────
CREATE TABLE IF NOT EXISTS ops.work_order_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id        UUID NOT NULL REFERENCES ops.work_orders(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_order_events_wo_idx
  ON ops.work_order_events (wo_id, created_at);


-- ── 8. purchase_orders: link back to the work order ─────────────────────────
ALTER TABLE ops.purchase_orders
  ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES ops.work_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_wo_idx
  ON ops.purchase_orders (work_order_id) WHERE work_order_id IS NOT NULL;

-- v_purchase_orders rebuilt to expose the WO linkage.
DROP VIEW IF EXISTS ops.v_purchase_orders;
CREATE VIEW ops.v_purchase_orders AS
SELECT
  o.id, o.po_number, o.qbo_vendor_id,
  v.display_name AS vendor_name,
  o.destination_location_id,
  loc.code || ' · ' || loc.name AS location_label,
  o.status, o.expected_date, o.subtotal, o.notes,
  o.qbo_purchase_order_id, o.qbo_pushed_at, o.qbo_push_error,
  o.ordered_at, o.received_at, o.closed_at, o.voided_at, o.void_reason,
  o.work_order_id,
  wo.batch_code AS work_order_batch_code,
  COALESCE(l.line_count, 0)         AS line_count,
  COALESCE(l.qty_ordered_total, 0)  AS qty_ordered_total,
  COALESCE(l.qty_received_total, 0) AS qty_received_total,
  o.created_at, o.updated_at
FROM ops.purchase_orders o
LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = o.qbo_vendor_id
LEFT JOIN ops.inventory_locations loc ON loc.id = o.destination_location_id
LEFT JOIN ops.work_orders wo ON wo.id = o.work_order_id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS line_count,
         sum(qty_ordered)  AS qty_ordered_total,
         sum(qty_received) AS qty_received_total
  FROM ops.purchase_order_lines pl WHERE pl.po_id = o.id
) l ON TRUE;

GRANT SELECT ON ops.v_purchase_orders TO authenticated;


-- ── 9. v_work_orders — pipeline list view ────────────────────────────────────
DROP VIEW IF EXISTS ops.v_work_orders;
CREATE VIEW ops.v_work_orders AS
SELECT
  w.*,
  b.name          AS bom_name,
  b.version       AS bom_version,
  b.yield_uom     AS bom_yield_uom,
  b.cans_per_case AS bom_cans_per_case,
  b.oz_per_can    AS bom_oz_per_can,
  f.name          AS formula_name,
  f.doc_rev       AS formula_doc_rev,
  it.name         AS finished_item_name,
  cv.display_name AS copacker_vendor_name,
  cl.code || ' · ' || cl.name AS copacker_location_label,
  dl.code || ' · ' || dl.name AS destination_location_label,
  t.bol_number    AS transfer_bol_number,
  t.status        AS transfer_status,
  c.total_cost, c.unit_cost, c.components_cost, c.services_cost,
  po.po_count, po.po_open_count
FROM ops.work_orders w
LEFT JOIN ops.product_bom b        ON b.id = w.bom_id
LEFT JOIN ops.product_formulas f   ON f.id = w.formula_id
LEFT JOIN ops.qbo_items it         ON it.qbo_item_id = w.finished_qbo_item_id
LEFT JOIN ops.qbo_vendors cv       ON cv.qbo_vendor_id = w.copacker_qbo_vendor_id
LEFT JOIN ops.inventory_locations cl ON cl.id = w.copacker_location_id
LEFT JOIN ops.inventory_locations dl ON dl.id = w.destination_location_id
LEFT JOIN ops.inventory_transfers t  ON t.id = w.transfer_id
LEFT JOIN ops.work_order_costs c     ON c.wo_id = w.id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS po_count,
         count(*) FILTER (WHERE p.status IN ('open','partial'))::int AS po_open_count
  FROM ops.purchase_orders p WHERE p.work_order_id = w.id
) po ON TRUE;

GRANT SELECT ON ops.v_work_orders TO authenticated;


-- ── 10. fn_formula_save — create/update a formula + ingredients ─────────────
-- p_header keys: name, code, title, doc_rev, effective_date, status,
--   default_batch_size_gal, can_size_oz, density_lbs_per_gal,
--   water_lbs_per_gal, qc_specs, batching_instructions, comments,
--   attachment_path, source_file_name
-- p_ingredients: [{ingredient_name, pct_by_weight, uom?, component_qbo_item_id?, notes?}, ...]
-- Appends a revision row when p_revision_note is provided.
CREATE OR REPLACE FUNCTION ops.fn_formula_save(
  p_id            UUID,
  p_header        JSONB,
  p_ingredients   JSONB,
  p_revision_note TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id    UUID := p_id;
  v_actor UUID := auth.uid();
  v_row   JSONB;
  v_sort  INTEGER := 100;
BEGIN
  IF p_header IS NULL OR (p_header ->> 'name') IS NULL OR (p_header ->> 'name') = '' THEN
    RAISE EXCEPTION 'formula name is required';
  END IF;
  IF jsonb_typeof(p_ingredients) <> 'array' OR jsonb_array_length(p_ingredients) = 0 THEN
    RAISE EXCEPTION 'p_ingredients must be a non-empty JSON array';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO ops.product_formulas (
      name, code, title, doc_rev, effective_date, status,
      default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
      qc_specs, batching_instructions, comments, attachment_path, source_file_name,
      created_by
    ) VALUES (
      p_header ->> 'name',
      p_header ->> 'code',
      p_header ->> 'title',
      COALESCE(p_header ->> 'doc_rev', '1.0'),
      NULLIF(p_header ->> 'effective_date', '')::date,
      COALESCE(NULLIF(p_header ->> 'status', ''), 'active'),
      NULLIF(p_header ->> 'default_batch_size_gal', '')::numeric,
      NULLIF(p_header ->> 'can_size_oz', '')::numeric,
      NULLIF(p_header ->> 'density_lbs_per_gal', '')::numeric,
      COALESCE(NULLIF(p_header ->> 'water_lbs_per_gal', '')::numeric, 8.345),
      COALESCE(p_header -> 'qc_specs', '{}'::jsonb),
      COALESCE(p_header -> 'batching_instructions', '[]'::jsonb),
      p_header ->> 'comments',
      p_header ->> 'attachment_path',
      p_header ->> 'source_file_name',
      v_actor
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE ops.product_formulas SET
      name                   = COALESCE(p_header ->> 'name', name),
      code                   = p_header ->> 'code',
      title                  = p_header ->> 'title',
      doc_rev                = COALESCE(NULLIF(p_header ->> 'doc_rev', ''), doc_rev),
      effective_date         = NULLIF(p_header ->> 'effective_date', '')::date,
      status                 = COALESCE(NULLIF(p_header ->> 'status', ''), status),
      default_batch_size_gal = NULLIF(p_header ->> 'default_batch_size_gal', '')::numeric,
      can_size_oz            = NULLIF(p_header ->> 'can_size_oz', '')::numeric,
      density_lbs_per_gal    = NULLIF(p_header ->> 'density_lbs_per_gal', '')::numeric,
      water_lbs_per_gal      = COALESCE(NULLIF(p_header ->> 'water_lbs_per_gal', '')::numeric, water_lbs_per_gal),
      qc_specs               = COALESCE(p_header -> 'qc_specs', qc_specs),
      batching_instructions  = COALESCE(p_header -> 'batching_instructions', batching_instructions),
      comments               = p_header ->> 'comments',
      attachment_path        = COALESCE(p_header ->> 'attachment_path', attachment_path),
      source_file_name       = COALESCE(p_header ->> 'source_file_name', source_file_name)
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'formula % not found', v_id; END IF;

    DELETE FROM ops.product_formula_ingredients WHERE formula_id = v_id;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_ingredients) LOOP
    IF (v_row ->> 'ingredient_name') IS NULL OR (v_row ->> 'ingredient_name') = '' THEN
      RAISE EXCEPTION 'every ingredient requires ingredient_name';
    END IF;
    IF (v_row ->> 'pct_by_weight')::numeric IS NULL THEN
      RAISE EXCEPTION 'every ingredient requires pct_by_weight';
    END IF;
    INSERT INTO ops.product_formula_ingredients (
      formula_id, ingredient_name, pct_by_weight, uom,
      component_qbo_item_id, notes, sort_order
    ) VALUES (
      v_id,
      v_row ->> 'ingredient_name',
      (v_row ->> 'pct_by_weight')::numeric,
      COALESCE(NULLIF(v_row ->> 'uom', ''), 'lbs'),
      NULLIF(v_row ->> 'component_qbo_item_id', ''),
      v_row ->> 'notes',
      v_sort
    );
    v_sort := v_sort + 10;
  END LOOP;

  IF p_revision_note IS NOT NULL AND p_revision_note <> '' THEN
    INSERT INTO ops.product_formula_revisions (formula_id, rev, note, rev_date, created_by)
    VALUES (v_id, COALESCE(p_header ->> 'doc_rev', '1.0'), p_revision_note, CURRENT_DATE, v_actor);
  END IF;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_formula_save(UUID, JSONB, JSONB, TEXT) TO authenticated;


-- ── 11. fn_wo_create_pipeline — WO for qty; requirements calc happens here ──
CREATE OR REPLACE FUNCTION ops.fn_wo_create_pipeline(
  p_bom_id                  UUID,
  p_qty_to_produce          NUMERIC,
  p_copacker_qbo_vendor_id  TEXT,
  p_copacker_location_id    UUID,
  p_destination_location_id UUID,
  p_scheduled_date          DATE DEFAULT NULL,
  p_batch_size_gal          NUMERIC DEFAULT NULL,
  p_notes                   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id               UUID;
  v_batch            TEXT;
  v_finished_item_id TEXT;
  v_yield            NUMERIC;
  v_formula_id       UUID;
  v_kind             TEXT;
  v_actor            UUID := auth.uid();
  v_runs             NUMERIC;
BEGIN
  IF p_qty_to_produce IS NULL OR p_qty_to_produce <= 0 THEN
    RAISE EXCEPTION 'qty_to_produce must be > 0';
  END IF;

  SELECT finished_qbo_item_id, yield_qty, formula_id
    INTO v_finished_item_id, v_yield, v_formula_id
    FROM ops.product_bom WHERE id = p_bom_id AND is_active;
  IF v_finished_item_id IS NULL THEN
    RAISE EXCEPTION 'bom_id not found or inactive';
  END IF;

  SELECT kind INTO v_kind FROM ops.inventory_locations WHERE id = p_copacker_location_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'copacker_location_id not found'; END IF;
  IF v_kind IN ('in_transit','adjustment') THEN
    RAISE EXCEPTION 'Co-packer location cannot be a virtual location';
  END IF;

  SELECT kind INTO v_kind FROM ops.inventory_locations WHERE id = p_destination_location_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'destination_location_id not found'; END IF;
  IF v_kind IN ('in_transit','adjustment') THEN
    RAISE EXCEPTION 'Destination cannot be a virtual location';
  END IF;

  v_runs  := p_qty_to_produce / v_yield;
  v_batch := ops.fn_next_wo_batch_code();

  INSERT INTO ops.work_orders (
    batch_code, bom_id, finished_qbo_item_id, qty_to_produce, expected_units,
    production_location_id, copacker_location_id, destination_location_id,
    copacker_qbo_vendor_id, formula_id, batch_size_gal,
    status, scheduled_date, notes, created_by
  ) VALUES (
    v_batch, p_bom_id, v_finished_item_id, p_qty_to_produce, p_qty_to_produce,
    p_copacker_location_id, p_copacker_location_id, p_destination_location_id,
    p_copacker_qbo_vendor_id, v_formula_id, p_batch_size_gal,
    'draft', p_scheduled_date, p_notes, v_actor
  )
  RETURNING id INTO v_id;

  -- Material requirements — THE quantity calculation, snapshotted on the WO.
  -- required = (qty_to_produce / bom yield) × qty_per × (1 + scrap).
  INSERT INTO ops.work_order_materials (
    wo_id, bom_line_id, component_qbo_item_id, item_name,
    required_qty, uom, unit_cost_est, qbo_vendor_id, vendor_name, sort_order, notes
  )
  SELECT
    v_id, l.id, l.component_qbo_item_id,
    (SELECT name FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id),
    v_runs * l.qty_per * (1 + l.scrap_pct),
    COALESCE(l.qty_uom, 'each'),
    COALESCE(l.default_cost,
             (SELECT purchase_cost FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id)),
    l.preferred_qbo_vendor_id,
    (SELECT display_name FROM ops.qbo_vendors WHERE qbo_vendor_id = l.preferred_qbo_vendor_id),
    l.sort_order,
    l.notes
  FROM ops.product_bom_lines l
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component'
  ORDER BY l.sort_order;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
  VALUES (v_id, 'created', NULL, 'draft',
          'Work order created for ' || p_qty_to_produce || ' units', v_actor);

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_create_pipeline(UUID, NUMERIC, TEXT, UUID, UUID, DATE, NUMERIC, TEXT) TO authenticated;


-- ── 12. fn_wo_generate_pos — one PO per vendor, from the WO's materials ─────
-- Groups every unassigned material row by its vendor, creates one PO per
-- vendor (destination = the co-packer, where the raw materials must land),
-- links each material row to its PO line, and advances draft → ordered.
CREATE OR REPLACE FUNCTION ops.fn_wo_generate_pos(
  p_wo_id         UUID,
  p_expected_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status    TEXT;
  v_batch     TEXT;
  v_copacker  UUID;
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
BEGIN
  SELECT status, batch_code, copacker_location_id
    INTO v_status, v_batch, v_copacker
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

    INSERT INTO ops.purchase_orders (
      po_number, qbo_vendor_id, destination_location_id, status,
      expected_date, notes, work_order_id, created_by, ordered_at, ordered_by
    ) VALUES (
      v_po_number, v_vendor, v_copacker, 'open',
      p_expected_date, 'Materials for work order ' || v_batch, p_wo_id,
      v_actor, now(), v_actor
    )
    RETURNING id INTO v_po_id;

    FOR v_mat IN
      SELECT * FROM ops.work_order_materials
        WHERE wo_id = p_wo_id AND po_id IS NULL AND qbo_vendor_id = v_vendor
        ORDER BY sort_order
    LOOP
      INSERT INTO ops.purchase_order_lines (
        po_id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order
      ) VALUES (
        v_po_id, v_mat.component_qbo_item_id, v_mat.item_name,
        v_mat.required_qty, COALESCE(v_mat.unit_cost_est, 0),
        'WO ' || v_batch, v_sort
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
      'po_id', v_po_id,
      'po_number', v_po_number,
      'qbo_vendor_id', v_vendor,
      'subtotal', v_subtotal
    );
  END LOOP;

  IF v_status = 'draft' THEN
    UPDATE ops.work_orders
       SET status = 'ordered', ordered_at = now()
     WHERE id = p_wo_id;
  END IF;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'pos_generated', v_status, 'ordered',
          jsonb_array_length(v_result) || ' purchase order(s) generated', v_result, v_actor);

  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_generate_pos(UUID, DATE) TO authenticated;


-- ── 13. fn_wo_advance — drive the production pipeline ───────────────────────
-- Actions and their payloads:
--   materials_at_copacker  {}                    ordered → at_copacker
--   start_production       {}                    ordered/at_copacker → in_production
--                                                (posts production_consume movements)
--   record_yield           {actual_yield_qty,    in_production → yield_recorded
--                           copack_fee?, freight_cost?, other_cost?, yield_date?}
--                                                (posts production_yield + cost snapshot)
--   ship                   {carrier?, tracking?, yield_recorded → in_transit
--                           ship_date?}          (creates + ships a BOL transfer
--                                                 co-packer → destination)
--   receive                {received_date?}      in_transit → received
--                                                (receives the transfer: finished
--                                                 goods land in our inventory)
--   close                  {}                    received → closed
--   void                   {reason}              draft/ordered/at_copacker → void
--                                                (voids linked POs w/o receipts)
CREATE OR REPLACE FUNCTION ops.fn_wo_advance(
  p_wo_id   UUID,
  p_action  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_wo               ops.work_orders%ROWTYPE;
  v_actor            UUID := auth.uid();
  v_yield_qty        NUMERIC;
  v_copack_fee       NUMERIC;
  v_freight          NUMERIC;
  v_other            NUMERIC;
  v_components_cost  NUMERIC := 0;
  v_services_cost    NUMERIC := 0;
  v_fees_cost        NUMERIC := 0;
  v_total_cost       NUMERIC;
  v_unit_cost        NUMERIC;
  v_detail           JSONB := '[]'::jsonb;
  v_runs             NUMERIC;
  v_bom              ops.product_bom%ROWTYPE;
  v_transfer_id      UUID;
  v_bol              TEXT;
  v_po               RECORD;
  v_per_case         NUMERIC;
  v_per_can          NUMERIC;
  v_per_oz           NUMERIC;
  v_per_gal          NUMERIC;
  v_yield_pct        NUMERIC;
BEGIN
  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_wo.bom_id;

  -- ── materials_at_copacker ──
  IF p_action = 'materials_at_copacker' THEN
    IF v_wo.status <> 'ordered' THEN
      RAISE EXCEPTION 'work order is %, expected ordered', v_wo.status;
    END IF;
    UPDATE ops.work_orders
       SET status = 'at_copacker', materials_at_copacker_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'materials_at_copacker', v_wo.status, 'at_copacker',
            'Raw materials at co-packer', v_actor);
    RETURN;
  END IF;

  -- ── start_production ──
  IF p_action = 'start_production' THEN
    IF v_wo.status NOT IN ('ordered','at_copacker') THEN
      RAISE EXCEPTION 'work order is %, expected ordered/at_copacker', v_wo.status;
    END IF;

    -- Consume raw materials at the co-packer. Actual PO cost wins over the
    -- estimate when the material's PO line has been received/re-costed.
    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty,
      from_location_id, to_location_id, unit_cost,
      source_doc_type, source_doc_id, source_doc_line_id,
      occurred_at, created_by, notes
    )
    SELECT
      'production_consume', m.component_qbo_item_id, m.required_qty,
      v_wo.copacker_location_id, NULL,
      COALESCE(pl.unit_cost, m.unit_cost_est),
      'work_order', p_wo_id, m.id,
      now(), v_actor,
      'WO consume · ' || v_wo.batch_code
    FROM ops.work_order_materials m
    LEFT JOIN ops.purchase_order_lines pl ON pl.id = m.po_line_id
    WHERE m.wo_id = p_wo_id;

    UPDATE ops.work_orders
       SET status = 'in_production', production_started_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'start_production', v_wo.status, 'in_production',
            'Production started at co-packer (raw materials consumed)', v_actor);
    RETURN;
  END IF;

  -- ── record_yield ──
  IF p_action = 'record_yield' THEN
    IF v_wo.status <> 'in_production' THEN
      RAISE EXCEPTION 'work order is %, expected in_production', v_wo.status;
    END IF;
    v_yield_qty := NULLIF(p_payload ->> 'actual_yield_qty', '')::numeric;
    IF v_yield_qty IS NULL OR v_yield_qty <= 0 THEN
      RAISE EXCEPTION 'actual_yield_qty must be > 0';
    END IF;
    v_copack_fee := COALESCE(NULLIF(p_payload ->> 'copack_fee', '')::numeric, 0);
    v_freight    := COALESCE(NULLIF(p_payload ->> 'freight_cost', '')::numeric, 0);
    v_other      := COALESCE(NULLIF(p_payload ->> 'other_cost', '')::numeric, 0);
    v_runs       := v_wo.qty_to_produce / v_bom.yield_qty;

    -- Component cost: the WO's material rows at actual PO cost when linked.
    SELECT
      COALESCE(sum(m.required_qty * COALESCE(pl.unit_cost, m.unit_cost_est, 0)), 0),
      COALESCE(jsonb_agg(jsonb_build_object(
        'kind', 'component',
        'label', COALESCE(m.item_name, m.component_qbo_item_id),
        'qbo_item_id', m.component_qbo_item_id,
        'qty', m.required_qty,
        'uom', m.uom,
        'unit_cost', COALESCE(pl.unit_cost, m.unit_cost_est),
        'extended_cost', m.required_qty * COALESCE(pl.unit_cost, m.unit_cost_est, 0),
        'notes', m.notes
      ) ORDER BY m.sort_order), '[]'::jsonb)
    INTO v_components_cost, v_detail
    FROM ops.work_order_materials m
    LEFT JOIN ops.purchase_order_lines pl ON pl.id = m.po_line_id
    WHERE m.wo_id = p_wo_id;

    -- Service lines from the BOM (labor/co-pack services priced per run).
    SELECT
      COALESCE(sum(l.qty_per * v_runs * COALESCE(l.default_cost, 0)), 0),
      v_detail || COALESCE(jsonb_agg(jsonb_build_object(
        'kind', 'service',
        'label', l.service_label,
        'qty', l.qty_per * v_runs,
        'unit_cost', l.default_cost,
        'extended_cost', l.qty_per * v_runs * COALESCE(l.default_cost, 0),
        'notes', l.notes
      ) ORDER BY l.sort_order), '[]'::jsonb)
    INTO v_services_cost, v_detail
    FROM ops.product_bom_lines l
    WHERE l.bom_id = v_wo.bom_id AND l.line_type = 'service';

    v_fees_cost := v_copack_fee + v_freight + v_other;
    IF v_copack_fee > 0 THEN
      v_detail := v_detail || jsonb_build_object('kind','landed_cost','label','Co-pack fee','qty',1,'unit_cost',v_copack_fee,'extended_cost',v_copack_fee,'notes',NULL);
    END IF;
    IF v_freight > 0 THEN
      v_detail := v_detail || jsonb_build_object('kind','landed_cost','label','Freight','qty',1,'unit_cost',v_freight,'extended_cost',v_freight,'notes',NULL);
    END IF;
    IF v_other > 0 THEN
      v_detail := v_detail || jsonb_build_object('kind','landed_cost','label','Other landed cost','qty',1,'unit_cost',v_other,'extended_cost',v_other,'notes',NULL);
    END IF;

    v_total_cost := v_components_cost + v_services_cost + v_fees_cost;
    v_unit_cost  := v_total_cost / v_yield_qty;
    v_yield_pct  := CASE WHEN COALESCE(v_wo.expected_units, 0) > 0
                         THEN round(100.0 * v_yield_qty / v_wo.expected_units, 2) END;

    -- Per-pack economics when the BOM knows its pack structure.
    IF COALESCE(v_bom.cans_per_case, 0) > 0 AND COALESCE(v_bom.oz_per_can, 0) > 0 THEN
      v_per_case := v_unit_cost;
      v_per_can  := v_unit_cost / v_bom.cans_per_case;
      v_per_oz   := v_per_can / v_bom.oz_per_can;
      v_per_gal  := v_total_cost / (v_yield_qty * v_bom.cans_per_case * v_bom.oz_per_can / 128.0);
    END IF;

    -- Finished goods appear at the co-packer, ready to ship back to us.
    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty,
      from_location_id, to_location_id, unit_cost,
      source_doc_type, source_doc_id,
      occurred_at, created_by, notes
    ) VALUES (
      'production_yield', v_wo.finished_qbo_item_id, v_yield_qty,
      NULL, v_wo.copacker_location_id, v_unit_cost,
      'work_order', p_wo_id,
      COALESCE(NULLIF(p_payload ->> 'yield_date','')::date::timestamptz, now()), v_actor,
      'WO yield · ' || v_wo.batch_code
    );

    INSERT INTO ops.work_order_costs (
      wo_id, components_cost, services_cost, total_cost, unit_cost,
      qty_produced, per_case, per_can, per_oz, per_gal_finished,
      actual_yield_pct, yield_loss_dollars, detail, computed_at
    ) VALUES (
      p_wo_id, v_components_cost, v_services_cost + v_fees_cost, v_total_cost, v_unit_cost,
      v_yield_qty, v_per_case, v_per_can, v_per_oz, v_per_gal,
      v_yield_pct,
      CASE WHEN COALESCE(v_wo.expected_units,0) > v_yield_qty
           THEN (v_wo.expected_units - v_yield_qty) * v_unit_cost END,
      v_detail, now()
    )
    ON CONFLICT (wo_id) DO UPDATE SET
      components_cost = EXCLUDED.components_cost,
      services_cost   = EXCLUDED.services_cost,
      total_cost      = EXCLUDED.total_cost,
      unit_cost       = EXCLUDED.unit_cost,
      qty_produced    = EXCLUDED.qty_produced,
      per_case        = EXCLUDED.per_case,
      per_can         = EXCLUDED.per_can,
      per_oz          = EXCLUDED.per_oz,
      per_gal_finished = EXCLUDED.per_gal_finished,
      actual_yield_pct = EXCLUDED.actual_yield_pct,
      yield_loss_dollars = EXCLUDED.yield_loss_dollars,
      detail          = EXCLUDED.detail,
      computed_at     = now();

    UPDATE ops.work_orders
       SET status = 'yield_recorded',
           qty_produced_actual = v_yield_qty,
           actual_yield_qty = v_yield_qty,
           yield_pct = v_yield_pct,
           yield_recorded_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (p_wo_id, 'record_yield', v_wo.status, 'yield_recorded',
            'Yield recorded: ' || v_yield_qty || ' units'
              || COALESCE(' (' || v_yield_pct || '% of plan)', ''),
            p_payload, v_actor);
    RETURN;
  END IF;

  -- ── ship ──
  IF p_action = 'ship' THEN
    IF v_wo.status <> 'yield_recorded' THEN
      RAISE EXCEPTION 'work order is %, expected yield_recorded', v_wo.status;
    END IF;

    SELECT unit_cost INTO v_unit_cost FROM ops.work_order_costs WHERE wo_id = p_wo_id;

    -- All 12 args passed explicitly: fn_create_transfer has a live 6-arg
    -- legacy overload, and a defaulted call is ambiguous between the two.
    v_transfer_id := ops.fn_create_transfer(
      v_wo.copacker_location_id,
      v_wo.destination_location_id,
      jsonb_build_array(jsonb_build_object(
        'qbo_item_id', v_wo.finished_qbo_item_id,
        'qty', v_wo.qty_produced_actual,
        'unit_cost', v_unit_cost,
        'notes', 'Finished goods · WO ' || v_wo.batch_code
      )),
      NULLIF(p_payload ->> 'carrier', ''),
      NULLIF(p_payload ->> 'tracking', ''),
      'Work order ' || v_wo.batch_code || ' — finished goods return',
      NULLIF(p_payload ->> 'pro_number', ''),
      NULLIF(p_payload ->> 'freight_terms', ''),
      NULLIF(p_payload ->> 'total_weight_lbs', '')::numeric,
      NULLIF(p_payload ->> 'total_pallets', '')::numeric,
      NULL::numeric,
      NULLIF(p_payload ->> 'special_instructions', '')
    );
    -- 3-arg form called explicitly (2-arg legacy overload also live).
    PERFORM ops.fn_ship_transfer(
      v_transfer_id,
      NULLIF(p_payload ->> 'ship_date','')::date,
      NULLIF(p_payload ->> 'shipper_signature_name','')::text
    );

    SELECT bol_number INTO v_bol FROM ops.inventory_transfers WHERE id = v_transfer_id;

    UPDATE ops.work_orders
       SET status = 'in_transit',
           transfer_id = v_transfer_id,
           ship_carrier = NULLIF(p_payload ->> 'carrier', ''),
           ship_tracking = NULLIF(p_payload ->> 'tracking', ''),
           ship_bol_number = v_bol,
           shipped_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (p_wo_id, 'ship', v_wo.status, 'in_transit',
            'Shipped from co-packer · BOL ' || v_bol, p_payload, v_actor);
    RETURN;
  END IF;

  -- ── receive ──
  IF p_action = 'receive' THEN
    IF v_wo.status <> 'in_transit' THEN
      RAISE EXCEPTION 'work order is %, expected in_transit', v_wo.status;
    END IF;
    IF v_wo.transfer_id IS NULL THEN
      RAISE EXCEPTION 'work order has no shipping transfer';
    END IF;
    -- 3-arg form called explicitly (2-arg legacy overload also live).
    PERFORM ops.fn_receive_transfer(
      v_wo.transfer_id,
      NULLIF(p_payload ->> 'received_date','')::date,
      NULLIF(p_payload ->> 'receiver_signature_name','')::text
    );

    UPDATE ops.work_orders
       SET status = 'received', received_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'receive', v_wo.status, 'received',
            'Finished goods received into inventory', v_actor);
    RETURN;
  END IF;

  -- ── close ──
  IF p_action = 'close' THEN
    IF v_wo.status <> 'received' THEN
      RAISE EXCEPTION 'work order is %, expected received', v_wo.status;
    END IF;
    UPDATE ops.work_orders
       SET status = 'closed', closed_at = now(), closed_by = v_actor
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'close', v_wo.status, 'closed', 'Work order closed', v_actor);
    RETURN;
  END IF;

  -- ── void ──
  IF p_action = 'void' THEN
    IF v_wo.status NOT IN ('draft','ordered','at_copacker') THEN
      RAISE EXCEPTION 'work order is %, can only void before production starts', v_wo.status;
    END IF;
    -- Linked POs with receipts block the void; the rest are voided with it.
    FOR v_po IN
      SELECT p.id, p.po_number, p.status,
             EXISTS (SELECT 1 FROM ops.purchase_order_lines pl
                      WHERE pl.po_id = p.id AND pl.qty_received > 0) AS has_receipts
        FROM ops.purchase_orders p
        WHERE p.work_order_id = p_wo_id AND p.status NOT IN ('void','closed')
    LOOP
      IF v_po.has_receipts THEN
        RAISE EXCEPTION 'PO % has receipts — close it out before voiding this work order', v_po.po_number;
      END IF;
      UPDATE ops.purchase_orders
         SET status = 'void', voided_at = now(), voided_by = v_actor,
             void_reason = 'Work order ' || v_wo.batch_code || ' voided'
       WHERE id = v_po.id;
    END LOOP;

    UPDATE ops.work_orders
       SET status = 'void', voided_at = now(), voided_by = v_actor,
           void_reason = NULLIF(p_payload ->> 'reason', '')
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (p_wo_id, 'void', v_wo.status, 'void',
            COALESCE(NULLIF(p_payload ->> 'reason',''), 'Voided'), p_payload, v_actor);
    RETURN;
  END IF;

  RAISE EXCEPTION 'unknown action %', p_action;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_advance(UUID, TEXT, JSONB) TO authenticated;


-- ── 14. fn_wo_set_material_vendor — assign/override a material's vendor ─────
CREATE OR REPLACE FUNCTION ops.fn_wo_set_material_vendor(
  p_material_id  UUID,
  p_qbo_vendor_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_po_id  UUID;
BEGIN
  SELECT w.status, m.po_id INTO v_status, v_po_id
    FROM ops.work_order_materials m
    JOIN ops.work_orders w ON w.id = m.wo_id
    WHERE m.id = p_material_id
    FOR UPDATE OF m;
  IF v_status IS NULL THEN RAISE EXCEPTION 'material not found'; END IF;
  IF v_po_id IS NOT NULL THEN
    RAISE EXCEPTION 'material already on a purchase order';
  END IF;
  IF v_status NOT IN ('draft','ordered') THEN
    RAISE EXCEPTION 'work order is %, vendors can only change while draft/ordered', v_status;
  END IF;

  UPDATE ops.work_order_materials
     SET qbo_vendor_id = NULLIF(p_qbo_vendor_id, ''),
         vendor_name = (SELECT display_name FROM ops.qbo_vendors
                         WHERE qbo_vendor_id = NULLIF(p_qbo_vendor_id, ''))
   WHERE id = p_material_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_wo_set_material_vendor(UUID, TEXT) TO authenticated;


-- ── 14b. fn_bom_save_v2 — create/update a BOM as a pure parts list ──────────
-- The redesigned BOM: a sellable item + its sub-items, attached to a formula.
-- No quantity scaling lives here — qty_per is "per 1 recipe yield" and every
-- total is computed on the work order.
-- p_header: {finished_qbo_item_id, name?, version?, formula_id?, yield_qty?,
--            yield_uom?, cans_per_case?, oz_per_can?, effective_date?, notes?,
--            is_active?}
-- p_lines:  [{line_type, component_qbo_item_id?, service_label?, qty_per,
--             qty_uom?, scrap_pct?, default_cost?, preferred_qbo_vendor_id?,
--             notes?}, ...]
CREATE OR REPLACE FUNCTION ops.fn_bom_save_v2(
  p_id     UUID,
  p_header JSONB,
  p_lines  JSONB
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id        UUID := p_id;
  v_actor     UUID := auth.uid();
  v_line      JSONB;
  v_lt        TEXT;
  v_sort      INTEGER := 100;
  v_active_wo INTEGER;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  IF v_id IS NULL THEN
    IF (p_header ->> 'finished_qbo_item_id') IS NULL OR (p_header ->> 'finished_qbo_item_id') = '' THEN
      RAISE EXCEPTION 'finished_qbo_item_id is required';
    END IF;
    INSERT INTO ops.product_bom (
      finished_qbo_item_id, version, name, formula_id, effective_date,
      yield_qty, yield_uom, cans_per_case, oz_per_can, notes, created_by
    ) VALUES (
      p_header ->> 'finished_qbo_item_id',
      COALESCE(NULLIF(p_header ->> 'version', ''), '1'),
      NULLIF(p_header ->> 'name', ''),
      NULLIF(p_header ->> 'formula_id', '')::uuid,
      NULLIF(p_header ->> 'effective_date', '')::date,
      COALESCE(NULLIF(p_header ->> 'yield_qty', '')::numeric, 1),
      COALESCE(NULLIF(p_header ->> 'yield_uom', ''), 'each'),
      COALESCE(NULLIF(p_header ->> 'cans_per_case', '')::int, 24),
      COALESCE(NULLIF(p_header ->> 'oz_per_can', '')::numeric, 12),
      NULLIF(p_header ->> 'notes', ''),
      v_actor
    )
    RETURNING id INTO v_id;
  ELSE
    SELECT count(*) INTO v_active_wo
      FROM ops.work_orders
      WHERE bom_id = v_id
        AND status IN ('draft','ordered','at_copacker','in_production','consumed');
    IF v_active_wo > 0 THEN
      RAISE EXCEPTION 'Cannot edit: % open work order(s) reference this BOM. Finish or void them first.', v_active_wo;
    END IF;

    UPDATE ops.product_bom SET
      name           = NULLIF(p_header ->> 'name', ''),
      version        = COALESCE(NULLIF(p_header ->> 'version', ''), version),
      formula_id     = NULLIF(p_header ->> 'formula_id', '')::uuid,
      effective_date = NULLIF(p_header ->> 'effective_date', '')::date,
      yield_qty      = COALESCE(NULLIF(p_header ->> 'yield_qty', '')::numeric, yield_qty),
      yield_uom      = COALESCE(NULLIF(p_header ->> 'yield_uom', ''), yield_uom),
      cans_per_case  = COALESCE(NULLIF(p_header ->> 'cans_per_case', '')::int, cans_per_case),
      oz_per_can     = COALESCE(NULLIF(p_header ->> 'oz_per_can', '')::numeric, oz_per_can),
      notes          = NULLIF(p_header ->> 'notes', ''),
      is_active      = COALESCE((p_header ->> 'is_active')::boolean, is_active)
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'bom % not found', v_id; END IF;

    DELETE FROM ops.product_bom_lines WHERE bom_id = v_id;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_lt := v_line ->> 'line_type';
    IF v_lt NOT IN ('component', 'service') THEN
      RAISE EXCEPTION 'line_type must be component or service';
    END IF;
    IF (v_line ->> 'qty_per') IS NULL OR (v_line ->> 'qty_per')::numeric <= 0 THEN
      RAISE EXCEPTION 'qty_per must be > 0';
    END IF;
    IF v_lt = 'component' AND COALESCE(v_line ->> 'component_qbo_item_id', '') = '' THEN
      RAISE EXCEPTION 'component lines require component_qbo_item_id';
    END IF;
    IF v_lt = 'service' AND COALESCE(v_line ->> 'service_label', '') = '' THEN
      RAISE EXCEPTION 'service lines require service_label';
    END IF;

    INSERT INTO ops.product_bom_lines (
      bom_id, line_type, component_qbo_item_id, service_label,
      qty_per, qty_uom, scrap_pct, default_cost, preferred_qbo_vendor_id,
      notes, sort_order
    ) VALUES (
      v_id, v_lt,
      CASE WHEN v_lt = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_lt = 'service'   THEN v_line ->> 'service_label'   END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'qty_uom', ''), 'each'),
      COALESCE(NULLIF(v_line ->> 'scrap_pct', '')::numeric, 0),
      NULLIF(v_line ->> 'default_cost', '')::numeric,
      NULLIF(v_line ->> 'preferred_qbo_vendor_id', ''),
      v_line ->> 'notes',
      v_sort
    );
    v_sort := v_sort + 10;
  END LOOP;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_bom_save_v2(UUID, JSONB, JSONB) TO authenticated;


-- ── 15. RLS + grants ─────────────────────────────────────────────────────────
ALTER TABLE ops.product_formulas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.product_formula_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.product_formula_revisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.work_order_materials        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.work_order_events           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_formulas_select ON ops.product_formulas;
CREATE POLICY product_formulas_select ON ops.product_formulas
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS product_formula_ingredients_select ON ops.product_formula_ingredients;
CREATE POLICY product_formula_ingredients_select ON ops.product_formula_ingredients
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS product_formula_revisions_select ON ops.product_formula_revisions;
CREATE POLICY product_formula_revisions_select ON ops.product_formula_revisions
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS work_order_materials_select ON ops.work_order_materials;
CREATE POLICY work_order_materials_select ON ops.work_order_materials
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS work_order_events_select ON ops.work_order_events;
CREATE POLICY work_order_events_select ON ops.work_order_events
  FOR SELECT TO authenticated USING (TRUE);

GRANT SELECT ON ops.product_formulas            TO authenticated;
GRANT SELECT ON ops.product_formula_ingredients TO authenticated;
GRANT SELECT ON ops.product_formula_revisions   TO authenticated;
GRANT SELECT ON ops.work_order_materials        TO authenticated;
GRANT SELECT ON ops.work_order_events           TO authenticated;


-- ── 16. Storage bucket for spec sheet attachments ────────────────────────────
-- Private bucket; authenticated users read/write. Wrapped so a storage-
-- permission hiccup can't sink the schema migration.
DO $storage$
BEGIN
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('product-formulas', 'product-formulas', false)
  ON CONFLICT (id) DO NOTHING;

  BEGIN
    CREATE POLICY product_formulas_read ON storage.objects
      FOR SELECT TO authenticated USING (bucket_id = 'product-formulas');
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY product_formulas_insert ON storage.objects
      FOR INSERT TO authenticated WITH CHECK (bucket_id = 'product-formulas');
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY product_formulas_update ON storage.objects
      FOR UPDATE TO authenticated USING (bucket_id = 'product-formulas');
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY product_formulas_delete ON storage.objects
      FOR DELETE TO authenticated USING (bucket_id = 'product-formulas');
  EXCEPTION WHEN duplicate_object THEN NULL; END;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'storage bucket/policies skipped (insufficient privilege) — create bucket product-formulas manually';
END;
$storage$;


-- ── 17. Seed the co-packer location ──────────────────────────────────────────
INSERT INTO ops.inventory_locations (code, name, kind, entity, is_active)
VALUES ('QUANTUM-CANNING', 'Quantum Canning (Co-Packer)', 'co_packer', 'brix', TRUE)
ON CONFLICT (code) DO NOTHING;
