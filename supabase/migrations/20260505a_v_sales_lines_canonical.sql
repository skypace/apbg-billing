-- §12 #1 — collapse ops.v_sales_lines into a single canonical definition.
--
-- Background: the view was redefined four times across earlier migrations,
-- each iteratively adding columns:
--   20260429_margin_dashboard            v1: base sales lines + est cost/margin
--   20260502b_channels_view_and_rpcs     v2: + channels[] / primary_channel
--   20260502d_segments_taxonomy          v3: + segment from category_segments
--   20260502e_segment_subdivisions       v4: + item-level segment override
-- The first three definitions are dead code; nothing reads them. Each
-- successive CREATE OR REPLACE superseded the previous one, so the live
-- view in production is whatever 20260502e produced. The chain made the
-- effective shape of v_sales_lines un-readable without replaying the
-- whole migration history.
--
-- This migration recreates the view in one place using the exact shape
-- currently in production (verified via `pg_get_viewdef('ops.v_sales_lines')`
-- on 2026-05-05). No behavior change: column order, names, types, and
-- semantics match the live view 1:1.
--
-- Future evolutions of v_sales_lines should edit this file (or supersede
-- it with a CREATE OR REPLACE in a later migration whose comment header
-- references this one), not start a new chain.

CREATE OR REPLACE VIEW ops.v_sales_lines AS
WITH effective AS (
  SELECT l.id,
         l.invoice_id,
         l.item_ref_id,
         l.item_name,
         l.revenue_line,
         l.account_name,
         l.description,
         l.quantity,
         l.unit_price,
         l.amount,
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
       CASE
         WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
         THEN e.effective_unit_cost * e.quantity
       END                                            AS est_cost,
       CASE
         WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
         THEN e.amount - e.effective_unit_cost * e.quantity
       END                                            AS est_margin,
       COALESCE(lc.channels, ARRAY[]::text[])         AS channels,
       lc.primary_channel,
       COALESCE(lr.sales_reps, ARRAY[]::text[])       AS sales_reps,
       lr.primary_sales_rep
FROM effective e
  JOIN      ops.qbo_invoices    i      ON i.id              = e.invoice_id
  LEFT JOIN ops.item_segments   is_map ON is_map.item_name  = e.item_name
  LEFT JOIN ops.segments        s_item ON s_item.segment_code = is_map.segment_code
                                       AND s_item.is_active
  LEFT JOIN ops.category_segments cs   ON cs.category       = e.revenue_line
  LEFT JOIN ops.segments        s_cat  ON s_cat.segment_code = cs.segment_code
                                       AND s_cat.is_active
  LEFT JOIN LATERAL (
    SELECT array_agg(c.label ORDER BY c.sort_order)        AS channels,
           max(c.label) FILTER (WHERE cc.is_primary)       AS primary_channel
    FROM ops.customer_channels cc
      JOIN ops.channels c ON c.channel_code = cc.channel_code
    WHERE cc.qbo_customer_id = i.customer_ref_id
      AND c.is_active
  ) lc ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(r.name ORDER BY r.sort_order)         AS sales_reps,
           max(r.name) FILTER (WHERE csr.is_primary)       AS primary_sales_rep
    FROM ops.customer_sales_reps csr
      JOIN ops.sales_reps r ON r.rep_code = csr.rep_code
    WHERE csr.qbo_customer_id = i.customer_ref_id
      AND r.is_active
  ) lr ON true;

COMMENT ON VIEW ops.v_sales_lines IS
  'Canonical sales-lines view. Defined in 20260505a; supersedes the v1-v4 chain in 20260429 / 20260502b / 20260502d / 20260502e. Edit this file (or replace with a fresh CREATE OR REPLACE in a later migration that references this comment) for future evolutions; do not start a new redefinition chain.';
