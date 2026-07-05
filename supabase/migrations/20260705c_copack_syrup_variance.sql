-- Co-pack syrup variance.
--
-- Keep the order feed explicit about BOM-estimated syrup versus the invoice
-- syrup values locked at receipt.

DROP VIEW IF EXISTS ops.v_copack_orders;

CREATE VIEW ops.v_copack_orders
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT
    o.id, o.order_number, o.bom_id, o.finished_qbo_item_id,
    COALESCE(qi.name, o.finished_qbo_item_id) AS finished_item_name,
    o.qbo_vendor_id, v.display_name AS vendor_name,
    o.destination_location_id, l.name AS location_label,
    o.status, o.qty_ordered, o.target_uom,
    o.actual_yield_qty, o.actual_yield_uom, o.finished_units_received,
    o.expected_date, o.sent_at, o.received_at, o.closed_at,
    o.voided_at, o.void_reason,
    o.material_source_mode, o.syrup_unit_cost_per_gal,
    o.actual_syrup_gallons, o.actual_syrup_unit_cost_per_gal,
    CASE
      WHEN o.material_source_mode = 'syrup_by_gallon'
        THEN ops.fn_copack_syrup_gallons(o.bom_id, o.qty_ordered, o.target_uom)
      ELSE NULL
    END AS estimated_syrup_gallons,
    c.syrup_gallons AS cost_syrup_gallons,
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
  LEFT JOIN ops.copack_order_costs c ON c.order_id = o.id
),
calc AS (
  SELECT
    base.*,
    CASE
      WHEN estimated_syrup_gallons IS NOT NULL
        THEN estimated_syrup_gallons * COALESCE(syrup_unit_cost_per_gal, 0)
      ELSE NULL
    END AS estimated_syrup_cost,
    CASE
      WHEN material_source_mode = 'syrup_by_gallon'
        THEN COALESCE(actual_syrup_gallons, cost_syrup_gallons)
      ELSE NULL
    END AS locked_syrup_gallons,
    CASE
      WHEN material_source_mode = 'syrup_by_gallon'
       AND COALESCE(actual_syrup_gallons, cost_syrup_gallons) IS NOT NULL
        THEN COALESCE(actual_syrup_unit_cost_per_gal, syrup_unit_cost_per_gal, 0)
      ELSE NULL
    END AS locked_syrup_unit_cost_per_gal,
    COALESCE(cost_syrup_gallons, actual_syrup_gallons, estimated_syrup_gallons) AS effective_syrup_gallons
  FROM base
),
variance AS (
  SELECT
    calc.*,
    CASE
      WHEN locked_syrup_gallons IS NOT NULL
       AND locked_syrup_unit_cost_per_gal IS NOT NULL
        THEN locked_syrup_gallons * locked_syrup_unit_cost_per_gal
      ELSE NULL
    END AS locked_syrup_cost,
    CASE
      WHEN locked_syrup_gallons IS NOT NULL
       AND estimated_syrup_gallons IS NOT NULL
        THEN locked_syrup_gallons - estimated_syrup_gallons
      ELSE NULL
    END AS syrup_gallons_variance,
    CASE
      WHEN locked_syrup_gallons IS NOT NULL
       AND locked_syrup_unit_cost_per_gal IS NOT NULL
       AND estimated_syrup_cost IS NOT NULL
        THEN (locked_syrup_gallons * locked_syrup_unit_cost_per_gal) - estimated_syrup_cost
      ELSE NULL
    END AS syrup_cost_variance
  FROM calc
),
scored AS (
  SELECT
    variance.*,
    CASE
      WHEN estimated_syrup_gallons > 0
       AND syrup_gallons_variance IS NOT NULL
        THEN syrup_gallons_variance / estimated_syrup_gallons
      ELSE NULL
    END AS syrup_gallons_variance_pct,
    CASE
      WHEN estimated_syrup_cost > 0
       AND syrup_cost_variance IS NOT NULL
        THEN syrup_cost_variance / estimated_syrup_cost
      ELSE NULL
    END AS syrup_cost_variance_pct
  FROM variance
)
SELECT
  id, order_number, bom_id, finished_qbo_item_id,
  finished_item_name, qbo_vendor_id, vendor_name,
  destination_location_id, location_label,
  status, qty_ordered, target_uom,
  actual_yield_qty, actual_yield_uom, finished_units_received,
  expected_date, sent_at, received_at, closed_at,
  voided_at, void_reason,
  material_source_mode, syrup_unit_cost_per_gal,
  estimated_syrup_gallons, estimated_syrup_cost,
  actual_syrup_gallons, actual_syrup_unit_cost_per_gal,
  locked_syrup_gallons, locked_syrup_unit_cost_per_gal, locked_syrup_cost,
  syrup_gallons_variance, syrup_gallons_variance_pct,
  syrup_cost_variance, syrup_cost_variance_pct,
  CASE
    WHEN material_source_mode <> 'syrup_by_gallon' THEN NULL
    WHEN locked_syrup_gallons IS NULL THEN 'pending'
    WHEN estimated_syrup_gallons IS NULL OR estimated_syrup_gallons <= 0 THEN 'watch'
    WHEN abs(COALESCE(syrup_gallons_variance_pct, 0)) >= 0.15
      OR abs(COALESCE(syrup_cost_variance, 0)) >= 250 THEN 'alert'
    WHEN abs(COALESCE(syrup_gallons_variance_pct, 0)) >= 0.05
      OR abs(COALESCE(syrup_cost_variance, 0)) >= 50 THEN 'watch'
    ELSE 'ok'
  END AS syrup_variance_status,
  effective_syrup_gallons AS syrup_gallons,
  co_pack_fee, freight_cost, other_landed_cost,
  components_cost, services_cost, total_cost,
  unit_cost, per_case, per_can, per_oz, per_gal_finished,
  actual_yield_pct, computed_at,
  notes, created_at, updated_at
FROM scored;

GRANT SELECT ON ops.v_copack_orders TO authenticated;

NOTIFY pgrst, 'reload schema';
