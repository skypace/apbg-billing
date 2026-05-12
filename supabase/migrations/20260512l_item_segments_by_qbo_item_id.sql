-- v0.9.35c — Rekey ops.item_segments from item_name to qbo_item_id.
--
-- Legacy schema (20260502e) keyed by item_name, which means:
--   (a) renaming an item in QBO silently detaches the segment override
--   (b) items with duplicate names can't each have their own override
--   (c) inconsistent with item_product_families / item_product_types
--       (keyed by qbo_item_id since 20260512d)
--
-- This migration creates the new table, expands 1:N where multiple items
-- shared a name, swaps it into place, and recreates v_sales_lines plus
-- fn_items_master / fn_set_item_segment / fn_bulk_set_item_segment to
-- use qbo_item_id joins. Old table is preserved as item_segments_legacy
-- for one release in case rollback is needed; safe to drop later.

-- 1. Move old table out of the way (preserve as backup)
ALTER TABLE IF EXISTS ops.item_segments RENAME TO item_segments_legacy;

-- 2. Drop dependent functions that reference the old structure
DROP FUNCTION IF EXISTS ops.fn_items_master(integer, text, boolean);
DROP FUNCTION IF EXISTS ops.fn_set_item_segment(text, text, text);
DROP FUNCTION IF EXISTS ops.fn_bulk_set_item_segment(text[], text, text);

-- 3. New table, qbo_item_id PK
CREATE TABLE ops.item_segments (
  qbo_item_id  text PRIMARY KEY REFERENCES ops.qbo_items(qbo_item_id) ON DELETE CASCADE,
  item_name    text,    -- denormalized for diagnostics; not a join key
  segment_code text NOT NULL REFERENCES ops.segments(segment_code) ON DELETE RESTRICT,
  notes        text,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_segments_segment ON ops.item_segments(segment_code);

ALTER TABLE ops.item_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_segments_read  ON ops.item_segments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY item_segments_write ON ops.item_segments FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.item_segments TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.item_segments TO authenticated;

-- 4. Backfill — expand 1:N where multiple items shared a name
INSERT INTO ops.item_segments (qbo_item_id, item_name, segment_code, notes, set_by, set_at)
SELECT it.qbo_item_id, it.name, s.segment_code, s.notes, s.set_by, s.set_at
FROM ops.item_segments_legacy s
JOIN ops.qbo_items it ON it.name = s.item_name
ON CONFLICT (qbo_item_id) DO NOTHING;

-- 5. v_sales_lines — switch the segment join to qbo_item_id
CREATE OR REPLACE VIEW ops.v_sales_lines AS
WITH effective AS (
  SELECT l.id, l.invoice_id, l.item_ref_id, l.item_name, l.revenue_line,
         l.account_name, l.description, l.quantity, l.unit_price, l.amount,
         l.department,
         it.purchase_cost                            AS static_unit_cost,
         ac.avg_unit_cost                            AS actual_unit_cost,
         COALESCE(ac.avg_unit_cost, it.purchase_cost) AS effective_unit_cost,
         CASE
           WHEN ac.avg_unit_cost  IS NOT NULL THEN 'actual'
           WHEN it.purchase_cost  IS NOT NULL THEN 'static'
           ELSE 'none'
         END                                          AS cost_source,
         it.type                                      AS item_type,
         it.income_account_name,
         it.expense_account_name
  FROM ops.qbo_invoice_lines l
    LEFT JOIN ops.qbo_items           it ON it.qbo_item_id  = l.item_ref_id
    LEFT JOIN ops.v_item_actual_cost  ac ON ac.item_ref_id  = l.item_ref_id
)
SELECT e.id                                           AS line_id,
       e.invoice_id,
       i.qbo_invoice_id,
       i.doc_number,
       i.txn_date,
       date_trunc('month', i.txn_date::timestamptz)::date AS txn_month,
       EXTRACT(year FROM i.txn_date)::integer            AS txn_year,
       i.customer_ref_id,
       i.customer_name,
       i.entity,
       i.department                                   AS invoice_department,
       e.department                                   AS line_department,
       e.item_ref_id,
       e.item_name,
       e.revenue_line                                 AS category,
       COALESCE(s_item.label, s_cat.label)            AS segment,
       e.account_name,
       e.description,
       e.quantity,
       e.unit_price,
       e.amount                                       AS revenue,
       e.static_unit_cost                             AS purchase_cost,
       e.actual_unit_cost,
       e.effective_unit_cost,
       e.cost_source,
       e.item_type,
       e.income_account_name,
       e.expense_account_name,
       CASE WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
            THEN e.effective_unit_cost * e.quantity END AS est_cost,
       CASE WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
            THEN e.amount - e.effective_unit_cost * e.quantity END AS est_margin,
       COALESCE(lc.channels, ARRAY[]::text[])         AS channels,
       lc.primary_channel,
       ARRAY[]::text[]                                AS sales_reps,
       pf.label                                       AS product_family,
       pt.label                                       AS product_type
FROM effective e
  JOIN      ops.qbo_invoices    i      ON i.id              = e.invoice_id
  LEFT JOIN ops.item_segments   is_map ON is_map.qbo_item_id = e.item_ref_id
  LEFT JOIN ops.segments        s_item ON s_item.segment_code = is_map.segment_code AND s_item.is_active
  LEFT JOIN ops.category_segments cs   ON cs.category       = e.revenue_line
  LEFT JOIN ops.segments        s_cat  ON s_cat.segment_code = cs.segment_code AND s_cat.is_active
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = e.item_ref_id
  LEFT JOIN ops.product_families       pf  ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = e.item_ref_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code     = ipt.type_code  AND pt.is_active
  LEFT JOIN LATERAL (
    SELECT array_agg(c.label ORDER BY c.sort_order) AS channels,
           max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
    FROM ops.customer_channels cc
      JOIN ops.channels c ON c.channel_code = cc.channel_code
    WHERE cc.qbo_customer_id = i.customer_ref_id
      AND c.is_active
  ) lc ON true;
GRANT SELECT ON ops.v_sales_lines TO anon, authenticated;

-- 6. fn_set_item_segment — write qbo_item_id directly (no name lookup needed)
CREATE FUNCTION ops.fn_set_item_segment(
  p_qbo_item_id  text,
  p_segment_code text,
  p_set_by       text DEFAULT 'dashboard'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE v_name text;
BEGIN
  IF p_qbo_item_id IS NULL THEN RAISE EXCEPTION 'qbo_item_id required'; END IF;
  SELECT name INTO v_name FROM ops.qbo_items WHERE qbo_item_id = p_qbo_item_id;

  IF p_segment_code IS NULL OR p_segment_code = '' THEN
    DELETE FROM ops.item_segments WHERE qbo_item_id = p_qbo_item_id;
    RETURN;
  END IF;

  INSERT INTO ops.item_segments AS t (qbo_item_id, item_name, segment_code, set_by, set_at)
  VALUES (p_qbo_item_id, v_name, p_segment_code, p_set_by, now())
  ON CONFLICT (qbo_item_id) DO UPDATE
    SET segment_code = EXCLUDED.segment_code,
        item_name    = EXCLUDED.item_name,
        set_by       = EXCLUDED.set_by,
        set_at       = now();
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_item_segment(text, text, text) TO authenticated;

CREATE FUNCTION ops.fn_bulk_set_item_segment(
  p_qbo_item_ids text[],
  p_segment_code text,
  p_set_by       text DEFAULT 'dashboard-bulk'
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE v_count integer;
BEGIN
  IF p_qbo_item_ids IS NULL OR cardinality(p_qbo_item_ids) = 0 THEN RETURN 0; END IF;

  IF p_segment_code IS NULL OR p_segment_code = '' THEN
    DELETE FROM ops.item_segments WHERE qbo_item_id = ANY(p_qbo_item_ids);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END IF;

  INSERT INTO ops.item_segments AS t (qbo_item_id, item_name, segment_code, set_by, set_at)
  SELECT it.qbo_item_id, it.name, p_segment_code, p_set_by, now()
    FROM ops.qbo_items it
   WHERE it.qbo_item_id = ANY(p_qbo_item_ids)
  ON CONFLICT (qbo_item_id) DO UPDATE
    SET segment_code = EXCLUDED.segment_code,
        item_name    = EXCLUDED.item_name,
        set_by       = EXCLUDED.set_by,
        set_at       = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_bulk_set_item_segment(text[], text, text) TO authenticated;

-- 7. fn_items_master — switch segment join to qbo_item_id, keep all other columns identical
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
      sum(v.quantity)::numeric AS qty, sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM start_date) AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
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
    END
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.account_settings acct ON acct.account_name = it.income_account_name
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj  ON adj.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  LEFT JOIN ops.item_segments     seg_item ON seg_item.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.segments        s_item_seg ON s_item_seg.segment_code = seg_item.segment_code AND s_item_seg.is_active
  LEFT JOIN ops.category_segments  seg_cat ON seg_cat.category = COALESCE(s.category_override, it.category_path)
  LEFT JOIN ops.segments         s_cat_seg ON s_cat_seg.segment_code = seg_cat.segment_code AND s_cat_seg.is_active
  WHERE
    (NOT p_managed_only OR COALESCE(s.is_managed, false))
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
