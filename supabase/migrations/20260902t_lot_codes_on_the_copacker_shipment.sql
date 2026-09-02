-- 2026-09-02  Lot codes and born-on dates ride the shipment home.
--
-- Ask (Sky): "when the shipment of produced product goes out from Quantum
-- back to Alameda Soda, can you enter the born-on date codes and the batch
-- codes on the order so we can track for quality control."
--
-- Quantum's own invoice already speaks in these terms -- invoice 1462 lists
-- each flavour's tolling with its batch codes in parentheses ("Q375, Q379,
-- 390, 393, 397").  Until now nothing here could hold them: a work order had
-- ONE batch_code (ours, WO-2026-00012) and the shipment back was ONE transfer
-- line for the whole yield.
--
-- Model:
--   ops.work_order_lots     -- what the co-packer actually produced, lot by lot:
--                              their lot code, the born-on (production) date,
--                              an optional best-by, and how many cases.  Entered
--                              when the yield is recorded, or at ship time,
--                              or edited in between.  The lot quantities must
--                              add up to the yield -- a case belongs to exactly
--                              one lot, so a total that disagrees is a typo,
--                              not a rounding matter.
--   inventory_transfer_lines gains lot_code / born_on_date / best_by_date, and
--                              the co-packer -> warehouse transfer is written
--                              ONE LINE PER LOT.  fn_ship_transfer and
--                              fn_receive_transfer already stamp every
--                              inventory movement with source_doc_line_id, so
--                              each movement traces to its lot without either
--                              function changing.  The BOL prints the lot and
--                              born-on beside every line, which is what the
--                              receiving dock and a recall both need.
--   ops.v_lot_trace         -- one row per lot: the run, the BOL it left on,
--                              when it shipped and landed, and the movements.
--
-- Deliberately NOT done: a lot column on inventory_movements.  The movement
-- already points at the transfer line that carries the lot, and a second copy
-- is the kind that drifts.  Nor is a lot demanded on ordinary warehouse
-- transfers -- the fields are optional there; a production run is where they
-- are expected, and the work-order screen says so.

BEGIN;

-- ── 1. Lots on the work order ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.work_order_lots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id         UUID NOT NULL REFERENCES ops.work_orders(id) ON DELETE CASCADE,
  lot_code      TEXT NOT NULL,
  born_on_date  DATE,
  best_by_date  DATE,
  qty           NUMERIC NOT NULL CHECK (qty > 0),
  notes         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wo_id, lot_code)
);
COMMENT ON TABLE ops.work_order_lots IS
  'The co-packer''s lots for one work order: lot code, born-on date, best-by, cases. Quantities must total the recorded yield. Each lot becomes one line on the return BOL.';
CREATE INDEX IF NOT EXISTS work_order_lots_wo_idx ON ops.work_order_lots (wo_id, sort_order);

ALTER TABLE ops.work_order_lots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_lots_select ON ops.work_order_lots;
DROP POLICY IF EXISTS work_order_lots_write  ON ops.work_order_lots;
CREATE POLICY work_order_lots_select ON ops.work_order_lots
  FOR SELECT TO authenticated USING (ops.fn_is_staff());
CREATE POLICY work_order_lots_write ON ops.work_order_lots
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
GRANT SELECT ON ops.work_order_lots TO authenticated;
GRANT ALL ON ops.work_order_lots TO service_role;

-- ── 2. Lots on the transfer line ────────────────────────────────────────────
ALTER TABLE ops.inventory_transfer_lines
  ADD COLUMN IF NOT EXISTS lot_code     TEXT,
  ADD COLUMN IF NOT EXISTS born_on_date DATE,
  ADD COLUMN IF NOT EXISTS best_by_date DATE;
COMMENT ON COLUMN ops.inventory_transfer_lines.lot_code IS
  'Producer lot / batch code for the units on this line. A production return is one line per lot.';
CREATE INDEX IF NOT EXISTS inventory_transfer_lines_lot_idx
  ON ops.inventory_transfer_lines (lot_code) WHERE lot_code IS NOT NULL;

-- ── 3. fn_create_transfer (12-arg inner) reads the lot fields off each line ─
CREATE OR REPLACE FUNCTION ops.fn_create_transfer__i(p_from_location_id uuid, p_to_location_id uuid, p_lines jsonb, p_carrier text DEFAULT NULL::text, p_tracking_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_pro_number text DEFAULT NULL::text, p_freight_terms text DEFAULT NULL::text, p_total_weight_lbs numeric DEFAULT NULL::numeric, p_total_pallets numeric DEFAULT NULL::numeric, p_declared_value_usd numeric DEFAULT NULL::numeric, p_special_instructions text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE
  v_id UUID; v_bol TEXT; v_from_kind TEXT; v_to_kind TEXT;
  v_actor UUID := auth.uid(); v_line JSONB;
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
  IF p_freight_terms IS NOT NULL AND p_freight_terms NOT IN ('prepaid','collect','third_party') THEN
    RAISE EXCEPTION 'freight_terms must be prepaid, collect, or third_party';
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
    carrier, tracking_number, notes, created_by,
    pro_number, freight_terms, total_weight_lbs, total_pallets,
    declared_value_usd, special_instructions
  )
  VALUES (
    v_bol, p_from_location_id, p_to_location_id, 'draft',
    p_carrier, p_tracking_number, p_notes, v_actor,
    p_pro_number, p_freight_terms, p_total_weight_lbs, p_total_pallets,
    p_declared_value_usd, p_special_instructions
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
      transfer_id, qbo_item_id, qty, unit_cost, notes,
      line_weight_lbs, line_pallets,
      lot_code, born_on_date, best_by_date
    )
    VALUES (
      v_id, v_line ->> 'qbo_item_id', (v_line ->> 'qty')::numeric,
      NULLIF(v_line ->> 'unit_cost','')::numeric, v_line ->> 'notes',
      NULLIF(v_line ->> 'line_weight_lbs','')::numeric,
      NULLIF(v_line ->> 'line_pallets','')::numeric,
      NULLIF(btrim(v_line ->> 'lot_code'), ''),
      NULLIF(v_line ->> 'born_on_date','')::date,
      NULLIF(v_line ->> 'best_by_date','')::date
    );
  END LOOP;

  RETURN v_id;
END;
$function$;

-- ── 4. Setting the lots: once, validated, from either the yield or the ship step
CREATE OR REPLACE FUNCTION ops.fn_wo_set_lots__i(p_wo_id uuid, p_lots jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE
  v_wo    ops.work_orders%ROWTYPE;
  v_actor UUID := auth.uid();
  v_lot   JSONB;
  v_code  TEXT;
  v_qty   NUMERIC;
  v_sum   NUMERIC := 0;
  v_sort  INTEGER := 100;
  v_n     INTEGER := 0;
BEGIN
  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  IF v_wo.status NOT IN ('in_production', 'yield_recorded') THEN
    RAISE EXCEPTION 'lots can be entered while the run is in production or once the yield is recorded — this work order is %', v_wo.status;
  END IF;
  IF p_lots IS NULL OR jsonb_typeof(p_lots) <> 'array' THEN
    RAISE EXCEPTION 'p_lots must be a JSON array';
  END IF;

  DELETE FROM ops.work_order_lots WHERE wo_id = p_wo_id;

  FOR v_lot IN SELECT * FROM jsonb_array_elements(p_lots) LOOP
    v_code := NULLIF(btrim(v_lot ->> 'lot_code'), '');
    v_qty  := NULLIF(v_lot ->> 'qty', '')::numeric;
    IF v_code IS NULL THEN RAISE EXCEPTION 'every lot needs a lot code'; END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'lot % needs a quantity > 0', v_code; END IF;
    INSERT INTO ops.work_order_lots (wo_id, lot_code, born_on_date, best_by_date, qty, notes, sort_order, created_by)
    VALUES (p_wo_id, v_code,
            NULLIF(v_lot ->> 'born_on_date', '')::date,
            NULLIF(v_lot ->> 'best_by_date', '')::date,
            v_qty, NULLIF(v_lot ->> 'notes', ''), v_sort, v_actor);
    v_sum  := v_sum + v_qty;
    v_sort := v_sort + 10;
    v_n    := v_n + 1;
  END LOOP;

  -- Once the yield is known the lots must account for it exactly: a case is in
  -- one lot, so a mismatch is a typo to fix, not a rounding difference to accept.
  IF v_n > 0 AND v_wo.qty_produced_actual IS NOT NULL AND v_sum <> v_wo.qty_produced_actual THEN
    RAISE EXCEPTION 'lot quantities total % but the recorded yield is % — they must match', v_sum, v_wo.qty_produced_actual;
  END IF;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'lots_set', v_wo.status, v_wo.status,
          CASE WHEN v_n = 0 THEN 'Lots cleared' ELSE v_n || ' lot(s) recorded: ' ||
            (SELECT string_agg(lot_code || ' ×' || qty, ', ' ORDER BY sort_order) FROM ops.work_order_lots WHERE wo_id = p_wo_id) END,
          jsonb_build_object('lots', p_lots), v_actor);

  RETURN jsonb_build_object('count', v_n, 'total_qty', v_sum);
END;
$function$;

CREATE OR REPLACE FUNCTION ops.fn_wo_set_lots(p_wo_id uuid, p_lots jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $function$-- GENERATED GUARD WRAPPER (20260902t) — the real body lives in ops.fn_wo_set_lots__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN ops.fn_wo_set_lots__i($1, $2); END$function$;
REVOKE ALL ON FUNCTION ops.fn_wo_set_lots__i(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_wo_set_lots(uuid, jsonb) TO authenticated, service_role;

-- ── 5. fn_wo_advance: lots at record_yield, one BOL line per lot at ship ────
CREATE OR REPLACE FUNCTION ops.fn_wo_advance__i(p_wo_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
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
  v_lines            JSONB;
  v_lot_count        INTEGER;
BEGIN
  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_wo.bom_id;

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

  IF p_action = 'start_production' THEN
    IF v_wo.status NOT IN ('ordered','at_copacker') THEN
      RAISE EXCEPTION 'work order is %, expected ordered/at_copacker', v_wo.status;
    END IF;

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

    IF COALESCE(v_bom.cans_per_case, 0) > 0 AND COALESCE(v_bom.oz_per_can, 0) > 0 THEN
      v_per_case := v_unit_cost;
      v_per_can  := v_unit_cost / v_bom.cans_per_case;
      v_per_oz   := v_per_can / v_bom.oz_per_can;
      v_per_gal  := v_total_cost / (v_yield_qty * v_bom.cans_per_case * v_bom.oz_per_can / 128.0);
    END IF;

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
            p_payload - 'lots', v_actor);

    -- The co-packer's lot codes and born-on dates, if they came with the yield.
    -- Validated against the yield just recorded (the row is updated above).
    IF p_payload ? 'lots' AND jsonb_typeof(p_payload -> 'lots') = 'array' AND jsonb_array_length(p_payload -> 'lots') > 0 THEN
      PERFORM ops.fn_wo_set_lots__i(p_wo_id, p_payload -> 'lots');
    END IF;
    RETURN;
  END IF;

  IF p_action = 'ship' THEN
    IF v_wo.status <> 'yield_recorded' THEN
      RAISE EXCEPTION 'work order is %, expected yield_recorded', v_wo.status;
    END IF;

    -- Lots may also be entered (or corrected) at ship time.
    IF p_payload ? 'lots' AND jsonb_typeof(p_payload -> 'lots') = 'array' THEN
      PERFORM ops.fn_wo_set_lots__i(p_wo_id, p_payload -> 'lots');
    END IF;

    SELECT unit_cost INTO v_unit_cost FROM ops.work_order_costs WHERE wo_id = p_wo_id;

    -- One BOL line per lot, so the receiving dock and a recall can both read
    -- which cases came from which batch.  No lots recorded = one line, as before.
    SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object(
             'qbo_item_id', v_wo.finished_qbo_item_id,
             'qty', wl.qty,
             'unit_cost', v_unit_cost,
             'lot_code', wl.lot_code,
             'born_on_date', wl.born_on_date,
             'best_by_date', wl.best_by_date,
             'notes', 'Finished goods · WO ' || v_wo.batch_code || ' · lot ' || wl.lot_code
           ) ORDER BY wl.sort_order), '[]'::jsonb)
      INTO v_lot_count, v_lines
      FROM ops.work_order_lots wl WHERE wl.wo_id = p_wo_id;
    IF v_lot_count = 0 THEN
      v_lines := jsonb_build_array(jsonb_build_object(
        'qbo_item_id', v_wo.finished_qbo_item_id,
        'qty', v_wo.qty_produced_actual,
        'unit_cost', v_unit_cost,
        'notes', 'Finished goods · WO ' || v_wo.batch_code
      ));
    END IF;

    -- All 12 args passed explicitly: fn_create_transfer has a live 6-arg
    -- legacy overload, and a defaulted call is ambiguous between the two.
    v_transfer_id := ops.fn_create_transfer(
      v_wo.copacker_location_id,
      v_wo.destination_location_id,
      v_lines,
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
            'Shipped from co-packer · BOL ' || v_bol
              || CASE WHEN v_lot_count > 0 THEN ' · ' || v_lot_count || ' lot(s)' ELSE '' END,
            p_payload - 'lots', v_actor);
    RETURN;
  END IF;

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

  IF p_action = 'void' THEN
    IF v_wo.status NOT IN ('draft','ordered','at_copacker') THEN
      RAISE EXCEPTION 'work order is %, can only void before production starts', v_wo.status;
    END IF;
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
$function$;

-- ── 6. The trace: lot → run → BOL → movements ───────────────────────────────
CREATE OR REPLACE VIEW ops.v_lot_trace
WITH (security_invoker = true) AS
SELECT
  wl.id                    AS lot_id,
  wl.lot_code,
  wl.born_on_date,
  wl.best_by_date,
  wl.qty,
  wl.notes                 AS lot_notes,
  w.id                     AS wo_id,
  w.batch_code,
  w.finished_qbo_item_id,
  it.name                  AS finished_item_name,
  w.status                 AS wo_status,
  w.production_started_at,
  w.yield_recorded_at,
  cl.name                  AS copacker_location,
  dl.name                  AS destination_location,
  t.id                     AS transfer_id,
  t.bol_number,
  t.status                 AS transfer_status,
  t.ship_date,
  t.received_date,
  tl.id                    AS transfer_line_id,
  tl.qty_received,
  (SELECT count(*) FROM ops.inventory_movements m WHERE m.source_doc_line_id = tl.id) AS movement_count
FROM ops.work_order_lots wl
JOIN ops.work_orders w            ON w.id = wl.wo_id
LEFT JOIN ops.qbo_items it        ON it.qbo_item_id = w.finished_qbo_item_id
LEFT JOIN ops.inventory_locations cl ON cl.id = w.copacker_location_id
LEFT JOIN ops.inventory_locations dl ON dl.id = w.destination_location_id
LEFT JOIN ops.inventory_transfers t  ON t.id = w.transfer_id
LEFT JOIN ops.inventory_transfer_lines tl ON tl.transfer_id = t.id AND tl.lot_code = wl.lot_code;
COMMENT ON VIEW ops.v_lot_trace IS
  'One row per production lot: the work order it came from, the BOL it shipped on, when it landed, and how many inventory movements reference it.';
GRANT SELECT ON ops.v_lot_trace TO authenticated, service_role;

COMMIT;
