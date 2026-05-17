-- Move the QBO income-account → revenue_line mapping out of the sync-qbo
-- edge function's hardcoded REVENUE_LINE_MAP constant and into a real
-- database table that the Margin UI can edit.

CREATE TABLE IF NOT EXISTS ops.revenue_account_map (
  qbo_income_account_id   text PRIMARY KEY,
  qbo_income_account_name text NOT NULL,
  revenue_line            text NOT NULL,
  category                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_account_map_revenue_line_idx
  ON ops.revenue_account_map (revenue_line);

-- Seed with the 18 mappings that were hardcoded in sync-qbo@v36.
INSERT INTO ops.revenue_account_map (qbo_income_account_id, qbo_income_account_name, revenue_line, category) VALUES
  ('120', '3 Gallon',                       'BIB - 3 Gallon',         'BIB'),
  ('121', '5 Gallon',                       'BIB - 5 Gallon',         'BIB'),
  ('273', 'Delivery Fees',                  'BIB - Delivery Fees',    'BIB'),
  ('123', '100% CO2',                       'Gas - CO2',              'GAS'),
  ('124', 'Mixed Gas and Nitro',            'Gas - Mixed/Nitro',      'GAS'),
  ('272', 'Hazmat Del Fees',                'Gas - Hazmat Fees',      'GAS'),
  ('32',  'Equipment Sales',                'Equipment Sales',        'EQ SALES'),
  ('33',  'Equipment Rental Income',        'Equipment Rental',       'EQ RENTAL'),
  ('278', 'Packaged Beverage Income',       'Packaged Beverage',      'PACKAGED BEVERAGE'),
  ('35',  'Service Income',                 'Service - General',      'SERVICE'),
  ('253', 'Equipment Remanufacturing',      'Service - Reman',        'SCRAPPING'),
  ('255', 'Freshpet Service Income',        'Service - Freshpet',     'FRESHPET'),
  ('303', 'PM and Contract Service Income', 'Service - PM Contract',  'SERVICE'),
  ('306', 'Shopify Sales',                  'Shopify Sales',          'SHOPIFY'),
  ('312', 'Shopify Shipping',               'Shopify Shipping',       'SHOPIFY'),
  ('230', 'Shipping Income',                'Shipping Income',        'OTHER'),
  ('229', 'Markup',                         'Markup',                 'OTHER'),
  ('10',  'Shipping and Delivery',          'Shipping and Delivery',  'OTHER')
ON CONFLICT (qbo_income_account_id) DO NOTHING;

-- Seed best-guess mappings for the 10 previously-uncategorized accounts.
INSERT INTO ops.revenue_account_map (qbo_income_account_id, qbo_income_account_name, revenue_line, category) VALUES
  ('34',         'Tank Rental Income',         'Equipment Rental',     'EQ RENTAL'),
  ('115',        'Beverage Fee Income',        'BIB - Delivery Fees',  'BIB'),
  ('37',         'Sublet Rental Income',       'Equipment Rental',     'EQ RENTAL'),
  ('153',        'Other Income',               'Markup',               'OTHER'),
  ('1150040023', 'Service Income:Scrap Income','Service - Reman',      'SCRAPPING'),
  ('29',         'BIB Income',                 'BIB - 3 Gallon',       'BIB'),
  ('1150040021', 'CA CRV Payable',             'Markup',               'OTHER'),
  ('107',        'Merchant Acct Fees',         'Markup',               'OTHER'),
  ('27',         '66000 Payroll Expenses',     'Markup',               'OTHER'),
  ('42',         'Equipment Sales COGS',       'Equipment Sales',      'EQ SALES')
ON CONFLICT (qbo_income_account_id) DO NOTHING;

ALTER TABLE ops.revenue_account_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY revenue_account_map_select_authn ON ops.revenue_account_map
  FOR SELECT TO authenticated USING (true);

CREATE POLICY revenue_account_map_service_all ON ops.revenue_account_map
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION ops.fn_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER revenue_account_map_touch
  BEFORE UPDATE ON ops.revenue_account_map
  FOR EACH ROW EXECUTE FUNCTION ops.fn_touch_updated_at();

UPDATE ops.qbo_invoice_lines l
SET revenue_line = m.revenue_line
FROM ops.revenue_account_map m
WHERE l.account_ref_id = m.qbo_income_account_id
  AND (l.revenue_line IS NULL OR l.revenue_line <> m.revenue_line);

REFRESH MATERIALIZED VIEW CONCURRENTLY ops.mv_sales_lines;
