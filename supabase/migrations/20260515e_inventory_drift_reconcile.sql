-- v0.9.45 — inventory drift visibility + one-click reconcile to QBO
--
-- Problem: Stock screen says one number, Inventory screen says another.
-- The two views read from different sources:
--   Stock     ← ops.inventory_movements (BRIX per-location ledger)
--   Inventory ← ops.qbo_items.qty_on_hand (QBO snapshot)
-- When location tracking was first enabled, each item was seeded with a
-- +qty movement to its home warehouse and a balancing −qty at the virtual
-- "Adjustment Counter" location. Since then QBO has booked sales,
-- adjustments, and bills against qty_on_hand — but those never made it
-- into the BRIX ledger, so the two drift apart. Example caught by user:
-- 24P126121 HANGAR 25 COLA CASE — Stock 311 / Inventory 261 / drift 50.
--
-- This migration adds:
--   1. ops.v_inventory_drift — per-item view of QBO total vs BRIX total,
--      ignoring the virtual "Adjustment Counter" / "In Transit" rows so
--      only real warehouses count toward the BRIX side.
--   2. ops.fn_reconcile_inventory_to_qbo(p_qbo_item_id, p_target_location_id)
--      — posts an offsetting movement_type='adjustment' row between the
--      target real location and the Adjustment Counter virtual location so
--      that SUM(real-location BRIX) == QBO qty_on_hand. Idempotent: a
--      second call with no drift does nothing.
--
-- Follow-up phases (separate PRs):
--   • Auto-emit inventory_movements rows from QBO sales so the ledger
--     keeps pace with QBO instead of drifting.
--   • Merge Stock + Inventory under one page with tabs.
--   • Mobile cycle-count app that posts adjustments + emails report.

CREATE OR REPLACE VIEW ops.v_inventory_drift AS
WITH brix AS (
  SELECT
    v.qbo_item_id,
    sum(CASE WHEN l.kind = 'warehouse' THEN v.on_hand ELSE 0 END)::numeric AS brix_warehouse_total,
    sum(CASE WHEN l.kind = 'in_transit' THEN v.on_hand ELSE 0 END)::numeric AS brix_in_transit,
    sum(CASE WHEN l.kind = 'adjustment' THEN v.on_hand ELSE 0 END)::numeric AS brix_adjustment_offset,
    sum(v.on_hand)::numeric AS brix_all_locations
  FROM ops.v_inventory_on_hand v
  JOIN ops.inventory_locations l ON l.id = v.location_id
  GROUP BY v.qbo_item_id
)
SELECT
  it.qbo_item_id,
  COALESCE(it.name, it.fully_qualified_name)         AS item_name,
  it.type                                            AS item_type,
  COALESCE(it.active, true)                          AS active,
  COALESCE(it.qty_on_hand, 0)::numeric               AS qbo_qty,
  COALESCE(b.brix_warehouse_total, 0)::numeric       AS brix_qty,
  COALESCE(b.brix_in_transit, 0)::numeric            AS brix_in_transit,
  COALESCE(b.brix_adjustment_offset, 0)::numeric     AS brix_adjustment_offset,
  (COALESCE(it.qty_on_hand, 0) - COALESCE(b.brix_warehouse_total, 0))::numeric AS drift,
  COALESCE(s.track_locations, false)                 AS track_locations,
  COALESCE(s.is_managed, false)                      AS is_managed,
  COALESCE(s.category_override, it.category_path, 'Uncategorized') AS category_resolved
FROM ops.qbo_items it
LEFT JOIN brix b ON b.qbo_item_id = it.qbo_item_id
LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
WHERE COALESCE(it.active, true)
  AND COALESCE(it.type, '') NOT IN ('Category', 'Group');

GRANT SELECT ON ops.v_inventory_drift TO authenticated;


-- ── fn_reconcile_inventory_to_qbo ─────────────────────────────────────────
-- Aligns BRIX ledger to QBO's qty_on_hand for one item. Posts an
-- inventory_movements row of type 'adjustment' that nets out the drift
-- against the virtual Adjustment Counter location.
--
-- Sign rules:
--   drift > 0  (QBO has more than BRIX shows) → +drift to target location,
--               −drift from Adjustment Counter
--   drift < 0  (BRIX shows more than QBO has) → +abs(drift) to Adjustment
--               Counter, −abs(drift) from target location
-- This is balanced (movement_type='adjustment' takes one from / one to),
-- so net inventory is unchanged when summed across both legs, but the
-- warehouse-only sum now matches QBO.
CREATE OR REPLACE FUNCTION ops.fn_reconcile_inventory_to_qbo(
  p_qbo_item_id        TEXT,
  p_target_location_id UUID DEFAULT NULL,
  p_reason             TEXT DEFAULT NULL
)
RETURNS TABLE(
  qbo_item_id    text,
  drift_resolved numeric,
  movement_id    uuid,
  message        text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_drift   NUMERIC;
  v_target  UUID := p_target_location_id;
  v_adj     UUID;
  v_actor   UUID := auth.uid();
  v_mv_id   UUID;
BEGIN
  IF p_qbo_item_id IS NULL OR p_qbo_item_id = '' THEN
    RAISE EXCEPTION 'qbo_item_id is required';
  END IF;

  SELECT drift INTO v_drift FROM ops.v_inventory_drift WHERE v_inventory_drift.qbo_item_id = p_qbo_item_id;
  IF v_drift IS NULL THEN
    RAISE EXCEPTION 'item not found in v_inventory_drift';
  END IF;
  IF v_drift = 0 THEN
    RETURN QUERY SELECT p_qbo_item_id, 0::numeric, NULL::uuid, 'no drift to reconcile';
    RETURN;
  END IF;

  SELECT id INTO v_adj FROM ops.inventory_locations WHERE kind = 'adjustment' AND is_active LIMIT 1;
  IF v_adj IS NULL THEN
    RAISE EXCEPTION 'no active adjustment location configured';
  END IF;

  IF v_target IS NULL THEN
    SELECT id INTO v_target FROM ops.inventory_locations
      WHERE kind = 'warehouse' AND is_active
      ORDER BY (code = 'BRIX-WAREHOUSE') DESC, name ASC LIMIT 1;
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'no active warehouse to receive reconcile adjustment';
    END IF;
  END IF;

  -- Always book the adjustment as a balanced movement. movement_type
  -- 'adjustment' requires qty > 0 with from/to locations; we pick the
  -- direction based on drift sign.
  IF v_drift > 0 THEN
    -- BRIX is short → add to warehouse, take from adjustment counter.
    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty,
      from_location_id, to_location_id, unit_cost,
      source_doc_type, source_doc_id,
      occurred_at, created_by, notes
    ) VALUES (
      'adjustment', p_qbo_item_id, v_drift,
      v_adj, v_target, NULL,
      'reconcile_qbo', NULL,
      now(), v_actor,
      COALESCE(p_reason, 'Reconcile to QBO · BRIX was short ' || v_drift)
    ) RETURNING id INTO v_mv_id;
  ELSE
    -- BRIX is long → remove from warehouse, add to adjustment counter.
    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty,
      from_location_id, to_location_id, unit_cost,
      source_doc_type, source_doc_id,
      occurred_at, created_by, notes
    ) VALUES (
      'adjustment', p_qbo_item_id, abs(v_drift),
      v_target, v_adj, NULL,
      'reconcile_qbo', NULL,
      now(), v_actor,
      COALESCE(p_reason, 'Reconcile to QBO · BRIX was over by ' || abs(v_drift))
    ) RETURNING id INTO v_mv_id;
  END IF;

  RETURN QUERY SELECT p_qbo_item_id, v_drift, v_mv_id, 'reconciled';
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_reconcile_inventory_to_qbo(TEXT, UUID, TEXT) TO authenticated;
