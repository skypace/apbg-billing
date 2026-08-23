-- Alameda Soda production hardening.
--
-- Production already has the Phase 2 BOM/work-order tables, but the UI and
-- live database had drifted ahead of the committed migrations. This records
-- those columns, removes stale RPC overloads, and makes the work-order
-- consume/close math use one scale calculation instead of assuming every
-- work order quantity is already in the BOM yield unit.

ALTER TABLE ops.product_bom
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS dilution_ratio numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cans_per_case integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS oz_per_can numeric NOT NULL DEFAULT 12;

ALTER TABLE ops.work_orders
  ADD COLUMN IF NOT EXISTS actual_yield_qty numeric,
  ADD COLUMN IF NOT EXISTS actual_yield_uom text;

ALTER TABLE ops.work_order_costs
  ADD COLUMN IF NOT EXISTS per_case numeric,
  ADD COLUMN IF NOT EXISTS per_can numeric,
  ADD COLUMN IF NOT EXISTS per_oz numeric,
  ADD COLUMN IF NOT EXISTS per_gal_finished numeric,
  ADD COLUMN IF NOT EXISTS actual_yield_pct numeric,
  ADD COLUMN IF NOT EXISTS yield_loss_dollars numeric;

COMMENT ON COLUMN ops.product_bom.name IS
  'Operator-friendly recipe name, e.g. Hangar 25 Diet Cola - 24 pack case.';
COMMENT ON COLUMN ops.product_bom.dilution_ratio IS
  'Water parts per one part concentrate. 5 means 5:1 post-mix, producing 6x finished volume from concentrate volume.';
COMMENT ON COLUMN ops.product_bom.cans_per_case IS
  'Pack count used for Alameda Soda per-case/per-can cost rollups.';
COMMENT ON COLUMN ops.product_bom.oz_per_can IS
  'Fluid ounces per can used for Alameda Soda per-case/per-can cost rollups.';
COMMENT ON COLUMN ops.work_orders.target_uom IS
  'Unit typed by the operator when creating the work order. Consume/close use ops.fn_bom_scale_runs to convert this into BOM runs.';
COMMENT ON COLUMN ops.work_orders.actual_yield_qty IS
  'Actual yield in the operator-entered close unit. qty_produced_actual stores the equivalent finished QBO item quantity.';
COMMENT ON COLUMN ops.work_orders.actual_yield_uom IS
  'Unit for actual_yield_qty.';

-- Remove stale overloads that make PostgREST schema matching brittle.
DROP FUNCTION IF EXISTS ops.fn_create_bom(text, numeric, jsonb, text, date, text);
DROP FUNCTION IF EXISTS ops.fn_create_bom(text, numeric, jsonb, text, date, text, text);
DROP FUNCTION IF EXISTS ops.fn_create_bom(text, numeric, jsonb, text, date, text, text, numeric);

CREATE OR REPLACE FUNCTION ops.fn_bom_uom_to_fl_oz(
  p_qty numeric,
  p_uom text
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_qty IS NULL OR p_uom IS NULL THEN NULL
    WHEN p_uom = 'fl_oz' THEN p_qty
    WHEN p_uom = 'gal'   THEN p_qty * 128
    WHEN p_uom = 'L'     THEN p_qty * 33.8140227
    WHEN p_uom = 'mL'    THEN p_qty * 0.0338140227
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_bom_item_volume_fl_oz(
  p_name text,
  p_type text DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_name text := trim(COALESCE(p_name, ''));
  v_scan text;
  v_type text := lower(COALESCE(p_type, ''));
  v_match text[];
  v_unit text;
  v_a numeric;
  v_b numeric;
BEGIN
  IF v_name = '' OR v_type IN ('service', 'category') THEN
    RETURN NULL;
  END IF;
  v_scan := replace(v_name, chr(215), 'x');

  -- Parenthesized pack volume: (8 x 12 fl oz), (24 * 12 oz), etc.
  v_match := regexp_match(v_scan, '\(([0-9]+[.]?[0-9]*)\s*[x*]\s*([0-9]+[.]?[0-9]*)\s*(fl\s*oz|oz|gal|l|ml)\s*\)', 'i');
  IF v_match IS NOT NULL THEN
    v_a := v_match[1]::numeric;
    v_b := v_match[2]::numeric;
    v_unit := lower(regexp_replace(v_match[3], '\s+', '', 'g'));
    IF v_unit IN ('floz', 'oz') THEN RETURN v_a * v_b; END IF;
    IF v_unit = 'gal' THEN RETURN v_a * v_b * 128; END IF;
    IF v_unit = 'l' THEN RETURN v_a * v_b * 33.8140227; END IF;
    IF v_unit = 'ml' THEN RETURN v_a * v_b * 0.0338140227; END IF;
  END IF;

  -- 1GNS1091, 1GN1091, 3G2051, 5G6121, etc.
  v_match := regexp_match(v_scan, '^([0-9]+[.]?[0-9]*)\s*G(NS?)?[0-9]', 'i');
  IF v_match IS NOT NULL THEN
    RETURN v_match[1]::numeric * 128;
  END IF;

  -- 2L2051 style liter prefix.
  v_match := regexp_match(v_scan, '^([0-9]+[.]?[0-9]*)\s*L[0-9]', 'i');
  IF v_match IS NOT NULL THEN
    RETURN v_match[1]::numeric * 33.8140227;
  END IF;

  -- 8PK12 / 24P12 style pack prefix. Conservative: only count ounce sizes
  -- in the normal beverage range so SKU suffixes do not become volume.
  v_match := regexp_match(v_scan, '^([0-9]+)\s*PK([0-9]{1,2})', 'i');
  IF v_match IS NULL THEN
    v_match := regexp_match(v_scan, '^([0-9]+)\s*P([0-9]{1,2})', 'i');
  END IF;
  IF v_match IS NOT NULL THEN
    v_a := v_match[1]::numeric;
    v_b := v_match[2]::numeric;
    IF v_b BETWEEN 6 AND 32 THEN
      RETURN v_a * v_b;
    END IF;
  END IF;

  -- 12OZ CAN / 16OZ BOTTLE single-container item.
  v_match := regexp_match(v_scan, '^([0-9]+[.]?[0-9]*)\s*OZ\s+(CAN|BTL|BOTTLE|CUP|MUG|GLASS)', 'i');
  IF v_match IS NOT NULL THEN
    RETURN v_match[1]::numeric;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_bom_scale_runs(
  p_bom_id uuid,
  p_target_qty numeric,
  p_target_uom text DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
DECLARE
  v_bom record;
  v_target_uom text;
  v_target_fl_oz numeric;
  v_yield_fl_oz numeric;
  v_concentrate_fl_oz numeric;
BEGIN
  IF p_target_qty IS NULL OR p_target_qty <= 0 THEN
    RAISE EXCEPTION 'target quantity must be > 0';
  END IF;

  SELECT *
    INTO v_bom
    FROM ops.product_bom
    WHERE id = p_bom_id;

  IF v_bom.id IS NULL THEN
    RAISE EXCEPTION 'bom % not found', p_bom_id;
  END IF;

  v_target_uom := COALESCE(NULLIF(p_target_uom, ''), v_bom.yield_uom, 'each');

  IF v_target_uom = COALESCE(v_bom.yield_uom, 'each') THEN
    RETURN p_target_qty / v_bom.yield_qty;
  END IF;

  v_target_fl_oz := ops.fn_bom_uom_to_fl_oz(p_target_qty, v_target_uom);

  IF v_target_fl_oz IS NOT NULL THEN
    IF COALESCE(v_bom.dilution_ratio, 0) > 0 THEN
      SELECT COALESCE(sum(
        CASE
          WHEN ops.fn_bom_uom_to_fl_oz(l.qty_per, l.qty_uom) IS NOT NULL
            THEN ops.fn_bom_uom_to_fl_oz(l.qty_per, l.qty_uom)
          ELSE l.qty_per * COALESCE(ops.fn_bom_item_volume_fl_oz(qi.name, qi.type), 0)
        END
      ), 0)
        INTO v_concentrate_fl_oz
        FROM ops.product_bom_lines l
        LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.component_qbo_item_id
       WHERE l.bom_id = p_bom_id
         AND l.line_type = 'component';

      IF v_concentrate_fl_oz > 0 THEN
        RETURN v_target_fl_oz / (v_concentrate_fl_oz * (1 + v_bom.dilution_ratio));
      END IF;
    END IF;

    v_yield_fl_oz := ops.fn_bom_uom_to_fl_oz(v_bom.yield_qty, v_bom.yield_uom);
    IF v_yield_fl_oz IS NOT NULL THEN
      RETURN v_target_fl_oz / v_yield_fl_oz;
    END IF;

    IF COALESCE(v_bom.finished_vol_per_yield_gal, 0) > 0 THEN
      RETURN (v_target_fl_oz / 128) / v_bom.finished_vol_per_yield_gal;
    END IF;
  END IF;

  RAISE EXCEPTION 'Cannot scale BOM % from % to %. Use the BOM yield unit or set a valid finished-volume bridge/dilution ratio.',
    p_bom_id, v_target_uom, v_bom.yield_uom;
END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_bom_target_to_yield_qty(
  p_bom_id uuid,
  p_target_qty numeric,
  p_target_uom text DEFAULT NULL
) RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  SELECT ops.fn_bom_scale_runs(p_bom_id, p_target_qty, p_target_uom) * b.yield_qty
  FROM ops.product_bom b
  WHERE b.id = p_bom_id;
$$;

CREATE OR REPLACE FUNCTION ops.fn_bom_finished_inventory_qty(
  p_bom_id uuid,
  p_finished_qty numeric,
  p_finished_uom text DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
DECLARE
  v_bom record;
  v_uom text;
  v_fl_oz numeric;
BEGIN
  IF p_finished_qty IS NULL OR p_finished_qty <= 0 THEN
    RAISE EXCEPTION 'finished quantity must be > 0';
  END IF;

  SELECT *
    INTO v_bom
    FROM ops.product_bom
    WHERE id = p_bom_id;

  IF v_bom.id IS NULL THEN
    RAISE EXCEPTION 'bom % not found', p_bom_id;
  END IF;

  v_uom := COALESCE(NULLIF(p_finished_uom, ''), v_bom.yield_uom, 'each');
  v_fl_oz := ops.fn_bom_uom_to_fl_oz(p_finished_qty, v_uom);

  -- Alameda Soda is made by the gallon, then packed into the finished QBO
  -- item. For a 24 x 12 oz finished case, 500 gal becomes 222.222 cases.
  IF v_fl_oz IS NOT NULL
     AND COALESCE(v_bom.cans_per_case, 0) > 0
     AND COALESCE(v_bom.oz_per_can, 0) > 0 THEN
    RETURN v_fl_oz / (v_bom.cans_per_case * v_bom.oz_per_can);
  END IF;

  -- Legacy count-based BOMs already express the finished inventory quantity
  -- directly in the target/yield unit.
  RETURN ops.fn_bom_scale_runs(p_bom_id, p_finished_qty, v_uom) * v_bom.yield_qty;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_bom_uom_to_fl_oz(numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_bom_item_volume_fl_oz(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_bom_scale_runs(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_bom_target_to_yield_qty(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_bom_finished_inventory_qty(uuid, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_create_bom(
  p_finished_qbo_item_id text,
  p_yield_qty numeric,
  p_yield_uom text DEFAULT 'each',
  p_finished_vol_per_yield_gal numeric DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_version text DEFAULT '1',
  p_effective_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, public
AS $$
DECLARE
  v_bom_id uuid;
  v_line jsonb;
  v_line_type text;
  v_sort int := 100;
BEGIN
  IF NULLIF(trim(COALESCE(p_finished_qbo_item_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'finished_qbo_item_id is required';
  END IF;
  IF p_yield_qty IS NULL OR p_yield_qty <= 0 THEN
    RAISE EXCEPTION 'yield_qty must be > 0';
  END IF;
  IF jsonb_typeof(COALESCE(p_lines, '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(p_lines, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  INSERT INTO ops.product_bom (
    finished_qbo_item_id, version, effective_date,
    yield_qty, yield_uom, finished_vol_per_yield_gal,
    is_active, notes, name, created_by
  ) VALUES (
    p_finished_qbo_item_id,
    COALESCE(NULLIF(trim(p_version), ''), '1'),
    p_effective_date,
    p_yield_qty,
    COALESCE(NULLIF(trim(p_yield_uom), ''), 'each'),
    p_finished_vol_per_yield_gal,
    true,
    p_notes,
    NULLIF(trim(COALESCE(p_name, '')), ''),
    auth.uid()
  )
  RETURNING id INTO v_bom_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb))
  LOOP
    v_line_type := v_line ->> 'line_type';
    IF v_line_type NOT IN ('component', 'service') THEN
      RAISE EXCEPTION 'line_type must be component or service';
    END IF;
    IF (v_line ->> 'qty_per') IS NULL OR (v_line ->> 'qty_per')::numeric <= 0 THEN
      RAISE EXCEPTION 'qty_per must be > 0';
    END IF;
    IF v_line_type = 'component' AND NULLIF(v_line ->> 'component_qbo_item_id', '') IS NULL THEN
      RAISE EXCEPTION 'component lines require component_qbo_item_id';
    END IF;
    IF v_line_type = 'service' AND NULLIF(v_line ->> 'service_label', '') IS NULL THEN
      RAISE EXCEPTION 'service lines require service_label';
    END IF;

    INSERT INTO ops.product_bom_lines (
      bom_id, line_type,
      component_qbo_item_id, service_label,
      qty_per, qty_uom, scrap_pct, default_cost, notes, sort_order
    ) VALUES (
      v_bom_id,
      v_line_type,
      CASE WHEN v_line_type = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_line_type = 'service' THEN v_line ->> 'service_label' END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'qty_uom', ''), 'each'),
      COALESCE(NULLIF(v_line ->> 'scrap_pct', '')::numeric, 0),
      NULLIF(v_line ->> 'default_cost', '')::numeric,
      v_line ->> 'notes',
      v_sort
    );
    v_sort := v_sort + 10;
  END LOOP;

  RETURN v_bom_id;
END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_consume_work_order(p_wo_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_status text;
  v_bom_id uuid;
  v_qty_target numeric;
  v_target_uom text;
  v_loc_id uuid;
  v_actor uuid := auth.uid();
  v_runs numeric;
BEGIN
  SELECT w.status, w.bom_id, w.qty_to_produce, COALESCE(w.target_uom, b.yield_uom),
         w.production_location_id
    INTO v_status, v_bom_id, v_qty_target, v_target_uom, v_loc_id
    FROM ops.work_orders w
    JOIN ops.product_bom b ON b.id = w.bom_id
    WHERE w.id = p_wo_id
    FOR UPDATE OF w;

  IF v_status IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'work order % is %, can only consume from draft', p_wo_id, v_status;
  END IF;

  v_runs := ops.fn_bom_scale_runs(v_bom_id, v_qty_target, v_target_uom);

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  SELECT
    'production_consume',
    l.component_qbo_item_id,
    v_runs * l.qty_per * (1 + l.scrap_pct),
    v_loc_id,
    NULL,
    COALESCE(l.default_cost,
             (SELECT purchase_cost FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id)),
    'work_order', p_wo_id, l.id,
    now(), v_actor,
    'WO consume - ' || COALESCE(l.notes, '')
  FROM ops.product_bom_lines l
  WHERE l.bom_id = v_bom_id
    AND l.line_type = 'component';

  UPDATE ops.work_orders
     SET status = 'consumed',
         consumed_at = now(),
         consumed_by = v_actor
   WHERE id = p_wo_id;
END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_close_work_order(
  p_wo_id uuid,
  p_qty_produced_actual numeric,
  p_close_date date DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_status text;
  v_bom_id uuid;
  v_bom record;
  v_loc_id uuid;
  v_finished_item_id text;
  v_qty_target numeric;
  v_target_uom text;
  v_actor uuid := auth.uid();
  v_runs_planned numeric;
  v_runs_actual numeric;
  v_planned_yield_qty numeric;
  v_actual_yield_qty numeric;
  v_finished_inventory_qty numeric;
  v_components_cost numeric := 0;
  v_services_cost numeric := 0;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_detail jsonb := '[]'::jsonb;
  v_planned_fl_oz numeric;
  v_actual_fl_oz numeric;
  v_per_oz numeric;
  v_per_can numeric;
  v_per_case numeric;
  v_per_gal numeric;
  v_yield_pct numeric;
  v_yield_loss numeric;
BEGIN
  IF p_qty_produced_actual IS NULL OR p_qty_produced_actual <= 0 THEN
    RAISE EXCEPTION 'qty_produced_actual must be > 0';
  END IF;

  SELECT w.status, w.bom_id, w.production_location_id, w.finished_qbo_item_id,
         w.qty_to_produce, COALESCE(w.target_uom, b.yield_uom) AS target_uom
    INTO v_status, v_bom_id, v_loc_id, v_finished_item_id,
         v_qty_target, v_target_uom
    FROM ops.work_orders w
    JOIN ops.product_bom b ON b.id = w.bom_id
    WHERE w.id = p_wo_id
    FOR UPDATE OF w;

  IF v_status IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_status <> 'consumed' THEN
    RAISE EXCEPTION 'work order % is %, can only close from consumed', p_wo_id, v_status;
  END IF;

  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_bom_id;

  v_runs_planned := ops.fn_bom_scale_runs(v_bom_id, v_qty_target, v_target_uom);
  v_runs_actual := ops.fn_bom_scale_runs(v_bom_id, p_qty_produced_actual, v_target_uom);
  v_planned_yield_qty := v_runs_planned * v_bom.yield_qty;
  v_actual_yield_qty := v_runs_actual * v_bom.yield_qty;
  v_finished_inventory_qty := ops.fn_bom_finished_inventory_qty(v_bom_id, p_qty_produced_actual, v_target_uom);

  WITH comp AS (
    SELECT
      l.id,
      l.component_qbo_item_id AS item_id,
      v_runs_planned * l.qty_per * (1 + l.scrap_pct) AS qty_consumed,
      l.qty_uom,
      COALESCE(l.default_cost,
               (SELECT purchase_cost FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id)) AS unit_cost,
      (SELECT name FROM ops.qbo_items WHERE qbo_item_id = l.component_qbo_item_id) AS item_name,
      l.notes
    FROM ops.product_bom_lines l
    WHERE l.bom_id = v_bom_id
      AND l.line_type = 'component'
  )
  SELECT
    COALESCE(sum(qty_consumed * COALESCE(unit_cost, 0)), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'kind', 'component',
      'label', COALESCE(item_name, item_id),
      'qbo_item_id', item_id,
      'qty', qty_consumed,
      'uom', qty_uom,
      'unit_cost', unit_cost,
      'extended_cost', qty_consumed * COALESCE(unit_cost, 0),
      'notes', notes
    ) ORDER BY item_name), '[]'::jsonb)
  INTO v_components_cost, v_detail
  FROM comp;

  WITH svc AS (
    SELECT
      l.id,
      l.service_label,
      v_runs_planned * l.qty_per AS qty,
      l.qty_uom,
      l.default_cost,
      l.notes
    FROM ops.product_bom_lines l
    WHERE l.bom_id = v_bom_id
      AND l.line_type = 'service'
  )
  SELECT
    COALESCE(sum(qty * COALESCE(default_cost, 0)), 0),
    v_detail || COALESCE(jsonb_agg(jsonb_build_object(
      'kind', 'service',
      'label', service_label,
      'qty', qty,
      'uom', qty_uom,
      'unit_cost', default_cost,
      'extended_cost', qty * COALESCE(default_cost, 0),
      'notes', notes
    ) ORDER BY service_label), '[]'::jsonb)
  INTO v_services_cost, v_detail
  FROM svc;

  v_total_cost := v_components_cost + v_services_cost;
  v_unit_cost := CASE WHEN v_finished_inventory_qty > 0 THEN v_total_cost / v_finished_inventory_qty END;

  v_planned_fl_oz := ops.fn_bom_uom_to_fl_oz(v_qty_target, v_target_uom);
  IF v_planned_fl_oz IS NULL AND COALESCE(v_bom.finished_vol_per_yield_gal, 0) > 0 THEN
    v_planned_fl_oz := v_runs_planned * v_bom.finished_vol_per_yield_gal * 128;
  END IF;
  IF v_planned_fl_oz IS NULL AND COALESCE(v_bom.cans_per_case, 0) > 0 AND COALESCE(v_bom.oz_per_can, 0) > 0 THEN
    v_planned_fl_oz := v_planned_yield_qty * v_bom.cans_per_case * v_bom.oz_per_can;
  END IF;

  v_actual_fl_oz := ops.fn_bom_uom_to_fl_oz(p_qty_produced_actual, v_target_uom);
  IF v_actual_fl_oz IS NULL AND COALESCE(v_bom.finished_vol_per_yield_gal, 0) > 0 THEN
    v_actual_fl_oz := v_runs_actual * v_bom.finished_vol_per_yield_gal * 128;
  END IF;
  IF v_actual_fl_oz IS NULL THEN
    v_actual_fl_oz := v_finished_inventory_qty * COALESCE(v_bom.cans_per_case, 24) * COALESCE(v_bom.oz_per_can, 12);
  END IF;

  v_per_oz := CASE WHEN v_actual_fl_oz > 0 THEN v_total_cost / v_actual_fl_oz END;
  v_per_can := CASE WHEN v_per_oz IS NOT NULL THEN v_per_oz * COALESCE(v_bom.oz_per_can, 12) END;
  v_per_case := CASE WHEN v_per_can IS NOT NULL THEN v_per_can * COALESCE(v_bom.cans_per_case, 24) END;
  v_per_gal := CASE WHEN v_per_oz IS NOT NULL THEN v_per_oz * 128 END;
  v_yield_pct := CASE
    WHEN v_planned_fl_oz > 0 AND v_actual_fl_oz > 0 THEN v_actual_fl_oz / v_planned_fl_oz
    WHEN v_planned_yield_qty > 0 THEN v_actual_yield_qty / v_planned_yield_qty
  END;
  v_yield_loss := CASE
    WHEN v_yield_pct IS NOT NULL AND v_yield_pct < 1
      THEN v_total_cost * (1 - v_yield_pct) / GREATEST(v_yield_pct, 0.0001)
    ELSE 0
  END;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  VALUES (
    'production_yield', v_finished_item_id, v_finished_inventory_qty,
    NULL, v_loc_id, v_unit_cost,
    'work_order', p_wo_id, NULL,
    COALESCE(p_close_date::timestamptz, now()), v_actor,
    'WO yield - ' || (SELECT batch_code FROM ops.work_orders WHERE id = p_wo_id)
  );

  INSERT INTO ops.work_order_costs (
    wo_id, components_cost, services_cost, total_cost, unit_cost,
    qty_produced, detail, computed_at,
    per_case, per_can, per_oz, per_gal_finished,
    actual_yield_pct, yield_loss_dollars
  )
  VALUES (
    p_wo_id, v_components_cost, v_services_cost, v_total_cost, v_unit_cost,
    v_finished_inventory_qty, v_detail, now(),
    v_per_case, v_per_can, v_per_oz, v_per_gal,
    v_yield_pct, v_yield_loss
  )
  ON CONFLICT (wo_id) DO UPDATE SET
    components_cost = EXCLUDED.components_cost,
    services_cost = EXCLUDED.services_cost,
    total_cost = EXCLUDED.total_cost,
    unit_cost = EXCLUDED.unit_cost,
    qty_produced = EXCLUDED.qty_produced,
    detail = EXCLUDED.detail,
    per_case = EXCLUDED.per_case,
    per_can = EXCLUDED.per_can,
    per_oz = EXCLUDED.per_oz,
    per_gal_finished = EXCLUDED.per_gal_finished,
    actual_yield_pct = EXCLUDED.actual_yield_pct,
    yield_loss_dollars = EXCLUDED.yield_loss_dollars,
    computed_at = now();

  UPDATE ops.work_orders
     SET status = 'closed',
         qty_produced_actual = v_finished_inventory_qty,
         actual_yield_qty = p_qty_produced_actual,
         actual_yield_uom = v_target_uom,
         closed_at = now(),
         closed_by = v_actor
   WHERE id = p_wo_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_create_bom(text, numeric, text, numeric, jsonb, text, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_consume_work_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_close_work_order(uuid, numeric, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
