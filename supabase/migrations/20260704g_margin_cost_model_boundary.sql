-- Margin cost model boundary.
--
-- Buckets are an overhead loading layer. They should subtract from item gross
-- margin, not rewrite item COGS or add hidden P&L true-ups to rows.
--
-- The prior zero-cost guard treated any row with "markup" in the account,
-- category, or item text as zero-cost. That erased real item master costs for
-- sellable equipment/items that happened to post under a Markup/Other Income
-- account. Keep true pass-through rows explicit, but never let a broad bucket
-- label override a real item's own cost.

INSERT INTO ops.item_cost_policies (qbo_item_id, cost_mode, note) VALUES
  ('361', 'static_only', 'STDPART uses the item master cost only; actual purchase history is polluted by unrelated large parts/equipment purchases.'),
  ('1029', 'zero_cost', 'Equipment rental revenue should not use the asset purchase cost as per-rental COGS.'),
  ('695', 'zero_cost', 'Shopify discount passthrough.'),
  ('697', 'static_only', 'Shopify sales summary item uses the item master cost only; update QBO if this should carry standard COGS.'),
  ('698', 'zero_cost', 'Shopify sales tax passthrough.'),
  ('699', 'static_only', 'Shopify shipping summary item uses the item master cost only; update QBO if this should carry standard COGS.'),
  ('SHIPPING_ITEM_ID', 'static_only', 'QBO synthetic shipping placeholder uses its item master cost only.')
ON CONFLICT (qbo_item_id) DO UPDATE SET
  cost_mode = EXCLUDED.cost_mode,
  note = EXCLUDED.note,
  updated_at = now();

CREATE OR REPLACE VIEW ops.v_sales_lines AS
WITH line_base AS (
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
    pol.cost_mode,
    lower(concat_ws(
      ' ',
      l.account_name,
      l.revenue_line,
      it.income_account_name,
      it.name,
      l.item_name,
      l.description
    )) AS cost_rule_text,
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
),
rules AS (
  SELECT
    lb.*,
    COALESCE(lb.cost_mode, '') = 'zero_cost' AS is_policy_zero,
    lb.amount < 0 AND lb.cost_rule_text LIKE '%discount%' AS is_discount_line,
    lb.cost_rule_text LIKE '%sales tax%' AS is_sales_tax_line,
    lb.item_ref_id IS NULL AND lb.cost_rule_text LIKE '%markup%' AS is_itemless_markup_line
  FROM line_base lb
),
effective AS (
  SELECT
    r.*,
    (
      r.is_policy_zero
      OR r.is_discount_line
      OR r.is_sales_tax_line
      OR r.is_itemless_markup_line
    ) AS is_zero_cost_line,
    CASE
      WHEN r.is_policy_zero OR r.is_discount_line OR r.is_sales_tax_line OR r.is_itemless_markup_line
        THEN 0::numeric
      WHEN COALESCE(r.cost_mode, '') = 'static_only'
        THEN r.static_unit_cost
      ELSE COALESCE(r.actual_unit_cost, r.static_unit_cost)
    END AS effective_unit_cost,
    CASE
      WHEN r.is_discount_line
        THEN 'discount'
      WHEN r.is_policy_zero
        THEN 'zero_policy'
      WHEN r.is_sales_tax_line OR r.is_itemless_markup_line
        THEN 'zero_rule'
      WHEN COALESCE(r.cost_mode, '') = 'static_only' AND r.static_unit_cost IS NOT NULL
        THEN 'static_policy'
      WHEN r.actual_unit_cost IS NOT NULL THEN 'actual_asof'
      WHEN r.static_unit_cost IS NOT NULL THEN 'static'
      ELSE 'none'
    END AS cost_source
  FROM rules r
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
  jsonb_build_object('relation', 'ops.mv_sales_lines', 'trigger', 'margin_cost_model_boundary')
);

NOTIFY pgrst, 'reload schema';
