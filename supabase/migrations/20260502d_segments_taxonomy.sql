-- Segment taxonomy: 4 product/service segments + Other catchall.
-- Maps each revenue_line (category) to one segment via ops.category_segments.
-- v_sales_lines gains a `segment` column; RPCs gain p_segments filter + 'segment' dim.
-- Applied to live DB on 2026-05-02.

CREATE TABLE IF NOT EXISTS ops.segments (
  segment_code text PRIMARY KEY,
  label        text NOT NULL,
  sort_order   int  NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true
);

INSERT INTO ops.segments (segment_code, label, sort_order) VALUES
  ('service',         'Service Business',            10),
  ('fountain',        'Fountain Products',           20),
  ('packaged',        'Packaged Beverage Products',  30),
  ('foodservice_gas', 'Foodservice Gas Products',    40),
  ('other',           'Other',                       90)
ON CONFLICT (segment_code) DO UPDATE SET label=EXCLUDED.label, sort_order=EXCLUDED.sort_order;

ALTER TABLE ops.segments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS segments_read ON ops.segments;
CREATE POLICY segments_read ON ops.segments FOR SELECT USING (true);
GRANT SELECT ON ops.segments TO anon, authenticated;
GRANT ALL    ON ops.segments TO service_role;

CREATE TABLE IF NOT EXISTS ops.category_segments (
  category     text PRIMARY KEY,
  segment_code text NOT NULL REFERENCES ops.segments(segment_code) ON DELETE RESTRICT,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.category_segments (category, segment_code, set_by) VALUES
  ('Equipment Sales',         'service',         'seed'),
  ('Equipment Rental',        'service',         'seed'),
  ('Service - General',       'service',         'seed'),
  ('Service - Reman',         'service',         'seed'),
  ('Service - PM Contract',   'service',         'seed'),
  ('Service - Freshpet',      'service',         'seed'),
  ('BIB - 3 Gallon',          'fountain',        'seed'),
  ('BIB - 5 Gallon',          'fountain',        'seed'),
  ('BIB - Delivery Fees',     'fountain',        'seed'),
  ('Packaged Beverage',       'packaged',        'seed'),
  ('Shopify Sales',           'packaged',        'seed'),
  ('Gas - CO2',               'foodservice_gas', 'seed'),
  ('Gas - Hazmat Fees',       'foodservice_gas', 'seed'),
  ('Gas - Mixed/Nitro',       'foodservice_gas', 'seed'),
  ('Markup',                  'other',           'seed'),
  ('Shipping Income',         'other',           'seed'),
  ('Shipping and Delivery',   'other',           'seed')
ON CONFLICT (category) DO NOTHING;

ALTER TABLE ops.category_segments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS category_segments_read  ON ops.category_segments;
DROP POLICY IF EXISTS category_segments_write ON ops.category_segments;
CREATE POLICY category_segments_read  ON ops.category_segments FOR SELECT USING (true);
CREATE POLICY category_segments_write ON ops.category_segments FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.category_segments TO anon, authenticated;
GRANT ALL ON ops.category_segments TO service_role;

-- Postgres won't reorder columns in CREATE OR REPLACE VIEW, so DROP CASCADE
-- and recreate. The CASCADE drops the dependent RPCs; we recreate them below
-- with the new p_segments parameter.
DROP VIEW IF EXISTS ops.v_sales_lines CASCADE;

CREATE VIEW ops.v_sales_lines AS
SELECT
  l.id                AS line_id,
  l.invoice_id,
  i.qbo_invoice_id,
  i.doc_number,
  i.txn_date,
  date_trunc('month', i.txn_date)::date AS txn_month,
  extract(year FROM i.txn_date)::int    AS txn_year,
  i.customer_ref_id,
  i.customer_name,
  i.entity,
  i.department        AS invoice_department,
  l.department        AS line_department,
  l.item_ref_id,
  l.item_name,
  l.revenue_line      AS category,
  s.label             AS segment,
  l.account_name,
  l.description,
  l.quantity,
  l.unit_price,
  l.amount            AS revenue,
  it.purchase_cost,
  it.type             AS item_type,
  it.income_account_name,
  it.expense_account_name,
  CASE WHEN it.purchase_cost IS NOT NULL AND l.quantity IS NOT NULL
       THEN it.purchase_cost * l.quantity ELSE NULL END  AS est_cost,
  CASE WHEN it.purchase_cost IS NOT NULL AND l.quantity IS NOT NULL
       THEN l.amount - (it.purchase_cost * l.quantity) ELSE NULL END AS est_margin,
  COALESCE(lc.channels, ARRAY[]::text[]) AS channels,
  lc.primary_channel
FROM ops.qbo_invoice_lines l
JOIN ops.qbo_invoices i ON i.id = l.invoice_id
LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.item_ref_id
LEFT JOIN ops.category_segments cs ON cs.category = l.revenue_line
LEFT JOIN ops.segments s ON s.segment_code = cs.segment_code AND s.is_active
LEFT JOIN LATERAL (
  SELECT
    array_agg(c.label ORDER BY c.sort_order) AS channels,
    max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
  FROM ops.customer_channels cc
  JOIN ops.channels c ON c.channel_code = cc.channel_code
  WHERE cc.qbo_customer_id = i.customer_ref_id AND c.is_active
) lc ON TRUE;

GRANT SELECT ON ops.v_sales_lines TO anon, authenticated;

-- RPCs recreated with p_segments parameter. See live DB / 20260502b for the
-- full earlier signatures; only the additions are documented here.
-- (Full SQL applied via mcp__d091b47c-...__apply_migration "segments_taxonomy_v2".)
