-- Include inactive items in fn_inventory_health (so the UI can show
-- them under an Inactive group) and surface the active flag so the
-- frontend can render the Active / Inactive sections.

DROP FUNCTION IF EXISTS ops.fn_inventory_health(integer, boolean);

CREATE OR REPLACE FUNCTION ops.fn_inventory_health(
  p_lookback_days integer DEFAULT 90,
  p_managed_only  boolean DEFAULT false
)
RETURNS TABLE(
  qbo_item_id text, item_name text, category_path text, income_account_name text,
  active boolean,
  on_hand numeric, unit_price numeric, static_purchase_cost numeric,
  is_managed boolean, target_days_supply integer, lead_time_days integer, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer,
  purchased_qty numeric, purchased_cost numeric,
  adjustment_qty numeric, shrinkage_qty numeric,
  daily_velocity numeric, days_of_supply numeric,
  reorder_point numeric, suggested_order_qty numeric, suggested_order_cycle_days numeric,
  status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $function$
  WITH excludes AS (
    SELECT qbo_customer_id FROM ops.inventory_velocity_excludes
  ),
  start_date AS (SELECT (current_date - p_lookback_days)::date AS d),
  sold AS (
    SELECT v.item_ref_id AS qbo_item_id,
      sum(v.quantity)::numeric AS qty,
      sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM start_date)
      AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL
      AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  purchased AS (
    SELECT el.item_ref_id AS qbo_item_id,
      sum(el.quantity)::numeric AS qty,
      sum(el.amount)::numeric AS cost
    FROM ops.qbo_expense_lines el
    WHERE el.detail_type = 'ItemBasedExpenseLineDetail'
      AND el.item_ref_id IS NOT NULL
      AND el.txn_date >= (SELECT d FROM start_date)
      AND el.quantity IS NOT NULL AND el.quantity > 0
    GROUP BY 1
  ),
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(a.qty_diff)::numeric AS net_qty,
      sum(CASE WHEN a.qty_diff < 0 THEN ABS(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL
      AND a.txn_date >= (SELECT d FROM start_date)
    GROUP BY 1
  )
  SELECT
    it.qbo_item_id,
    COALESCE(it.fully_qualified_name, it.name),
    it.category_path,
    it.income_account_name,
    COALESCE(it.active, true)::boolean AS active,
    COALESCE(it.qty_on_hand, 0)::numeric,
    it.unit_price,
    it.purchase_cost,
    COALESCE(s.is_managed, false),
    COALESCE(s.target_days_supply, 30),
    COALESCE(s.lead_time_days, 7),
    s.notes,
    COALESCE(sold.qty, 0),
    COALESCE(sold.revenue, 0),
    COALESCE(sold.customers_count, 0),
    COALESCE(purchased.qty, 0),
    COALESCE(purchased.cost, 0),
    COALESCE(adj.net_qty, 0),
    COALESCE(adj.shrink_qty, 0),
    ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))::numeric,
    CASE WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
         THEN COALESCE(it.qty_on_hand, 0) / ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))
         ELSE NULL END,
    COALESCE(s.reorder_point,
             COALESCE(s.lead_time_days, 7) * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1)),
    GREATEST(0,
      COALESCE(s.target_days_supply, 30) * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1)
      - COALESCE(it.qty_on_hand, 0)
    ),
    CASE WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
         THEN GREATEST(1, COALESCE(s.target_days_supply, 30) - COALESCE(s.lead_time_days, 7))
         ELSE NULL END,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) > 0 THEN 'idle'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) = 0 THEN 'idle'
      WHEN COALESCE(it.qty_on_hand, 0) <= 0 THEN 'critical'
      WHEN COALESCE(it.qty_on_hand, 0) <
           COALESCE(s.lead_time_days, 7) * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1) THEN 'reorder'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
           AND COALESCE(it.qty_on_hand, 0) >
               COALESCE(s.target_days_supply, 30) * 2 * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1)
           THEN 'overstock'
      ELSE 'ok'
    END
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN purchased ON purchased.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj ON adj.qbo_item_id = it.qbo_item_id
  WHERE (NOT p_managed_only OR COALESCE(s.is_managed, false))
  ORDER BY
    COALESCE(it.active, true) DESC,
    it.category_path NULLS LAST,
    CASE
      WHEN COALESCE(it.qty_on_hand, 0) <= 0 AND (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0 THEN 0
      WHEN COALESCE(it.qty_on_hand, 0) <
           COALESCE(s.lead_time_days, 7) * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1) THEN 1
      ELSE 2
    END,
    sold.revenue DESC NULLS LAST;
$function$;

GRANT EXECUTE ON FUNCTION ops.fn_inventory_health(integer, boolean) TO authenticated;
