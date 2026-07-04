-- Margin cost policy for zero-cost/pass-through items.
--
-- Some QBO sales lines are legitimate revenue/pass-through rows with no unit
-- COGS, and some generic sales items have polluted purchase history. Without a
-- small explicit policy layer, Margin reports these as missing cost or negative
-- margin even though the row should be zero-cost for Margin purposes.

CREATE TABLE IF NOT EXISTS ops.item_cost_policies (
  qbo_item_id text PRIMARY KEY,
  cost_mode text NOT NULL CHECK (cost_mode IN ('actual_first', 'static_only', 'zero_cost')),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ops.item_cost_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS item_cost_policies_read ON ops.item_cost_policies;
CREATE POLICY item_cost_policies_read ON ops.item_cost_policies FOR SELECT USING (true);
GRANT SELECT ON ops.item_cost_policies TO anon, authenticated;
GRANT ALL ON ops.item_cost_policies TO service_role;

INSERT INTO ops.item_cost_policies (qbo_item_id, cost_mode, note) VALUES
  ('361', 'zero_cost', 'STDPART is a generic sales item; actual purchase history is polluted by unrelated large parts/equipment purchases.'),
  ('1029', 'zero_cost', 'Equipment rental revenue should not use the asset purchase cost as per-rental COGS.'),
  ('695', 'zero_cost', 'Shopify discount passthrough.'),
  ('697', 'zero_cost', 'Shopify sales summary item has no line-level item cost in QBO.'),
  ('698', 'zero_cost', 'Shopify sales tax passthrough.'),
  ('699', 'zero_cost', 'Shopify shipping summary item has no line-level item cost in QBO.'),
  ('SHIPPING_ITEM_ID', 'zero_cost', 'QBO synthetic shipping placeholder used on invoice lines without item master cost.')
ON CONFLICT (qbo_item_id) DO UPDATE SET
  cost_mode = EXCLUDED.cost_mode,
  note = EXCLUDED.note,
  updated_at = now();

CREATE OR REPLACE VIEW ops.v_sales_lines AS
WITH effective AS (
  SELECT
    l.id,
    l.invoice_id,
    i.qbo_invoice_id,
    i.doc_number,
    i.txn_date,
    date_trunc('month'::text, i.txn_date::timestamptz)::date AS txn_month,
    EXTRACT(year FROM i.txn_date)::integer AS txn_year,
    i.customer_ref_id,
    i.customer_name,
    i.entity,
    i.department AS invoice_department,
    l.department AS line_department,
    l.item_ref_id,
    COALESCE(it.name, l.item_name) AS item_name,
    l.revenue_line,
    CASE
      WHEN NULLIF(trim(COALESCE(l.revenue_line, '')), '') IS NOT NULL
        THEN l.revenue_line
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%pm%'
        THEN 'Service - PM Contract'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%shipping%'
        THEN 'Shipping Income'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%sublet%'
        THEN 'Subleased Space'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%rent%'
        THEN 'Subleased Space'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%service%'
        THEN 'Service - General'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%melt%'
        AND lower(COALESCE(l.account_name, '') || ' ' || COALESCE(it.income_account_name, '')) LIKE '%equipment%'
        THEN 'Equipment Sales'
      ELSE COALESCE(
        NULLIF(trim(COALESCE(it.category_path, '')), ''),
        NULLIF(trim(COALESCE(l.account_name, '')), ''),
        NULLIF(trim(COALESCE(it.income_account_name, '')), '')
      )
    END AS resolved_category,
    l.account_name,
    l.description,
    l.quantity,
    l.unit_price,
    l.amount,
    it.purchase_cost AS static_unit_cost,
    ac.avg_unit_cost AS actual_unit_cost,
    (
      COALESCE(pol.cost_mode, '') = 'zero_cost'
      OR lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%discount%'
      OR lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%markup%'
      OR lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%sales tax%'
    ) AS is_zero_cost_line,
    CASE
      WHEN COALESCE(pol.cost_mode, '') = 'zero_cost'
        OR lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%discount%'
        OR lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%markup%'
        OR lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%sales tax%'
        THEN 0::numeric
      WHEN COALESCE(pol.cost_mode, '') = 'static_only'
        THEN it.purchase_cost
      ELSE COALESCE(ac.avg_unit_cost, it.purchase_cost)
    END AS effective_unit_cost,
    CASE
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%discount%'
        THEN 'discount'
      WHEN COALESCE(pol.cost_mode, '') = 'zero_cost'
        THEN 'zero_policy'
      WHEN lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%markup%'
        OR lower(COALESCE(l.account_name, '') || ' ' || COALESCE(l.revenue_line, '') || ' ' || COALESCE(it.income_account_name, '') || ' ' || COALESCE(it.name, l.item_name, '')) LIKE '%sales tax%'
        THEN 'zero_rule'
      WHEN COALESCE(pol.cost_mode, '') = 'static_only' AND it.purchase_cost IS NOT NULL
        THEN 'static_policy'
      WHEN ac.avg_unit_cost IS NOT NULL THEN 'actual_asof'
      WHEN it.purchase_cost IS NOT NULL THEN 'static'
      ELSE 'none'
    END AS cost_source,
    it.type AS item_type,
    it.income_account_name,
    it.expense_account_name
  FROM ops.qbo_invoice_lines l
  JOIN ops.qbo_invoices i ON i.id = l.invoice_id
  LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.item_ref_id
  LEFT JOIN ops.item_cost_policies pol ON pol.qbo_item_id = l.item_ref_id
  LEFT JOIN LATERAL (
    SELECT
      CASE WHEN sum(el.quantity) > 0 THEN sum(el.amount) / sum(el.quantity) END AS avg_unit_cost
    FROM ops.qbo_expense_lines el
    WHERE el.detail_type = 'ItemBasedExpenseLineDetail'
      AND el.item_ref_id = l.item_ref_id
      AND el.quantity IS NOT NULL
      AND el.quantity > 0
      AND el.txn_date IS NOT NULL
      AND el.txn_date <= i.txn_date
  ) ac ON l.item_ref_id IS NOT NULL AND COALESCE(pol.cost_mode, 'actual_first') = 'actual_first'
)
SELECT
  e.id AS line_id,
  e.invoice_id,
  e.qbo_invoice_id,
  e.doc_number,
  e.txn_date,
  e.txn_month,
  e.txn_year,
  e.customer_ref_id,
  e.customer_name,
  e.entity,
  e.invoice_department,
  e.line_department,
  e.item_ref_id,
  e.item_name,
  e.resolved_category AS category,
  COALESCE(s_item.label, s_cat.label) AS segment,
  e.account_name,
  e.description,
  e.quantity,
  e.unit_price,
  e.amount AS revenue,
  e.static_unit_cost AS purchase_cost,
  e.actual_unit_cost,
  e.effective_unit_cost,
  e.cost_source,
  e.item_type,
  e.income_account_name,
  e.expense_account_name,
  CASE
    WHEN e.is_zero_cost_line OR e.effective_unit_cost = 0 THEN 0::numeric
    WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
      THEN e.effective_unit_cost * e.quantity
  END AS est_cost,
  CASE
    WHEN e.is_zero_cost_line OR e.effective_unit_cost = 0 THEN e.amount
    WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
      THEN e.amount - e.effective_unit_cost * e.quantity
  END AS est_margin,
  COALESCE(lc.channels, ARRAY[]::text[]) AS channels,
  lc.primary_channel,
  ARRAY[]::text[] AS sales_reps,
  pf.label AS product_family,
  pt.label AS product_type
FROM effective e
LEFT JOIN ops.item_segments is_map ON is_map.qbo_item_id = e.item_ref_id
LEFT JOIN ops.segments s_item ON s_item.segment_code = is_map.segment_code AND s_item.is_active
LEFT JOIN ops.category_segments cs ON cs.category = e.resolved_category
LEFT JOIN ops.segments s_cat ON s_cat.segment_code = cs.segment_code AND s_cat.is_active
LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = e.item_ref_id
LEFT JOIN ops.product_families pf ON pf.family_code = ipf.family_code AND pf.is_active
LEFT JOIN ops.item_product_types ipt ON ipt.qbo_item_id = e.item_ref_id
LEFT JOIN ops.product_types pt ON pt.type_code = ipt.type_code AND pt.is_active
LEFT JOIN LATERAL (
  SELECT
    array_agg(c.label ORDER BY c.sort_order) AS channels,
    max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
  FROM ops.customer_channels cc
  JOIN ops.channels c ON c.channel_code = cc.channel_code
  WHERE cc.qbo_customer_id = e.customer_ref_id
    AND c.is_active
) lc ON true;

REFRESH MATERIALIZED VIEW CONCURRENTLY ops.mv_sales_lines;

INSERT INTO ops.sync_log (
  source, sync_type, status, records_synced,
  started_at, completed_at, metadata
) VALUES (
  'qbo', 'mv_refresh', 'success', 0,
  clock_timestamp(), clock_timestamp(),
  jsonb_build_object('relation', 'ops.mv_sales_lines', 'trigger', 'margin_cost_policy_zero_cost_items')
);
