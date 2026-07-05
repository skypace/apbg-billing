-- Co-pack syrup invoice actuals.
--
-- Syrup co-pack orders estimate gallons from the BOM when drafted. At receipt,
-- APBG can now lock the vendor invoice gallons and rate so landed COGS uses the
-- actual bill instead of only the recipe estimate.

ALTER TABLE ops.copack_orders
  ADD COLUMN IF NOT EXISTS actual_syrup_gallons numeric,
  ADD COLUMN IF NOT EXISTS actual_syrup_unit_cost_per_gal numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'copack_orders_actual_syrup_gallons_check'
      AND conrelid = 'ops.copack_orders'::regclass
  ) THEN
    ALTER TABLE ops.copack_orders
      ADD CONSTRAINT copack_orders_actual_syrup_gallons_check
      CHECK (actual_syrup_gallons IS NULL OR actual_syrup_gallons >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'copack_orders_actual_syrup_unit_cost_check'
      AND conrelid = 'ops.copack_orders'::regclass
  ) THEN
    ALTER TABLE ops.copack_orders
      ADD CONSTRAINT copack_orders_actual_syrup_unit_cost_check
      CHECK (actual_syrup_unit_cost_per_gal IS NULL OR actual_syrup_unit_cost_per_gal >= 0);
  END IF;
END $$;

COMMENT ON COLUMN ops.copack_orders.actual_syrup_gallons IS
  'Vendor invoice syrup gallons locked at co-pack receipt. Overrides BOM-estimated syrup gallons for landed COGS.';
COMMENT ON COLUMN ops.copack_orders.actual_syrup_unit_cost_per_gal IS
  'Vendor invoice syrup cost per gallon locked at co-pack receipt. Overrides the draft syrup rate for landed COGS.';

DROP FUNCTION IF EXISTS ops.fn_receive_copack_order(uuid, numeric, text, numeric, numeric, numeric, timestamptz);
DROP FUNCTION IF EXISTS ops.fn_receive_copack_order(uuid, numeric, text, numeric, numeric, numeric, timestamptz, numeric, numeric);

CREATE OR REPLACE FUNCTION ops.fn_receive_copack_order(
  p_order_id uuid,
  p_actual_yield_qty numeric,
  p_actual_yield_uom text DEFAULT NULL,
  p_co_pack_fee numeric DEFAULT NULL,
  p_freight_cost numeric DEFAULT NULL,
  p_other_landed_cost numeric DEFAULT NULL,
  p_received_at timestamptz DEFAULT NULL,
  p_syrup_gallons numeric DEFAULT NULL,
  p_syrup_unit_cost_per_gal numeric DEFAULT NULL
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
  IF p_syrup_gallons IS NOT NULL AND p_syrup_gallons < 0 THEN
    RAISE EXCEPTION 'syrup_gallons must be >= 0';
  END IF;
  IF p_syrup_unit_cost_per_gal IS NOT NULL AND p_syrup_unit_cost_per_gal < 0 THEN
    RAISE EXCEPTION 'syrup_unit_cost_per_gal must be >= 0';
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
    v_syrup_unit_cost_per_gal := COALESCE(
      p_syrup_unit_cost_per_gal,
      v_order.actual_syrup_unit_cost_per_gal,
      v_order.syrup_unit_cost_per_gal,
      0
    );
    v_syrup_gallons := COALESCE(
      p_syrup_gallons,
      v_order.actual_syrup_gallons,
      ops.fn_copack_syrup_gallons(v_order.bom_id, v_order.qty_ordered, v_order.target_uom),
      0
    );
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
         actual_syrup_gallons = CASE
           WHEN COALESCE(v_order.material_source_mode, 'raw_materials') = 'syrup_by_gallon'
             THEN v_syrup_gallons
           ELSE NULL
         END,
         actual_syrup_unit_cost_per_gal = CASE
           WHEN COALESCE(v_order.material_source_mode, 'raw_materials') = 'syrup_by_gallon'
             THEN v_syrup_unit_cost_per_gal
           ELSE NULL
         END,
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
  o.actual_syrup_gallons, o.actual_syrup_unit_cost_per_gal,
  COALESCE(c.syrup_gallons, o.actual_syrup_gallons,
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
GRANT EXECUTE ON FUNCTION ops.fn_receive_copack_order(uuid, numeric, text, numeric, numeric, numeric, timestamptz, numeric, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';
