-- Melt child income accounts were not in revenue_account_map, so invoice
-- lines landed in Margin as category = NULL even though segment/family/type
-- were populated. Map the child accounts and backfill historical lines.

INSERT INTO ops.revenue_account_map (
  qbo_income_account_id,
  qbo_income_account_name,
  revenue_line,
  category
) VALUES
  ('1150040025', 'Equipment Sales:The Melt', 'Equipment Sales', 'EQ SALES'),
  ('1150040027', 'Service Income:Melt Service Income', 'Service - General', 'SERVICE'),
  ('1150040030', 'Shipping Income:Melt Shipping Income', 'Shipping Income', 'OTHER'),
  ('1150040032', 'Service Income:PM and Contract Service Income:Melt PM', 'Service - PM Contract', 'SERVICE'),
  ('1150040029', 'Sublet Rental Income:Melt Equipment Rent', 'Subleased Space', 'OTHER')
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
