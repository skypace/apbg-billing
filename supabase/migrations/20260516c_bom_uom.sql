-- BOM unit-of-measure support.
--
-- Before this migration, ops.product_bom.yield_qty and
-- ops.product_bom_lines.qty_per were both dimensionless numerics — the operator
-- had to know what unit they meant. This adds a UoM column to both, and a
-- target_uom to ops.work_orders so a production run can specify "make 1000
-- gallons" and have the BOM scaler convert it to BOM-yield runs.
--
-- Common UoM values: each, case, gal, fl_oz, L, mL, lb, oz. Free text allowed
-- for site-specific units (kg, drum, pallet, etc.). The frontend UoM dropdown
-- in app/src/pages/production/BomsTab.tsx lists the common set;
-- app/src/lib/uom.ts holds the conversion factors + scaler.
--
-- Already applied live via Supabase MCP on 2026-05-16.

ALTER TABLE ops.product_bom
  ADD COLUMN IF NOT EXISTS yield_uom text NOT NULL DEFAULT 'each';

ALTER TABLE ops.product_bom_lines
  ADD COLUMN IF NOT EXISTS qty_uom text NOT NULL DEFAULT 'each';

ALTER TABLE ops.work_orders
  ADD COLUMN IF NOT EXISTS target_uom text;

COMMENT ON COLUMN ops.product_bom.yield_uom IS
  'Unit of measure for yield_qty. Common: each, case, gal, fl_oz, L, mL, lb, oz.';
COMMENT ON COLUMN ops.product_bom_lines.qty_uom IS
  'Unit of measure for qty_per. Same UoM vocabulary as yield_uom.';
COMMENT ON COLUMN ops.work_orders.target_uom IS
  'Unit the operator typed when creating the WO. qty_to_produce is converted to BOM yield_uom for multiplying BOM lines. NULL = legacy (qty_to_produce in BOM yield_uom).';

-- fn_create_bom: accept p_yield_uom, persist qty_uom from p_lines jsonb.
CREATE OR REPLACE FUNCTION ops.fn_create_bom(
  p_finished_qbo_item_id text,
  p_yield_qty numeric,
  p_lines jsonb,
  p_version text DEFAULT '1'::text,
  p_effective_date date DEFAULT NULL::date,
  p_notes text DEFAULT NULL::text,
  p_yield_uom text DEFAULT 'each'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE
  v_id UUID; v_actor UUID := auth.uid(); v_line JSONB; v_lt TEXT; v_sort INTEGER := 100;
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

  INSERT INTO ops.product_bom (finished_qbo_item_id, version, effective_date, yield_qty, yield_uom, notes, created_by)
  VALUES (p_finished_qbo_item_id, p_version, p_effective_date, p_yield_qty, COALESCE(NULLIF(p_yield_uom, ''), 'each'), p_notes, v_actor)
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
      qty_per, qty_uom, scrap_pct, default_cost, notes, sort_order
    )
    VALUES (
      v_id, v_lt,
      CASE WHEN v_lt = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_lt = 'service'   THEN v_line ->> 'service_label'   END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'qty_uom', ''), 'each'),
      COALESCE(NULLIF(v_line ->> 'scrap_pct', '')::numeric, 0),
      NULLIF(v_line ->> 'default_cost', '')::numeric,
      v_line ->> 'notes',
      v_sort
    );
    v_sort := v_sort + 10;
  END LOOP;

  RETURN v_id;
END;
$function$;

-- fn_replace_bom_lines: persist qty_uom from p_lines jsonb (no signature change).
CREATE OR REPLACE FUNCTION ops.fn_replace_bom_lines(p_bom_id uuid, p_lines jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE v_active_wos INTEGER; v_line JSONB; v_lt TEXT; v_sort INTEGER := 100;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  SELECT count(*) INTO v_active_wos FROM ops.work_orders WHERE bom_id = p_bom_id AND status IN ('draft','consumed');
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
      qty_per, qty_uom, scrap_pct, default_cost, notes, sort_order
    )
    VALUES (
      p_bom_id, v_lt,
      CASE WHEN v_lt = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_lt = 'service'   THEN v_line ->> 'service_label'   END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'qty_uom', ''), 'each'),
      COALESCE(NULLIF(v_line ->> 'scrap_pct', '')::numeric, 0),
      NULLIF(v_line ->> 'default_cost', '')::numeric,
      v_line ->> 'notes',
      v_sort
    );
    v_sort := v_sort + 10;
  END LOOP;
END;
$function$;

-- fn_create_work_order: accept p_target_uom, persist on work_orders row.
CREATE OR REPLACE FUNCTION ops.fn_create_work_order(
  p_bom_id uuid,
  p_qty_to_produce numeric,
  p_production_location_id uuid,
  p_scheduled_date date DEFAULT NULL::date,
  p_notes text DEFAULT NULL::text,
  p_target_uom text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE
  v_id UUID; v_batch TEXT; v_finished_item_id TEXT; v_loc_kind TEXT; v_actor UUID := auth.uid();
BEGIN
  IF p_qty_to_produce IS NULL OR p_qty_to_produce <= 0 THEN
    RAISE EXCEPTION 'qty_to_produce must be > 0';
  END IF;

  SELECT finished_qbo_item_id INTO v_finished_item_id FROM ops.product_bom WHERE id = p_bom_id AND is_active;
  IF v_finished_item_id IS NULL THEN RAISE EXCEPTION 'bom_id not found or inactive'; END IF;

  SELECT kind INTO v_loc_kind FROM ops.inventory_locations WHERE id = p_production_location_id;
  IF v_loc_kind IS NULL THEN RAISE EXCEPTION 'production_location_id not found'; END IF;
  IF v_loc_kind IN ('in_transit', 'adjustment') THEN
    RAISE EXCEPTION 'Production location cannot be a virtual location';
  END IF;

  v_batch := ops.fn_next_wo_batch_code();

  INSERT INTO ops.work_orders (
    batch_code, bom_id, finished_qbo_item_id, qty_to_produce, target_uom,
    production_location_id, status, scheduled_date, notes, created_by
  )
  VALUES (
    v_batch, p_bom_id, v_finished_item_id, p_qty_to_produce, p_target_uom,
    p_production_location_id, 'draft', p_scheduled_date, p_notes, v_actor
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
