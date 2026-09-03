-- 20260903f — production runs: one order, several bills of materials, one PO per vendor
--
-- Ask (Sky): "create a work order that has MULTIPLE bills of materials on it
-- as one huge order to quantum and calderoni"; "the master work order should
-- void everything in the chain". Phase 6 of the production overhaul.
--
-- Model — a PARENT, not a wider work order:
--  * ops.production_runs is the order. Each BOM on it is a child work_orders
--    row (run_id), so record_yield, lots, costs, the BOL and the run guide keep
--    working unchanged; a one-line run is exactly today's work order.
--  * PO generation, MOQ, netting against co-packer stock, close rules, the
--    void cascade, reopen and (P7) bills operate at the RUN level. A run PO
--    carries production_run_id and work_order_id NULL; purchase_order_line_demand
--    says which WO material each aggregated line covers, and how much.
--  * inventory_reservations: when a run nets against stock already at the
--    co-packer (last run's MOQ surplus), the quantity it will use is reserved
--    so a second run raised the same day cannot count it too. Consumed at
--    start_production, released on void.
--  * ops.fn_bom_component_demand(bom, qty) is the ONE implementation of the
--    material maths — fn_wo_create_pipeline inserts from it and fn_run_preview
--    aggregates it, so the New Order preview cannot disagree with the POs it
--    is previewing.
--  * fn_wo_attach_recipe_detail is re-homed to __i + guard wrapper and scoped
--    per WO: a run's gallon line is shared by several WOs, so each WO's
--    ingredient detail rides under the line with its wo_id, costed on that
--    WO's share of the line.
--  * fn_wo_advance__i: anchored edits (ship/void refuse a run WO unless
--    _run_scope; start_production lands run POs too and consumes reservations).
--    A trigger keeps production_runs.status derived from its WOs.

BEGIN;

-- ── 1. Tables ────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ops.production_run_seq;

CREATE TABLE IF NOT EXISTS ops.production_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_number               TEXT NOT NULL UNIQUE,
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','in_progress','closed','void')),
  copacker_qbo_vendor_id   TEXT NOT NULL,
  copacker_location_id     UUID NOT NULL REFERENCES ops.inventory_locations(id),
  destination_location_id  UUID NOT NULL REFERENCES ops.inventory_locations(id),
  scheduled_date           DATE,
  tank_size_gal            NUMERIC,
  net_against_stock        BOOLEAN NOT NULL DEFAULT TRUE,
  notes                    TEXT,
  ordered_at               TIMESTAMPTZ,
  started_at               TIMESTAMPTZ,
  shipped_at               TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ,
  closed_by                UUID,
  voided_at                TIMESTAMPTZ,
  voided_by                UUID,
  void_reason              TEXT,
  reopened_at              TIMESTAMPTZ,
  reopened_by              UUID,
  reopen_reason            TEXT,
  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ops.work_orders ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES ops.production_runs(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS work_orders_run_id_idx ON ops.work_orders(run_id);
ALTER TABLE ops.purchase_orders ADD COLUMN IF NOT EXISTS production_run_id UUID REFERENCES ops.production_runs(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS purchase_orders_run_id_idx ON ops.purchase_orders(production_run_id);
ALTER TABLE ops.purchase_order_lines
  ADD COLUMN IF NOT EXISTS moq_applied  NUMERIC,   -- ordered − shortfall when the vendor's terms lifted the line
  ADD COLUMN IF NOT EXISTS demand_total NUMERIC;   -- Σ demand covered by this line; surplus = qty_ordered − demand_total
ALTER TABLE ops.purchase_order_line_details ADD COLUMN IF NOT EXISTS wo_id UUID REFERENCES ops.work_orders(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS ops.inventory_reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qbo_item_id     TEXT NOT NULL,
  location_id     UUID NOT NULL REFERENCES ops.inventory_locations(id),
  qty             NUMERIC NOT NULL CHECK (qty > 0),
  run_id          UUID REFERENCES ops.production_runs(id) ON DELETE CASCADE,
  wo_id           UUID REFERENCES ops.work_orders(id) ON DELETE CASCADE,
  wo_material_id  UUID REFERENCES ops.work_order_materials(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released')),
  note            TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS inventory_reservations_item_loc_idx ON ops.inventory_reservations(qbo_item_id, location_id) WHERE status = 'active';
ALTER TABLE ops.work_order_materials ADD COLUMN IF NOT EXISTS reservation_id UUID REFERENCES ops.inventory_reservations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ops.purchase_order_line_demand (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_line_id      UUID NOT NULL REFERENCES ops.purchase_order_lines(id) ON DELETE CASCADE,
  po_id           UUID NOT NULL REFERENCES ops.purchase_orders(id) ON DELETE CASCADE,
  run_id          UUID REFERENCES ops.production_runs(id) ON DELETE CASCADE,
  wo_id           UUID NOT NULL REFERENCES ops.work_orders(id) ON DELETE CASCADE,
  wo_material_id  UUID NOT NULL UNIQUE REFERENCES ops.work_order_materials(id) ON DELETE CASCADE,
  demand_qty      NUMERIC NOT NULL CHECK (demand_qty > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: the production pattern — any authenticated read, distributors denied, writes only inside definer fns.
ALTER TABLE ops.production_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.purchase_order_line_demand ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_runs_select ON ops.production_runs;
CREATE POLICY production_runs_select ON ops.production_runs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS production_runs_no_distributor ON ops.production_runs;
CREATE POLICY production_runs_no_distributor ON ops.production_runs AS RESTRICTIVE FOR ALL TO authenticated USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor());
DROP POLICY IF EXISTS inventory_reservations_select ON ops.inventory_reservations;
CREATE POLICY inventory_reservations_select ON ops.inventory_reservations FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS inventory_reservations_no_distributor ON ops.inventory_reservations;
CREATE POLICY inventory_reservations_no_distributor ON ops.inventory_reservations AS RESTRICTIVE FOR ALL TO authenticated USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor());
DROP POLICY IF EXISTS po_line_demand_select ON ops.purchase_order_line_demand;
CREATE POLICY po_line_demand_select ON ops.purchase_order_line_demand FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS po_line_demand_no_distributor ON ops.purchase_order_line_demand;
CREATE POLICY po_line_demand_no_distributor ON ops.purchase_order_line_demand AS RESTRICTIVE FOR ALL TO authenticated USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor());
GRANT SELECT ON ops.production_runs, ops.inventory_reservations, ops.purchase_order_line_demand TO authenticated;
GRANT ALL ON ops.production_runs, ops.inventory_reservations, ops.purchase_order_line_demand TO service_role;
GRANT USAGE, SELECT ON SEQUENCE ops.production_run_seq TO service_role;

-- production_doc_events already admits doc_type 'run' (20260903b).

-- ── 2. Numbering (internal only) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_next_run_number__i() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
BEGIN RETURN 'RUN-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('ops.production_run_seq')::text, 5, '0'); END $$;
REVOKE ALL ON FUNCTION ops.fn_next_run_number__i() FROM PUBLIC, anon, authenticated;

-- ── 3. The material maths, once ──────────────────────────────────────────────
-- What a run of p_qty finished units off this BOM needs (demand) and would
-- order (required, the vendor's terms applied) per stocked component.
CREATE OR REPLACE FUNCTION ops.fn_bom_component_demand(p_bom_id uuid, p_qty numeric)
RETURNS TABLE (
  bom_line_id uuid, component_qbo_item_id text, item_name text,
  required_qty numeric, demand_qty numeric, qty_basis text,
  recipe_qty numeric, recipe_uom text, pack_size numeric, uom text,
  unit_cost_est numeric, qbo_vendor_id text, vendor_name text, ingredient_id uuid,
  sort_order integer, notes text, item_type text, min_order_qty numeric, order_multiple numeric
) LANGUAGE sql STABLE SET search_path TO 'ops', 'pg_temp' AS $$
  WITH b AS (SELECT yield_qty FROM ops.product_bom WHERE id = p_bom_id)
  SELECT
    l.id, l.component_qbo_item_id,
    COALESCE(qi.name, ri.name, l.component_qbo_item_id),
    CASE
      WHEN l.qty_basis = 'per_run' THEN dem.demand_qty
      WHEN ri.id IS NOT NULL THEN ops.fn_order_qty(dem.demand_qty, ri.min_order_qty,
          CASE WHEN ri.pack_size IS NOT NULL AND ri.pack_size > 0 THEN COALESCE(ri.order_multiple, 1) ELSE NULLIF(ri.order_multiple, 1) END)
      ELSE ops.fn_order_qty(dem.demand_qty, pi.min_order_qty, pi.order_multiple)
    END,
    dem.demand_qty,
    COALESCE(l.qty_basis, 'per_yield'),
    need.recipe_qty,
    COALESCE(l.qty_uom, 'each'),
    ri.pack_size,
    COALESCE(ri.purchase_uom, l.qty_uom, 'each'),
    COALESCE(l.default_cost, pi.unit_cost, ri.purchase_cost, qi.purchase_cost),
    COALESCE(l.preferred_qbo_vendor_id, pi.qbo_vendor_id, ri.qbo_vendor_id),
    (SELECT display_name FROM ops.qbo_vendors WHERE qbo_vendor_id = COALESCE(l.preferred_qbo_vendor_id, pi.qbo_vendor_id, ri.qbo_vendor_id)),
    l.ingredient_id, l.sort_order, l.notes, qi.type,
    CASE WHEN ri.id IS NOT NULL THEN ri.min_order_qty ELSE pi.min_order_qty END,
    CASE WHEN ri.id IS NOT NULL THEN (CASE WHEN ri.pack_size IS NOT NULL AND ri.pack_size > 0 THEN COALESCE(ri.order_multiple, 1) ELSE NULLIF(ri.order_multiple, 1) END) ELSE pi.order_multiple END
  FROM ops.product_bom_lines l
  CROSS JOIN b
  LEFT JOIN ops.raw_ingredients  ri ON ri.id = l.ingredient_id
  LEFT JOIN ops.qbo_items        qi ON qi.qbo_item_id = l.component_qbo_item_id
  LEFT JOIN ops.production_items pi ON pi.qbo_item_id = l.component_qbo_item_id AND pi.active
  CROSS JOIN LATERAL (
    SELECT CASE WHEN l.qty_basis = 'per_run' THEN l.qty_per
                ELSE (p_qty / b.yield_qty) * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) END AS recipe_qty
  ) need
  CROSS JOIN LATERAL (
    SELECT CASE WHEN ri.pack_size IS NULL OR ri.pack_size <= 0 THEN need.recipe_qty ELSE need.recipe_qty / ri.pack_size END AS demand_qty
  ) dem
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component' AND l.component_qbo_item_id IS NOT NULL
  ORDER BY l.sort_order
$$;
REVOKE ALL ON FUNCTION ops.fn_bom_component_demand(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_bom_component_demand(uuid, numeric) TO authenticated, service_role;

-- fn_wo_create_pipeline__i now inserts from it (same signature and defaults).
CREATE OR REPLACE FUNCTION ops.fn_wo_create_pipeline__i(p_bom_id uuid, p_qty_to_produce numeric, p_copacker_qbo_vendor_id text, p_copacker_location_id uuid, p_destination_location_id uuid, p_scheduled_date date DEFAULT NULL::date, p_batch_size_gal numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  v_id UUID; v_batch TEXT; v_finished_item_id TEXT; v_yield NUMERIC; v_formula_id UUID; v_kind TEXT;
  v_actor UUID := auth.uid(); v_runs NUMERIC;
BEGIN
  IF p_qty_to_produce IS NULL OR p_qty_to_produce <= 0 THEN RAISE EXCEPTION 'qty_to_produce must be > 0'; END IF;
  SELECT finished_qbo_item_id, yield_qty, formula_id INTO v_finished_item_id, v_yield, v_formula_id
    FROM ops.product_bom WHERE id = p_bom_id AND is_active;
  IF v_finished_item_id IS NULL THEN RAISE EXCEPTION 'bom_id not found or inactive'; END IF;
  SELECT kind INTO v_kind FROM ops.inventory_locations WHERE id = p_copacker_location_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'copacker_location_id not found'; END IF;
  IF v_kind IN ('in_transit','adjustment') THEN RAISE EXCEPTION 'Co-packer location cannot be a virtual location'; END IF;
  SELECT kind INTO v_kind FROM ops.inventory_locations WHERE id = p_destination_location_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'destination_location_id not found'; END IF;
  IF v_kind IN ('in_transit','adjustment') THEN RAISE EXCEPTION 'Destination cannot be a virtual location'; END IF;

  v_runs  := p_qty_to_produce / v_yield;
  v_batch := ops.fn_next_wo_batch_code();

  INSERT INTO ops.work_orders (
    batch_code, bom_id, finished_qbo_item_id, qty_to_produce, expected_units,
    production_location_id, copacker_location_id, destination_location_id,
    copacker_qbo_vendor_id, formula_id, batch_size_gal, status, scheduled_date, notes, created_by
  ) VALUES (
    v_batch, p_bom_id, v_finished_item_id, p_qty_to_produce, p_qty_to_produce,
    p_copacker_location_id, p_copacker_location_id, p_destination_location_id,
    p_copacker_qbo_vendor_id, v_formula_id, p_batch_size_gal, 'draft', p_scheduled_date, p_notes, v_actor
  ) RETURNING id INTO v_id;

  INSERT INTO ops.work_order_materials (
    wo_id, bom_line_id, component_qbo_item_id, item_name,
    required_qty, demand_qty, qty_basis, recipe_qty, recipe_uom, pack_size, uom,
    unit_cost_est, qbo_vendor_id, vendor_name, ingredient_id, sort_order, notes)
  SELECT v_id, d.bom_line_id, d.component_qbo_item_id, d.item_name,
         d.required_qty, d.demand_qty, d.qty_basis, d.recipe_qty, d.recipe_uom, d.pack_size, d.uom,
         d.unit_cost_est, d.qbo_vendor_id, d.vendor_name, d.ingredient_id, d.sort_order, d.notes
    FROM ops.fn_bom_component_demand(p_bom_id, p_qty_to_produce) d;

  INSERT INTO ops.work_order_recipe_lines (
    wo_id, bom_line_id, ingredient_id, item_name, recipe_qty, recipe_uom, order_qty, purchase_uom, pack_size,
    rollup_qbo_item_id, sort_order, notes)
  SELECT v_id, l.id, l.ingredient_id, COALESCE(ri.name, 'ingredient'), need.recipe_qty, COALESCE(l.qty_uom, 'lbs'),
    CASE WHEN ri.pack_size IS NULL OR ri.pack_size <= 0 THEN NULL
         ELSE ops.fn_order_qty(need.recipe_qty / ri.pack_size, ri.min_order_qty, COALESCE(ri.order_multiple, 1)) END,
    ri.purchase_uom, ri.pack_size, l.rollup_qbo_item_id, l.sort_order, l.notes
  FROM ops.product_bom_lines l
  LEFT JOIN ops.raw_ingredients ri ON ri.id = l.ingredient_id
  CROSS JOIN LATERAL (SELECT v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) AS recipe_qty) need
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component' AND l.component_qbo_item_id IS NULL
  ORDER BY l.sort_order;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
  VALUES (v_id, 'created', NULL, 'draft', 'Work order created for ' || p_qty_to_produce || ' units', v_actor);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION ops.fn_wo_create_pipeline__i(uuid, numeric, text, uuid, uuid, date, numeric, text) FROM PUBLIC, anon, authenticated;

-- ── 4. Recipe detail per WO under a SHARED line ──────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_wo_attach_recipe_detail__i(p_wo_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  v_attached INTEGER := 0; v_orphans JSONB := '[]'::jsonb;
  v_grp RECORD; v_line RECORD; v_po_line RECORD;
  v_weight NUMERIC; v_amount NUMERIC; v_sort INTEGER;
BEGIN
  FOR v_grp IN
    SELECT rollup_qbo_item_id, sum(recipe_qty) AS total_weight
      FROM ops.work_order_recipe_lines WHERE wo_id = p_wo_id AND rollup_qbo_item_id IS NOT NULL
     GROUP BY rollup_qbo_item_id
  LOOP
    -- The line THIS WO's gallon material sits on (a run PO shares one line
    -- across several WOs); the WO's share is its demand on that line.
    SELECT pl.id, pl.unit_cost,
           COALESCE(pd.demand_qty, m.demand_qty, m.required_qty) AS share_qty
      INTO v_po_line
      FROM ops.work_order_materials m
      JOIN ops.purchase_order_lines pl ON pl.id = m.po_line_id
      JOIN ops.purchase_orders po ON po.id = pl.po_id AND po.status <> 'void'
      LEFT JOIN ops.purchase_order_line_demand pd ON pd.wo_material_id = m.id
     WHERE m.wo_id = p_wo_id AND m.component_qbo_item_id = v_grp.rollup_qbo_item_id AND m.po_line_id IS NOT NULL
     ORDER BY m.sort_order LIMIT 1;
    IF v_po_line.id IS NULL THEN
      -- legacy: a PO raised straight from the WO
      SELECT pl.id, pl.unit_cost, pl.qty_ordered AS share_qty INTO v_po_line
        FROM ops.purchase_order_lines pl JOIN ops.purchase_orders po ON po.id = pl.po_id
       WHERE po.work_order_id = p_wo_id AND po.status <> 'void' AND pl.qbo_item_id = v_grp.rollup_qbo_item_id
       ORDER BY pl.sort_order LIMIT 1;
    END IF;
    IF v_po_line.id IS NULL THEN
      v_orphans := v_orphans || jsonb_build_object('rollup_qbo_item_id', v_grp.rollup_qbo_item_id,
        'reason', 'no purchase order line carries this item, so its ingredients have nothing to be billed inside');
      CONTINUE;
    END IF;

    v_weight := NULLIF(v_grp.total_weight, 0);
    v_amount := COALESCE(v_po_line.share_qty, 0) * COALESCE(v_po_line.unit_cost, 0);
    v_sort   := 10;
    DELETE FROM ops.purchase_order_line_details WHERE po_line_id = v_po_line.id AND (wo_id = p_wo_id OR wo_id IS NULL);

    FOR v_line IN
      SELECT r.*, ri.purchase_cost, ri.pack_size AS ri_pack
        FROM ops.work_order_recipe_lines r LEFT JOIN ops.raw_ingredients ri ON ri.id = r.ingredient_id
       WHERE r.wo_id = p_wo_id AND r.rollup_qbo_item_id = v_grp.rollup_qbo_item_id ORDER BY r.sort_order
    LOOP
      INSERT INTO ops.purchase_order_line_details (po_line_id, wo_id, ingredient_id, item_name, qty, uom, allocated_cost, quoted_cost, notes, sort_order)
      VALUES (v_po_line.id, p_wo_id, v_line.ingredient_id, v_line.item_name, v_line.recipe_qty, v_line.recipe_uom,
        CASE WHEN v_weight IS NULL THEN NULL ELSE ROUND(v_amount * (v_line.recipe_qty / v_weight), 4) END,
        CASE WHEN v_line.purchase_cost IS NULL THEN NULL
             ELSE ROUND(v_line.recipe_qty / NULLIF(COALESCE(v_line.ri_pack, 1), 0) * v_line.purchase_cost, 4) END,
        CASE WHEN v_line.order_qty IS NOT NULL THEN 'order ' || ROUND(v_line.order_qty, 3) || ' ' || COALESCE(v_line.purchase_uom, '') END,
        v_sort);
      UPDATE ops.work_order_recipe_lines SET po_line_id = v_po_line.id WHERE id = v_line.id;
      v_attached := v_attached + 1; v_sort := v_sort + 10;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('attached', v_attached, 'orphans', v_orphans);
END;
$$;
REVOKE ALL ON FUNCTION ops.fn_wo_attach_recipe_detail__i(uuid) FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION ops.fn_wo_attach_recipe_detail(p_wo_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
-- GENERATED GUARD WRAPPER (20260903f, the 20260820b pattern) — the real body lives in ops.fn_wo_attach_recipe_detail__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN ops.fn_wo_attach_recipe_detail__i(p_wo_id); END $$;
REVOKE ALL ON FUNCTION ops.fn_wo_attach_recipe_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_wo_attach_recipe_detail(uuid) TO authenticated, service_role;

-- fn_wo_generate_pos__i: refuse a run WO (POs come from the run) and call the inner detail fn.
DO $$
DECLARE v_src text; v_a text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p WHERE p.pronamespace='ops'::regnamespace AND p.proname='fn_wo_generate_pos__i';
  IF v_src LIKE '%20260903f%' THEN RAISE NOTICE 'fn_wo_generate_pos__i already carries 20260903f'; RETURN; END IF;
  v_a := E'  IF v_status IS NULL THEN RAISE EXCEPTION ''work order not found''; END IF;\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (gp-a) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, v_a
    || E'  IF EXISTS (SELECT 1 FROM ops.work_orders WHERE id = p_wo_id AND run_id IS NOT NULL) THEN   -- 20260903f\n'
    || E'    RAISE EXCEPTION ''work order % belongs to run % — generate purchase orders from the run'', v_batch,\n'
    || E'      (SELECT r.run_number FROM ops.production_runs r JOIN ops.work_orders w ON w.run_id = r.id WHERE w.id = p_wo_id);\n'
    || E'  END IF;\n');
  v_a := 'v_detail := ops.fn_wo_attach_recipe_detail(p_wo_id);';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (gp-b) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, 'v_detail := ops.fn_wo_attach_recipe_detail__i(p_wo_id);');
  EXECUTE v_src;
END $$;
REVOKE ALL ON FUNCTION ops.fn_wo_generate_pos__i(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── 5. fn_wo_advance__i — anchored edits ─────────────────────────────────────
DO $$
DECLARE v_src text; v_a text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p WHERE p.pronamespace='ops'::regnamespace AND p.proname='fn_wo_advance__i';
  IF v_src LIKE '%20260903f%' THEN RAISE NOTICE 'fn_wo_advance__i already carries 20260903f'; RETURN; END IF;

  -- (a) ship: a run WO ships with the run
  v_a := E'IF p_action = ''ship'' THEN\n    IF v_wo.status <> ''yield_recorded'' THEN\n      RAISE EXCEPTION ''work order is %, expected yield_recorded'', v_wo.status;\n    END IF;\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (a) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, v_a
    || E'    IF v_wo.run_id IS NOT NULL AND COALESCE(p_payload ->> ''_run_scope'', '''') <> ''1'' THEN   -- 20260903f\n'
    || E'      RAISE EXCEPTION ''work order % is part of a production run — ship the run (one bill of lading for the truck)'', v_wo.batch_code;\n'
    || E'    END IF;\n');

  -- (b) void: the run voids everything in the chain
  v_a := E'IF p_action = ''void'' THEN\n    IF v_wo.status NOT IN (''draft'',''ordered'',''at_copacker'') THEN\n      RAISE EXCEPTION ''work order is %, can only void before production starts'', v_wo.status;\n    END IF;\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (b) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, v_a
    || E'    IF v_wo.run_id IS NOT NULL AND COALESCE(p_payload ->> ''_run_scope'', '''') <> ''1'' THEN   -- 20260903f\n'
    || E'      RAISE EXCEPTION ''work order % is part of a production run — void the run, or remove this line from it while it is a draft'', v_wo.batch_code;\n'
    || E'    END IF;\n');

  -- (c) start_production: the co-packer's RUN PO lands too (once per line, idempotent)
  v_a := E'     WHERE po.work_order_id = p_wo_id AND po.close_rule = ''on_run_yield'' AND po.status <> ''void''\n       AND COALESCE(i.type, '''') <> ''Service''';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (c) found % times', v_n; END IF;
  v_src := replace(v_src, v_a,
    E'     WHERE (po.work_order_id = p_wo_id OR (v_wo.run_id IS NOT NULL AND po.production_run_id = v_wo.run_id))   -- 20260903f\n       AND po.close_rule = ''on_run_yield'' AND po.status <> ''void''\n       AND COALESCE(i.type, '''') <> ''Service''');
  v_a := E'     WHERE po.id = pl.po_id AND po.work_order_id = p_wo_id AND po.close_rule = ''on_run_yield'' AND po.status <> ''void''\n       AND pl.qty_received < pl.qty_ordered;';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (c2) found % times', v_n; END IF;
  v_src := replace(v_src, v_a,
    E'     WHERE po.id = pl.po_id AND (po.work_order_id = p_wo_id OR (v_wo.run_id IS NOT NULL AND po.production_run_id = v_wo.run_id))\n       AND po.close_rule = ''on_run_yield'' AND po.status <> ''void''\n       AND pl.qty_received < pl.qty_ordered;');

  -- (d) reservations this WO drew on are consumed with the batch
  v_a := E'AND COALESCE(i.type, '''') <> ''Service'';   -- 20260903d: a tolling charge is not stock\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (d) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, v_a
    || E'    UPDATE ops.inventory_reservations SET status = ''consumed'', resolved_at = now()\n'
    || E'     WHERE wo_id = p_wo_id AND status = ''active'';   -- 20260903f\n');

  EXECUTE v_src;
END $$;
REVOKE ALL ON FUNCTION ops.fn_wo_advance__i(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 6. Run status is DERIVED from its work orders ────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_run_recompute_status__i(p_run_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_cur text; v_new text; n_live int; n_closed int; n_started int; n_ordered int; n_all int;
BEGIN
  SELECT status INTO v_cur FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF v_cur IS NULL OR v_cur = 'void' THEN RETURN v_cur; END IF;
  SELECT count(*), count(*) FILTER (WHERE status <> 'void'),
         count(*) FILTER (WHERE status = 'closed'),
         count(*) FILTER (WHERE status IN ('in_production','yield_recorded','in_transit','received','closed')),
         count(*) FILTER (WHERE status IN ('ordered','at_copacker'))
    INTO n_all, n_live, n_closed, n_started, n_ordered
    FROM ops.work_orders WHERE run_id = p_run_id;
  v_new := CASE
    WHEN n_all > 0 AND n_live = 0 THEN 'void'
    WHEN n_live > 0 AND n_closed = n_live THEN 'closed'
    WHEN n_started > 0 THEN 'in_progress'
    WHEN n_ordered > 0 THEN 'ordered'
    ELSE 'draft' END;
  IF v_new <> v_cur THEN
    UPDATE ops.production_runs
       SET status = v_new, updated_at = now(),
           started_at = CASE WHEN v_new = 'in_progress' THEN COALESCE(started_at, now()) ELSE started_at END,
           closed_at  = CASE WHEN v_new = 'closed' THEN COALESCE(closed_at, now()) WHEN v_cur = 'closed' THEN NULL ELSE closed_at END,
           voided_at  = CASE WHEN v_new = 'void' THEN COALESCE(voided_at, now()) ELSE voided_at END
     WHERE id = p_run_id;
  END IF;
  RETURN v_new;
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_recompute_status__i(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION ops.tg_work_orders_run_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
BEGIN
  IF NEW.run_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.run_id IS DISTINCT FROM OLD.run_id) THEN
    PERFORM ops.fn_run_recompute_status__i(NEW.run_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_work_orders_run_status ON ops.work_orders;
CREATE TRIGGER tg_work_orders_run_status AFTER INSERT OR UPDATE OF status, run_id ON ops.work_orders
  FOR EACH ROW EXECUTE FUNCTION ops.tg_work_orders_run_status();

-- ── 7. Run RPCs ──────────────────────────────────────────────────────────────
-- create: the order, with one child work order per BOM line
CREATE OR REPLACE FUNCTION ops.fn_run_create(
  p_lines jsonb, p_copacker_qbo_vendor_id text, p_copacker_location_id uuid, p_destination_location_id uuid,
  p_scheduled_date date DEFAULT NULL, p_tank_size_gal numeric DEFAULT NULL, p_notes text DEFAULT NULL, p_net_against_stock boolean DEFAULT TRUE)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_run uuid; v_line jsonb; v_wo uuid; v_actor uuid := auth.uid(); v_n int := 0; v_num text;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN RAISE EXCEPTION 'a run needs at least one bill of materials'; END IF;
  IF p_copacker_qbo_vendor_id IS NULL OR p_copacker_qbo_vendor_id = '' THEN RAISE EXCEPTION 'co-packer vendor is required'; END IF;
  v_num := ops.fn_next_run_number__i();
  INSERT INTO ops.production_runs (run_number, copacker_qbo_vendor_id, copacker_location_id, destination_location_id,
    scheduled_date, tank_size_gal, notes, net_against_stock, created_by)
  VALUES (v_num, p_copacker_qbo_vendor_id, p_copacker_location_id, p_destination_location_id,
    p_scheduled_date, p_tank_size_gal, p_notes, COALESCE(p_net_against_stock, TRUE), v_actor)
  RETURNING id INTO v_run;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_wo := ops.fn_wo_create_pipeline__i((v_line ->> 'bom_id')::uuid, (v_line ->> 'qty_to_produce')::numeric,
      p_copacker_qbo_vendor_id, p_copacker_location_id, p_destination_location_id, p_scheduled_date,
      NULLIF(v_line ->> 'batch_size_gal', '')::numeric, COALESCE(NULLIF(v_line ->> 'notes', ''), 'Run ' || v_num));
    UPDATE ops.work_orders SET run_id = v_run WHERE id = v_wo;
    v_n := v_n + 1;
  END LOOP;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', v_run, 'create', v_num || ' · ' || v_n || ' work order(s)', v_actor);
  RETURN v_run;
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_create(jsonb, text, uuid, uuid, date, numeric, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_create(jsonb, text, uuid, uuid, date, numeric, text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ops.fn_run_add_line(p_run_id uuid, p_bom_id uuid, p_qty_to_produce numeric, p_batch_size_gal numeric DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE r ops.production_runs%ROWTYPE; v_wo uuid;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'run % is %; lines can only be added while it is a draft', r.run_number, r.status; END IF;
  v_wo := ops.fn_wo_create_pipeline__i(p_bom_id, p_qty_to_produce, r.copacker_qbo_vendor_id, r.copacker_location_id, r.destination_location_id, r.scheduled_date, p_batch_size_gal, 'Run ' || r.run_number);
  UPDATE ops.work_orders SET run_id = p_run_id WHERE id = v_wo;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, 'add_line', (SELECT batch_code FROM ops.work_orders WHERE id = v_wo), auth.uid());
  RETURN v_wo;
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_add_line(uuid, uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_add_line(uuid, uuid, numeric, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ops.fn_run_remove_line(p_run_id uuid, p_wo_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_status text; v_batch text;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT status INTO v_status FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'run is %; a line can only be removed while the run is a draft — void the run instead', v_status; END IF;
  SELECT batch_code INTO v_batch FROM ops.work_orders WHERE id = p_wo_id AND run_id = p_run_id;
  IF v_batch IS NULL THEN RAISE EXCEPTION 'that work order is not on this run'; END IF;
  IF (SELECT count(*) FROM ops.work_orders WHERE run_id = p_run_id AND status <> 'void') <= 1 THEN
    RAISE EXCEPTION 'a run needs at least one line — delete the draft run instead';
  END IF;
  PERFORM ops.fn_wo_advance__i(p_wo_id, 'void', jsonb_build_object('reason', COALESCE(p_reason, 'Removed from run'), '_run_scope', '1'));
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, 'remove_line', v_batch || COALESCE(' · ' || p_reason, ''), auth.uid());
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_remove_line(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_remove_line(uuid, uuid, text) TO authenticated, service_role;

-- preview: what the POs will carry, read-only, off the same maths
CREATE OR REPLACE FUNCTION ops.fn_run_preview(p_lines jsonb, p_copacker_qbo_vendor_id text, p_copacker_location_id uuid, p_net_against_stock boolean DEFAULT TRUE)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_pos jsonb := '[]'::jsonb; v_blockers jsonb := '[]'::jsonb; v_warnings jsonb := '[]'::jsonb; v_line jsonb; v_pf jsonb; v_grand numeric := 0;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN RETURN jsonb_build_object('pos', v_pos, 'blockers', v_blockers, 'warnings', v_warnings, 'total', 0); END IF;
  CREATE TEMP TABLE IF NOT EXISTS _run_prev (bom_id uuid, bom_name text, qty numeric, component_qbo_item_id text, item_name text, demand numeric, qty_basis text, unit_cost numeric, qbo_vendor_id text, vendor_name text, item_type text, moq numeric, mult numeric, sort_order int) ON COMMIT DROP;
  DELETE FROM _run_prev;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (v_line ->> 'bom_id') IS NULL OR COALESCE((v_line ->> 'qty_to_produce')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    INSERT INTO _run_prev
    SELECT (v_line ->> 'bom_id')::uuid, (SELECT name FROM ops.product_bom WHERE id = (v_line ->> 'bom_id')::uuid), (v_line ->> 'qty_to_produce')::numeric,
           d.component_qbo_item_id, d.item_name, d.demand_qty, d.qty_basis, d.unit_cost_est, d.qbo_vendor_id, d.vendor_name, d.item_type, d.min_order_qty, d.order_multiple, d.sort_order
      FROM ops.fn_bom_component_demand((v_line ->> 'bom_id')::uuid, (v_line ->> 'qty_to_produce')::numeric) d;
    BEGIN
      v_pf := ops.fn_bom_preflight((v_line ->> 'bom_id')::uuid);
      v_blockers := v_blockers || COALESCE((SELECT jsonb_agg(b || jsonb_build_object('bom_id', v_line ->> 'bom_id')) FROM jsonb_array_elements(v_pf -> 'blockers') b), '[]'::jsonb);
      v_warnings := v_warnings || COALESCE((SELECT jsonb_agg(w || jsonb_build_object('bom_id', v_line ->> 'bom_id')) FROM jsonb_array_elements(v_pf -> 'warnings') w), '[]'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      v_blockers := v_blockers || jsonb_build_object('kind', 'preflight_failed', 'bom_id', v_line ->> 'bom_id', 'detail', SQLERRM);
    END;
  END LOOP;

  SELECT COALESCE(jsonb_agg(v ORDER BY v ->> 'vendor_name'), '[]'::jsonb), COALESCE(sum((v ->> 'subtotal')::numeric), 0) INTO v_pos, v_grand FROM (
    SELECT jsonb_build_object(
      'qbo_vendor_id', vend.qbo_vendor_id, 'vendor_name', COALESCE(vend.vendor_name, '(no vendor)'),
      'close_rule', CASE WHEN vend.qbo_vendor_id = p_copacker_qbo_vendor_id THEN 'on_run_yield' ELSE 'on_receipt' END,
      'lines', vend.lines, 'subtotal', vend.subtotal) AS v
    FROM (
      SELECT it.qbo_vendor_id, it.vendor_name,
             jsonb_agg(jsonb_build_object(
               'qbo_item_id', it.component_qbo_item_id, 'item_name', it.item_name, 'item_type', it.item_type,
               'demand', it.demand, 'on_hand', it.on_hand, 'reserved', it.reserved, 'available', it.available,
               'use_stock', it.use_stock, 'shortfall', it.shortfall, 'ordered', it.ordered,
               'surplus', GREATEST(it.ordered - it.shortfall, 0), 'moq', it.moq, 'multiple', it.mult,
               'unit_cost', it.unit_cost, 'ext', ROUND(it.ordered * COALESCE(it.unit_cost, 0), 2),
               'receivable', (it.qbo_vendor_id IS DISTINCT FROM p_copacker_qbo_vendor_id AND COALESCE(it.item_type, '') <> 'Service'),
               'from', it.from_boms) ORDER BY it.sort_order) AS lines,
             ROUND(sum(it.ordered * COALESCE(it.unit_cost, 0)), 2) AS subtotal
        FROM (
          SELECT g.*,
                 LEAST(g.available, g.demand) AS use_stock,
                 g.demand - LEAST(g.available, g.demand) AS shortfall,
                 CASE WHEN g.per_run THEN g.demand - LEAST(g.available, g.demand)
                      ELSE ops.fn_order_qty(g.demand - LEAST(g.available, g.demand), g.moq, g.mult) END AS ordered
            FROM (
              SELECT p.qbo_vendor_id, min(p.vendor_name) AS vendor_name, p.component_qbo_item_id, min(p.item_name) AS item_name, min(p.item_type) AS item_type,
                     sum(p.demand) AS demand, bool_or(p.qty_basis = 'per_run') AS per_run, max(p.unit_cost) AS unit_cost,
                     max(p.moq) AS moq, max(p.mult) AS mult, min(p.sort_order) AS sort_order,
                     jsonb_agg(jsonb_build_object('bom', p.bom_name, 'qty', p.demand)) AS from_boms,
                     COALESCE((SELECT sum(h.on_hand) FROM ops.v_inventory_on_hand h WHERE h.qbo_item_id = p.component_qbo_item_id AND h.location_id = p_copacker_location_id), 0) AS on_hand,
                     COALESCE((SELECT sum(rv.qty) FROM ops.inventory_reservations rv WHERE rv.qbo_item_id = p.component_qbo_item_id AND rv.location_id = p_copacker_location_id AND rv.status = 'active'), 0) AS reserved,
                     CASE WHEN COALESCE(p_net_against_stock, TRUE) AND NOT bool_or(p.qty_basis = 'per_run') AND COALESCE(min(p.item_type), '') <> 'Service'
                          THEN GREATEST(COALESCE((SELECT sum(h.on_hand) FROM ops.v_inventory_on_hand h WHERE h.qbo_item_id = p.component_qbo_item_id AND h.location_id = p_copacker_location_id), 0)
                                        - COALESCE((SELECT sum(rv.qty) FROM ops.inventory_reservations rv WHERE rv.qbo_item_id = p.component_qbo_item_id AND rv.location_id = p_copacker_location_id AND rv.status = 'active'), 0), 0)
                          ELSE 0 END AS available
                FROM _run_prev p GROUP BY p.qbo_vendor_id, p.component_qbo_item_id
            ) g
        ) it
       GROUP BY it.qbo_vendor_id, it.vendor_name
    ) vend
  ) x;
  RETURN jsonb_build_object('pos', v_pos, 'blockers', v_blockers, 'warnings', v_warnings, 'total', v_grand,
    'lines', (SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('bom_id', bom_id, 'bom_name', bom_name, 'qty', qty)), '[]'::jsonb) FROM _run_prev));
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_preview(jsonb, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_preview(jsonb, text, uuid, boolean) TO authenticated, service_role;

-- generate: one PO per vendor for the whole run, netted against co-packer stock, lifted to MOQ
CREATE OR REPLACE FUNCTION ops.fn_run_generate_pos(p_run_id uuid, p_expected_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  r ops.production_runs%ROWTYPE; v_actor uuid := auth.uid();
  v_vendor text; v_close_rule text; v_po_id uuid; v_po_number text; v_subtotal numeric; v_sort int;
  v_item record; v_mat record; v_missing text;
  v_avail numeric; v_use numeric; v_left numeric; v_take numeric; v_shortfall numeric; v_line_qty numeric; v_line_id uuid;
  v_res uuid; v_result jsonb := '[]'::jsonb; v_reservations int := 0; v_detail jsonb := '[]'::jsonb; v_wo record; v_pos_n int := 0;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF r.status NOT IN ('draft', 'ordered') THEN RAISE EXCEPTION 'run % is %; purchase orders can only be generated while draft/ordered', r.run_number, r.status; END IF;

  SELECT string_agg(DISTINCT COALESCE(m.item_name, m.component_qbo_item_id), ', ') INTO v_missing
    FROM ops.work_order_materials m JOIN ops.work_orders w ON w.id = m.wo_id
   WHERE w.run_id = p_run_id AND w.status IN ('draft','ordered') AND m.po_id IS NULL AND m.reservation_id IS NULL AND m.qbo_vendor_id IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'No vendor assigned for: %. Set a vendor on each material first.', v_missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.work_order_materials m JOIN ops.work_orders w ON w.id = m.wo_id
                  WHERE w.run_id = p_run_id AND w.status IN ('draft','ordered') AND m.po_id IS NULL AND m.reservation_id IS NULL) THEN
    RAISE EXCEPTION 'Every material on this run already has a purchase order (or is covered by stock at the co-packer)';
  END IF;

  FOR v_vendor IN
    SELECT DISTINCT m.qbo_vendor_id FROM ops.work_order_materials m JOIN ops.work_orders w ON w.id = m.wo_id
     WHERE w.run_id = p_run_id AND w.status IN ('draft','ordered') AND m.po_id IS NULL AND m.reservation_id IS NULL ORDER BY 1
  LOOP
    v_close_rule := CASE WHEN v_vendor = r.copacker_qbo_vendor_id THEN 'on_run_yield' ELSE 'on_receipt' END;
    v_po_id := NULL; v_subtotal := 0; v_sort := 100;

    FOR v_item IN
      SELECT m.component_qbo_item_id, min(m.item_name) AS item_name, min(m.sort_order) AS sort_order,
             bool_or(m.qty_basis = 'per_run') AS per_run, max(m.unit_cost_est) AS unit_cost,
             sum(COALESCE(m.demand_qty, m.required_qty)) AS demand,
             min(qi.type) AS item_type,
             bool_or(m.ingredient_id IS NOT NULL) AS has_ri,
             max(COALESCE(ri.min_order_qty, pi.min_order_qty)) AS moq,
             max(CASE WHEN ri.id IS NOT NULL THEN (CASE WHEN ri.pack_size IS NOT NULL AND ri.pack_size > 0 THEN COALESCE(ri.order_multiple, 1) ELSE NULLIF(ri.order_multiple, 1) END) ELSE pi.order_multiple END) AS mult,
             min(m.recipe_uom) AS recipe_uom
        FROM ops.work_order_materials m
        JOIN ops.work_orders w ON w.id = m.wo_id
        LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = m.component_qbo_item_id
        LEFT JOIN ops.raw_ingredients ri ON ri.id = m.ingredient_id
        LEFT JOIN ops.production_items pi ON pi.qbo_item_id = m.component_qbo_item_id AND pi.active
       WHERE w.run_id = p_run_id AND w.status IN ('draft','ordered') AND m.po_id IS NULL AND m.reservation_id IS NULL AND m.qbo_vendor_id = v_vendor
       GROUP BY m.component_qbo_item_id ORDER BY min(m.sort_order)
    LOOP
      -- net against what is already at the co-packer (never a service, never a flat fee)
      v_avail := 0;
      IF r.net_against_stock AND NOT v_item.per_run AND COALESCE(v_item.item_type, '') <> 'Service' THEN
        SELECT GREATEST(COALESCE((SELECT sum(h.on_hand) FROM ops.v_inventory_on_hand h WHERE h.qbo_item_id = v_item.component_qbo_item_id AND h.location_id = r.copacker_location_id), 0)
                      - COALESCE((SELECT sum(rv.qty) FROM ops.inventory_reservations rv WHERE rv.qbo_item_id = v_item.component_qbo_item_id AND rv.location_id = r.copacker_location_id AND rv.status = 'active'), 0), 0)
          INTO v_avail;
      END IF;
      v_use := LEAST(v_avail, v_item.demand);
      v_shortfall := v_item.demand - v_use;
      v_line_qty := CASE WHEN v_item.per_run THEN v_shortfall ELSE ops.fn_order_qty(v_shortfall, v_item.moq, v_item.mult) END;
      v_line_id := NULL;

      IF v_line_qty > 0 THEN
        IF v_po_id IS NULL THEN
          v_po_number := ops.fn_next_po_number();
          INSERT INTO ops.purchase_orders (po_number, qbo_vendor_id, destination_location_id, status, po_kind, close_rule, expected_date, notes,
                                           production_run_id, created_by, ordered_at, ordered_by)
          VALUES (v_po_number, v_vendor, r.copacker_location_id, 'open', 'materials', v_close_rule, p_expected_date,
                  'Materials for run ' || r.run_number || CASE WHEN v_close_rule = 'on_run_yield' THEN ' · closes when the run ships (nothing is received against it)' ELSE '' END,
                  p_run_id, v_actor, now(), v_actor)
          RETURNING id INTO v_po_id;
          v_pos_n := v_pos_n + 1;
        END IF;
        INSERT INTO ops.purchase_order_lines (po_id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order, receivable, moq_applied, demand_total)
        VALUES (v_po_id, v_item.component_qbo_item_id, v_item.item_name, v_line_qty, COALESCE(v_item.unit_cost, 0),
                'Run ' || r.run_number
                  || CASE WHEN v_use > 0 THEN ' · ' || ROUND(v_use, 3) || ' from stock at the co-packer' ELSE '' END
                  || CASE WHEN v_line_qty > v_shortfall THEN ' · +' || ROUND(v_line_qty - v_shortfall, 3) || ' to reach ' || CASE WHEN v_item.moq IS NOT NULL AND v_shortfall < v_item.moq THEN 'the MOQ' ELSE 'the order multiple' END ELSE '' END,
                v_sort, (v_close_rule = 'on_receipt' AND COALESCE(v_item.item_type, '') <> 'Service'),
                CASE WHEN v_line_qty > v_shortfall THEN v_line_qty - v_shortfall END, v_item.demand)
        RETURNING id INTO v_line_id;
        v_subtotal := v_subtotal + v_line_qty * COALESCE(v_item.unit_cost, 0);
        v_sort := v_sort + 10;
      END IF;

      -- hand the stock and the line out across the WO materials, in WO order
      v_left := v_use;
      FOR v_mat IN
        SELECT m.id, m.wo_id, COALESCE(m.demand_qty, m.required_qty) AS demand
          FROM ops.work_order_materials m JOIN ops.work_orders w ON w.id = m.wo_id
         WHERE w.run_id = p_run_id AND w.status IN ('draft','ordered') AND m.po_id IS NULL AND m.reservation_id IS NULL
           AND m.qbo_vendor_id = v_vendor AND m.component_qbo_item_id = v_item.component_qbo_item_id
         ORDER BY w.created_at, m.sort_order
      LOOP
        v_take := LEAST(v_left, v_mat.demand);
        IF v_take > 0 THEN
          INSERT INTO ops.inventory_reservations (qbo_item_id, location_id, qty, run_id, wo_id, wo_material_id, note, created_by)
          VALUES (v_item.component_qbo_item_id, r.copacker_location_id, v_take, p_run_id, v_mat.wo_id, v_mat.id, 'Run ' || r.run_number || ' — stock already at the co-packer', v_actor)
          RETURNING id INTO v_res;
          UPDATE ops.work_order_materials SET reservation_id = v_res WHERE id = v_mat.id;
          v_reservations := v_reservations + 1;
          v_left := v_left - v_take;
        END IF;
        IF v_mat.demand - v_take > 0 THEN
          IF v_line_id IS NULL THEN RAISE EXCEPTION 'internal: uncovered demand with no line for item %', v_item.component_qbo_item_id; END IF;
          INSERT INTO ops.purchase_order_line_demand (po_line_id, po_id, run_id, wo_id, wo_material_id, demand_qty)
          VALUES (v_line_id, v_po_id, p_run_id, v_mat.wo_id, v_mat.id, v_mat.demand - v_take);
          UPDATE ops.work_order_materials SET po_id = v_po_id, po_line_id = v_line_id WHERE id = v_mat.id;
        END IF;
      END LOOP;
    END LOOP;

    IF v_po_id IS NOT NULL THEN
      UPDATE ops.purchase_orders SET subtotal = v_subtotal WHERE id = v_po_id;
      v_result := v_result || jsonb_build_object('po_id', v_po_id, 'po_number', v_po_number, 'qbo_vendor_id', v_vendor, 'close_rule', v_close_rule, 'subtotal', v_subtotal);
    END IF;
  END LOOP;

  FOR v_wo IN SELECT id, batch_code, status FROM ops.work_orders WHERE run_id = p_run_id AND status IN ('draft','ordered') ORDER BY created_at LOOP
    v_detail := v_detail || jsonb_build_object('wo', v_wo.batch_code, 'detail', ops.fn_wo_attach_recipe_detail__i(v_wo.id));
    IF v_wo.status = 'draft' THEN UPDATE ops.work_orders SET status = 'ordered', ordered_at = now() WHERE id = v_wo.id; END IF;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (v_wo.id, 'pos_generated', v_wo.status, 'ordered', 'Purchase orders generated from run ' || r.run_number, jsonb_build_object('pos', v_result), v_actor);
  END LOOP;
  UPDATE ops.production_runs SET ordered_at = COALESCE(ordered_at, now()), updated_at = now() WHERE id = p_run_id;
  PERFORM ops.fn_run_recompute_status__i(p_run_id);
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('run', p_run_id, 'pos_generated', v_pos_n || ' purchase order(s) · ' || v_reservations || ' reservation(s) against co-packer stock', jsonb_build_object('pos', v_result), v_actor);
  RETURN jsonb_build_object('pos', v_result, 'reservations', v_reservations, 'recipe_detail', v_detail);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_generate_pos(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_generate_pos(uuid, date) TO authenticated, service_role;

-- advance: fan a per-WO action out to every live WO, one sub-transaction each
CREATE OR REPLACE FUNCTION ops.fn_run_advance(p_run_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_wo record; v_done jsonb := '[]'; v_skip jsonb := '[]'; v_num text;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF p_action NOT IN ('materials_at_copacker', 'start_production', 'receive', 'close') THEN
    RAISE EXCEPTION 'action % is not a run-level action (yield is recorded per work order; ship with fn_run_ship)', p_action;
  END IF;
  SELECT run_number INTO v_num FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF v_num IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  FOR v_wo IN SELECT id, batch_code, status FROM ops.work_orders WHERE run_id = p_run_id AND status <> 'void' ORDER BY created_at LOOP
    BEGIN
      PERFORM ops.fn_wo_advance__i(v_wo.id, p_action, COALESCE(p_payload, '{}'::jsonb));
      v_done := v_done || jsonb_build_object('id', v_wo.id, 'number', v_wo.batch_code);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_wo.id, 'number', v_wo.batch_code, 'reason', SQLERRM);
    END;
  END LOOP;
  PERFORM ops.fn_run_recompute_status__i(p_run_id);
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, p_action, jsonb_array_length(v_done) || ' work order(s) · ' || jsonb_array_length(v_skip) || ' skipped', auth.uid());
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_advance(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_advance(uuid, text, jsonb) TO authenticated, service_role;

-- ship: ONE bill of lading for the truck, every yield-recorded WO on it, one line per lot
CREATE OR REPLACE FUNCTION ops.fn_run_ship(p_run_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  r ops.production_runs%ROWTYPE; v_actor uuid := auth.uid(); v_lines jsonb := '[]'::jsonb; v_wo record; v_unit numeric; v_wo_lines jsonb; v_n int;
  v_transfer uuid; v_bol text; v_laggards text; v_shipped jsonb := '[]'::jsonb; v_closed jsonb := '[]'::jsonb;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  SELECT string_agg(batch_code || ' is ' || status, ', ') INTO v_laggards
    FROM ops.work_orders WHERE run_id = p_run_id AND status NOT IN ('void', 'yield_recorded', 'in_transit', 'received', 'closed');
  IF v_laggards IS NOT NULL THEN RAISE EXCEPTION 'every work order on the run must have its yield recorded before the truck leaves — %', v_laggards; END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.work_orders WHERE run_id = p_run_id AND status = 'yield_recorded') THEN
    RAISE EXCEPTION 'nothing left to ship on run %', r.run_number;
  END IF;

  FOR v_wo IN SELECT * FROM ops.work_orders WHERE run_id = p_run_id AND status = 'yield_recorded' ORDER BY created_at LOOP
    SELECT unit_cost INTO v_unit FROM ops.work_order_costs WHERE wo_id = v_wo.id;
    SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object(
             'qbo_item_id', v_wo.finished_qbo_item_id, 'qty', wl.qty, 'unit_cost', v_unit,
             'lot_code', wl.lot_code, 'born_on_date', wl.born_on_date, 'best_by_date', wl.best_by_date,
             'notes', 'Finished goods · WO ' || v_wo.batch_code || ' · lot ' || wl.lot_code) ORDER BY wl.sort_order), '[]'::jsonb)
      INTO v_n, v_wo_lines FROM ops.work_order_lots wl WHERE wl.wo_id = v_wo.id;
    IF v_n = 0 THEN
      v_wo_lines := jsonb_build_array(jsonb_build_object('qbo_item_id', v_wo.finished_qbo_item_id, 'qty', v_wo.qty_produced_actual,
                      'unit_cost', v_unit, 'notes', 'Finished goods · WO ' || v_wo.batch_code));
    END IF;
    v_lines := v_lines || v_wo_lines;
  END LOOP;

  v_transfer := ops.fn_create_transfer(r.copacker_location_id, r.destination_location_id, v_lines,
    NULLIF(p_payload ->> 'carrier', ''), NULLIF(p_payload ->> 'tracking', ''),
    'Run ' || r.run_number || ' — finished goods return',
    NULLIF(p_payload ->> 'pro_number', ''), NULLIF(p_payload ->> 'freight_terms', ''),
    NULLIF(p_payload ->> 'total_weight_lbs', '')::numeric, NULLIF(p_payload ->> 'total_pallets', '')::numeric,
    NULL::numeric, NULLIF(p_payload ->> 'special_instructions', ''));
  PERFORM ops.fn_ship_transfer(v_transfer, NULLIF(p_payload ->> 'ship_date', '')::date, NULLIF(p_payload ->> 'shipper_signature_name', '')::text);
  SELECT bol_number INTO v_bol FROM ops.inventory_transfers WHERE id = v_transfer;

  FOR v_wo IN SELECT id, batch_code, status FROM ops.work_orders WHERE run_id = p_run_id AND status = 'yield_recorded' LOOP
    UPDATE ops.work_orders SET status = 'in_transit', transfer_id = v_transfer,
      ship_carrier = NULLIF(p_payload ->> 'carrier', ''), ship_tracking = NULLIF(p_payload ->> 'tracking', ''),
      ship_bol_number = v_bol, shipped_at = now() WHERE id = v_wo.id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (v_wo.id, 'ship', v_wo.status, 'in_transit', 'Shipped with run ' || r.run_number || ' · BOL ' || v_bol, p_payload, v_actor);
    v_shipped := v_shipped || to_jsonb(v_wo.batch_code);
  END LOOP;

  -- the co-packer's PO closes with the run — nothing is received against it
  UPDATE ops.purchase_order_lines pl SET qty_received = pl.qty_ordered FROM ops.purchase_orders po
   WHERE po.id = pl.po_id AND po.close_rule = 'on_run_yield' AND po.status <> 'void' AND pl.qty_received < pl.qty_ordered
     AND (po.production_run_id = p_run_id OR po.work_order_id IN (SELECT id FROM ops.work_orders WHERE run_id = p_run_id));
  WITH c AS (
    UPDATE ops.purchase_orders SET status = 'closed', closed_at = now(), closed_by = v_actor, closed_reason = 'run_shipped', received_at = COALESCE(received_at, now())
     WHERE close_rule = 'on_run_yield' AND status NOT IN ('closed', 'void')
       AND (production_run_id = p_run_id OR work_order_id IN (SELECT id FROM ops.work_orders WHERE run_id = p_run_id))
    RETURNING id, po_number)
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  SELECT 'purchase_order', id, 'close', 'Closed with run ' || r.run_number || ' — shipped', v_actor FROM c;
  SELECT COALESCE(jsonb_agg(po_number), '[]'::jsonb) INTO v_closed FROM ops.purchase_orders WHERE production_run_id = p_run_id AND closed_reason = 'run_shipped';

  UPDATE ops.production_runs SET shipped_at = COALESCE(shipped_at, now()), updated_at = now() WHERE id = p_run_id;
  PERFORM ops.fn_run_recompute_status__i(p_run_id);
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('run', p_run_id, 'ship', 'BOL ' || v_bol || ' · ' || jsonb_array_length(v_shipped) || ' work order(s)', p_payload, v_actor);
  RETURN jsonb_build_object('transfer_id', v_transfer, 'bol_number', v_bol, 'work_orders', v_shipped, 'closed_pos', v_closed);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_ship(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_ship(uuid, jsonb) TO authenticated, service_role;

-- receive: every transfer the run's in-transit WOs ride on
CREATE OR REPLACE FUNCTION ops.fn_run_receive(p_run_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_t uuid; v_actor uuid := auth.uid(); v_n int := 0; v_wo record;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF NOT EXISTS (SELECT 1 FROM ops.production_runs WHERE id = p_run_id) THEN RAISE EXCEPTION 'run not found'; END IF;
  FOR v_t IN SELECT DISTINCT transfer_id FROM ops.work_orders WHERE run_id = p_run_id AND status = 'in_transit' AND transfer_id IS NOT NULL LOOP
    IF (SELECT status FROM ops.inventory_transfers WHERE id = v_t) = 'in_transit' THEN
      PERFORM ops.fn_receive_transfer(v_t, NULLIF(p_payload ->> 'received_date', '')::date, NULLIF(p_payload ->> 'receiver_signature_name', '')::text);
    END IF;
    FOR v_wo IN SELECT id, batch_code, status FROM ops.work_orders WHERE run_id = p_run_id AND status = 'in_transit' AND transfer_id = v_t LOOP
      UPDATE ops.work_orders SET status = 'received', received_at = now() WHERE id = v_wo.id;
      INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
      VALUES (v_wo.id, 'receive', v_wo.status, 'received', 'Finished goods received into inventory (run)', v_actor);
      v_n := v_n + 1;
    END LOOP;
  END LOOP;
  IF v_n = 0 THEN RAISE EXCEPTION 'nothing in transit on this run'; END IF;
  PERFORM ops.fn_run_recompute_status__i(p_run_id);
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, 'receive', v_n || ' work order(s) received', v_actor);
  RETURN jsonb_build_object('received', v_n);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_receive(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_receive(uuid, jsonb) TO authenticated, service_role;

-- close: every WO closed; leftover materials POs short-closed
CREATE OR REPLACE FUNCTION ops.fn_run_close(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_actor uuid := auth.uid(); v_wo record; v_lag text; v_short jsonb; v_num text;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT run_number INTO v_num FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF v_num IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  SELECT string_agg(batch_code || ' is ' || status, ', ') INTO v_lag FROM ops.work_orders WHERE run_id = p_run_id AND status NOT IN ('void','received','closed');
  IF v_lag IS NOT NULL THEN RAISE EXCEPTION 'every work order must be received before the run closes — %', v_lag; END IF;
  FOR v_wo IN SELECT id FROM ops.work_orders WHERE run_id = p_run_id AND status = 'received' LOOP
    PERFORM ops.fn_wo_advance__i(v_wo.id, 'close', '{}'::jsonb);
  END LOOP;
  WITH c AS (
    UPDATE ops.purchase_orders SET status = 'closed', closed_at = now(), closed_by = v_actor, closed_reason = 'run_closed'
     WHERE production_run_id = p_run_id AND status IN ('open','partial','received') RETURNING id, po_number)
  SELECT COALESCE(jsonb_agg(po_number), '[]'::jsonb) INTO v_short FROM c;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  SELECT 'purchase_order', id, 'close', 'Short-closed — run ' || v_num || ' closed', v_actor FROM ops.purchase_orders WHERE production_run_id = p_run_id AND closed_reason = 'run_closed';
  UPDATE ops.production_runs SET status = 'closed', closed_at = COALESCE(closed_at, now()), closed_by = v_actor, updated_at = now() WHERE id = p_run_id;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, 'close', 'Run closed' || CASE WHEN jsonb_array_length(v_short) > 0 THEN ' · short-closed ' || v_short::text ELSE '' END, v_actor);
  RETURN jsonb_build_object('short_closed_pos', v_short);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_close(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_close(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ops.fn_run_reopen(p_run_id uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_status text; v_wo record; v_actor uuid := auth.uid();
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT status INTO v_status FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF v_status <> 'closed' THEN RAISE EXCEPTION 'run is %; only a closed run can be reopened', v_status; END IF;
  FOR v_wo IN SELECT id FROM ops.work_orders WHERE run_id = p_run_id AND status = 'closed' LOOP
    PERFORM ops.fn_reopen_work_order(v_wo.id, p_reason);
  END LOOP;
  UPDATE ops.production_runs SET status = 'in_progress', closed_at = NULL, closed_by = NULL,
    reopened_at = now(), reopened_by = v_actor, reopen_reason = p_reason, updated_at = now() WHERE id = p_run_id;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by) VALUES ('run', p_run_id, 'reopen', p_reason, v_actor);
  RETURN 'in_progress';
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_reopen(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_reopen(uuid, text) TO authenticated, service_role;

-- void: the master void — everything in the chain
CREATE OR REPLACE FUNCTION ops.fn_run_void(p_run_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE r ops.production_runs%ROWTYPE; v_actor uuid := auth.uid(); v_wo record; v_po record; v_lag text;
  v_voided jsonb := '[]'; v_closed jsonb := '[]'; v_qbo jsonb := '[]'; v_released int;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF r.status = 'void' THEN RAISE EXCEPTION 'run % is already void', r.run_number; END IF;
  SELECT string_agg(batch_code || ' is ' || status, ', ') INTO v_lag FROM ops.work_orders WHERE run_id = p_run_id AND status NOT IN ('void','draft','ordered','at_copacker');
  IF v_lag IS NOT NULL THEN RAISE EXCEPTION 'production has started on this run — close it out instead of voiding (%)', v_lag; END IF;

  FOR v_wo IN SELECT id, batch_code FROM ops.work_orders WHERE run_id = p_run_id AND status <> 'void' LOOP
    PERFORM ops.fn_wo_advance__i(v_wo.id, 'void', jsonb_build_object('reason', 'Run ' || r.run_number || ' voided: ' || p_reason, '_run_scope', '1'));
  END LOOP;
  FOR v_po IN
    SELECT p.id, p.po_number, p.status, p.qbo_purchase_order_id,
           EXISTS (SELECT 1 FROM ops.purchase_order_lines pl WHERE pl.po_id = p.id AND pl.qty_received > 0) AS has_receipts
      FROM ops.purchase_orders p WHERE p.production_run_id = p_run_id AND p.status NOT IN ('void','closed')
  LOOP
    IF v_po.has_receipts THEN
      -- goods physically at the co-packer stay on hand; the PO is short-closed, not un-received
      UPDATE ops.purchase_orders SET status = 'closed', closed_at = now(), closed_by = v_actor, closed_reason = 'short_close_run_void' WHERE id = v_po.id;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
      VALUES ('purchase_order', v_po.id, 'close', 'Short-closed — run ' || r.run_number || ' voided; received goods stay on hand', v_actor);
      v_closed := v_closed || to_jsonb(v_po.po_number);
    ELSE
      UPDATE ops.purchase_orders SET status = 'void', voided_at = now(), voided_by = v_actor, void_reason = 'Run ' || r.run_number || ' voided: ' || p_reason WHERE id = v_po.id;
      UPDATE ops.work_order_materials SET po_id = NULL, po_line_id = NULL WHERE po_id = v_po.id;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
      VALUES ('purchase_order', v_po.id, 'void', 'Run ' || r.run_number || ' voided: ' || p_reason, v_actor);
      v_voided := v_voided || to_jsonb(v_po.po_number);
    END IF;
    IF v_po.qbo_purchase_order_id IS NOT NULL THEN
      v_qbo := v_qbo || jsonb_build_object('po_number', v_po.po_number, 'qbo_purchase_order_id', v_po.qbo_purchase_order_id);
    END IF;
  END LOOP;
  UPDATE ops.inventory_reservations SET status = 'released', resolved_at = now() WHERE run_id = p_run_id AND status = 'active';
  GET DIAGNOSTICS v_released = ROW_COUNT;
  UPDATE ops.production_runs SET status = 'void', voided_at = now(), voided_by = v_actor, void_reason = p_reason, updated_at = now() WHERE id = p_run_id;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('run', p_run_id, 'void', p_reason, jsonb_build_object('voided_pos', v_voided, 'short_closed_pos', v_closed, 'released_reservations', v_released), v_actor);
  RETURN jsonb_build_object('voided_pos', v_voided, 'short_closed_pos', v_closed, 'released_reservations', v_released, 'qbo_pos_to_close', v_qbo);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_void(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_void(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ops.fn_void_runs(p_ids uuid[], p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_id uuid; v_num text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    SELECT run_number INTO v_num FROM ops.production_runs WHERE id = v_id;
    BEGIN
      PERFORM ops.fn_run_void(v_id, p_reason);
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;
REVOKE ALL ON FUNCTION ops.fn_void_runs(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_void_runs(uuid[], text) TO authenticated, service_role;

-- delete: a draft run and its draft work orders — the only hard delete
CREATE OR REPLACE FUNCTION ops.fn_run_delete_drafts(p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_id uuid; v_num text; v_status text; v_done jsonb := '[]'; v_skip jsonb := '[]';
BEGIN
  PERFORM ops.fn_assert_internal();
  FOREACH v_id IN ARRAY coalesce(p_ids, '{}') LOOP
    v_num := NULL;
    BEGIN
      SELECT run_number, status INTO v_num, v_status FROM ops.production_runs WHERE id = v_id FOR UPDATE;
      IF v_num IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
      IF v_status <> 'draft' THEN RAISE EXCEPTION 'is %; only a draft can be deleted — void it instead', v_status; END IF;
      IF EXISTS (SELECT 1 FROM ops.purchase_orders WHERE production_run_id = v_id) THEN RAISE EXCEPTION 'has purchase orders; void it instead'; END IF;
      IF EXISTS (SELECT 1 FROM ops.work_orders WHERE run_id = v_id AND status NOT IN ('draft','void')) THEN RAISE EXCEPTION 'a work order on it has been ordered; void the run instead'; END IF;
      IF EXISTS (SELECT 1 FROM ops.purchase_orders p JOIN ops.work_orders w ON w.id = p.work_order_id WHERE w.run_id = v_id) THEN RAISE EXCEPTION 'a work order on it has purchase orders; void the run instead'; END IF;
      DELETE FROM ops.inventory_reservations WHERE run_id = v_id;
      DELETE FROM ops.work_orders WHERE run_id = v_id;
      DELETE FROM ops.production_runs WHERE id = v_id;
      INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by) VALUES ('run', v_id, 'delete', v_num, auth.uid());
      v_done := v_done || jsonb_build_object('id', v_id, 'number', v_num);
    EXCEPTION WHEN OTHERS THEN
      v_skip := v_skip || jsonb_build_object('id', v_id, 'number', v_num, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('done', v_done, 'skipped', v_skip);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_delete_drafts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_delete_drafts(uuid[]) TO authenticated, service_role;

-- production PO for the run: one PO to ALAMEDA SODA COMPANY PRODUCTION, one line per WO
CREATE OR REPLACE FUNCTION ops.fn_run_create_production_po(p_run_id uuid, p_expected_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE r ops.production_runs%ROWTYPE; v_vendor text; v_po uuid; v_num text; v_actor uuid := auth.uid(); v_wo record; v_sort int := 100; v_sub numeric := 0; v_lag text; v_lines int := 0;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF EXISTS (SELECT 1 FROM ops.purchase_orders WHERE production_run_id = p_run_id AND po_kind = 'production' AND status <> 'void') THEN
    RAISE EXCEPTION 'run % already has a production purchase order', r.run_number;
  END IF;
  SELECT string_agg(w.batch_code, ', ') INTO v_lag FROM ops.work_orders w LEFT JOIN ops.work_order_costs c ON c.wo_id = w.id WHERE w.run_id = p_run_id AND w.status <> 'void' AND c.wo_id IS NULL;
  IF v_lag IS NOT NULL THEN RAISE EXCEPTION 'record the yield first so the per-case cost is measured — no cost yet on %', v_lag; END IF;
  SELECT production_vendor_qbo_id INTO v_vendor FROM ops.production_settings LIMIT 1;
  IF v_vendor IS NULL THEN RAISE EXCEPTION 'no production vendor configured in ops.production_settings'; END IF;
  v_num := ops.fn_next_po_number();
  INSERT INTO ops.purchase_orders (po_number, qbo_vendor_id, destination_location_id, status, po_kind, close_rule, expected_date, notes, production_run_id, created_by, ordered_at, ordered_by)
  VALUES (v_num, v_vendor, r.destination_location_id, 'open', 'production', 'on_receipt', p_expected_date,
          'Finished goods from run ' || r.run_number || ' — merged cost of the material and co-pack purchase orders', p_run_id, v_actor, now(), v_actor)
  RETURNING id INTO v_po;
  FOR v_wo IN
    SELECT w.id, w.batch_code, w.finished_qbo_item_id, COALESCE(c.qty_produced, w.actual_yield_qty, w.qty_to_produce) AS qty, COALESCE(c.per_case, c.unit_cost) AS unit, qi.name
      FROM ops.work_orders w JOIN ops.work_order_costs c ON c.wo_id = w.id LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = w.finished_qbo_item_id
     WHERE w.run_id = p_run_id AND w.status <> 'void' ORDER BY w.created_at
  LOOP
    INSERT INTO ops.purchase_order_lines (po_id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order, receivable)
    VALUES (v_po, v_wo.finished_qbo_item_id, COALESCE(v_wo.name, v_wo.finished_qbo_item_id), v_wo.qty, ROUND(v_wo.unit, 5), 'WO ' || v_wo.batch_code || ' · per-case cost', v_sort, FALSE);
    v_sub := v_sub + v_wo.qty * v_wo.unit; v_sort := v_sort + 10; v_lines := v_lines + 1;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    SELECT v_wo.id, 'production_po_created', status, status, 'Production PO ' || v_num || ' (run)', v_actor FROM ops.work_orders WHERE id = v_wo.id;
  END LOOP;
  UPDATE ops.purchase_orders SET subtotal = ROUND(v_sub, 2) WHERE id = v_po;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by) VALUES ('run', p_run_id, 'production_po_created', v_num || ' · ' || v_lines || ' line(s)', v_actor);
  RETURN jsonb_build_object('po_id', v_po, 'po_number', v_num, 'qbo_vendor_id', v_vendor, 'lines', v_lines, 'subtotal', ROUND(v_sub, 2));
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_create_production_po(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_create_production_po(uuid, date) TO authenticated, service_role;

-- ── 8. Views ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW ops.v_production_runs WITH (security_invoker = on) AS
SELECT r.*,
       v.display_name AS copacker_vendor_name,
       (cl.code || ' · ' || cl.name) AS copacker_location_label,
       (dl.code || ' · ' || dl.name) AS destination_location_label,
       ops.fn_status_bucket('run', r.status) AS bucket,
       COALESCE(w.wo_count, 0) AS wo_count, COALESCE(w.wo_live_count, 0) AS wo_live_count,
       COALESCE(w.cases_planned, 0) AS cases_planned, w.cases_produced, w.flavours, w.stages,
       COALESCE(p.po_count, 0) AS po_count, COALESCE(p.po_open_count, 0) AS po_open_count, COALESCE(p.po_total, 0) AS po_total,
       w.total_cost, COALESCE(rs.reserved_lines, 0) AS reserved_lines
  FROM ops.production_runs r
  LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = r.copacker_qbo_vendor_id
  LEFT JOIN ops.inventory_locations cl ON cl.id = r.copacker_location_id
  LEFT JOIN ops.inventory_locations dl ON dl.id = r.destination_location_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS wo_count, count(*) FILTER (WHERE w.status <> 'void')::int AS wo_live_count,
           sum(w.qty_to_produce) FILTER (WHERE w.status <> 'void') AS cases_planned,
           sum(w.qty_produced_actual) FILTER (WHERE w.status <> 'void') AS cases_produced,
           string_agg(DISTINCT b.name, ', ' ORDER BY b.name) FILTER (WHERE w.status <> 'void') AS flavours,
           string_agg(DISTINCT w.status, ', ') FILTER (WHERE w.status <> 'void') AS stages,
           sum(c.total_cost) AS total_cost
      FROM ops.work_orders w LEFT JOIN ops.product_bom b ON b.id = w.bom_id LEFT JOIN ops.work_order_costs c ON c.wo_id = w.id
     WHERE w.run_id = r.id) w ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS po_count, count(*) FILTER (WHERE p.status IN ('open','partial'))::int AS po_open_count, sum(p.subtotal) FILTER (WHERE p.status <> 'void') AS po_total
      FROM ops.purchase_orders p WHERE p.production_run_id = r.id) p ON true
  LEFT JOIN LATERAL (SELECT count(*)::int AS reserved_lines FROM ops.inventory_reservations x WHERE x.run_id = r.id AND x.status = 'active') rs ON true;
GRANT SELECT ON ops.v_production_runs TO authenticated, service_role;

CREATE OR REPLACE VIEW ops.v_work_orders AS
 SELECT w.id, w.batch_code, w.bom_id, w.finished_qbo_item_id, w.qty_to_produce, w.qty_produced_actual, w.production_location_id, w.status,
    w.scheduled_date, w.consumed_at, w.consumed_by, w.closed_at, w.closed_by, w.voided_at, w.voided_by, w.void_reason, w.notes, w.created_by,
    w.created_at, w.updated_at, w.qbo_inventory_adjustment_id, w.qbo_pushed_at, w.qbo_push_error, w.target_uom, w.actual_yield_qty, w.actual_yield_uom,
    w.formula_id, w.copacker_qbo_vendor_id, w.copacker_location_id, w.destination_location_id, w.batch_size_gal, w.expected_units, w.yield_pct,
    w.ordered_at, w.materials_at_copacker_at, w.production_started_at, w.yield_recorded_at, w.shipped_at, w.received_at, w.ship_carrier, w.ship_tracking,
    w.ship_bol_number, w.transfer_id,
    b.name AS bom_name, b.version AS bom_version, b.yield_uom AS bom_yield_uom, b.cans_per_case AS bom_cans_per_case, b.oz_per_can AS bom_oz_per_can,
    f.name AS formula_name, f.doc_rev AS formula_doc_rev, it.name AS finished_item_name, cv.display_name AS copacker_vendor_name,
    (cl.code || ' · '::text) || cl.name AS copacker_location_label, (dl.code || ' · '::text) || dl.name AS destination_location_label,
    t.bol_number AS transfer_bol_number, t.status AS transfer_status,
    c.total_cost, c.unit_cost, c.components_cost, c.services_cost,
    po.po_count, po.po_open_count,
    ops.fn_status_bucket('work_order'::text, w.status) AS bucket,
    w.reopened_at, w.reopen_reason,
    w.run_id, r.run_number
   FROM ops.work_orders w
     LEFT JOIN ops.product_bom b ON b.id = w.bom_id
     LEFT JOIN ops.product_formulas f ON f.id = w.formula_id
     LEFT JOIN ops.qbo_items it ON it.qbo_item_id = w.finished_qbo_item_id
     LEFT JOIN ops.qbo_vendors cv ON cv.qbo_vendor_id = w.copacker_qbo_vendor_id
     LEFT JOIN ops.inventory_locations cl ON cl.id = w.copacker_location_id
     LEFT JOIN ops.inventory_locations dl ON dl.id = w.destination_location_id
     LEFT JOIN ops.inventory_transfers t ON t.id = w.transfer_id
     LEFT JOIN ops.work_order_costs c ON c.wo_id = w.id
     LEFT JOIN ops.production_runs r ON r.id = w.run_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS po_count,
            count(*) FILTER (WHERE p.status = ANY (ARRAY['open'::text, 'partial'::text]))::integer AS po_open_count
           FROM ops.purchase_orders p
          WHERE p.work_order_id = w.id OR p.id IN (SELECT DISTINCT m.po_id FROM ops.work_order_materials m WHERE m.wo_id = w.id AND m.po_id IS NOT NULL)) po ON true;

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
    o.po_kind, o.reopened_at, o.reopen_reason, o.close_rule, o.closed_reason,
    COALESCE(l.receivable_line_count, 0) AS receivable_line_count,
    o.production_run_id, r.run_number,
    COALESCE(wob.batch_codes, wo.batch_code) AS work_order_batch_codes,
    COALESCE(l.qty_surplus_total, 0::numeric) AS qty_surplus_total
   FROM ops.purchase_orders o
     LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = o.qbo_vendor_id
     LEFT JOIN ops.inventory_locations loc ON loc.id = o.destination_location_id
     LEFT JOIN ops.work_orders wo ON wo.id = o.work_order_id
     LEFT JOIN ops.production_runs r ON r.id = o.production_run_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS line_count,
            count(*) FILTER (WHERE pl.receivable)::integer AS receivable_line_count,
            sum(pl.qty_ordered) AS qty_ordered_total,
            sum(pl.qty_received) AS qty_received_total,
            sum(GREATEST(pl.qty_ordered - pl.demand_total, 0)) FILTER (WHERE pl.demand_total IS NOT NULL) AS qty_surplus_total
           FROM ops.purchase_order_lines pl WHERE pl.po_id = o.id) l ON true
     LEFT JOIN LATERAL ( SELECT string_agg(DISTINCT w.batch_code, ', ' ORDER BY w.batch_code) AS batch_codes
           FROM ops.purchase_order_line_demand d JOIN ops.work_orders w ON w.id = d.wo_id WHERE d.po_id = o.id) wob ON true;
GRANT SELECT ON ops.v_purchase_orders TO authenticated, service_role;

-- reservations are real now
CREATE OR REPLACE VIEW ops.v_copacker_stock WITH (security_invoker = on) AS
WITH loc AS (SELECT id, code, name FROM ops.inventory_locations WHERE kind = 'co_packer' AND is_active),
oh AS (SELECT h.qbo_item_id, h.location_id, h.on_hand FROM ops.v_inventory_on_hand h JOIN loc ON loc.id = h.location_id),
items AS (
  SELECT DISTINCT x.qbo_item_id, x.location_id FROM (
    SELECT qbo_item_id, location_id FROM oh
    UNION ALL SELECT pi.qbo_item_id, loc.id FROM ops.production_items pi CROSS JOIN loc WHERE pi.active) x),
res AS (SELECT qbo_item_id, location_id, sum(qty) AS reserved FROM ops.inventory_reservations WHERE status = 'active' GROUP BY 1, 2),
demand AS (
  SELECT m.component_qbo_item_id AS qbo_item_id, w.copacker_location_id AS location_id, sum(COALESCE(m.demand_qty, m.required_qty)) AS open_demand
    FROM ops.work_order_materials m JOIN ops.work_orders w ON w.id = m.wo_id WHERE w.status IN ('draft', 'ordered', 'at_copacker') GROUP BY 1, 2),
last_mv AS (
  SELECT qbo_item_id, location_id, max(occurred_at) AS last_movement_at
    FROM (SELECT qbo_item_id, to_location_id AS location_id, occurred_at FROM ops.inventory_movements WHERE to_location_id IS NOT NULL
          UNION ALL SELECT qbo_item_id, from_location_id, occurred_at FROM ops.inventory_movements WHERE from_location_id IS NOT NULL) m GROUP BY 1, 2),
last_cost AS (
  SELECT DISTINCT ON (qbo_item_id, to_location_id) qbo_item_id, to_location_id AS location_id, unit_cost
    FROM ops.inventory_movements WHERE to_location_id IS NOT NULL AND unit_cost IS NOT NULL ORDER BY qbo_item_id, to_location_id, occurred_at DESC)
SELECT i.qbo_item_id, qi.name AS item_name, qi.type AS item_type,
       i.location_id, loc.code AS location_code, loc.name AS location_name,
       COALESCE(oh.on_hand, 0)::numeric AS on_hand,
       COALESCE(rv.reserved, 0)::numeric AS reserved,
       (COALESCE(oh.on_hand, 0) - COALESCE(rv.reserved, 0))::numeric AS available,
       COALESCE(d.open_demand, 0)::numeric AS open_demand,
       lc.unit_cost AS last_unit_cost, lm.last_movement_at,
       pi.min_order_qty, pi.order_multiple, pi.lead_days
  FROM items i
  JOIN loc ON loc.id = i.location_id
  LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = i.qbo_item_id
  LEFT JOIN ops.production_items pi ON pi.qbo_item_id = i.qbo_item_id
  LEFT JOIN oh ON oh.qbo_item_id = i.qbo_item_id AND oh.location_id = i.location_id
  LEFT JOIN res rv ON rv.qbo_item_id = i.qbo_item_id AND rv.location_id = i.location_id
  LEFT JOIN demand d ON d.qbo_item_id = i.qbo_item_id AND d.location_id = i.location_id
  LEFT JOIN last_mv lm ON lm.qbo_item_id = i.qbo_item_id AND lm.location_id = i.location_id
  LEFT JOIN last_cost lc ON lc.qbo_item_id = i.qbo_item_id AND lc.location_id = i.location_id;
GRANT SELECT ON ops.v_copacker_stock TO authenticated, service_role;

-- one transfer now serves several WOs: a lot line belongs to the WO whose item it is
CREATE OR REPLACE VIEW ops.v_lot_trace AS
 SELECT wl.id AS lot_id, wl.lot_code, wl.born_on_date, wl.best_by_date, wl.qty, wl.notes AS lot_notes,
    w.id AS wo_id, w.batch_code, w.finished_qbo_item_id, it.name AS finished_item_name, w.status AS wo_status,
    w.production_started_at, w.yield_recorded_at, cl.name AS copacker_location, dl.name AS destination_location,
    t.id AS transfer_id, t.bol_number, t.status AS transfer_status, t.ship_date, t.received_date,
    tl.id AS transfer_line_id, tl.qty_received,
    ( SELECT count(*) FROM ops.inventory_movements m WHERE m.source_doc_line_id = tl.id) AS movement_count
   FROM ops.work_order_lots wl
     JOIN ops.work_orders w ON w.id = wl.wo_id
     LEFT JOIN ops.qbo_items it ON it.qbo_item_id = w.finished_qbo_item_id
     LEFT JOIN ops.inventory_locations cl ON cl.id = w.copacker_location_id
     LEFT JOIN ops.inventory_locations dl ON dl.id = w.destination_location_id
     LEFT JOIN ops.inventory_transfers t ON t.id = w.transfer_id
     LEFT JOIN ops.inventory_transfer_lines tl ON tl.transfer_id = t.id AND tl.lot_code = wl.lot_code AND tl.qbo_item_id = w.finished_qbo_item_id;

COMMIT;
