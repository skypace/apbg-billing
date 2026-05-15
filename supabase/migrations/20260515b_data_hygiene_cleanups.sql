-- v0.9.42 — data hygiene cleanups
--
-- Three fixes from the user's feedback after the PO module shipped:
--
-- 1. fn_set_inventory_settings was 11 args; the client now passes 20
--    (weight, dimensions, freight_class, unit_type, nmfc_code). Every
--    toggle in Items master was 404ing with PGRST202. This migration
--    drops the 11-arg overload and re-creates the function at 20 args.
--
-- 2. fn_items_master returned QBO Category and Group items as if they
--    were inventory items. Categories are headers in QBO; Groups are
--    bundles. Both pollute the Items master grid and the inventory
--    Velocity tab. We now filter them out at the SQL level so they
--    can never leak into BRIX views.
--
-- 3. fn_item_hygiene_summary counted Category items under
--    "no income account" + "no category" — categories never have an
--    income account, so they were dragging the hygiene buckets up by
--    ~54 false positives. Same fix: filter at the source.
--
-- 4. fn_customers_master used to return every active customer (11,889
--    rows) even though only ~500 had any invoice. A new optional
--    p_show_unconnected parameter (default FALSE) hides customers that
--    have no invoices, no sub-customers, no channel/rep assignment, and
--    no manual entity or notes. The existing UI just gets the cleaner
--    list automatically. Toggle to TRUE to see leads/prospects.


-- ── 1. fn_set_inventory_settings — extend to 20 args ────────────────────────
DROP FUNCTION IF EXISTS ops.fn_set_inventory_settings(
  text, boolean, integer, integer, numeric, numeric, text, text, boolean, boolean, boolean
);

CREATE OR REPLACE FUNCTION ops.fn_set_inventory_settings(
  p_qbo_item_id          TEXT,
  p_is_managed           BOOLEAN DEFAULT NULL,
  p_target_days_supply   INTEGER DEFAULT NULL,
  p_lead_time_days       INTEGER DEFAULT NULL,
  p_reorder_point        NUMERIC DEFAULT NULL,
  p_min_order_qty        NUMERIC DEFAULT NULL,
  p_notes                TEXT    DEFAULT NULL,
  p_category_override    TEXT    DEFAULT NULL,
  p_is_planner           BOOLEAN DEFAULT NULL,
  p_track_locations      BOOLEAN DEFAULT NULL,
  p_has_bom              BOOLEAN DEFAULT NULL,
  p_weight_per_unit_lbs  NUMERIC DEFAULT NULL,
  p_units_per_pallet     NUMERIC DEFAULT NULL,
  p_freight_class        TEXT    DEFAULT NULL,
  p_dim_l_in             NUMERIC DEFAULT NULL,
  p_dim_w_in             NUMERIC DEFAULT NULL,
  p_dim_h_in             NUMERIC DEFAULT NULL,
  p_unit_type            TEXT    DEFAULT NULL,
  p_nmfc_code            TEXT    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ops, public
AS $func$
BEGIN
  INSERT INTO ops.inventory_settings (
    qbo_item_id, is_managed, target_days_supply, lead_time_days,
    reorder_point, min_order_qty, notes, category_override, is_planner,
    track_locations, has_bom, weight_per_unit_lbs, units_per_pallet,
    freight_class, dim_l_in, dim_w_in, dim_h_in, unit_type, nmfc_code,
    updated_at
  )
  VALUES (
    p_qbo_item_id,
    COALESCE(p_is_managed, false),
    COALESCE(p_target_days_supply, 30),
    COALESCE(p_lead_time_days, 7),
    p_reorder_point, p_min_order_qty, p_notes, p_category_override,
    COALESCE(p_is_planner, false),
    COALESCE(p_track_locations, false),
    COALESCE(p_has_bom, false),
    p_weight_per_unit_lbs, p_units_per_pallet,
    p_freight_class, p_dim_l_in, p_dim_w_in, p_dim_h_in,
    p_unit_type, p_nmfc_code,
    NOW()
  )
  ON CONFLICT (qbo_item_id) DO UPDATE SET
    is_managed          = COALESCE(p_is_managed,          ops.inventory_settings.is_managed),
    target_days_supply  = COALESCE(p_target_days_supply,  ops.inventory_settings.target_days_supply),
    lead_time_days      = COALESCE(p_lead_time_days,      ops.inventory_settings.lead_time_days),
    reorder_point       = COALESCE(p_reorder_point,       ops.inventory_settings.reorder_point),
    min_order_qty       = COALESCE(p_min_order_qty,       ops.inventory_settings.min_order_qty),
    notes               = COALESCE(p_notes,               ops.inventory_settings.notes),
    category_override   = COALESCE(p_category_override,   ops.inventory_settings.category_override),
    is_planner          = COALESCE(p_is_planner,          ops.inventory_settings.is_planner),
    track_locations     = COALESCE(p_track_locations,     ops.inventory_settings.track_locations),
    has_bom             = COALESCE(p_has_bom,             ops.inventory_settings.has_bom),
    weight_per_unit_lbs = COALESCE(p_weight_per_unit_lbs, ops.inventory_settings.weight_per_unit_lbs),
    units_per_pallet    = COALESCE(p_units_per_pallet,    ops.inventory_settings.units_per_pallet),
    freight_class       = COALESCE(p_freight_class,       ops.inventory_settings.freight_class),
    dim_l_in            = COALESCE(p_dim_l_in,            ops.inventory_settings.dim_l_in),
    dim_w_in            = COALESCE(p_dim_w_in,            ops.inventory_settings.dim_w_in),
    dim_h_in            = COALESCE(p_dim_h_in,            ops.inventory_settings.dim_h_in),
    unit_type           = COALESCE(p_unit_type,           ops.inventory_settings.unit_type),
    nmfc_code           = COALESCE(p_nmfc_code,           ops.inventory_settings.nmfc_code),
    updated_at          = NOW();
END;
$func$;
GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_settings(
  TEXT, BOOLEAN, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN,
  NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT
) TO authenticated;


-- ── 2. fn_items_master — exclude Category + Group items ────────────────────
-- These QBO item types are headers/bundles, not inventory items. They have
-- no income account so they polluted Items master + Inventory views as
-- "Uncategorized" rows that looked like real items the user needed to fix.
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
    END,
    COALESCE(s.track_locations, false),
    COALESCE(s.has_bom, false)
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


-- ── 3. fn_item_hygiene_summary — same Category/Group filter ────────────────
CREATE OR REPLACE FUNCTION ops.fn_item_hygiene_summary()
RETURNS TABLE(bucket text, label text, item_count integer, detail jsonb)
LANGUAGE sql STABLE SET search_path = ops, public
AS $function$
  WITH items AS (
    SELECT
      it.qbo_item_id,
      it.name,
      it.active,
      it.income_account_name,
      COALESCE(s.category_override, it.category_path) AS category_resolved,
      it.category_path
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
    WHERE COALESCE(it.active, true)
      AND COALESCE(it.type, '') NOT IN ('Category', 'Group')
  ),
  audit AS (
    SELECT * FROM ops.fn_item_pl_audit(3) WHERE active
  )
  SELECT 'no_income_account' AS bucket,
         'No income account in QBO' AS label,
         count(*)::integer AS item_count,
         to_jsonb(array_agg(name ORDER BY name)) AS detail
    FROM items
   WHERE income_account_name IS NULL OR income_account_name = ''
  UNION ALL
  SELECT 'no_category',
         'No category (neither QBO path nor override)',
         count(*)::integer,
         to_jsonb(array_agg(name ORDER BY name))
    FROM items
   WHERE category_resolved IS NULL OR category_resolved = ''
  UNION ALL
  SELECT 'isolated_in_account',
         'Alone or nearly alone in their P&L account',
         count(*)::integer,
         to_jsonb(array_agg(item_name ORDER BY item_name))
    FROM audit
   WHERE alignment_status = 'isolated'
  UNION ALL
  SELECT 'account_uncategorized',
         'Account itself mostly uncategorized — needs review',
         count(*)::integer,
         to_jsonb(array_agg(item_name ORDER BY item_name))
    FROM audit
   WHERE alignment_status = 'unclassified_account';
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_item_hygiene_summary() TO authenticated;


-- ── 4. fn_customers_master — hide unconnected by default ───────────────────
-- "Unconnected" = no invoices, no sub-customers, no channel, no rep,
-- no manual entity, no notes. Adds p_show_unconnected (default FALSE).
DROP FUNCTION IF EXISTS ops.fn_customers_master(date, date, text, text, boolean, integer, integer);

CREATE OR REPLACE FUNCTION ops.fn_customers_master(
  p_start            date    DEFAULT (date_trunc('year'::text, (CURRENT_DATE)::timestamp with time zone))::date,
  p_end              date    DEFAULT CURRENT_DATE,
  p_search           text    DEFAULT NULL,
  p_channel          text    DEFAULT NULL,
  p_only_active      boolean DEFAULT true,
  p_limit            integer DEFAULT 500,
  p_offset           integer DEFAULT 0,
  p_show_unconnected boolean DEFAULT false
)
RETURNS TABLE(
  qbo_customer_id text, display_name text, fully_qualified_name text,
  parent_ref_id text, parent_name text, is_sub_customer boolean,
  active boolean, entity text, entity_resolved text,
  state text, city text, address text, postal text,
  customer_type_name text, email text, phone text, notes text,
  ytd_revenue numeric, invoice_count bigint, last_invoice_date date,
  ar_total numeric, ar_current numeric, ar_31_60 numeric,
  ar_61_90 numeric, ar_90_plus numeric, open_invoice_count bigint,
  channels text[], primary_channel text,
  sales_reps text[], primary_sales_rep text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH rev AS (
    SELECT i.customer_ref_id,
           sum(l.amount)::numeric AS rev,
           count(DISTINCT i.id)::bigint AS inv_count,
           max(i.txn_date)::date AS last_inv,
           true AS has_any_inv
    FROM ops.qbo_invoice_lines l
    JOIN ops.qbo_invoices i ON i.id = l.invoice_id
    WHERE i.txn_date >= p_start AND i.txn_date <= p_end
    GROUP BY 1
  ),
  all_inv AS (
    -- Any invoice ever, irrespective of the date window. Drives the
    -- "connected" filter so a customer with historical invoices outside
    -- the YTD window still shows.
    SELECT DISTINCT i.customer_ref_id FROM ops.qbo_invoices i
  ),
  ar AS (
    SELECT i.customer_ref_id,
           sum(i.balance)::numeric                                                            AS ar_total,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 0 AND 30)::numeric  AS ar_current,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 31 AND 60)::numeric AS ar_31_60,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 61 AND 90)::numeric AS ar_61_90,
           sum(i.balance) FILTER (WHERE current_date - i.due_date > 90)::numeric              AS ar_90_plus,
           count(*)::bigint                                                                   AS open_inv
    FROM ops.qbo_invoices i
    WHERE i.balance > 0
    GROUP BY 1
  ),
  ch AS (
    SELECT cc.qbo_customer_id,
           array_agg(c.label ORDER BY c.sort_order, c.label) AS channels,
           max(c.label) FILTER (WHERE cc.is_primary)         AS primary_channel
    FROM ops.customer_channels cc
    JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  ),
  sr AS (
    SELECT csr.qbo_customer_id,
           array_agg(s.name ORDER BY s.sort_order, s.name)  AS reps,
           max(s.name) FILTER (WHERE csr.is_primary)        AS primary_rep
    FROM ops.customer_sales_reps csr
    JOIN ops.sales_reps s ON s.rep_code = csr.rep_code AND s.is_active
    GROUP BY 1
  ),
  has_subs AS (
    SELECT DISTINCT parent_ref_id AS qbo_customer_id
    FROM ops.qbo_customers
    WHERE parent_ref_id IS NOT NULL
  )
  SELECT
    qc.qbo_customer_id, qc.display_name, qc.fully_qualified_name,
    qc.parent_ref_id, parent.display_name,
    COALESCE(qc.is_sub_customer, false),
    COALESCE(qc.active, true),
    qc.entity,
    COALESCE(qc.entity, ops.fn_derive_entity(qc.display_name, parent.display_name)) AS entity_resolved,
    qc.bill_addr_state, qc.bill_addr_city, qc.bill_addr_line1, qc.bill_addr_postal,
    qc.customer_type_name, qc.email, qc.phone, qc.notes,
    COALESCE(rev.rev, 0)::numeric,
    COALESCE(rev.inv_count, 0)::bigint,
    rev.last_inv,
    COALESCE(ar.ar_total, 0)::numeric,
    COALESCE(ar.ar_current, 0)::numeric,
    COALESCE(ar.ar_31_60, 0)::numeric,
    COALESCE(ar.ar_61_90, 0)::numeric,
    COALESCE(ar.ar_90_plus, 0)::numeric,
    COALESCE(ar.open_inv, 0)::bigint,
    COALESCE(ch.channels, ARRAY[]::text[]),
    ch.primary_channel,
    COALESCE(sr.reps, ARRAY[]::text[]),
    sr.primary_rep
  FROM ops.qbo_customers qc
  LEFT JOIN ops.qbo_customers parent ON parent.qbo_customer_id = qc.parent_ref_id
  LEFT JOIN rev ON rev.customer_ref_id = qc.qbo_customer_id
  LEFT JOIN ar  ON ar.customer_ref_id  = qc.qbo_customer_id
  LEFT JOIN ch  ON ch.qbo_customer_id  = qc.qbo_customer_id
  LEFT JOIN sr  ON sr.qbo_customer_id  = qc.qbo_customer_id
  WHERE (NOT p_only_active OR COALESCE(qc.active, true))
    AND (
      p_search IS NULL OR p_search = ''
      OR qc.display_name        ILIKE '%' || p_search || '%'
      OR qc.fully_qualified_name ILIKE '%' || p_search || '%'
      OR COALESCE(qc.customer_type_name, '') ILIKE '%' || p_search || '%'
    )
    AND (
      p_channel IS NULL OR p_channel = ''
      OR (p_channel = 'unassigned' AND (ch.channels IS NULL OR array_length(ch.channels, 1) = 0))
      OR (p_channel <> 'unassigned' AND p_channel = ANY(COALESCE(ch.channels, ARRAY[]::text[])))
    )
    AND (
      p_show_unconnected
      OR EXISTS (SELECT 1 FROM all_inv ai WHERE ai.customer_ref_id = qc.qbo_customer_id)
      OR EXISTS (SELECT 1 FROM has_subs hs WHERE hs.qbo_customer_id = qc.qbo_customer_id)
      OR ch.channels IS NOT NULL
      OR sr.reps     IS NOT NULL
      OR qc.entity   IS NOT NULL
      OR qc.notes    IS NOT NULL
      OR qc.is_sub_customer = true
    )
  ORDER BY
    COALESCE(parent.display_name, qc.display_name),
    qc.is_sub_customer,
    qc.display_name
  LIMIT GREATEST(COALESCE(p_limit, 500), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_customers_master(date, date, text, text, boolean, integer, integer, boolean) TO authenticated;
