-- Split Tank Rental and Sublet (subleased building space) out of the generic
-- "Equipment Rental" bucket. Per Sky: tank rentals are their own product
-- line, and Sublet Rental Income is rent collected from tenants subleasing
-- space in our building — that's real-estate income, not equipment.

INSERT INTO ops.revenue_categories (category, revenue_line, display_order, notes) VALUES
  ('EQ RENTAL', 'Tank Rental',     22, 'Tank rentals (1000TRF-* series). Separate from generic equipment rental.'),
  ('OTHER',     'Subleased Space', 92, 'Rent collected from tenants subleasing space in our building.')
ON CONFLICT DO NOTHING;

UPDATE ops.revenue_account_map
SET revenue_line = 'Tank Rental', category = 'EQ RENTAL'
WHERE qbo_income_account_id = '34';

UPDATE ops.revenue_account_map
SET revenue_line = 'Subleased Space', category = 'OTHER'
WHERE qbo_income_account_id = '37';

UPDATE ops.qbo_invoice_lines
SET revenue_line = 'Tank Rental'
WHERE account_ref_id = '34';

UPDATE ops.qbo_invoice_lines
SET revenue_line = 'Subleased Space'
WHERE account_ref_id = '37';

REFRESH MATERIALIZED VIEW CONCURRENTLY ops.mv_sales_lines;
