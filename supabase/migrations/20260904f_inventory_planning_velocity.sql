-- 20260904f — Inventory Planning: the velocity was counting phantom shrinkage.
--
-- ASK (Sky, 2026-09-04): "does the inventory planning tool really work? it
-- needs to be very very smart. for instance i think we have about 19 days left
-- of rootbeer, can you check the coding to see if its working."
--
-- IT WAS NOT, and the reason was a data bug, not a maths bug:
--   ops.qbo_inventory_adjustment_lines held 125,694 rows for 1,138 real lines.
--   QuickBooks does not put a LineNum on InventoryAdjustment lines, so the
--   nightly sync wrote line_num = NULL and its upsert key (qbo_txn_id, line_num)
--   never fired — NULLs are distinct in a unique index — so every night since
--   2026-05-03 INSERTED every line again. fn_items_master summed those rows as
--   "shrinkage" demand: in the last 90 days it counted 24,770 units lost against
--   a true 743. Root beer cases (574) read 39.5 units/day and 5 days of supply;
--   the truth is ~7.8/day and ~28 days. The "19 days" on Sky's screen was the
--   30-day lookback's version of the same inflation (12.8/day vs a true 7.2).
--
-- THIS MIGRATION:
--   1. Deduplicates the adjustment lines (one row per adjustment × item × diff ×
--      description × date, lowest id kept). The edge function is redeployed as
--      v15 alongside: a real line_num, and each adjustment's lines rewritten on
--      every run so this cannot stack again.
--   2. Rebuilds fn_items_master (drop + create, the wrapper re-minted with the
--      same fn_assert_internal guard — the return shape gains columns):
--      • DEMAND = sales (v_sales_lines) + ledger-recorded consumption that is
--        not a sale: production runs eating materials (production_consume) and
--        repacks turning cases into packs (source_doc_type='repack' into the
--        Adjustment Counter). QuickBooks inventory ADJUSTMENTS are no longer
--        demand — a count correction is not something to reorder for. They stay
--        visible as adjustment_qty / shrinkage_qty.
--      • VELOCITY is recency-weighted: 60% of the trailing-28-day rate + 40% of
--        the lookback rate (when the lookback is longer than 28 days), so a
--        flavour that is slowing or picking up is read as such within a month
--        instead of a quarter. velocity_28d and velocity_trend_pct are exposed
--        so the blend can be checked on screen.
--      • SELLABLE vs INBOUND: planning_on_hand is what can ship today
--        (warehouses + consignment partners); stock at a co-packer or in transit
--        is qty_inbound together with open PO lines. days_of_supply is on the
--        sellable figure; days_of_cover adds the inbound. Status and the
--        suggested order use cover, so a PO already raised stops the alarm.
--      • The shadow-table CTE (ops.qbo_purchase_orders) is gone: QuickBooks POs
--        are real rows in ops.purchase_orders since 20260904d, and the one
--        shadow row (AC04282026, April) was still counting 140 BIBs as inbound.
--      • overstock is a real status now (> 3 × (target + lead) days of supply).
--
-- ⚠ Lead time still defaults to 7 days (inventory_settings.lead_time_days).
-- A co-packed 24-pack case has a production cycle of weeks, not a week, so
-- "reorder" fires late on those until the lead time is set per item — that is
-- a settings entry, not a formula, and it is flagged rather than guessed.

-- 1 ── dedupe the adjustment lines --------------------------------------------
-- ⚠ Applied live as TWO steps: the dedupe below through execute_sql (a
-- self-join DELETE over 125k rows with ~110 copies per line ran past the MCP's
-- 60-second window and was cancelled — the group-by form finishes in seconds),
-- then the function rebuild through apply_migration.
create temp table _adj_keep as
  select min(id) as id from ops.qbo_inventory_adjustment_lines
  group by qbo_txn_id, item_ref_id, qty_diff, coalesce(description, ''), txn_date;
create index on _adj_keep (id);
delete from ops.qbo_inventory_adjustment_lines a where not exists (select 1 from _adj_keep k where k.id = a.id);
drop table _adj_keep;

-- 2 ── fn_items_master: drop wrapper + inner (return shape changes) -------------
drop function if exists ops.fn_items_master(integer, text, boolean);
drop function if exists ops.fn_items_master__i(integer, text, boolean);

create function ops.fn_items_master__i(p_lookback_days integer default 90, p_search text default null, p_managed_only boolean default false)
returns table(
  qbo_item_id text, item_name text, fully_qualified_name text, active boolean, category_path text, category_override text, category_resolved text,
  income_account_name text, expense_account_name text, on_hand numeric, unit_price numeric, purchase_cost numeric, is_managed boolean, is_planner boolean,
  target_days_supply integer, lead_time_days integer, reorder_point numeric, min_order_qty numeric, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer, purchased_qty numeric, purchased_cost numeric, adjustment_qty numeric, shrinkage_qty numeric,
  qty_on_order numeric, suggested_order_qty numeric, suggested_order_cycle_days numeric, daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text, product_type_code text, product_type_label text, segment_code text, segment_label text, segment_source text,
  track_locations boolean, has_bom boolean, inventory_lane text, inventory_lane_size text, inventory_lane_source text, inventory_lane_reviewed boolean,
  default_receiving_location_id uuid, qbo_on_hand numeric, brix_on_hand numeric, planning_on_hand numeric, on_hand_drift numeric,
  -- 20260904f
  velocity_28d numeric, velocity_lookback numeric, velocity_trend_pct numeric, consumed_qty numeric, qty_inbound numeric, days_of_cover numeric
)
language sql stable security definer
set search_path to 'ops', 'public'
as $$
  WITH params AS (
    SELECT (current_date - GREATEST(p_lookback_days, 1))::date AS d,
           (current_date - LEAST(GREATEST(p_lookback_days, 1), 28))::date AS d28,
           GREATEST(p_lookback_days, 1)::numeric AS lb,
           LEAST(GREATEST(p_lookback_days, 1), 28)::numeric AS lb28
  ),
  excludes AS (SELECT qbo_customer_id FROM ops.inventory_velocity_excludes),
  sold AS (
    SELECT v.item_ref_id AS qbo_item_id,
      sum(v.quantity)::numeric AS qty,
      sum(v.quantity) FILTER (WHERE v.txn_date >= (SELECT d28 FROM params))::numeric AS qty28,
      sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM params) AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  -- Consumption the ledger records that is not a sale: a production run eating
  -- its materials, a repack turning cases into packs. Both are real demand on
  -- the item consumed. Sales-feed shipments are NOT here — they are the sales.
  consumed AS (
    SELECT m.qbo_item_id,
      sum(m.qty)::numeric AS qty,
      sum(m.qty) FILTER (WHERE m.occurred_at >= (SELECT d28 FROM params))::numeric AS qty28
    FROM ops.inventory_movements m
    LEFT JOIN ops.inventory_locations tl ON tl.id = m.to_location_id
    WHERE m.occurred_at >= (SELECT d FROM params)
      AND m.qbo_item_id IS NOT NULL
      AND (
        m.movement_type = 'production_consume'
        OR (m.source_doc_type = 'repack' AND m.movement_type = 'adjustment' AND m.from_location_id IS NOT NULL AND tl.kind = 'adjustment')
      )
    GROUP BY 1
  ),
  purch AS (
    SELECT m.qbo_item_id,
      sum(m.qty)::numeric AS qty,
      sum(m.qty * COALESCE(m.unit_cost, 0))::numeric AS cost
    FROM ops.inventory_movements m
    WHERE m.movement_type = 'receipt'
      AND m.occurred_at >= (SELECT d FROM params)
      AND m.qbo_item_id IS NOT NULL
    GROUP BY 1
  ),
  -- QuickBooks adjustments: shown, never demand. A count correction is not
  -- something to reorder for; the 125,694-row duplication that made them
  -- dominate the velocity is why this is written down here.
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(a.qty_diff)::numeric AS adjustment_qty,
      sum(CASE WHEN a.qty_diff < 0 THEN abs(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL AND a.txn_date >= (SELECT d FROM params)
    GROUP BY 1
  ),
  -- Sellable = it can ship today: our warehouses and consignment partners (our
  -- system bills their customers). Inbound = made or bought but not here yet.
  brix_stock AS (
    SELECT oh.qbo_item_id,
      sum(oh.on_hand)::numeric AS qty_all,
      sum(oh.on_hand) FILTER (WHERE loc.kind IN ('warehouse', 'distributor'))::numeric AS qty_sellable,
      sum(oh.on_hand) FILTER (WHERE loc.kind IN ('co_packer', 'in_transit'))::numeric AS qty_inbound
    FROM ops.v_inventory_on_hand oh
    JOIN ops.inventory_locations loc ON loc.id = oh.location_id
    WHERE loc.kind <> 'adjustment'
    GROUP BY 1
  ),
  on_order AS (
    SELECT l.qbo_item_id,
      sum(GREATEST(l.qty_ordered - l.qty_received, 0))::numeric AS qty_pending
    FROM ops.purchase_order_lines l
    JOIN ops.purchase_orders p ON p.id = l.po_id
    WHERE p.status IN ('draft', 'open', 'partial', 'received')
      AND l.receivable
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
      COALESCE(brix_stock.qty_all, 0)::numeric AS brix_on_hand,
      CASE
        WHEN COALESCE(s.track_locations, false) THEN COALESCE(brix_stock.qty_sellable, 0)::numeric
        ELSE COALESCE(it.qty_on_hand, 0)::numeric
      END AS planning_on_hand,
      CASE WHEN COALESCE(s.track_locations, false) THEN COALESCE(brix_stock.qty_inbound, 0)::numeric ELSE 0::numeric END AS stock_inbound
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
    LEFT JOIN brix_stock ON brix_stock.qbo_item_id = it.qbo_item_id
  ),
  calc AS (
    SELECT
      b.*,
      COALESCE(sold.qty, 0) AS sold_qty_c, COALESCE(sold.revenue, 0) AS sold_rev_c, COALESCE(sold.customers_count, 0) AS customers_c,
      COALESCE(consumed.qty, 0) AS consumed_c,
      COALESCE(purch.qty, 0) AS purch_qty_c, COALESCE(purch.cost, 0) AS purch_cost_c,
      COALESCE(adj.adjustment_qty, 0) AS adj_c, COALESCE(adj.shrink_qty, 0) AS shrink_c,
      COALESCE(on_order.qty_pending, 0) AS on_order_c,
      COALESCE(on_order.qty_pending, 0) + b.stock_inbound AS inbound_c,
      -- rates
      (COALESCE(sold.qty, 0) + COALESCE(consumed.qty, 0)) / (SELECT lb FROM params) AS rate_lb,
      (COALESCE(sold.qty28, 0) + COALESCE(consumed.qty28, 0)) / (SELECT lb28 FROM params) AS rate_28
    FROM base b
    LEFT JOIN sold     ON sold.qbo_item_id     = b.qbo_item_id
    LEFT JOIN consumed ON consumed.qbo_item_id = b.qbo_item_id
    LEFT JOIN purch    ON purch.qbo_item_id    = b.qbo_item_id
    LEFT JOIN adj      ON adj.qbo_item_id      = b.qbo_item_id
    LEFT JOIN on_order ON on_order.qbo_item_id = b.qbo_item_id
  ),
  vel AS (
    SELECT c.*,
      CASE WHEN (SELECT lb FROM params) > 28 THEN 0.6 * c.rate_28 + 0.4 * c.rate_lb ELSE c.rate_lb END AS velocity
    FROM calc c
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
    it.sold_qty_c, it.sold_rev_c, it.customers_c,
    it.purch_qty_c, it.purch_cost_c,
    it.adj_c, it.shrink_c,
    it.on_order_c AS qty_on_order,
    CASE
      WHEN COALESCE(it.active, true) = false THEN NULL
      WHEN it.velocity <= 0 THEN NULL
      ELSE GREATEST(
        ceil((it.target_days_supply_resolved + it.lead_time_days_resolved) * it.velocity - it.planning_on_hand - it.inbound_c),
        COALESCE(it.min_order_qty, 0))
    END AS suggested_order_qty,
    it.target_days_supply_resolved::numeric AS suggested_order_cycle_days,
    round(it.velocity, 4) AS daily_velocity,
    CASE WHEN it.velocity > 0 THEN round(it.planning_on_hand / it.velocity, 1) ELSE NULL END AS days_of_supply,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN it.velocity <= 0 THEN 'idle'
      WHEN it.planning_on_hand <= 0 THEN 'critical'
      WHEN (it.planning_on_hand + it.inbound_c) / it.velocity <= it.lead_time_days_resolved THEN 'reorder'
      WHEN (it.planning_on_hand + it.inbound_c) / it.velocity <= it.lead_time_days_resolved * 2 THEN 'reorder_soon'
      WHEN it.planning_on_hand / it.velocity > (it.target_days_supply_resolved + it.lead_time_days_resolved) * 3 THEN 'overstock'
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
    it.brix_on_hand - it.qbo_on_hand AS on_hand_drift,
    round(it.rate_28, 4) AS velocity_28d,
    round(it.rate_lb, 4) AS velocity_lookback,
    CASE WHEN it.rate_lb > 0 THEN round((it.rate_28 - it.rate_lb) / it.rate_lb * 100, 1) ELSE NULL END AS velocity_trend_pct,
    it.consumed_c AS consumed_qty,
    it.inbound_c AS qty_inbound,
    CASE WHEN it.velocity > 0 THEN round((it.planning_on_hand + it.inbound_c) / it.velocity, 1) ELSE NULL END AS days_of_cover
  FROM vel it
  LEFT JOIN ops.account_settings acct ON acct.account_name = it.income_account_name
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
$$;
revoke all on function ops.fn_items_master__i(integer, text, boolean) from public, anon, authenticated;
grant execute on function ops.fn_items_master__i(integer, text, boolean) to service_role;

-- the guard wrapper, re-minted in the 20260820b shape (fn_assert_internal:
-- staff + internal logins pass, distributor logins do not)
create function ops.fn_items_master(p_lookback_days integer default 90, p_search text default null, p_managed_only boolean default false)
returns table(
  qbo_item_id text, item_name text, fully_qualified_name text, active boolean, category_path text, category_override text, category_resolved text,
  income_account_name text, expense_account_name text, on_hand numeric, unit_price numeric, purchase_cost numeric, is_managed boolean, is_planner boolean,
  target_days_supply integer, lead_time_days integer, reorder_point numeric, min_order_qty numeric, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer, purchased_qty numeric, purchased_cost numeric, adjustment_qty numeric, shrinkage_qty numeric,
  qty_on_order numeric, suggested_order_qty numeric, suggested_order_cycle_days numeric, daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text, product_type_code text, product_type_label text, segment_code text, segment_label text, segment_source text,
  track_locations boolean, has_bom boolean, inventory_lane text, inventory_lane_size text, inventory_lane_source text, inventory_lane_reviewed boolean,
  default_receiving_location_id uuid, qbo_on_hand numeric, brix_on_hand numeric, planning_on_hand numeric, on_hand_drift numeric,
  velocity_28d numeric, velocity_lookback numeric, velocity_trend_pct numeric, consumed_qty numeric, qty_inbound numeric, days_of_cover numeric
)
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$-- GENERATED GUARD WRAPPER (20260820b shape, re-minted 20260904f) — the real body lives in ops.fn_items_master__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN QUERY SELECT * FROM ops.fn_items_master__i($1, $2, $3); END$$;
revoke all on function ops.fn_items_master(integer, text, boolean) from public, anon;
grant execute on function ops.fn_items_master(integer, text, boolean) to authenticated, service_role;
