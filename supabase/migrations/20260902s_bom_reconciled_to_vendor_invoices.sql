-- 2026-09-02  The BOM now carries every charge the two vendors actually bill.
--
-- Ask (Sky): "Did you make sure that the BOM has all the materials we get
-- charged from both vendors? Did you look at older POs to insure all items are
-- listed from both?"  Read against the vendors' own paper -- Quantum invoices
-- 1462 (05/2025 final), 1583 (09/2025), 1741 (04/2026 deposit), 1766 (05/2026
-- final) and bill 171778 (07/2026 cans); every AC Calderoni line booked to Can
-- Raw Materials since 2025 -- the BOM was WRONG on the Quantum side in four
-- places and MISSING one Calderoni charge entirely:
--
--   Quantum bills ONE tolling line, "Basic Fill: Tolling" at $0.62/can (both
--     1462 and 1741).  The BOM carried FILL LABOR $0.33 + PACK OFF $0.055 =
--     $0.385 -- two lines Quantum never bills, understating tolling by 38%.
--   Velcorin (DMDC cold-sterilant) $0.02/can -- not on the BOM at all.
--   Dunnage -- CHEP pallet, 4-way polystrap, shrinkwrap -- $50 per pallet,
--     ~2,045 cans (85 cases) to the pallet on 1462 -- not on the BOM at all.
--   Cans: BOM said $0.26; the last can bill (171778) is $0.328, and the 2025
--     deposits ran $0.31-0.37.
--   The 24-pk TRAY is on NO Quantum invoice.  Left on the BOM (Sky moved it to
--     Quantum on purpose) with a note saying so -- who supplies it is a
--     question for a human, not a guess.
--
--   Calderoni bills a FLAT "canning fees" line per run -- $1,173.33 on every
--     run since 2026-03 (Feb, April, May, June, September) -- on top of the
--     syrup.  A flat per-run charge cannot be a per-case quantity, so BOM lines
--     gain qty_basis: 'per_yield' (the default, scales with the run) or
--     'per_run' (one per work order, whatever the size).
--
-- Two QuickBooks items were created for the two charges that had none, both
-- expensed to Can Raw Materials (294), neither Inventory:
--   1390  VELCORIN 12OZ CAN                    NonInventory  $0.02
--   1391  CANNING RUN FEE (SYRUP COMPOUNDING)  Service       $1,173.33
-- Dunnage reuses the existing 565 DUNNAGE FEE PER PALLET (Service).  Tolling
-- reuses 531 (12OZ CAN FILL LABOR) at the real $0.62 -- renaming a QBO item
-- that carries history is not worth the confusion; the master note says what
-- it is.  532 PACK OFF comes off every BOM and is retired in the item master.
--
-- Guard hygiene, found while here: 20260902r (and 20260902k before it)
-- CREATE-OR-REPLACEd fn_wo_create_pipeline / fn_wo_generate_pos /
-- fn_bom_save_v2 by NAME, which is exactly the 20260820b maintenance trap --
-- the guard WRAPPER was overwritten with the body and the __i inner went
-- stale.  Bodies move back into __i here and the wrappers are re-minted.

BEGIN;

-- ── 1. A line is per yield unit, or once per run ─────────────────────────────
ALTER TABLE ops.product_bom_lines
  ADD COLUMN IF NOT EXISTS qty_basis TEXT NOT NULL DEFAULT 'per_yield';
ALTER TABLE ops.product_bom_lines DROP CONSTRAINT IF EXISTS product_bom_lines_qty_basis_check;
ALTER TABLE ops.product_bom_lines
  ADD CONSTRAINT product_bom_lines_qty_basis_check CHECK (qty_basis IN ('per_yield','per_run'));
COMMENT ON COLUMN ops.product_bom_lines.qty_basis IS
  'per_yield: qty_per is per finished unit and scales with the run (the default). per_run: qty_per is a fixed quantity per work order — a flat vendor fee.';

-- ── 2. Mirror rows for the two new QuickBooks items ─────────────────────────
-- sync-qbo re-upserts these nightly with full detail; today they need to exist
-- so the BOM editor and pre-flight can name them.
INSERT INTO ops.qbo_items (qbo_item_id, name, type, active, purchase_cost, expense_account_ref_id)
VALUES ('1390', 'VELCORIN 12OZ CAN', 'NonInventory', TRUE, 0.02, '294'),
       ('1391', 'CANNING RUN FEE (SYRUP COMPOUNDING)', 'Service', TRUE, 1173.33, '294')
ON CONFLICT (qbo_item_id) DO UPDATE
  SET name = EXCLUDED.name, type = EXCLUDED.type, active = TRUE,
      purchase_cost = EXCLUDED.purchase_cost, expense_account_ref_id = EXCLUDED.expense_account_ref_id;

-- ── 3. The item master, reconciled ──────────────────────────────────────────
-- Tolling: one all-in line at what Quantum bills.
UPDATE ops.production_items
   SET unit_cost = 0.62, cost_uom = 'can',
       cost_note = 'Quantum "Basic Fill: Tolling" — the ONE co-packer charge per can (fill + pack-off). Invoice 1462 (05/2025) and deposit 1741 (04/2026) both at $0.62. Was carried as $0.33 fill + $0.055 pack-off.',
       updated_at = now()
 WHERE qbo_item_id = '531';

-- Pack-off is not a thing Quantum bills.
DELETE FROM ops.product_bom_lines WHERE component_qbo_item_id = '532';
UPDATE ops.production_items
   SET active = FALSE,
       cost_note = 'Retired 2026-09-02: Quantum bills one tolling line ($0.62/can on item 531); pack-off is not billed separately.',
       updated_at = now()
 WHERE qbo_item_id = '532';

-- Cans: the last can bill.
UPDATE ops.production_items
   SET unit_cost = 0.328,
       cost_note = 'Bill 171778 (2026-07-17): 10,626 printed cans for $3,485.33 = $0.328/can. 2025 deposits ran $0.31–0.37. Confirm against the Quantum contract price.',
       updated_at = now()
 WHERE qbo_item_id IN ('685','686','687','688','689','690','691');

-- Trays: on no Quantum invoice.
UPDATE ops.production_items
   SET cost_note = 'NOT on any Quantum invoice 2025–26 (1462, 1583, 1741, 1766). Vendor set to Quantum on instruction; confirm who actually supplies the 24-pk tray and at what price — $0.01583 is the QuickBooks mirror value, not a quote.',
       updated_at = now()
 WHERE qbo_item_id = '563';

-- Velcorin, dunnage, canning fee.
INSERT INTO ops.production_items (qbo_item_id, qbo_vendor_id, unit_cost, cost_uom, cost_note)
VALUES
  ('1390', '1744', 0.02, 'can',
   'Quantum invoice 1462: Velcorin $0.02 × 233,088 cans. Dosed at the filler; billed per can.'),
  ('565',  '1744', 50.00, 'pallet',
   'Quantum invoice 1462: "Dunnage — CHEP Pallet, 4-way polystrap, shrinkwrap" $50 × 114 pallets for 233,088 cans ≈ 2,045 cans (85 cases) per pallet.'),
  ('1391', '1099', 1173.33, 'run',
   'AC Calderoni "canning fees" — flat per run: $1,173.33 on the Feb, April, May, June and September 2026 runs (bills 163739, 163740, 169364, 169365, 173607). Billed to Can Raw Materials.')
ON CONFLICT (qbo_item_id) DO UPDATE
  SET qbo_vendor_id = EXCLUDED.qbo_vendor_id, unit_cost = EXCLUDED.unit_cost,
      cost_uom = EXCLUDED.cost_uom, cost_note = EXCLUDED.cost_note, active = TRUE, updated_at = now();

-- ── 4. The lines, on all seven case BOMs ────────────────────────────────────
-- Velcorin: 24 per case, rides beside the cans.
INSERT INTO ops.product_bom_lines (bom_id, line_type, component_qbo_item_id, qty_per, qty_uom, qty_basis, sort_order, source, notes)
SELECT b.id, 'component', '1390', 24, 'each', 'per_yield', 150, 'manual',
       'Dosed at the filler — Quantum bills it per can'
  FROM ops.product_bom b
 WHERE b.cans_per_case = 24
   AND NOT EXISTS (SELECT 1 FROM ops.product_bom_lines l WHERE l.bom_id = b.id AND l.component_qbo_item_id = '1390');

-- Dunnage: a pallet holds ~85 cases, so 1/85 of a pallet per case.
INSERT INTO ops.product_bom_lines (bom_id, line_type, component_qbo_item_id, qty_per, qty_uom, qty_basis, sort_order, source, notes)
SELECT b.id, 'component', '565', 0.011765, 'pallet', 'per_yield', 160, 'manual',
       'CHEP pallet + polystrap + shrinkwrap, $50/pallet, ~85 cases to a pallet (invoice 1462)'
  FROM ops.product_bom b
 WHERE b.cans_per_case = 24
   AND NOT EXISTS (SELECT 1 FROM ops.product_bom_lines l WHERE l.bom_id = b.id AND l.component_qbo_item_id = '565');

-- Calderoni canning fee: one per run, whatever the size.
INSERT INTO ops.product_bom_lines (bom_id, line_type, component_qbo_item_id, qty_per, qty_uom, qty_basis, sort_order, source, notes)
SELECT b.id, 'component', '1391', 1, 'run', 'per_run', 105, 'manual',
       'Flat compounding fee Calderoni bills once per can run ($1,173.33 every run since 2026-03)'
  FROM ops.product_bom b
 WHERE b.cans_per_case = 24
   AND NOT EXISTS (SELECT 1 FROM ops.product_bom_lines l WHERE l.bom_id = b.id AND l.component_qbo_item_id = '1391');

-- Quantum's ZIP, read off invoice 1462's header.
UPDATE ops.inventory_locations SET postal_code = '80516'
 WHERE code = 'QUANTUM-CANNING' AND postal_code IS NULL;

-- ── 5. fn_bom_save_v2: accept qty_basis, and put the guard back ─────────────
CREATE OR REPLACE FUNCTION ops.fn_bom_save_v2__i(p_id uuid, p_header jsonb, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE
  v_id        UUID := p_id;
  v_actor     UUID := auth.uid();
  v_line      JSONB;
  v_lt        TEXT;
  v_basis     TEXT;
  v_sort      INTEGER := 100;
  v_active_wo INTEGER;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines must be a JSON array';
  END IF;
  IF v_id IS NULL AND jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'a new BOM needs at least one line';
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

    -- Only the hand-entered lines. The recipe belongs to the formula sync.
    DELETE FROM ops.product_bom_lines WHERE bom_id = v_id AND source = 'manual';
  END IF;

  -- Manual lines sort after the recipe (which starts at 10 and steps by 10),
  -- so a printed BOM reads ingredients first, then packaging and services.
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_lt    := v_line ->> 'line_type';
    v_basis := COALESCE(NULLIF(v_line ->> 'qty_basis', ''), 'per_yield');
    IF v_lt NOT IN ('component', 'service') THEN
      RAISE EXCEPTION 'line_type must be component or service';
    END IF;
    IF v_basis NOT IN ('per_yield', 'per_run') THEN
      RAISE EXCEPTION 'qty_basis must be per_yield or per_run';
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
      qty_per, qty_uom, qty_basis, scrap_pct, default_cost, preferred_qbo_vendor_id,
      notes, sort_order, source
    ) VALUES (
      v_id, v_lt,
      CASE WHEN v_lt = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_lt = 'service'   THEN v_line ->> 'service_label'   END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'qty_uom', ''), 'each'),
      v_basis,
      COALESCE(NULLIF(v_line ->> 'scrap_pct', '')::numeric, 0),
      NULLIF(v_line ->> 'default_cost', '')::numeric,
      NULLIF(v_line ->> 'preferred_qbo_vendor_id', ''),
      v_line ->> 'notes',
      v_sort,
      'manual'
    );
    v_sort := v_sort + 10;
  END LOOP;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION ops.fn_bom_save_v2(p_id uuid, p_header jsonb, p_lines jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $function$-- GENERATED GUARD WRAPPER (20260820b, re-minted 20260902s) — the real body lives in ops.fn_bom_save_v2__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN ops.fn_bom_save_v2__i($1, $2, $3); END$function$;

-- ── 6. fn_wo_create_pipeline: per_run lines, and the guard back ─────────────
CREATE OR REPLACE FUNCTION ops.fn_wo_create_pipeline__i(p_bom_id uuid, p_qty_to_produce numeric, p_copacker_qbo_vendor_id text, p_copacker_location_id uuid, p_destination_location_id uuid, p_scheduled_date date DEFAULT NULL::date, p_batch_size_gal numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
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

  -- Stocked components: the gallon, cans, tray, tolling, Velcorin, dunnage, and
  -- any flat per-run fee.  Cost and vendor precedence: line override >
  -- production_items > raw_ingredients > QBO mirror.
  INSERT INTO ops.work_order_materials (
    wo_id, bom_line_id, component_qbo_item_id, item_name,
    required_qty, recipe_qty, recipe_uom, pack_size, uom,
    unit_cost_est, qbo_vendor_id, vendor_name, ingredient_id, sort_order, notes
  )
  SELECT
    v_id, l.id, l.component_qbo_item_id,
    COALESCE(qi.name, ri.name, l.component_qbo_item_id),
    CASE
      WHEN ri.pack_size IS NULL OR ri.pack_size <= 0 THEN need.recipe_qty
      ELSE ceil((need.recipe_qty / ri.pack_size) / ri.order_multiple) * ri.order_multiple
    END,
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
    -- A per_run line is a flat quantity per work order (a vendor's fixed fee);
    -- everything else scales with the run and its scrap allowance.
    SELECT CASE WHEN l.qty_basis = 'per_run' THEN l.qty_per
                ELSE v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) END AS recipe_qty
  ) need
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
      ELSE ceil((need.recipe_qty / ri.pack_size) / ri.order_multiple) * ri.order_multiple
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
$function$;

CREATE OR REPLACE FUNCTION ops.fn_wo_create_pipeline(p_bom_id uuid, p_qty_to_produce numeric, p_copacker_qbo_vendor_id text, p_copacker_location_id uuid, p_destination_location_id uuid, p_scheduled_date date DEFAULT NULL::date, p_batch_size_gal numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $function$-- GENERATED GUARD WRAPPER (20260820b, re-minted 20260902s) — the real body lives in ops.fn_wo_create_pipeline__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN ops.fn_wo_create_pipeline__i($1, $2, $3, $4, $5, $6, $7, $8); END$function$;

-- ── 7. fn_wo_generate_pos: body back into __i, guard back on the name ───────
CREATE OR REPLACE FUNCTION ops.fn_wo_generate_pos__i(p_wo_id uuid, p_expected_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
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
  v_detail    JSONB;
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
      po_number, qbo_vendor_id, destination_location_id, status, po_kind,
      expected_date, notes, work_order_id, created_by, ordered_at, ordered_by
    ) VALUES (
      v_po_number, v_vendor, v_copacker, 'open', 'materials',
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
        'WO ' || v_batch ||
          CASE WHEN v_mat.recipe_qty IS NOT NULL AND v_mat.pack_size IS NOT NULL
               THEN ' · needs ' || ROUND(v_mat.recipe_qty, 3) || ' ' ||
                    COALESCE(v_mat.recipe_uom, '') ELSE '' END,
        v_sort
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
      'po_id', v_po_id, 'po_number', v_po_number,
      'qbo_vendor_id', v_vendor, 'subtotal', v_subtotal
    );
  END LOOP;

  -- The ingredients are specification, not spend: they are filed UNDER the
  -- gallon line that carries their price, so Refractor and the printed PO show
  -- what the supplier must buy while QuickBooks still sees one gallon line.
  v_detail := ops.fn_wo_attach_recipe_detail(p_wo_id);

  IF v_status = 'draft' THEN
    UPDATE ops.work_orders SET status = 'ordered', ordered_at = now() WHERE id = p_wo_id;
  END IF;

  INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
  VALUES (p_wo_id, 'pos_generated', v_status, 'ordered',
          jsonb_array_length(v_result) || ' purchase order(s) generated',
          jsonb_build_object('pos', v_result, 'recipe_detail', v_detail), v_actor);

  RETURN jsonb_build_object('pos', v_result, 'recipe_detail', v_detail);
END;
$function$;

CREATE OR REPLACE FUNCTION ops.fn_wo_generate_pos(p_wo_id uuid, p_expected_date date DEFAULT NULL::date)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $function$-- GENERATED GUARD WRAPPER (20260820b, re-minted 20260902s) — the real body lives in ops.fn_wo_generate_pos__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN ops.fn_wo_generate_pos__i($1, $2); END$function$;

-- Inner bodies are reachable only through their wrappers.
REVOKE ALL ON FUNCTION ops.fn_bom_save_v2__i(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.fn_wo_create_pipeline__i(uuid, numeric, text, uuid, uuid, date, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ops.fn_wo_generate_pos__i(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_bom_save_v2(uuid, jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ops.fn_wo_create_pipeline(uuid, numeric, text, uuid, uuid, date, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ops.fn_wo_generate_pos(uuid, date) TO authenticated, service_role;

-- ── 8. Material requirements: per_run aware, and reading the item master ────
CREATE OR REPLACE FUNCTION ops.fn_bom_material_requirements(p_bom_id uuid, p_target_qty numeric, p_target_uom text DEFAULT NULL::text, p_location_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(component_qbo_item_id text, item_name text, required_qty numeric, required_uom text, source_line_count integer, qty_per numeric, scrap_pct numeric, on_hand_qty numeric, location_on_hand_qty numeric, on_order_qty numeric, available_qty numeric, shortage_qty numeric, unit_cost numeric, shortage_cost numeric, status text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'ops', 'pg_temp'
AS $function$
WITH bom AS (
  SELECT b.id, COALESCE(NULLIF(p_target_uom, ''), b.yield_uom, 'each') AS target_uom
  FROM ops.product_bom b
  WHERE b.id = p_bom_id
),
runs AS (
  SELECT ops.fn_bom_scale_runs(p_bom_id, p_target_qty, b.target_uom) AS runs
  FROM bom b
),
required AS (
  SELECT
    l.component_qbo_item_id,
    COALESCE(qi.name, qi.fully_qualified_name, l.component_qbo_item_id) AS item_name,
    COALESCE(NULLIF(l.qty_uom, ''), 'each') AS required_uom,
    count(*)::integer AS source_line_count,
    sum(CASE WHEN l.qty_basis = 'per_run' THEN l.qty_per
             ELSE r.runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) END)::numeric AS required_qty,
    sum(l.qty_per)::numeric AS qty_per,
    max(COALESCE(l.scrap_pct, 0))::numeric AS scrap_pct,
    COALESCE(max(l.default_cost), max(pi.unit_cost), max(qi.purchase_cost))::numeric AS unit_cost
  FROM ops.product_bom_lines l
  CROSS JOIN runs r
  LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.component_qbo_item_id
  LEFT JOIN ops.production_items pi ON pi.qbo_item_id = l.component_qbo_item_id AND pi.active
  WHERE l.bom_id = p_bom_id
    AND l.line_type = 'component'
    AND l.component_qbo_item_id IS NOT NULL
  GROUP BY l.component_qbo_item_id, COALESCE(qi.name, qi.fully_qualified_name, l.component_qbo_item_id), COALESCE(NULLIF(l.qty_uom, ''), 'each')
),
stock_all AS (
  SELECT oh.qbo_item_id, sum(oh.on_hand)::numeric AS qty
  FROM ops.v_inventory_on_hand oh
  JOIN ops.inventory_locations loc ON loc.id = oh.location_id
  WHERE loc.kind <> 'adjustment'
  GROUP BY oh.qbo_item_id
),
stock_location AS (
  SELECT oh.qbo_item_id, sum(oh.on_hand)::numeric AS qty
  FROM ops.v_inventory_on_hand oh
  JOIN ops.inventory_locations loc ON loc.id = oh.location_id
  WHERE p_location_id IS NOT NULL
    AND oh.location_id = p_location_id
    AND loc.kind <> 'adjustment'
  GROUP BY oh.qbo_item_id
),
brix_on_order AS (
  SELECT l.qbo_item_id,
    sum(GREATEST(COALESCE(l.qty_ordered, 0) - COALESCE(l.qty_received, 0), 0))::numeric AS qty_pending
  FROM ops.purchase_order_lines l
  JOIN ops.purchase_orders p ON p.id = l.po_id
  WHERE p.status IN ('draft', 'open', 'partial', 'received')
    AND l.qbo_item_id IS NOT NULL
  GROUP BY l.qbo_item_id
),
qbo_direct_on_order AS (
  SELECT l.qbo_item_id,
    sum(COALESCE(l.qty, 0))::numeric AS qty_pending
  FROM ops.qbo_purchase_order_lines l
  JOIN ops.qbo_purchase_orders p ON p.qbo_id = l.qbo_po_id
  LEFT JOIN ops.purchase_orders brix ON brix.qbo_purchase_order_id = p.qbo_id
  WHERE l.qbo_item_id IS NOT NULL
    AND lower(COALESCE(p.po_status, '')) IN ('open')
    AND brix.id IS NULL
  GROUP BY l.qbo_item_id
),
on_order AS (
  SELECT qbo_item_id, sum(qty_pending)::numeric AS qty_pending
  FROM (
    SELECT qbo_item_id, qty_pending FROM brix_on_order
    UNION ALL
    SELECT qbo_item_id, qty_pending FROM qbo_direct_on_order
  ) x
  GROUP BY qbo_item_id
),
availability AS (
  SELECT
    r.*,
    COALESCE(sa.qty, 0)::numeric AS all_on_hand,
    COALESCE(sl.qty, 0)::numeric AS loc_on_hand,
    COALESCE(oo.qty_pending, 0)::numeric AS on_order
  FROM required r
  LEFT JOIN stock_all sa ON sa.qbo_item_id = r.component_qbo_item_id
  LEFT JOIN stock_location sl ON sl.qbo_item_id = r.component_qbo_item_id
  LEFT JOIN on_order oo ON oo.qbo_item_id = r.component_qbo_item_id
)
SELECT
  a.component_qbo_item_id,
  a.item_name,
  a.required_qty,
  a.required_uom,
  a.source_line_count,
  a.qty_per,
  a.scrap_pct,
  a.all_on_hand AS on_hand_qty,
  CASE WHEN p_location_id IS NULL THEN NULL ELSE a.loc_on_hand END AS location_on_hand_qty,
  a.on_order AS on_order_qty,
  (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END + a.on_order)::numeric AS available_qty,
  GREATEST(a.required_qty - (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END + a.on_order), 0)::numeric AS shortage_qty,
  a.unit_cost,
  (GREATEST(a.required_qty - (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END + a.on_order), 0) * COALESCE(a.unit_cost, 0))::numeric AS shortage_cost,
  CASE
    WHEN a.required_qty <= (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END) THEN 'ok'
    WHEN a.required_qty <= (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END + a.on_order) THEN 'on_order'
    WHEN (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END + a.on_order) <= 0 THEN 'no_stock'
    ELSE 'short'
  END AS status
FROM availability a
ORDER BY
  CASE
    WHEN a.required_qty > (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END + a.on_order) THEN 0
    WHEN a.required_qty > (CASE WHEN p_location_id IS NULL THEN a.all_on_hand ELSE a.loc_on_hand END) THEN 1
    ELSE 2
  END,
  a.item_name;
$function$;

COMMIT;
