-- 20260903e — MOQ, demand vs ordered, and opening stock at the co-packer
--
-- Ask (Sky): a place to record each purchased item's MOQ; when the MOQ
-- exceeds the run's need "we need to fill that void" — the PO orders the MOQ,
-- the surplus lands at Quantum and is visible as raw-material stock for the
-- next run; and "we will need starting amounts for the ingredients". Phase 5.
--
-- Model:
--  * production_items.min_order_qty / order_multiple / lead_days — the
--    purchased-item master (cans, gallons, Velcorin, dunnage…) gains the
--    vendor's ordering terms. raw_ingredients.min_order_qty joins the
--    pack_size / order_multiple it already carries.
--  * work_order_materials.demand_qty — what the BATCH needs, in purchase
--    units, unrounded. required_qty stays what is ORDERED (MOQ / multiple /
--    whole packs applied). Surplus = required − demand, and it is real stock at
--    the co-packer: the run consumes demand_qty and is costed on demand_qty, so
--    the leftover is valued where it sits, not buried in this batch's cases.
--  * fn_order_qty(demand, moq, multiple) is the ONE rounding rule; the client
--    mirrors it in lib/componentSourcing.ts (orderQty / componentOrderQty).
--  * Rounding applies only where the master SAYS something — an item with no
--    MOQ and a BLANK multiple orders exactly its demand, as today (187.5 gal
--    stays 187.5 gal); a typed multiple of 1 means whole units (6 pallets, not
--    5.88). raw_ingredients.order_multiple defaults to 1 by schema, so there a
--    1 with no pack size is treated as blank. A per_run line is never rounded.
--  * fn_copacker_opening_balance — the starting amounts: 'adjustment'
--    movements ADJUSTMENT → co-packer, source_doc_type 'opening_balance', one
--    per item per location, refused a second time (a correction is an ordinary
--    Stock → Adjustment, not a second opening).
--  * v_copacker_stock — on hand / reserved / available per (item, co-packer).
--    `reserved` is 0 here and is REDEFINED by the runs phase (reservations);
--    the column exists now so the screen does not change shape later.
--  * fn_wo_advance__i is edited by anchored replace() on the LIVE definition
--    (consume + record-yield cost read demand_qty); each anchor asserted once.

BEGIN;

-- ── 1. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE ops.production_items
  ADD COLUMN IF NOT EXISTS min_order_qty  NUMERIC CHECK (min_order_qty  IS NULL OR min_order_qty  > 0),
  ADD COLUMN IF NOT EXISTS order_multiple NUMERIC CHECK (order_multiple IS NULL OR order_multiple > 0),
  ADD COLUMN IF NOT EXISTS lead_days      INTEGER CHECK (lead_days IS NULL OR lead_days >= 0);
ALTER TABLE ops.raw_ingredients
  ADD COLUMN IF NOT EXISTS min_order_qty NUMERIC CHECK (min_order_qty IS NULL OR min_order_qty > 0);
ALTER TABLE ops.work_order_materials
  ADD COLUMN IF NOT EXISTS demand_qty NUMERIC,
  ADD COLUMN IF NOT EXISTS qty_basis  TEXT NOT NULL DEFAULT 'per_yield' CHECK (qty_basis IN ('per_yield', 'per_run'));

-- Backfill: no live material carries a pack size, so demand = ordered today.
UPDATE ops.work_order_materials m SET demand_qty = COALESCE(m.demand_qty, m.required_qty) WHERE m.demand_qty IS NULL;
UPDATE ops.work_order_materials m SET qty_basis = l.qty_basis
  FROM ops.product_bom_lines l WHERE l.id = m.bom_line_id AND l.qty_basis IN ('per_yield', 'per_run') AND m.qty_basis <> l.qty_basis;

-- ── 2. The rounding rule ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_order_qty(p_demand numeric, p_moq numeric, p_multiple numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_demand IS NULL OR p_demand <= 0 THEN 0
    WHEN p_moq IS NULL AND p_multiple IS NULL THEN p_demand   -- nothing said: order the demand (a typed 1 means WHOLE units)
    ELSE ceil(GREATEST(p_demand, COALESCE(p_moq, 0)) / COALESCE(NULLIF(p_multiple, 0), 1)) * COALESCE(NULLIF(p_multiple, 0), 1)
  END
$$;
REVOKE ALL ON FUNCTION ops.fn_order_qty(numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_order_qty(numeric, numeric, numeric) TO authenticated, service_role;

-- ── 3. v_raw_ingredients: min_order_qty appended ─────────────────────────────
CREATE OR REPLACE VIEW ops.v_raw_ingredients AS
 SELECT r.id, r.name, r.slug, r.category, r.recipe_uom, r.is_purchased, r.purchase_uom, r.pack_size,
    r.order_multiple, r.purchase_cost, r.qbo_item_id, r.qbo_vendor_id, r.vendor_part_no, r.notes, r.active,
    r.created_at, r.updated_at, r.purchase_mode,
    qi.name AS qbo_item_name, qi.active AS qbo_item_active, qi.expense_account_name,
    v.display_name AS vendor_name,
    ( SELECT count(*) FROM ops.product_formula_ingredients fi WHERE fi.ingredient_id = r.id) AS formula_count,
    array_remove(ARRAY[
        CASE WHEN r.is_purchased AND r.purchase_mode = 'direct' AND r.qbo_item_id IS NULL THEN 'no QuickBooks item' END,
        CASE WHEN r.is_purchased AND r.qbo_vendor_id IS NULL THEN 'no vendor' END,
        CASE WHEN r.is_purchased AND r.pack_size IS NULL THEN 'no pack size' END,
        CASE WHEN r.is_purchased AND r.purchase_cost IS NULL THEN 'no cost' END], NULL::text) AS gaps,
    r.min_order_qty
   FROM ops.raw_ingredients r
     LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = r.qbo_item_id
     LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = r.qbo_vendor_id;

-- ── 4. Work-order creation stamps demand and applies the rule ────────────────
CREATE OR REPLACE FUNCTION ops.fn_wo_create_pipeline__i(p_bom_id uuid, p_qty_to_produce numeric, p_copacker_qbo_vendor_id text, p_copacker_location_id uuid, p_destination_location_id uuid, p_scheduled_date date DEFAULT NULL::date, p_batch_size_gal numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
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

  -- demand_qty: what the batch needs, in PURCHASE units (recipe / pack where
  -- the ingredient is bought in packs). required_qty: what is ORDERED — the
  -- one rounding rule, fed by the ingredient's pack/MOQ/multiple or the
  -- purchased-item master's MOQ/multiple. A per_run line is a flat charge:
  -- demand = ordered = qty_per, never rounded, never multiplied.
  INSERT INTO ops.work_order_materials (
    wo_id, bom_line_id, component_qbo_item_id, item_name,
    required_qty, demand_qty, qty_basis, recipe_qty, recipe_uom, pack_size, uom,
    unit_cost_est, qbo_vendor_id, vendor_name, ingredient_id, sort_order, notes
  )
  SELECT
    v_id, l.id, l.component_qbo_item_id,
    COALESCE(qi.name, ri.name, l.component_qbo_item_id),
    CASE
      WHEN l.qty_basis = 'per_run' THEN dem.demand_qty
      WHEN ri.id IS NOT NULL THEN
        ops.fn_order_qty(dem.demand_qty, ri.min_order_qty,
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
    (SELECT display_name FROM ops.qbo_vendors
      WHERE qbo_vendor_id = COALESCE(l.preferred_qbo_vendor_id, pi.qbo_vendor_id, ri.qbo_vendor_id)),
    l.ingredient_id,
    l.sort_order,
    l.notes
  FROM ops.product_bom_lines l
  LEFT JOIN ops.raw_ingredients  ri ON ri.id = l.ingredient_id
  LEFT JOIN ops.qbo_items        qi ON qi.qbo_item_id = l.component_qbo_item_id
  LEFT JOIN ops.production_items pi ON pi.qbo_item_id = l.component_qbo_item_id AND pi.active
  CROSS JOIN LATERAL (
    SELECT CASE WHEN l.qty_basis = 'per_run' THEN l.qty_per
                ELSE v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) END AS recipe_qty
  ) need
  CROSS JOIN LATERAL (
    SELECT CASE WHEN ri.pack_size IS NULL OR ri.pack_size <= 0 THEN need.recipe_qty
                ELSE need.recipe_qty / ri.pack_size END AS demand_qty
  ) dem
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component'
    AND l.component_qbo_item_id IS NOT NULL
  ORDER BY l.sort_order;

  INSERT INTO ops.work_order_recipe_lines (
    wo_id, bom_line_id, ingredient_id, item_name,
    recipe_qty, recipe_uom, order_qty, purchase_uom, pack_size,
    rollup_qbo_item_id, sort_order, notes
  )
  SELECT
    v_id, l.id, l.ingredient_id,
    COALESCE(ri.name, 'ingredient'),
    need.recipe_qty,
    COALESCE(l.qty_uom, 'lbs'),
    CASE
      WHEN ri.pack_size IS NULL OR ri.pack_size <= 0 THEN NULL
      ELSE ops.fn_order_qty(need.recipe_qty / ri.pack_size, ri.min_order_qty, COALESCE(ri.order_multiple, 1))
    END,
    ri.purchase_uom,
    ri.pack_size,
    l.rollup_qbo_item_id,
    l.sort_order,
    l.notes
  FROM ops.product_bom_lines l
  LEFT JOIN ops.raw_ingredients ri ON ri.id = l.ingredient_id
  CROSS JOIN LATERAL (
    SELECT v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) AS recipe_qty
  ) need
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component'
    AND l.component_qbo_item_id IS NULL
  ORDER BY l.sort_order;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
  VALUES (v_id, 'created', NULL, 'draft',
          'Work order created for ' || p_qty_to_produce || ' units', v_actor);

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION ops.fn_wo_create_pipeline__i(uuid, numeric, text, uuid, uuid, date, numeric, text) FROM PUBLIC, anon, authenticated;

-- ── 5. fn_wo_advance__i: consume and cost the DEMAND, not the order ──────────
DO $$
DECLARE v_src text; v_a text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p WHERE p.pronamespace = 'ops'::regnamespace AND p.proname = 'fn_wo_advance__i';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_wo_advance__i not found'; END IF;
  IF v_src LIKE '%20260903e%' THEN RAISE NOTICE 'fn_wo_advance__i already carries 20260903e — skipped'; RETURN; END IF;

  -- (a) consume what the batch needs; the MOQ surplus stays on hand at the co-packer
  v_a := E'''production_consume'', m.component_qbo_item_id, m.required_qty,';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (a) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, E'''production_consume'', m.component_qbo_item_id, COALESCE(m.demand_qty, m.required_qty),  -- 20260903e: demand, not order');

  -- (b) record_yield components cost: the batch carries what it used
  v_a := 'COALESCE(sum(m.required_qty * COALESCE(pl.unit_cost, m.unit_cost_est, 0)), 0),';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (b) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, 'COALESCE(sum(COALESCE(m.demand_qty, m.required_qty) * COALESCE(pl.unit_cost, m.unit_cost_est, 0)), 0),');

  v_a := E'''qty'', m.required_qty,';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (c) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, E'''qty'', COALESCE(m.demand_qty, m.required_qty), ''ordered_qty'', m.required_qty,');

  v_a := E'''extended_cost'', m.required_qty * COALESCE(pl.unit_cost, m.unit_cost_est, 0),';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (d) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, E'''extended_cost'', COALESCE(m.demand_qty, m.required_qty) * COALESCE(pl.unit_cost, m.unit_cost_est, 0),');

  EXECUTE v_src;
END $$;
REVOKE ALL ON FUNCTION ops.fn_wo_advance__i(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 6. Opening stock at the co-packer ────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_copacker_opening_balance(p_location_id uuid, p_lines jsonb, p_as_of timestamptz DEFAULT now(), p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE
  v_kind text; v_code text; v_adj uuid; v_actor uuid := auth.uid();
  v_line jsonb; v_item text; v_qty numeric; v_cost numeric; v_name text;
  v_done jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb; v_prev timestamptz;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT kind, code INTO v_kind, v_code FROM ops.inventory_locations WHERE id = p_location_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'location not found'; END IF;
  IF v_kind <> 'co_packer' THEN
    RAISE EXCEPTION 'opening stock is for a co-packer location — % is a %; use Stock → Adjustments for a warehouse', v_code, v_kind;
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'no lines';
  END IF;
  SELECT id INTO v_adj FROM ops.inventory_locations WHERE code = 'ADJUSTMENT';
  IF v_adj IS NULL THEN RAISE EXCEPTION 'ADJUSTMENT virtual location missing'; END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_item := v_line ->> 'qbo_item_id';
    v_qty  := NULLIF(v_line ->> 'qty', '')::numeric;
    v_cost := NULLIF(v_line ->> 'unit_cost', '')::numeric;
    SELECT name INTO v_name FROM ops.qbo_items WHERE qbo_item_id = v_item;
    IF v_item IS NULL OR v_name IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('qbo_item_id', v_item, 'reason', 'unknown item');
      CONTINUE;
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('qbo_item_id', v_item, 'item', v_name, 'reason', 'qty must be > 0');
      CONTINUE;
    END IF;
    -- One opening per item per location. A second one is a correction, and a
    -- correction is an ordinary adjustment with its own reason on it.
    SELECT occurred_at INTO v_prev FROM ops.inventory_movements
     WHERE source_doc_type = 'opening_balance' AND to_location_id = p_location_id AND qbo_item_id = v_item
     ORDER BY occurred_at DESC LIMIT 1;
    IF v_prev IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('qbo_item_id', v_item, 'item', v_name,
        'reason', 'opening stock already recorded on ' || to_char(v_prev, 'YYYY-MM-DD') || ' — correct it with Stock → Adjustments');
      CONTINUE;
    END IF;
    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty, from_location_id, to_location_id, unit_cost,
      source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
    VALUES ('adjustment', v_item, v_qty, v_adj, p_location_id, v_cost,
      'opening_balance', NULL, NULL, COALESCE(p_as_of, now()), v_actor,
      'Opening stock at ' || v_code || COALESCE(' · ' || NULLIF(trim(p_note), ''), ''));
    v_done := v_done || jsonb_build_object('qbo_item_id', v_item, 'item', v_name, 'qty', v_qty, 'unit_cost', v_cost);
  END LOOP;
  RETURN jsonb_build_object('location', v_code, 'done', v_done, 'skipped', v_skipped);
END;
$$;
REVOKE ALL ON FUNCTION ops.fn_copacker_opening_balance(uuid, jsonb, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_copacker_opening_balance(uuid, jsonb, timestamptz, text) TO authenticated, service_role;

-- ── 7. What is at the co-packer ──────────────────────────────────────────────
-- reserved is 0 until the runs phase adds inventory_reservations and redefines
-- this view with the same column list.
CREATE OR REPLACE VIEW ops.v_copacker_stock WITH (security_invoker = on) AS
WITH loc AS (SELECT id, code, name FROM ops.inventory_locations WHERE kind = 'co_packer' AND is_active),
oh AS (
  SELECT h.qbo_item_id, h.location_id, h.on_hand FROM ops.v_inventory_on_hand h JOIN loc ON loc.id = h.location_id
),
items AS (
  SELECT DISTINCT x.qbo_item_id, x.location_id FROM (
    SELECT qbo_item_id, location_id FROM oh
    UNION ALL SELECT pi.qbo_item_id, loc.id FROM ops.production_items pi CROSS JOIN loc WHERE pi.active
  ) x
),
demand AS (
  SELECT m.component_qbo_item_id AS qbo_item_id, w.copacker_location_id AS location_id,
         sum(COALESCE(m.demand_qty, m.required_qty)) AS open_demand
    FROM ops.work_order_materials m JOIN ops.work_orders w ON w.id = m.wo_id
   WHERE w.status IN ('draft', 'ordered', 'at_copacker')
   GROUP BY 1, 2
),
last_mv AS (
  SELECT qbo_item_id, location_id, max(occurred_at) AS last_movement_at
    FROM (SELECT qbo_item_id, to_location_id AS location_id, occurred_at FROM ops.inventory_movements WHERE to_location_id IS NOT NULL
          UNION ALL SELECT qbo_item_id, from_location_id, occurred_at FROM ops.inventory_movements WHERE from_location_id IS NOT NULL) m
   GROUP BY 1, 2
),
last_cost AS (
  SELECT DISTINCT ON (qbo_item_id, to_location_id) qbo_item_id, to_location_id AS location_id, unit_cost
    FROM ops.inventory_movements WHERE to_location_id IS NOT NULL AND unit_cost IS NOT NULL
   ORDER BY qbo_item_id, to_location_id, occurred_at DESC
)
SELECT i.qbo_item_id, qi.name AS item_name, qi.type AS item_type,
       i.location_id, loc.code AS location_code, loc.name AS location_name,
       COALESCE(oh.on_hand, 0)::numeric AS on_hand,
       0::numeric AS reserved,
       COALESCE(oh.on_hand, 0)::numeric AS available,
       COALESCE(d.open_demand, 0)::numeric AS open_demand,
       lc.unit_cost AS last_unit_cost,
       lm.last_movement_at,
       pi.min_order_qty, pi.order_multiple, pi.lead_days
  FROM items i
  JOIN loc ON loc.id = i.location_id
  LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = i.qbo_item_id
  LEFT JOIN ops.production_items pi ON pi.qbo_item_id = i.qbo_item_id
  LEFT JOIN oh ON oh.qbo_item_id = i.qbo_item_id AND oh.location_id = i.location_id
  LEFT JOIN demand d ON d.qbo_item_id = i.qbo_item_id AND d.location_id = i.location_id
  LEFT JOIN last_mv lm ON lm.qbo_item_id = i.qbo_item_id AND lm.location_id = i.location_id
  LEFT JOIN last_cost lc ON lc.qbo_item_id = i.qbo_item_id AND lc.location_id = i.location_id;
GRANT SELECT ON ops.v_copacker_stock TO authenticated, service_role;

COMMIT;
