-- v0.9.43 — surface purchased_qty / adjustment_qty / shrinkage_qty on fn_items_master
--
-- The Inventory > Velocity tab has columns for Purchased, Adj Qty, and
-- Shrink, but the underlying fn_items_master never returned those values
-- — they always rendered 0 (or — for shrink). This migration adds the
-- three columns end-to-end.
--
-- Sources:
--   purchased_qty / purchased_cost  ← ops.inventory_movements where
--                                      movement_type='receipt' (PO receipts
--                                      land here; future QBO bill receipts
--                                      will too).
--   adjustment_qty                  ← sum(qty_diff) from
--                                      ops.qbo_inventory_adjustment_lines
--                                      (signed; positive = counted up).
--   shrinkage_qty                   ← sum(abs(qty_diff)) where qty_diff < 0
--                                      (same source; already computed as a
--                                       private CTE for velocity math, just
--                                       never surfaced).

DROP FUNCTION IF EXISTS ops.fn_items_master(integer, text, boolean);

CREATE FUNCTION ops.fn_items_master(
  p_lookback_days integer DEFAULT 90,
  p_search        text    DEFAULT NULL,
  p_managed_only  boolean DEFAULT false
)
RETURNS TABLE(
  qbo_item_id text, item_name text, fully_qualified_name text, active boolean,
  category_path text, category_override text, category_resolved text,
  income_account_name text, expense_account_name text,
  on_hand numeric, unit_price numeric, purchase_cost numeric,
  is_managed boolean, is_planner boolean,
  target_days_supply integer, lead_time_days integer,
  reorder_point numeric, min_order_qty numeric, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer,
  purchased_qty numeric, purchased_cost numeric,
  adjustment_qty numeric, shrinkage_qty numeric,
  daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text,
  product_type_code   text, product_type_label   text,
  segment_code text, segment_label text, segment_source text,
  track_locations boolean, has_bom boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH start_date AS (SELECT (current_date - p_lookback_days)::date AS d),
  excludes AS (SELECT qbo_customer_id FROM ops.inventory_velocity_excludes),
  sold AS (
    SELECT v.item_ref_id AS qbo_item_id,
      sum(v.quantity)::numeric AS qty, sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM start_date) AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  -- All movements over the lookback window aggregated per item.
  -- purch_qty/purch_cost from 'receipt' rows (PO receipts).
  -- adj_qty / shrink_qty from QBO inventory adjustments only — receipts
  -- aren't "adjustments" semantically and shouldn't bleed into shrink.
  purch AS (
    SELECT m.qbo_item_id,
      sum(m.qty)::numeric AS qty,
      sum(m.qty * COALESCE(m.unit_cost, 0))::numeric AS cost
    FROM ops.inventory_movements m
    WHERE m.movement_type = 'receipt'
      AND m.occurred_at >= (SELECT d FROM start_date)
      AND m.qbo_item_id IS NOT NULL
    GROUP BY 1
  ),
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(a.qty_diff)::numeric AS adjustment_qty,
      sum(CASE WHEN a.qty_diff < 0 THEN abs(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL AND a.txn_date >= (SELECT d FROM start_date)
    GROUP BY 1
  )
  SELECT
    it.qbo_item_id, COALESCE(it.name, it.fully_qualified_name), it.fully_qualified_name,
    COALESCE(it.active, true)::boolean,
    it.category_path, s.category_override,
    COALESCE(s.category_override, it.category_path, 'Uncategorized'),
    it.income_account_name, it.expense_account_name,
    COALESCE(it.qty_on_hand, 0)::numeric, it.unit_price, it.purchase_cost,
    COALESCE(s.is_managed, false), COALESCE(s.is_planner, false),
    COALESCE(s.target_days_supply, 30), COALESCE(s.lead_time_days, 7),
    s.reorder_point, s.min_order_qty, s.notes,
    COALESCE(sold.qty, 0), COALESCE(sold.revenue, 0), COALESCE(sold.customers_count, 0),
    COALESCE(purch.qty, 0)::numeric, COALESCE(purch.cost, 0)::numeric,
    COALESCE(adj.adjustment_qty, 0)::numeric, COALESCE(adj.shrink_qty, 0)::numeric,
    ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))::numeric,
    CASE WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
         THEN COALESCE(it.qty_on_hand, 0) / ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))
         ELSE NULL END,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) > 0 THEN 'idle'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) = 0 THEN 'idle'
      WHEN COALESCE(it.qty_on_hand, 0) <= 0 THEN 'critical'
      WHEN COALESCE(it.qty_on_hand, 0) <
           COALESCE(s.lead_time_days, 7) * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1) THEN 'reorder'
      ELSE 'ok'
    END,
    ipf.family_code, pf.label,
    ipt.type_code, pt.label,
    COALESCE(seg_item.segment_code, seg_cat.segment_code),
    COALESCE(s_item_seg.label, s_cat_seg.label),
    CASE
      WHEN seg_item.segment_code IS NOT NULL THEN 'item'
      WHEN seg_cat.segment_code  IS NOT NULL THEN 'category'
      ELSE NULL
    END,
    COALESCE(s.track_locations, false),
    COALESCE(s.has_bom, false)
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.account_settings acct ON acct.account_name = it.income_account_name
  LEFT JOIN sold  ON sold.qbo_item_id  = it.qbo_item_id
  LEFT JOIN purch ON purch.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj   ON adj.qbo_item_id   = it.qbo_item_id
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  LEFT JOIN ops.item_segments     seg_item ON seg_item.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.segments        s_item_seg ON s_item_seg.segment_code = seg_item.segment_code AND s_item_seg.is_active
  LEFT JOIN ops.category_segments  seg_cat ON seg_cat.category = COALESCE(s.category_override, it.category_path)
  LEFT JOIN ops.segments         s_cat_seg ON s_cat_seg.segment_code = seg_cat.segment_code AND s_cat_seg.is_active
  WHERE
    COALESCE(it.type, '') NOT IN ('Category', 'Group')
    AND (NOT p_managed_only OR COALESCE(s.is_managed, false))
    AND COALESCE(acct.is_active, true)
    AND (
      p_search IS NULL OR p_search = '' OR
      it.name ILIKE '%' || p_search || '%' OR
      it.fully_qualified_name ILIKE '%' || p_search || '%' OR
      COALESCE(s.category_override, it.category_path) ILIKE '%' || p_search || '%'
    )
  ORDER BY
    COALESCE(it.active, true) DESC,
    COALESCE(s.category_override, it.category_path) NULLS LAST,
    it.name;
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_items_master(integer, text, boolean) TO authenticated;
