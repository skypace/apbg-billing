-- ============================================================================
-- Inventory adjustments — opening balance + shrinkage / variance entry
--
-- Phase 1's movement ledger has only `transfer_ship` and `transfer_receive`
-- writers. There is no path to materialize stock into the ledger from
-- nothing — so the On-Hand grid stays empty even after operators flag
-- `track_locations=true` on their items.
--
-- This migration adds:
--   1. ops.fn_record_adjustment(location, item, qty, direction, reason)
--      — SECURITY DEFINER. Writes one movement_type='adjustment' row
--        between the real location and the virtual ADJUSTMENT singleton
--        seeded by 20260513a.
--
-- "add"    direction: ADJUSTMENT -> location  (qty appears at location)
-- "remove" direction: location   -> ADJUSTMENT (qty disappears from location)
--
-- Used by the Stock → Adjustments tab.
-- ============================================================================

CREATE OR REPLACE FUNCTION ops.fn_record_adjustment(
  p_location_id  UUID,
  p_qbo_item_id  TEXT,
  p_qty          NUMERIC,
  p_direction    TEXT,                          -- 'add' | 'remove'
  p_reason       TEXT,
  p_unit_cost    NUMERIC      DEFAULT NULL,
  p_occurred_at  TIMESTAMPTZ  DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_loc_kind    TEXT;
  v_adjustment  UUID;
  v_actor       UUID := auth.uid();
  v_movement_id UUID;
  v_from        UUID;
  v_to          UUID;
BEGIN
  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'location_id is required';
  END IF;
  IF p_qbo_item_id IS NULL OR p_qbo_item_id = '' THEN
    RAISE EXCEPTION 'qbo_item_id is required';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'qty must be > 0';
  END IF;
  IF p_direction NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'direction must be add or remove';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason is required';
  END IF;

  SELECT kind INTO v_loc_kind
    FROM ops.inventory_locations WHERE id = p_location_id;
  IF v_loc_kind IS NULL THEN
    RAISE EXCEPTION 'location_id not found';
  END IF;
  IF v_loc_kind IN ('in_transit', 'adjustment') THEN
    RAISE EXCEPTION 'Cannot adjust a virtual location (kind=%)', v_loc_kind;
  END IF;

  SELECT id INTO v_adjustment FROM ops.inventory_locations WHERE code = 'ADJUSTMENT';
  IF v_adjustment IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT virtual location missing — re-run 20260513a';
  END IF;

  IF p_direction = 'add' THEN
    v_from := v_adjustment;
    v_to   := p_location_id;
  ELSE
    v_from := p_location_id;
    v_to   := v_adjustment;
  END IF;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  VALUES (
    'adjustment', p_qbo_item_id, p_qty,
    v_from, v_to, p_unit_cost,
    'manual', NULL, NULL,
    COALESCE(p_occurred_at, now()), v_actor, p_reason
  )
  RETURNING id INTO v_movement_id;

  RETURN v_movement_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_record_adjustment(
  UUID, TEXT, NUMERIC, TEXT, TEXT, NUMERIC, TIMESTAMPTZ
) TO authenticated;
