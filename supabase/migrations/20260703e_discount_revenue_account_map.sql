-- Finish category cleanup for normal discount/tax accounts that otherwise
-- show as (unspecified) in Margin.

INSERT INTO ops.category_segments (category, segment_code, set_by) VALUES
  ('Discounts', 'other', 'codex'),
  ('Sales Tax', 'other', 'codex')
ON CONFLICT (category) DO UPDATE SET
  segment_code = EXCLUDED.segment_code,
  set_by = EXCLUDED.set_by,
  set_at = now();

INSERT INTO ops.revenue_account_map (
  qbo_income_account_id,
  qbo_income_account_name,
  revenue_line,
  category
) VALUES
  ('38',  'Discounts', 'Discounts', 'OTHER'),
  ('308', 'Channel Discount:Shopify Discount', 'Discounts', 'OTHER'),
  ('314', 'Channel Sales Tax Payable:Shopify Sales Tax', 'Sales Tax', 'OTHER')
ON CONFLICT (qbo_income_account_id) DO UPDATE SET
  qbo_income_account_name = EXCLUDED.qbo_income_account_name,
  revenue_line = EXCLUDED.revenue_line,
  category = EXCLUDED.category,
  updated_at = now();

UPDATE ops.qbo_invoice_lines l
SET revenue_line = m.revenue_line
FROM ops.revenue_account_map m
WHERE l.account_ref_id = m.qbo_income_account_id
  AND (
    l.revenue_line IS NULL
    OR l.revenue_line <> m.revenue_line
  );

REFRESH MATERIALIZED VIEW CONCURRENTLY ops.mv_sales_lines;
