-- 'BIB Income' (legacy catch-all, account id 29) was wrongly mapped to
-- "BIB - 3 Gallon" in 20260517c — it's a generic income account that picks
-- up old misc revenue (a deleted refrigerator from 2022, etc.). Reroute it
-- to "Markup" under OTHER so the 3-Gallon bucket only contains actual
-- 3-gal sales.

UPDATE ops.revenue_account_map
SET revenue_line = 'Markup', category = 'OTHER'
WHERE qbo_income_account_id = '29';

UPDATE ops.qbo_invoice_lines
SET revenue_line = 'Markup'
WHERE account_ref_id = '29';

REFRESH MATERIALIZED VIEW CONCURRENTLY ops.mv_sales_lines;
