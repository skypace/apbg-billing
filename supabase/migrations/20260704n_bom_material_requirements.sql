-- BOM material requirements and shortage check.
--
-- Recomputes raw material demand from the active BOM math, then compares it
-- with BRIX location inventory and outstanding BRIX/QBO purchase orders.
-- This is intentionally read-only: requirements should always reflect the
-- current formula, stock movements, and PO pipeline when an order is planned.

CREATE OR REPLACE FUNCTION ops.fn_bom_material_requirements(
  p_bom_id uuid,
  p_target_qty numeric,
  p_target_uom text DEFAULT NULL,
  p_location_id uuid DEFAULT NULL
) RETURNS TABLE (
  component_qbo_item_id text,
  item_name text,
  required_qty numeric,
  required_uom text,
  source_line_count integer,
  qty_per numeric,
  scrap_pct numeric,
  on_hand_qty numeric,
  location_on_hand_qty numeric,
  on_order_qty numeric,
  available_qty numeric,
  shortage_qty numeric,
  unit_cost numeric,
  shortage_cost numeric,
  status text
)
LANGUAGE sql
STABLE
SET search_path = ops, pg_temp
AS $$
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
    sum(r.runs * l.qty_per * (1 + COALESCE(l.scrap_pct, 0)))::numeric AS required_qty,
    sum(l.qty_per)::numeric AS qty_per,
    max(COALESCE(l.scrap_pct, 0))::numeric AS scrap_pct,
    COALESCE(max(l.default_cost), max(qi.purchase_cost))::numeric AS unit_cost
  FROM ops.product_bom_lines l
  CROSS JOIN runs r
  LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.component_qbo_item_id
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
$$;

GRANT EXECUTE ON FUNCTION ops.fn_bom_material_requirements(uuid, numeric, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
