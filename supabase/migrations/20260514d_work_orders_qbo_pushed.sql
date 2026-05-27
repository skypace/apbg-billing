-- v0.9.40 — track QBO writeback state on work orders.
--
-- Phase 3 from 20260514b: closing a work order in BRIX needs to push
-- the consume + yield movements to QBO as an InventoryAdjustment so
-- QBO's Item.QtyOnHand reflects the build. Without this, BRIX and
-- QBO drift apart every time a WO closes.
--
-- These columns let us:
-- (a) Prevent double-push — the UI hides the "Push to QBO" button
--     once qbo_inventory_adjustment_id is set.
-- (b) Surface when the WO was synced + which adjustment record it
--     became in QBO (for audit / drill-through).
-- (c) Capture push errors without losing the WO state.
--
-- The edge function push-qbo-item v4 adds a `postInventoryAdjustment`
-- action that reads ops.inventory_movements for the WO, builds a QBO
-- InventoryAdjustment payload, POSTs it, and writes the resulting id
-- back to ops.work_orders via service-role.

ALTER TABLE ops.work_orders
  ADD COLUMN IF NOT EXISTS qbo_inventory_adjustment_id text,
  ADD COLUMN IF NOT EXISTS qbo_pushed_at               timestamptz,
  ADD COLUMN IF NOT EXISTS qbo_push_error              text;

CREATE INDEX IF NOT EXISTS idx_wo_qbo_pushed_at ON ops.work_orders(qbo_pushed_at)
  WHERE qbo_inventory_adjustment_id IS NOT NULL;
