-- v0.9.45 — inventory lanes + Refractor-side planning quantities
--
-- APBG's daily inventory scope is intentionally narrow:
--   1. BIB Product: 3G and 5G only
--   2. Cans 24pks: 24-pack cans only
--
-- QuickBooks remains the accounting / item identity source. Refractor owns
-- operational lane classification, multi-location on-hand, and planning math.

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS inventory_lane TEXT NOT NULL DEFAULT 'excluded'
    CHECK (inventory_lane IN ('bib_product', 'cans_24pk', 'excluded'));

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS inventory_lane_size TEXT
    CHECK (inventory_lane_size IN ('3g', '5g', '24pk') OR inventory_lane_size IS NULL);

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS inventory_lane_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (inventory_lane_source IN ('auto', 'manual'));

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS inventory_lane_reviewed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS default_receiving_location_id UUID
    REFERENCES ops.inventory_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inventory_settings_lane_idx
  ON ops.inventory_settings (inventory_lane, inventory_lane_size, inventory_lane_reviewed);

CREATE INDEX IF NOT EXISTS inventory_settings_default_receiving_location_idx
  ON ops.inventory_settings (default_receiving_location_id)
  WHERE default_receiving_location_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ops.fn_set_inventory_lane(
  p_qbo_item_id TEXT,
  p_inventory_lane TEXT,
  p_inventory_lane_size TEXT DEFAULT NULL,
  p_default_receiving_location_id UUID DEFAULT NULL,
  p_inventory_lane_reviewed BOOLEAN DEFAULT TRUE
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ops, public
AS $func$
BEGIN
  IF p_inventory_lane NOT IN ('bib_product', 'cans_24pk', 'excluded') THEN
    RAISE EXCEPTION 'invalid inventory lane: %', p_inventory_lane;
  END IF;

  IF p_inventory_lane = 'bib_product' AND p_inventory_lane_size NOT IN ('3g', '5g') THEN
    RAISE EXCEPTION 'BIB Product lane requires inventory_lane_size 3g or 5g';
  END IF;

  IF p_inventory_lane = 'cans_24pk' AND p_inventory_lane_size <> '24pk' THEN
    RAISE EXCEPTION 'Cans 24pks lane requires inventory_lane_size 24pk';
  END IF;

  IF p_inventory_lane = 'excluded' THEN
    p_inventory_lane_size := NULL;
  END IF;

  INSERT INTO ops.inventory_settings (
    qbo_item_id,
    inventory_lane,
    inventory_lane_size,
    inventory_lane_source,
    inventory_lane_reviewed,
    default_receiving_location_id,
    updated_at
  )
  VALUES (
    p_qbo_item_id,
    p_inventory_lane,
    p_inventory_lane_size,
    'manual',
    COALESCE(p_inventory_lane_reviewed, TRUE),
    p_default_receiving_location_id,
    now()
  )
  ON CONFLICT (qbo_item_id) DO UPDATE SET
    inventory_lane = EXCLUDED.inventory_lane,
    inventory_lane_size = EXCLUDED.inventory_lane_size,
    inventory_lane_source = 'manual',
    inventory_lane_reviewed = EXCLUDED.inventory_lane_reviewed,
    default_receiving_location_id = EXCLUDED.default_receiving_location_id,
    is_managed = CASE
      WHEN EXCLUDED.inventory_lane <> 'excluded' THEN TRUE
      ELSE ops.inventory_settings.is_managed
    END,
    track_locations = CASE
      WHEN EXCLUDED.inventory_lane <> 'excluded' THEN TRUE
      ELSE ops.inventory_settings.track_locations
    END,
    has_bom = CASE
      WHEN EXCLUDED.inventory_lane = 'cans_24pk' THEN TRUE
      WHEN EXCLUDED.inventory_lane = 'bib_product' THEN FALSE
      ELSE ops.inventory_settings.has_bom
    END,
    updated_at = now();
END;
$func$;

GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_lane(TEXT, TEXT, TEXT, UUID, BOOLEAN) TO authenticated;

-- Seed an auto-classification pass. Manual reviewed rows are left alone.
WITH classified AS (
  SELECT
    it.qbo_item_id,
    lower(
      concat_ws(' ',
        it.name,
        it.fully_qualified_name,
        it.category_path,
        it.income_account_name,
        ipf.family_code,
        ipt.type_code
      )
    ) AS haystack,
    ipf.family_code
  FROM ops.qbo_items it
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_types ipt ON ipt.qbo_item_id = it.qbo_item_id
  WHERE COALESCE(it.type, '') NOT IN ('Category', 'Group')
),
lanes AS (
  SELECT
    qbo_item_id,
    CASE
      WHEN family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])3[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])3g(ns?)?[0-9]'
        THEN 'bib_product'
      WHEN family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])5[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])5g(ns?)?[0-9]'
        THEN 'bib_product'
      WHEN family_code = 'can'
       AND haystack ~ '(^|[^a-z0-9])24[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)|(^|[^a-z0-9])24p(k)?[0-9]'
       AND haystack !~ '(^|[^a-z0-9])(6|12)[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)'
        THEN 'cans_24pk'
      ELSE 'excluded'
    END AS inventory_lane,
    CASE
      WHEN family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])3[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])3g(ns?)?[0-9]'
        THEN '3g'
      WHEN family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])5[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])5g(ns?)?[0-9]'
        THEN '5g'
      WHEN family_code = 'can'
       AND haystack ~ '(^|[^a-z0-9])24[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)|(^|[^a-z0-9])24p(k)?[0-9]'
       AND haystack !~ '(^|[^a-z0-9])(6|12)[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)'
        THEN '24pk'
      ELSE NULL
    END AS inventory_lane_size
  FROM classified
)
INSERT INTO ops.inventory_settings (
  qbo_item_id,
  inventory_lane,
  inventory_lane_size,
  inventory_lane_source,
  inventory_lane_reviewed,
  is_managed,
  is_planner,
  target_days_supply,
  lead_time_days,
  track_locations,
  has_bom,
  updated_at
)
SELECT
  qbo_item_id,
  inventory_lane,
  inventory_lane_size,
  'auto',
  FALSE,
  inventory_lane <> 'excluded',
  FALSE,
  30,
  7,
  inventory_lane <> 'excluded',
  inventory_lane = 'cans_24pk',
  now()
FROM lanes
ON CONFLICT (qbo_item_id) DO UPDATE SET
  inventory_lane = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane
    ELSE EXCLUDED.inventory_lane
  END,
  inventory_lane_size = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane_size
    ELSE EXCLUDED.inventory_lane_size
  END,
  inventory_lane_source = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane_source
    ELSE 'auto'
  END,
  inventory_lane_reviewed = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane_reviewed
    ELSE FALSE
  END,
  is_managed = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.is_managed
    WHEN EXCLUDED.inventory_lane <> 'excluded' THEN TRUE
    ELSE ops.inventory_settings.is_managed
  END,
  track_locations = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.track_locations
    WHEN EXCLUDED.inventory_lane <> 'excluded' THEN TRUE
    ELSE ops.inventory_settings.track_locations
  END,
  has_bom = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.has_bom
    WHEN EXCLUDED.inventory_lane = 'cans_24pk' THEN TRUE
    ELSE ops.inventory_settings.has_bom
  END,
  updated_at = now();

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
  track_locations boolean, has_bom boolean,
  inventory_lane text, inventory_lane_size text, inventory_lane_source text,
  inventory_lane_reviewed boolean, default_receiving_location_id uuid,
  qbo_on_hand numeric, brix_on_hand numeric, planning_on_hand numeric, on_hand_drift numeric
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
  brix_stock AS (
    SELECT oh.qbo_item_id, sum(oh.on_hand)::numeric AS qty
    FROM ops.v_inventory_on_hand oh
    JOIN ops.inventory_locations loc ON loc.id = oh.location_id
    WHERE loc.kind <> 'adjustment'
    GROUP BY 1
  ),
  brix_on_order AS (
    SELECT l.qbo_item_id,
      sum(GREATEST(l.qty_ordered - l.qty_received, 0))::numeric AS qty_pending
    FROM ops.purchase_order_lines l
    JOIN ops.purchase_orders p ON p.id = l.po_id
    WHERE p.status IN ('draft', 'open', 'partial', 'received')
    GROUP BY 1
  ),
  qbo_direct_on_order AS (
    SELECT l.qbo_item_id,
      sum(COALESCE(l.qty, 0))::numeric AS qty_pending
    FROM ops.qbo_purchase_order_lines l
    JOIN ops.qbo_purchase_orders p ON p.qbo_id = l.qbo_po_id
    LEFT JOIN ops.purchase_orders brix
      ON brix.qbo_purchase_order_id = p.qbo_id
    WHERE l.qbo_item_id IS NOT NULL
      AND lower(COALESCE(p.po_status, '')) IN ('open')
      AND brix.id IS NULL
    GROUP BY 1
  ),
  on_order AS (
    SELECT qbo_item_id, sum(qty_pending)::numeric AS qty_pending
    FROM (
      SELECT qbo_item_id, qty_pending FROM brix_on_order
      UNION ALL
      SELECT qbo_item_id, qty_pending FROM qbo_direct_on_order
    ) x
    GROUP BY 1
  ),
  base AS (
    SELECT
      it.*,
      s.category_override,
      COALESCE(s.is_managed, false) AS is_managed_resolved,
      COALESCE(s.is_planner, false) AS is_planner_resolved,
      COALESCE(s.target_days_supply, 30) AS target_days_supply_resolved,
      COALESCE(s.lead_time_days, 7) AS lead_time_days_resolved,
      s.reorder_point,
      s.min_order_qty,
      s.notes,
      COALESCE(s.track_locations, false) AS track_locations_resolved,
      COALESCE(s.has_bom, false) AS has_bom_resolved,
      COALESCE(s.inventory_lane, 'excluded') AS inventory_lane_resolved,
      s.inventory_lane_size,
      COALESCE(s.inventory_lane_source, 'auto') AS inventory_lane_source_resolved,
      COALESCE(s.inventory_lane_reviewed, false) AS inventory_lane_reviewed_resolved,
      s.default_receiving_location_id,
      COALESCE(it.qty_on_hand, 0)::numeric AS qbo_on_hand,
      COALESCE(brix_stock.qty, 0)::numeric AS brix_on_hand,
      CASE
        WHEN COALESCE(s.track_locations, false) THEN COALESCE(brix_stock.qty, 0)::numeric
        ELSE COALESCE(it.qty_on_hand, 0)::numeric
      END AS planning_on_hand
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
    LEFT JOIN brix_stock ON brix_stock.qbo_item_id = it.qbo_item_id
  )
  SELECT
    it.qbo_item_id, COALESCE(it.name, it.fully_qualified_name), it.fully_qualified_name,
    COALESCE(it.active, true)::boolean,
    it.category_path, it.category_override,
    COALESCE(it.category_override, it.category_path, 'Uncategorized'),
    it.income_account_name, it.expense_account_name,
    it.planning_on_hand, it.unit_price, it.purchase_cost,
    it.is_managed_resolved, it.is_planner_resolved,
    it.target_days_supply_resolved, it.lead_time_days_resolved,
    it.reorder_point, it.min_order_qty, it.notes,
    COALESCE(sold.qty, 0), COALESCE(sold.revenue, 0), COALESCE(sold.customers_count, 0),
    COALESCE(purch.qty, 0)::numeric, COALESCE(purch.cost, 0)::numeric,
    COALESCE(adj.adjustment_qty, 0)::numeric, COALESCE(adj.shrink_qty, 0)::numeric,
    COALESCE(on_order.qty_pending, 0)::numeric AS qty_on_order,
    CASE
      WHEN COALESCE(it.active, true) = false THEN NULL
      WHEN ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1)) <= 0 THEN NULL
      ELSE
        GREATEST(
          ceil(
            ((it.target_days_supply_resolved + it.lead_time_days_resolved)
             * ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1)))
            - it.planning_on_hand
            - COALESCE(on_order.qty_pending, 0)
          ),
          COALESCE(it.min_order_qty, 0)
        )
    END AS suggested_order_qty,
    it.target_days_supply_resolved::numeric AS suggested_order_cycle_days,
    ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))::numeric AS daily_velocity,
    CASE WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
         THEN it.planning_on_hand / ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))
         ELSE NULL END AS days_of_supply,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 THEN 'idle'
      WHEN it.planning_on_hand <= 0 THEN 'critical'
      WHEN (it.planning_on_hand / NULLIF((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1), 0))
           <= it.lead_time_days_resolved THEN 'reorder'
      WHEN (it.planning_on_hand / NULLIF((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1), 0))
           <= it.lead_time_days_resolved * 2 THEN 'reorder_soon'
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
    it.track_locations_resolved,
    it.has_bom_resolved,
    it.inventory_lane_resolved,
    it.inventory_lane_size,
    it.inventory_lane_source_resolved,
    it.inventory_lane_reviewed_resolved,
    it.default_receiving_location_id,
    it.qbo_on_hand,
    it.brix_on_hand,
    it.planning_on_hand,
    it.brix_on_hand - it.qbo_on_hand AS on_hand_drift
  FROM base it
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
  LEFT JOIN ops.category_segments  seg_cat ON seg_cat.category = COALESCE(it.category_override, it.category_path)
  LEFT JOIN ops.segments         s_cat_seg ON s_cat_seg.segment_code = seg_cat.segment_code AND s_cat_seg.is_active
  WHERE
    COALESCE(it.type, '') NOT IN ('Category', 'Group')
    AND (NOT p_managed_only OR it.is_managed_resolved)
    AND COALESCE(acct.is_active, true)
    AND (
      p_search IS NULL OR p_search = '' OR
      it.name ILIKE '%' || p_search || '%' OR
      it.fully_qualified_name ILIKE '%' || p_search || '%' OR
      COALESCE(it.category_override, it.category_path) ILIKE '%' || p_search || '%'
    )
  ORDER BY
    COALESCE(it.active, true) DESC,
    COALESCE(it.category_override, it.category_path) NULLS LAST,
    it.name;
$function$;

GRANT EXECUTE ON FUNCTION ops.fn_items_master(integer, text, boolean) TO authenticated;
