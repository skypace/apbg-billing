-- fn_bom_save_v2 must not own the formula-derived lines.
--
-- The BOM editor loads every line, then saves them all back — which before
-- this change wiped source='formula' and ingredient_id off the ingredient
-- lines fn_bom_sync_from_formula had written. The next rebuild would then find
-- nothing of its own to replace and ADD A SECOND COPY of every ingredient.
--
-- Ownership is now explicit and symmetrical:
--   fn_bom_sync_from_formula  owns source='formula'  (the recipe)
--   fn_bom_save_v2            owns source='manual'   (cans, tray, fill, tolling)
-- Neither ever touches the other's rows. The editor in BomsTab.tsx enforces the
-- same split on the client: it loads only manual lines into the form and shows
-- the recipe read-only beside them.
--
-- p_lines may now be EMPTY on an update: a BOM whose packaging lines are all
-- being removed is a legitimate intermediate state when the recipe lines are
-- still there. It stays required on create, where an empty BOM is a mistake.
--
-- Body is otherwise verbatim from 20260721a; the two changed lines are the
-- DELETE predicate and source='manual' on the INSERT.

CREATE OR REPLACE FUNCTION ops.fn_bom_save_v2(
  p_id     UUID,
  p_header JSONB,
  p_lines  JSONB
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id        UUID := p_id;
  v_actor     UUID := auth.uid();
  v_line      JSONB;
  v_lt        TEXT;
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
    v_lt := v_line ->> 'line_type';
    IF v_lt NOT IN ('component', 'service') THEN
      RAISE EXCEPTION 'line_type must be component or service';
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
      qty_per, qty_uom, scrap_pct, default_cost, preferred_qbo_vendor_id,
      notes, sort_order, source
    ) VALUES (
      v_id, v_lt,
      CASE WHEN v_lt = 'component' THEN v_line ->> 'component_qbo_item_id' END,
      CASE WHEN v_lt = 'service'   THEN v_line ->> 'service_label'   END,
      (v_line ->> 'qty_per')::numeric,
      COALESCE(NULLIF(v_line ->> 'qty_uom', ''), 'each'),
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
$$;
GRANT EXECUTE ON FUNCTION ops.fn_bom_save_v2(UUID, JSONB, JSONB) TO authenticated;
