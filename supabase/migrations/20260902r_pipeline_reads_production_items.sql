-- 2026-09-02  The work order and the pre-flight read the item master.
--
-- Precedence, in both:  BOM line override > production_items > raw_ingredients > QBO mirror.
-- Same signatures as before -- CREATE OR REPLACE on an identical argument list,
-- so no zombie overload.

CREATE OR REPLACE FUNCTION ops.fn_wo_create_pipeline(
  p_bom_id uuid, p_qty_to_produce numeric, p_copacker_qbo_vendor_id text,
  p_copacker_location_id uuid, p_destination_location_id uuid,
  p_scheduled_date date DEFAULT NULL::date, p_batch_size_gal numeric DEFAULT NULL::numeric,
  p_notes text DEFAULT NULL::text)
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

  -- STOCKED lines → what we buy, move and cost.
  -- Vendor and cost: BOM line override > production_items > raw_ingredients > QBO mirror.
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
    SELECT v_runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)) AS recipe_qty
  ) need
  WHERE l.bom_id = p_bom_id AND l.line_type = 'component'
    AND l.component_qbo_item_id IS NOT NULL
  ORDER BY l.sort_order;

  -- RECIPE lines → the specification under a gallon. Same arithmetic, but they
  -- are told to the supplier, not bought from one.
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

CREATE OR REPLACE FUNCTION ops.fn_bom_preflight(p_bom_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_vendors  JSONB;
  v_blockers JSONB;
  v_warnings JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ops.product_bom WHERE id = p_bom_id) THEN
    RAISE EXCEPTION 'bom % not found', p_bom_id;
  END IF;

  -- Vendor per line: BOM line override > production_items master.
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'vendor_name'), '[]'::jsonb)
    INTO v_vendors
    FROM (
      SELECT jsonb_build_object(
               'qbo_vendor_id', vend.id,
               'vendor_name',   COALESCE(v.display_name, '(no vendor set)'),
               'line_count',    count(*),
               'items',         jsonb_agg(COALESCE(i.name, l.service_label, l.component_qbo_item_id)
                                          ORDER BY l.sort_order)
             ) AS x
        FROM ops.product_bom_lines l
        LEFT JOIN ops.qbo_items        i  ON i.qbo_item_id  = l.component_qbo_item_id
        LEFT JOIN ops.production_items pi ON pi.qbo_item_id = l.component_qbo_item_id AND pi.active
        CROSS JOIN LATERAL (SELECT COALESCE(l.preferred_qbo_vendor_id, pi.qbo_vendor_id) AS id) vend
        LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = vend.id
       WHERE l.bom_id = p_bom_id
         AND l.line_type = 'component'
         AND l.component_qbo_item_id IS NOT NULL
       GROUP BY vend.id, v.display_name
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'item_name'), '[]'::jsonb)
    INTO v_blockers
    FROM (
      SELECT jsonb_build_object(
               'kind',        CASE WHEN vend.id IS NULL THEN 'no_vendor' ELSE 'inactive_in_qbo' END,
               'qbo_item_id', l.component_qbo_item_id,
               'item_name',   COALESCE(i.name, l.component_qbo_item_id),
               'detail',      CASE WHEN vend.id IS NULL
                                   THEN 'No vendor on this item — set one under Materials & Pricing, or on this BOM line.'
                                   ELSE 'This item is deactivated in QuickBooks. Reactivate it there, or point the line at the current item, before pushing a purchase order.'
                              END
             ) AS x
        FROM ops.product_bom_lines l
        LEFT JOIN ops.qbo_items        i  ON i.qbo_item_id  = l.component_qbo_item_id
        LEFT JOIN ops.production_items pi ON pi.qbo_item_id = l.component_qbo_item_id AND pi.active
        CROSS JOIN LATERAL (SELECT COALESCE(l.preferred_qbo_vendor_id, pi.qbo_vendor_id) AS id) vend
       WHERE l.bom_id = p_bom_id
         AND l.line_type = 'component'
         AND l.component_qbo_item_id IS NOT NULL
         AND (vend.id IS NULL OR COALESCE(i.active, TRUE) = FALSE)
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'item_name'), '[]'::jsonb)
    INTO v_warnings
    FROM (
      SELECT jsonb_build_object(
               'kind',        'inventory_component',
               'qbo_item_id', l.component_qbo_item_id,
               'item_name',   i.name,
               'detail',      'This is an Inventory item in QuickBooks. Components should be Service or Non-inventory — an inventory component starts tracking quantity and value for something we never count. Only the finished case belongs in inventory.'
             ) AS x
        FROM ops.product_bom_lines l
        JOIN ops.qbo_items i ON i.qbo_item_id = l.component_qbo_item_id
       WHERE l.bom_id = p_bom_id
         AND l.line_type = 'component'
         AND i.type = 'Inventory'
    ) s;

  RETURN jsonb_build_object(
    'po_count', jsonb_array_length(v_vendors),
    'vendors',  v_vendors,
    'blockers', v_blockers,
    'warnings', v_warnings
  );
END;
$$;
