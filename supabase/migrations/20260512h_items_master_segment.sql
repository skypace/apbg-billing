-- v0.9.34a — Surface segment on the Items master grid + add setter RPCs.
-- Segment was auto-populated for 567/574 items in 20260512d but had no
-- editor. fn_items_master now returns segment_code + segment_label, and
-- two new RPCs let the dashboard write/bulk-write segment via the
-- existing ops.item_segments table (which keys by item_name).

-- 1. Segment list for dropdown ---------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_list_segments_for_items()
RETURNS TABLE(segment_code text, label text, sort_order int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  SELECT segment_code, label, sort_order
    FROM ops.segments
   WHERE is_active
   ORDER BY sort_order, label;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_list_segments_for_items() TO anon, authenticated;

-- 2. Per-item segment setter -----------------------------------------------
-- ops.item_segments is keyed by item_name (legacy), so we look the name
-- up from qbo_item_id. Passing NULL/'' clears the override (item falls
-- back to category_segments).
CREATE OR REPLACE FUNCTION ops.fn_set_item_segment(
  p_qbo_item_id text,
  p_segment_code text,
  p_set_by      text DEFAULT 'dashboard'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE
  v_name text;
BEGIN
  IF p_qbo_item_id IS NULL THEN RAISE EXCEPTION 'qbo_item_id required'; END IF;
  SELECT name INTO v_name FROM ops.qbo_items WHERE qbo_item_id = p_qbo_item_id;
  IF v_name IS NULL THEN RAISE EXCEPTION 'item not found'; END IF;

  IF p_segment_code IS NULL OR p_segment_code = '' THEN
    DELETE FROM ops.item_segments WHERE item_name = v_name;
    RETURN;
  END IF;

  INSERT INTO ops.item_segments AS t (item_name, segment_code, set_by, set_at)
  VALUES (v_name, p_segment_code, p_set_by, now())
  ON CONFLICT (item_name) DO UPDATE
    SET segment_code = EXCLUDED.segment_code,
        set_by       = EXCLUDED.set_by,
        set_at       = now();
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_item_segment(text, text, text) TO authenticated;

-- 3. Bulk segment setter ---------------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_bulk_set_item_segment(
  p_qbo_item_ids text[],
  p_segment_code text,
  p_set_by       text DEFAULT 'dashboard-bulk'
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_qbo_item_ids IS NULL OR cardinality(p_qbo_item_ids) = 0 THEN RETURN 0; END IF;

  IF p_segment_code IS NULL OR p_segment_code = '' THEN
    DELETE FROM ops.item_segments
     WHERE item_name IN (
       SELECT name FROM ops.qbo_items WHERE qbo_item_id = ANY(p_qbo_item_ids)
     );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END IF;

  INSERT INTO ops.item_segments AS t (item_name, segment_code, set_by, set_at)
  SELECT it.name, p_segment_code, p_set_by, now()
    FROM ops.qbo_items it
   WHERE it.qbo_item_id = ANY(p_qbo_item_ids) AND it.name IS NOT NULL
  ON CONFLICT (item_name) DO UPDATE
    SET segment_code = EXCLUDED.segment_code,
        set_by       = EXCLUDED.set_by,
        set_at       = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_bulk_set_item_segment(text[], text, text) TO authenticated;

-- 4. fn_items_master — append segment_code + segment_label ----------------
-- Effective segment = item override (item_segments) if set, else
-- category fallback (category_segments).
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
  daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text,
  product_type_code   text, product_type_label   text,
  segment_code text, segment_label text, segment_source text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH start_date AS (SELECT (current_date - p_lookback_days)::date AS d),
  excludes AS (SELECT qbo_customer_id FROM ops.inventory_velocity_excludes),
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
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(CASE WHEN a.qty_diff < 0 THEN ABS(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL
      AND a.txn_date >= (SELECT d FROM start_date)
    GROUP BY 1
  )
  SELECT
    it.qbo_item_id,
    COALESCE(it.name, it.fully_qualified_name),
    it.fully_qualified_name,
    COALESCE(it.active, true)::boolean,
    it.category_path,
    s.category_override,
    COALESCE(s.category_override, it.category_path, 'Uncategorized'),
    it.income_account_name,
    it.expense_account_name,
    COALESCE(it.qty_on_hand, 0)::numeric,
    it.unit_price,
    it.purchase_cost,
    COALESCE(s.is_managed, false),
    COALESCE(s.is_planner, false),
    COALESCE(s.target_days_supply, 30),
    COALESCE(s.lead_time_days, 7),
    s.reorder_point,
    s.min_order_qty,
    s.notes,
    COALESCE(sold.qty, 0),
    COALESCE(sold.revenue, 0),
    COALESCE(sold.customers_count, 0),
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
    ipf.family_code,
    pf.label,
    ipt.type_code,
    pt.label,
    COALESCE(seg_item.segment_code, seg_cat.segment_code)        AS segment_code,
    COALESCE(s_item_seg.label,       s_cat_seg.label)            AS segment_label,
    CASE
      WHEN seg_item.segment_code IS NOT NULL THEN 'item'
      WHEN seg_cat.segment_code  IS NOT NULL THEN 'category'
      ELSE NULL
    END                                                          AS segment_source
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj  ON adj.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  LEFT JOIN ops.item_segments     seg_item ON seg_item.item_name = it.name
  LEFT JOIN ops.segments        s_item_seg ON s_item_seg.segment_code = seg_item.segment_code AND s_item_seg.is_active
  LEFT JOIN ops.category_segments  seg_cat ON seg_cat.category = COALESCE(s.category_override, it.category_path)
  LEFT JOIN ops.segments         s_cat_seg ON s_cat_seg.segment_code  = seg_cat.segment_code  AND s_cat_seg.is_active
  WHERE
    (NOT p_managed_only OR COALESCE(s.is_managed, false))
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
