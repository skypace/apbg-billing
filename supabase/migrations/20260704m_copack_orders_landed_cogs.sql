-- Co-pack production orders with landed COGS.
--
-- Alameda Soda is made by a co-packer. This workflow keeps the BOM as the
-- expected recipe/cost basis, but receives finished goods like a vendor order:
-- BOM materials/services + co-pack fee + inbound freight + other landed cost
-- are rolled into the finished SKU unit cost at receipt.

CREATE TABLE IF NOT EXISTS ops.copack_orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number             text NOT NULL UNIQUE,
  bom_id                   uuid NOT NULL REFERENCES ops.product_bom(id) ON DELETE RESTRICT,
  finished_qbo_item_id      text NOT NULL,
  qbo_vendor_id            text NOT NULL REFERENCES ops.qbo_vendors(qbo_vendor_id),
  destination_location_id  uuid NOT NULL REFERENCES ops.inventory_locations(id) ON DELETE RESTRICT,
  status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','sent','received','closed','void')),
  qty_ordered              numeric NOT NULL CHECK (qty_ordered > 0),
  target_uom               text NOT NULL DEFAULT 'gal',
  actual_yield_qty         numeric,
  actual_yield_uom         text,
  finished_units_received  numeric,
  expected_date            date,
  sent_at                  timestamptz,
  sent_by                  uuid REFERENCES auth.users(id),
  received_at              timestamptz,
  received_by              uuid REFERENCES auth.users(id),
  closed_at                timestamptz,
  closed_by                uuid REFERENCES auth.users(id),
  voided_at                timestamptz,
  voided_by                uuid REFERENCES auth.users(id),
  void_reason              text,
  co_pack_fee              numeric NOT NULL DEFAULT 0,
  freight_cost             numeric NOT NULL DEFAULT 0,
  other_landed_cost        numeric NOT NULL DEFAULT 0,
  notes                    text,
  created_by               uuid REFERENCES auth.users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS copack_orders_status_idx
  ON ops.copack_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS copack_orders_bom_idx
  ON ops.copack_orders (bom_id);
CREATE INDEX IF NOT EXISTS copack_orders_vendor_idx
  ON ops.copack_orders (qbo_vendor_id);
CREATE INDEX IF NOT EXISTS copack_orders_finished_idx
  ON ops.copack_orders (finished_qbo_item_id);

CREATE TABLE IF NOT EXISTS ops.copack_order_costs (
  order_id          uuid PRIMARY KEY REFERENCES ops.copack_orders(id) ON DELETE CASCADE,
  components_cost   numeric NOT NULL DEFAULT 0,
  services_cost     numeric NOT NULL DEFAULT 0,
  co_pack_fee       numeric NOT NULL DEFAULT 0,
  freight_cost      numeric NOT NULL DEFAULT 0,
  other_cost        numeric NOT NULL DEFAULT 0,
  total_cost        numeric NOT NULL DEFAULT 0,
  unit_cost         numeric,
  qty_finished      numeric NOT NULL DEFAULT 0,
  per_case          numeric,
  per_can           numeric,
  per_oz            numeric,
  per_gal_finished  numeric,
  actual_yield_pct  numeric,
  detail            jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ops.tg_copack_orders_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS copack_orders_touch ON ops.copack_orders;
CREATE TRIGGER copack_orders_touch
  BEFORE UPDATE ON ops.copack_orders
  FOR EACH ROW EXECUTE FUNCTION ops.tg_copack_orders_touch();

CREATE SEQUENCE IF NOT EXISTS ops.copack_order_seq;

CREATE OR REPLACE FUNCTION ops.fn_next_copack_order_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  yr text := to_char(now(), 'YYYY');
  seq bigint := nextval('ops.copack_order_seq');
BEGIN
  RETURN 'CP-' || yr || '-' || lpad(seq::text, 5, '0');
END;
$$;

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
  p_notes text DEFAULT NULL
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
    notes, created_by
  ) VALUES (
    v_number, p_bom_id, v_finished_item_id, p_qbo_vendor_id,
    p_destination_location_id, 'draft', p_qty_ordered,
    COALESCE(NULLIF(p_target_uom, ''), 'gal'),
    p_expected_date, COALESCE(p_co_pack_fee, 0), COALESCE(p_freight_cost, 0),
    COALESCE(p_other_landed_cost, 0), p_notes, v_actor
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_send_copack_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_status text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT status INTO v_status FROM ops.copack_orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'co-pack order not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'co-pack order is %, can only send from draft', v_status;
  END IF;
  UPDATE ops.copack_orders
     SET status = 'sent', sent_at = now(), sent_by = v_actor
   WHERE id = p_order_id;
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
    detail, computed_at
  ) VALUES (
    p_order_id, v_components_cost, v_services_cost, v_co_pack_fee, v_freight_cost,
    v_other_cost, v_total_cost, v_unit_cost, v_finished_units,
    v_per_case, v_per_can, v_per_oz, v_per_gal, v_yield_pct,
    v_detail, now()
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

CREATE OR REPLACE FUNCTION ops.fn_close_copack_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_status text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT status INTO v_status FROM ops.copack_orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'co-pack order not found'; END IF;
  IF v_status <> 'received' THEN
    RAISE EXCEPTION 'co-pack order is %, can only close from received', v_status;
  END IF;
  UPDATE ops.copack_orders
     SET status = 'closed', closed_at = now(), closed_by = v_actor
   WHERE id = p_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_void_copack_order(
  p_order_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_status text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT status INTO v_status FROM ops.copack_orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'co-pack order not found'; END IF;
  IF v_status NOT IN ('draft','sent') THEN
    RAISE EXCEPTION 'co-pack order is %, can only void from draft/sent', v_status;
  END IF;
  UPDATE ops.copack_orders
     SET status = 'void', voided_at = now(), voided_by = v_actor, void_reason = p_reason
   WHERE id = p_order_id;
END;
$$;

CREATE OR REPLACE VIEW ops.v_copack_orders
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

ALTER TABLE ops.copack_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.copack_order_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS copack_orders_select ON ops.copack_orders;
CREATE POLICY copack_orders_select ON ops.copack_orders
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS copack_order_costs_select ON ops.copack_order_costs;
CREATE POLICY copack_order_costs_select ON ops.copack_order_costs
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON ops.copack_orders TO authenticated;
GRANT SELECT ON ops.copack_order_costs TO authenticated;
GRANT SELECT ON ops.v_copack_orders TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_next_copack_order_number() TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_create_copack_order(uuid, text, uuid, numeric, text, date, numeric, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_send_copack_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_receive_copack_order(uuid, numeric, text, numeric, numeric, numeric, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_close_copack_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_void_copack_order(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
