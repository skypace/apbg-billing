-- BOM unit-of-measure support + volume bridge for cross-family scaling.
--
-- Before this migration, ops.product_bom.yield_qty and
-- ops.product_bom_lines.qty_per were both dimensionless numerics — the operator
-- had to know what unit they meant. This adds a UoM column to both, plus a
-- target_uom to ops.work_orders so a production run can specify "make 1000
-- gallons" and have the BOM scaler convert it to BOM-yield runs.
--
-- ops.product_bom.finished_vol_per_yield_gal is the optional volume bridge:
-- when yield_uom is a count UoM (each/case) and 1 yield produces a known
-- volume of finished product, this column captures the gallons-per-yield so
-- the scaler can convert "make 1000 gal" → runs.
--
-- Common UoM values: each, case, gal, fl_oz, L, mL, lb, oz. Free text allowed
-- for site-specific units (kg, drum, pallet, etc.). The frontend dropdown in
-- app/src/pages/production/BomsTab.tsx lists the common set;
-- app/src/lib/uom.ts holds the conversion factors + scaler.
--
-- Already applied live via Supabase MCP on 2026-05-16.

ALTER TABLE ops.product_bom
  ADD COLUMN IF NOT EXISTS yield_uom text NOT NULL DEFAULT 'each';

ALTER TABLE ops.product_bom_lines
  ADD COLUMN IF NOT EXISTS qty_uom text NOT NULL DEFAULT 'each';

ALTER TABLE ops.work_orders
  ADD COLUMN IF NOT EXISTS target_uom text;

ALTER TABLE ops.product_bom
  ADD COLUMN IF NOT EXISTS finished_vol_per_yield_gal numeric;

COMMENT ON COLUMN ops.product_bom.yield_uom IS
  'Unit of measure for yield_qty. Common: each, case, gal, fl_oz, L, mL, lb, oz.';
COMMENT ON COLUMN ops.product_bom_lines.qty_uom IS
  'Unit of measure for qty_per. Same UoM vocabulary as yield_uom.';
COMMENT ON COLUMN ops.work_orders.target_uom IS
  'Unit the operator typed when creating the WO. Informational-only today: captured for the UI/audit trail, but fn_consume_work_order and fn_close_work_order do NOT read it — they compute (qty_to_produce / yield_qty) * qty_per * (1 + scrap_pct) directly. Phase 2 will wire UoM conversion into those functions. Today, qty_to_produce must already be expressed in BOM yield_uom; passing target_uom != yield_uom will not convert. NULL = legacy (created before this column existed).';
COMMENT ON COLUMN ops.product_bom.finished_vol_per_yield_gal IS
  'Optional volume bridge for count-family yields: how many gallons of finished product 1 yield (e.g. 1 case) produces. Enables "make 1000 gal" scaling in the Scale this BOM panel when yield_uom is each/case.';

-- Drop the old fixed-arg signatures before re-creating with the new params.
-- CREATE OR REPLACE only matches on (name, arg_types); changing the signature
-- creates a new overload alongside the old one (PG zombie overload trap —
-- see 20260514b_fix_set_inventory_settings_partial_patch.sql for the same
-- pattern). Use the exact original signatures from 20260514b_phase2_bom_work_orders.sql.
DROP FUNCTION IF EXISTS ops.fn_create_bom(text, numeric, jsonb, text, date, text);
DROP FUNCTION IF EXISTS ops.fn_create_work_order(uuid, numeric, uuid, date, text);

-- fn_create_bom: accept p_yield_uom + p_finished_vol_per_yield_gal,
-- and persist qty_uom from p_lines jsonb.
CREATE OR REPLACE FUNCTION ops.fn_create_bom(
  p_finished_qbo_item_id text,
  p_yield_qty numeric,
  p_lines jsonb,
  p_version text DEFAULT '1'::text,
  p_effective_date date DEFAULT NULL::date,
  p_notes text DEFAULT NULL::text,
  p_yield_uom text DEFAULT 'each',
  p_finished_vol_per_yield_gal numeric DEFAULT NULL
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

  INSERT INTO ops.product_bom (finished_qbo_item_id, version, effective_date, yield_qty, yield_uom, finished_vol_per_yield_gal, notes, created_by)
  VALUES (p_finished_qbo_item_id, p_version, p_effective_date, p_yield_qty, COALESCE(NULLIF(p_yield_uom, ''), 'each'), p_finished_vol_per_yield_gal, p_notes, v_actor)
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

-- fn_replace_bom_lines: no signature change, but persist qty_uom from p_lines.
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

-- Grants match the convention from 20260514b — explicit EXECUTE on every
-- new signature. CREATE OR REPLACE does not preserve grants across signature
-- changes, and the prior overloads' grants don't apply to the new ones.
GRANT EXECUTE ON FUNCTION ops.fn_create_bom(text, numeric, jsonb, text, date, text, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_create_work_order(uuid, numeric, uuid, date, text, text) TO authenticated;
