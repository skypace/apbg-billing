-- v0.9.44 — fix reorder math + add on-order awareness
--
-- Three problems wrapped into one fix:
--
-- 1. STATUS LOGIC was off. The rule was
--      on_hand < lead_time * velocity  →  'reorder'
--    but that means by the time the order arrives you're at zero. An
--    item with days_of_supply ≈ lead_time stayed 'ok' until it crossed
--    the threshold by a single unit. Example caught by user:
--    24P126121 HANGAR 25 COLA CASE — on_hand 261, velocity 35/day,
--    days_of_supply 7.4, lead_time 7 → status was 'ok'. Should be
--    'reorder' (will be empty in ~7 days when the next order arrives).
--    New rule, easier to reason about:
--      days_of_supply <= lead_time      → 'reorder'      (won't make it)
--      days_of_supply <= 2 * lead_time  → 'reorder_soon' (approaching)
--      else                              → 'ok'
--
-- 2. SUGGESTED ORDER QTY was promised by the TypeScript type but never
--    actually returned by fn_items_master. The Reorder tab's
--    "Suggested Qty" column rendered "—" on every row.
--    Now computed server-side: cover (target_days_supply + lead_time)
--    of demand, less on-hand, less currently-on-order, rounded up to
--    min_order_qty, returned as suggested_order_qty.
--
-- 3. NO ON-ORDER AWARENESS. Open POs sitting in
--    ops.purchase_order_lines have qty_ordered - qty_received still
--    coming, but the reorder math ignored them — so the Suggested Qty
--    would double-count and reorder lists would keep flagging items
--    that already had a PO in flight. New column qty_on_order on
--    fn_items_master sums open PO commitments per item. The suggestion
--    math subtracts it; the UI gets a new "On Order" column to display.

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
  qty_on_order numeric, suggested_order_qty numeric, suggested_order_cycle_days numeric,
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
  ),
  -- Open PO commitments: anything not yet received on a non-void/closed
  -- PO. We deliberately count 'draft' + 'open' + 'partial' + 'received'
  -- (received but not yet closed could still revert), but exclude
  -- 'closed' and 'void'.
  on_order AS (
    SELECT l.qbo_item_id,
      sum(GREATEST(l.qty_ordered - l.qty_received, 0))::numeric AS qty_pending
    FROM ops.purchase_order_lines l
    JOIN ops.purchase_orders p ON p.id = l.po_id
    WHERE p.status IN ('draft', 'open', 'partial', 'received')
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
    COALESCE(on_order.qty_pending, 0)::numeric AS qty_on_order,
    -- Suggested order qty: cover (target_days + lead_time) of demand,
    -- less on-hand, less on-order. Round up to min_order_qty if set.
    -- NULL when item has no velocity or is inactive (no signal).
    CASE
      WHEN COALESCE(it.active, true) = false THEN NULL
      WHEN ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1)) <= 0 THEN NULL
      ELSE
        GREATEST(
          ceil(
            ((COALESCE(s.target_days_supply, 30) + COALESCE(s.lead_time_days, 7))
             * ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1)))
            - COALESCE(it.qty_on_hand, 0)
            - COALESCE(on_order.qty_pending, 0)
          ),
          COALESCE(s.min_order_qty, 0)
        )
    END AS suggested_order_qty,
    -- Suggested cycle in days = target_days_supply (how often to reorder
    -- at steady state). Echoed for UI convenience.
    COALESCE(s.target_days_supply, 30)::numeric AS suggested_order_cycle_days,
    ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))::numeric AS daily_velocity,
    CASE WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
         THEN COALESCE(it.qty_on_hand, 0) / ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))
         ELSE NULL END AS days_of_supply,
    -- New status logic based on days_of_supply vs lead_time.
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 THEN 'idle'
      WHEN COALESCE(it.qty_on_hand, 0) <= 0 THEN 'critical'
      WHEN (COALESCE(it.qty_on_hand, 0) / NULLIF((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1), 0))
           <= COALESCE(s.lead_time_days, 7) THEN 'reorder'
      WHEN (COALESCE(it.qty_on_hand, 0) / NULLIF((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1), 0))
           <= COALESCE(s.lead_time_days, 7) * 2 THEN 'reorder_soon'
      ELSE 'ok'
    END AS status,
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
  LEFT JOIN sold     ON sold.qbo_item_id     = it.qbo_item_id
  LEFT JOIN purch    ON purch.qbo_item_id    = it.qbo_item_id
  LEFT JOIN adj      ON adj.qbo_item_id      = it.qbo_item_id
  LEFT JOIN on_order ON on_order.qbo_item_id = it.qbo_item_id
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
