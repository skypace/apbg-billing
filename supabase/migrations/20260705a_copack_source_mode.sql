-- Co-pack source mode.
--
-- Raw-material co-pack means APBG stages component inventory to the co-packer.
-- Syrup co-pack means the flavor/syrup company supplies the syrup and charges
-- by gallon, so component inventory should not be staged or counted twice.

ALTER TABLE ops.copack_orders
  ADD COLUMN IF NOT EXISTS material_source_mode text NOT NULL DEFAULT 'raw_materials',
  ADD COLUMN IF NOT EXISTS syrup_unit_cost_per_gal numeric NOT NULL DEFAULT 0;

ALTER TABLE ops.copack_order_costs
  ADD COLUMN IF NOT EXISTS syrup_gallons numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'copack_orders_material_source_mode_check'
      AND conrelid = 'ops.copack_orders'::regclass
  ) THEN
    ALTER TABLE ops.copack_orders
      ADD CONSTRAINT copack_orders_material_source_mode_check
      CHECK (material_source_mode IN ('raw_materials', 'syrup_by_gallon'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'copack_orders_syrup_unit_cost_check'
      AND conrelid = 'ops.copack_orders'::regclass
  ) THEN
    ALTER TABLE ops.copack_orders
      ADD CONSTRAINT copack_orders_syrup_unit_cost_check
      CHECK (syrup_unit_cost_per_gal >= 0);
  END IF;
END $$;

COMMENT ON COLUMN ops.copack_orders.material_source_mode IS
  'raw_materials = APBG stages component inventory; syrup_by_gallon = syrup/flavor company supplies syrup and bills per gallon.';
COMMENT ON COLUMN ops.copack_orders.syrup_unit_cost_per_gal IS
  'Cost per syrup gallon used when material_source_mode = syrup_by_gallon.';
COMMENT ON COLUMN ops.copack_order_costs.syrup_gallons IS
  'Estimated syrup gallons costed on a syrup_by_gallon co-pack order.';

CREATE OR REPLACE FUNCTION ops.fn_copack_syrup_gallons(
  p_bom_id uuid,
  p_target_qty numeric,
  p_target_uom text DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ops, public, pg_temp
AS $$
DECLARE
  v_bom record;
  v_target_uom text;
  v_runs numeric;
  v_component_fl_oz numeric;
  v_finished_fl_oz numeric;
  v_finished_units numeric;
BEGIN
  IF p_bom_id IS NULL OR p_target_qty IS NULL OR p_target_qty <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_bom
    FROM ops.product_bom
   WHERE id = p_bom_id;

  IF v_bom.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_target_uom := COALESCE(NULLIF(p_target_uom, ''), v_bom.yield_uom, 'gal');
  v_runs := ops.fn_bom_scale_runs(p_bom_id, p_target_qty, v_target_uom);

  SELECT COALESCE(sum(
    CASE
      WHEN ops.fn_bom_uom_to_fl_oz(
        v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)),
        COALESCE(NULLIF(l.qty_uom, ''), 'each')
      ) IS NOT NULL
        THEN ops.fn_bom_uom_to_fl_oz(
          v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)),
          COALESCE(NULLIF(l.qty_uom, ''), 'each')
        )
      ELSE
        v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0))
        * COALESCE(ops.fn_bom_item_volume_fl_oz(qi.name, qi.type), 0)
    END
  ), 0)
    INTO v_component_fl_oz
    FROM ops.product_bom_lines l
    LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.component_qbo_item_id
   WHERE l.bom_id = p_bom_id
     AND l.line_type = 'component';

  IF COALESCE(v_component_fl_oz, 0) > 0 THEN
    RETURN v_component_fl_oz / 128;
  END IF;

  -- Fallback for simple BOMs that do not expose component volume yet: use
  -- finished gallons so the order still produces a usable syrup estimate.
  v_finished_fl_oz := ops.fn_bom_uom_to_fl_oz(p_target_qty, v_target_uom);
  IF v_finished_fl_oz IS NOT NULL THEN
    RETURN v_finished_fl_oz / 128;
  END IF;

  v_finished_units := ops.fn_bom_finished_inventory_qty(p_bom_id, p_target_qty, v_target_uom);
  IF v_finished_units IS NOT NULL
     AND COALESCE(v_bom.cans_per_case, 0) > 0
     AND COALESCE(v_bom.oz_per_can, 0) > 0 THEN
    RETURN (v_finished_units * v_bom.cans_per_case * v_bom.oz_per_can) / 128;
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS ops.fn_create_copack_order(uuid, text, uuid, numeric, text, date, numeric, numeric, numeric, text);
DROP FUNCTION IF EXISTS ops.fn_create_copack_order(uuid, text, uuid, numeric, text, date, numeric, numeric, numeric, text, text, numeric);

CREATE OR REPLACE FUNCTION ops.fn_create_copack_order(
  p_bom_id uuid,
  p_qbo_vendor_id text,
  p_destination_location_id uuid,
  p_qty_ordered numeric,
  p_target_uom text DEFAULT 'gal',
  p_expected_date date DEFAULT NULL,
  p_co_pack_fee numeric DEFAULT 0,
  p_freight_cost numeric DEFAULT 0,
  p_other_landed_cost numeric DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_material_source_mode text DEFAULT 'raw_materials',
  p_syrup_unit_cost_per_gal numeric DEFAULT 0
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_number text;
  v_finished_item_id text;
  v_loc_kind text;
  v_actor uuid := auth.uid();
  v_material_source_mode text := COALESCE(NULLIF(p_material_source_mode, ''), 'raw_materials');
  v_syrup_unit_cost_per_gal numeric := COALESCE(p_syrup_unit_cost_per_gal, 0);
BEGIN
  IF p_bom_id IS NULL THEN RAISE EXCEPTION 'bom_id is required'; END IF;
  IF NULLIF(trim(COALESCE(p_qbo_vendor_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'qbo_vendor_id is required';
  END IF;
  IF p_destination_location_id IS NULL THEN
    RAISE EXCEPTION 'destination_location_id is required';
  END IF;
  IF p_qty_ordered IS NULL OR p_qty_ordered <= 0 THEN
    RAISE EXCEPTION 'qty_ordered must be > 0';
  END IF;
  IF v_material_source_mode NOT IN ('raw_materials', 'syrup_by_gallon') THEN
    RAISE EXCEPTION 'invalid material source mode %', v_material_source_mode;
  END IF;
  IF v_syrup_unit_cost_per_gal < 0 THEN
    RAISE EXCEPTION 'syrup_unit_cost_per_gal must be >= 0';
  END IF;

  SELECT finished_qbo_item_id INTO v_finished_item_id
  FROM ops.product_bom
  WHERE id = p_bom_id AND is_active;
  IF v_finished_item_id IS NULL THEN
    RAISE EXCEPTION 'active BOM not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.qbo_vendors WHERE qbo_vendor_id = p_qbo_vendor_id AND active) THEN
    RAISE EXCEPTION 'active vendor not found';
  END IF;

  SELECT kind INTO v_loc_kind FROM ops.inventory_locations WHERE id = p_destination_location_id;
  IF v_loc_kind IS NULL THEN RAISE EXCEPTION 'destination_location_id not found'; END IF;
  IF v_loc_kind IN ('in_transit', 'adjustment') THEN
    RAISE EXCEPTION 'destination cannot be a virtual location';
  END IF;

  PERFORM ops.fn_bom_scale_runs(p_bom_id, p_qty_ordered, COALESCE(NULLIF(p_target_uom, ''), 'gal'));

  v_number := ops.fn_next_copack_order_number();
  INSERT INTO ops.copack_orders (
    order_number, bom_id, finished_qbo_item_id, qbo_vendor_id,
    destination_location_id, status, qty_ordered, target_uom,
    expected_date, co_pack_fee, freight_cost, other_landed_cost,
    material_source_mode, syrup_unit_cost_per_gal,
    notes, created_by
  ) VALUES (
    v_number, p_bom_id, v_finished_item_id, p_qbo_vendor_id,
    p_destination_location_id, 'draft', p_qty_ordered,
    COALESCE(NULLIF(p_target_uom, ''), 'gal'),
    p_expected_date, COALESCE(p_co_pack_fee, 0), COALESCE(p_freight_cost, 0),
    COALESCE(p_other_landed_cost, 0),
    v_material_source_mode, v_syrup_unit_cost_per_gal,
    p_notes, v_actor
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_receive_copack_order(
  p_order_id uuid,
  p_actual_yield_qty numeric,
  p_actual_yield_uom text DEFAULT NULL,
  p_co_pack_fee numeric DEFAULT NULL,
  p_freight_cost numeric DEFAULT NULL,
  p_other_landed_cost numeric DEFAULT NULL,
  p_received_at timestamptz DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_order record;
  v_bom record;
  v_actor uuid := auth.uid();
  v_received_uom text;
  v_runs_ordered numeric;
  v_finished_units numeric;
  v_components_cost numeric := 0;
  v_services_cost numeric := 0;
  v_co_pack_fee numeric;
  v_freight_cost numeric;
  v_other_cost numeric;
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
  v_syrup_gallons numeric := NULL;
  v_syrup_unit_cost_per_gal numeric := 0;
BEGIN
  IF p_actual_yield_qty IS NULL OR p_actual_yield_qty <= 0 THEN
    RAISE EXCEPTION 'actual_yield_qty must be > 0';
  END IF;

  SELECT * INTO v_order
  FROM ops.copack_orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'co-pack order not found'; END IF;
  IF v_order.status NOT IN ('draft','sent') THEN
    RAISE EXCEPTION 'co-pack order is %, can only receive from draft/sent', v_order.status;
  END IF;

  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_order.bom_id;
  v_received_uom := COALESCE(NULLIF(p_actual_yield_uom, ''), v_order.target_uom, v_bom.yield_uom, 'gal');
  v_runs_ordered := ops.fn_bom_scale_runs(v_order.bom_id, v_order.qty_ordered, v_order.target_uom);
  v_finished_units := ops.fn_bom_finished_inventory_qty(v_order.bom_id, p_actual_yield_qty, v_received_uom);

  IF COALESCE(v_order.material_source_mode, 'raw_materials') = 'syrup_by_gallon' THEN
    v_syrup_unit_cost_per_gal := COALESCE(v_order.syrup_unit_cost_per_gal, 0);
    v_syrup_gallons := COALESCE(ops.fn_copack_syrup_gallons(
      v_order.bom_id,
      v_order.qty_ordered,
      v_order.target_uom
    ), 0);
    v_components_cost := v_syrup_gallons * v_syrup_unit_cost_per_gal;
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'component',
      'label', 'Flavor company syrup',
      'qbo_item_id', NULL,
      'qty', v_syrup_gallons,
      'uom', 'gal',
      'unit_cost', v_syrup_unit_cost_per_gal,
      'extended_cost', v_components_cost,
      'notes', 'Syrup supplied by flavor company; component inventory not staged'
    ));
  ELSE
    WITH comp AS (
      SELECT
        l.component_qbo_item_id AS item_id,
        COALESCE(qi.name, l.component_qbo_item_id) AS item_name,
        v_runs_ordered * l.qty_per * (1 + l.scrap_pct) AS qty,
        l.qty_uom,
        COALESCE(l.default_cost, qi.purchase_cost, 0) AS unit_cost,
        l.notes
      FROM ops.product_bom_lines l
      LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.component_qbo_item_id
      WHERE l.bom_id = v_order.bom_id
        AND l.line_type = 'component'
    )
    SELECT
      COALESCE(sum(qty * unit_cost), 0),
      COALESCE(jsonb_agg(jsonb_build_object(
        'kind', 'component',
        'label', item_name,
        'qbo_item_id', item_id,
        'qty', qty,
        'uom', qty_uom,
        'unit_cost', unit_cost,
        'extended_cost', qty * unit_cost,
        'notes', notes
      ) ORDER BY item_name), '[]'::jsonb)
    INTO v_components_cost, v_detail
    FROM comp;
  END IF;

  WITH svc AS (
    SELECT
      l.service_label,
      v_runs_ordered * l.qty_per AS qty,
      l.qty_uom,
      COALESCE(l.default_cost, 0) AS unit_cost,
      l.notes
    FROM ops.product_bom_lines l
    WHERE l.bom_id = v_order.bom_id
      AND l.line_type = 'service'
  )
  SELECT
    COALESCE(sum(qty * unit_cost), 0),
    v_detail || COALESCE(jsonb_agg(jsonb_build_object(
      'kind', 'service',
      'label', service_label,
      'qty', qty,
      'uom', qty_uom,
      'unit_cost', unit_cost,
      'extended_cost', qty * unit_cost,
      'notes', notes
    ) ORDER BY service_label), '[]'::jsonb)
  INTO v_services_cost, v_detail
  FROM svc;

  v_co_pack_fee := COALESCE(p_co_pack_fee, v_order.co_pack_fee, 0);
  v_freight_cost := COALESCE(p_freight_cost, v_order.freight_cost, 0);
  v_other_cost := COALESCE(p_other_landed_cost, v_order.other_landed_cost, 0);

  IF v_co_pack_fee > 0 THEN
    v_detail := v_detail || jsonb_build_array(jsonb_build_object(
      'kind', 'landed_cost', 'label', 'Co-pack fee', 'qty', 1, 'uom', 'order',
      'unit_cost', v_co_pack_fee, 'extended_cost', v_co_pack_fee, 'notes', NULL
    ));
  END IF;
  IF v_freight_cost > 0 THEN
    v_detail := v_detail || jsonb_build_array(jsonb_build_object(
      'kind', 'landed_cost', 'label', 'Inbound freight', 'qty', 1, 'uom', 'order',
      'unit_cost', v_freight_cost, 'extended_cost', v_freight_cost, 'notes', NULL
    ));
  END IF;
  IF v_other_cost > 0 THEN
    v_detail := v_detail || jsonb_build_array(jsonb_build_object(
      'kind', 'landed_cost', 'label', 'Other landed cost', 'qty', 1, 'uom', 'order',
      'unit_cost', v_other_cost, 'extended_cost', v_other_cost, 'notes', NULL
    ));
  END IF;

  v_total_cost := v_components_cost + v_services_cost + v_co_pack_fee + v_freight_cost + v_other_cost;
  v_unit_cost := CASE WHEN v_finished_units > 0 THEN v_total_cost / v_finished_units END;

  v_planned_fl_oz := ops.fn_bom_uom_to_fl_oz(v_order.qty_ordered, v_order.target_uom);
  IF v_planned_fl_oz IS NULL AND COALESCE(v_bom.finished_vol_per_yield_gal, 0) > 0 THEN
    v_planned_fl_oz := v_runs_ordered * v_bom.finished_vol_per_yield_gal * 128;
  END IF;
  IF v_planned_fl_oz IS NULL THEN
    v_planned_fl_oz := ops.fn_bom_finished_inventory_qty(v_order.bom_id, v_order.qty_ordered, v_order.target_uom)
      * COALESCE(v_bom.cans_per_case, 24) * COALESCE(v_bom.oz_per_can, 12);
  END IF;

  v_actual_fl_oz := ops.fn_bom_uom_to_fl_oz(p_actual_yield_qty, v_received_uom);
  IF v_actual_fl_oz IS NULL THEN
    v_actual_fl_oz := v_finished_units * COALESCE(v_bom.cans_per_case, 24) * COALESCE(v_bom.oz_per_can, 12);
  END IF;

  v_per_oz := CASE WHEN v_actual_fl_oz > 0 THEN v_total_cost / v_actual_fl_oz END;
  v_per_can := CASE WHEN v_per_oz IS NOT NULL THEN v_per_oz * COALESCE(v_bom.oz_per_can, 12) END;
  v_per_case := CASE WHEN v_per_can IS NOT NULL THEN v_per_can * COALESCE(v_bom.cans_per_case, 24) END;
  v_per_gal := CASE WHEN v_per_oz IS NOT NULL THEN v_per_oz * 128 END;
  v_yield_pct := CASE WHEN v_planned_fl_oz > 0 AND v_actual_fl_oz > 0 THEN v_actual_fl_oz / v_planned_fl_oz END;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  ) VALUES (
    'receipt', v_order.finished_qbo_item_id, v_finished_units,
    NULL, v_order.destination_location_id, v_unit_cost,
    'copack_order', p_order_id, NULL,
    COALESCE(p_received_at, now()), v_actor,
    'Co-pack receipt - ' || v_order.order_number
  );

  INSERT INTO ops.copack_order_costs (
    order_id, components_cost, services_cost, co_pack_fee, freight_cost,
    other_cost, total_cost, unit_cost, qty_finished,
    per_case, per_can, per_oz, per_gal_finished, actual_yield_pct,
    syrup_gallons, detail, computed_at
  ) VALUES (
    p_order_id, v_components_cost, v_services_cost, v_co_pack_fee, v_freight_cost,
    v_other_cost, v_total_cost, v_unit_cost, v_finished_units,
    v_per_case, v_per_can, v_per_oz, v_per_gal, v_yield_pct,
    v_syrup_gallons, v_detail, now()
  )
  ON CONFLICT (order_id) DO UPDATE SET
    components_cost = EXCLUDED.components_cost,
    services_cost = EXCLUDED.services_cost,
    co_pack_fee = EXCLUDED.co_pack_fee,
    freight_cost = EXCLUDED.freight_cost,
    other_cost = EXCLUDED.other_cost,
    total_cost = EXCLUDED.total_cost,
    unit_cost = EXCLUDED.unit_cost,
    qty_finished = EXCLUDED.qty_finished,
    per_case = EXCLUDED.per_case,
    per_can = EXCLUDED.per_can,
    per_oz = EXCLUDED.per_oz,
    per_gal_finished = EXCLUDED.per_gal_finished,
    actual_yield_pct = EXCLUDED.actual_yield_pct,
    syrup_gallons = EXCLUDED.syrup_gallons,
    detail = EXCLUDED.detail,
    computed_at = now();

  UPDATE ops.copack_orders
     SET status = 'received',
         actual_yield_qty = p_actual_yield_qty,
         actual_yield_uom = v_received_uom,
         finished_units_received = v_finished_units,
         co_pack_fee = v_co_pack_fee,
         freight_cost = v_freight_cost,
         other_landed_cost = v_other_cost,
         received_at = COALESCE(p_received_at, now()),
         received_by = v_actor
   WHERE id = p_order_id;
END;
$$;

DROP VIEW IF EXISTS ops.v_copack_orders;

CREATE VIEW ops.v_copack_orders
WITH (security_invoker = true)
AS
SELECT
  o.id, o.order_number, o.bom_id, o.finished_qbo_item_id,
  COALESCE(qi.name, o.finished_qbo_item_id) AS finished_item_name,
  o.qbo_vendor_id, v.display_name AS vendor_name,
  o.destination_location_id, l.name AS location_label,
  o.status, o.qty_ordered, o.target_uom,
  o.actual_yield_qty, o.actual_yield_uom, o.finished_units_received,
  o.expected_date, o.sent_at, o.received_at, o.closed_at,
  o.voided_at, o.void_reason,
  o.material_source_mode, o.syrup_unit_cost_per_gal,
  COALESCE(c.syrup_gallons,
    CASE
      WHEN o.material_source_mode = 'syrup_by_gallon'
        THEN ops.fn_copack_syrup_gallons(o.bom_id, o.qty_ordered, o.target_uom)
      ELSE NULL
    END
  ) AS syrup_gallons,
  o.co_pack_fee, o.freight_cost, o.other_landed_cost,
  COALESCE(c.components_cost, 0) AS components_cost,
  COALESCE(c.services_cost, 0) AS services_cost,
  COALESCE(c.total_cost, 0) AS total_cost,
  c.unit_cost, c.per_case, c.per_can, c.per_oz, c.per_gal_finished,
  c.actual_yield_pct, c.computed_at,
  o.notes, o.created_at, o.updated_at
FROM ops.copack_orders o
LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = o.qbo_vendor_id
LEFT JOIN ops.inventory_locations l ON l.id = o.destination_location_id
LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = o.finished_qbo_item_id
LEFT JOIN ops.copack_order_costs c ON c.order_id = o.id;

GRANT SELECT ON ops.v_copack_orders TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_copack_syrup_gallons(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_create_copack_order(uuid, text, uuid, numeric, text, date, numeric, numeric, numeric, text, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_receive_copack_order(uuid, numeric, text, numeric, numeric, numeric, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
