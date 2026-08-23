-- Sub-segments: split Equipment Sales / Scrapping / Remanufacturing out of Service.
-- Adds ops.item_segments for item-level overrides (beats category-level mapping).
-- Applied to live DB on 2026-05-02.

INSERT INTO ops.segments (segment_code, label, sort_order) VALUES
  ('equipment_sales', 'Equipment Sales',     5),
  ('scrapping',       'Scrapping',           7),
  ('reman',           'Remanufacturing',     8)
ON CONFLICT (segment_code) DO UPDATE SET label=EXCLUDED.label, sort_order=EXCLUDED.sort_order;

UPDATE ops.segments SET label = 'Service' WHERE segment_code = 'service';

UPDATE ops.category_segments SET segment_code = 'equipment_sales' WHERE category = 'Equipment Sales';
UPDATE ops.category_segments SET segment_code = 'reman'           WHERE category = 'Service - Reman';

CREATE TABLE IF NOT EXISTS ops.item_segments (
  item_name    text PRIMARY KEY,
  segment_code text NOT NULL REFERENCES ops.segments(segment_code) ON DELETE RESTRICT,
  notes        text,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.item_segments (item_name, segment_code, notes, set_by) VALUES
  ('REF-SCRAP UNIT', 'scrapping', 'scrap revenue from FreeFlow service ops', 'seed')
ON CONFLICT (item_name) DO NOTHING;

ALTER TABLE ops.item_segments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS item_segments_read  ON ops.item_segments;
DROP POLICY IF EXISTS item_segments_write ON ops.item_segments;
CREATE POLICY item_segments_read  ON ops.item_segments FOR SELECT USING (true);
CREATE POLICY item_segments_write ON ops.item_segments FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.item_segments TO anon, authenticated;
GRANT ALL ON ops.item_segments TO service_role;

-- v_sales_lines: prefer item-level segment over category-level
DROP VIEW IF EXISTS ops.v_sales_lines CASCADE;

CREATE VIEW ops.v_sales_lines AS
SELECT
  l.id AS line_id, l.invoice_id, i.qbo_invoice_id, i.doc_number, i.txn_date,
  date_trunc('month', i.txn_date)::date AS txn_month,
  extract(year FROM i.txn_date)::int    AS txn_year,
  i.customer_ref_id, i.customer_name, i.entity,
  i.department AS invoice_department, l.department AS line_department,
  l.item_ref_id, l.item_name,
  l.revenue_line AS category,
  COALESCE(s_item.label, s_cat.label) AS segment,
  l.account_name, l.description, l.quantity, l.unit_price,
  l.amount AS revenue,
  it.purchase_cost, it.type AS item_type,
  it.income_account_name, it.expense_account_name,
  CASE WHEN it.purchase_cost IS NOT NULL AND l.quantity IS NOT NULL
       THEN it.purchase_cost * l.quantity ELSE NULL END  AS est_cost,
  CASE WHEN it.purchase_cost IS NOT NULL AND l.quantity IS NOT NULL
       THEN l.amount - (it.purchase_cost * l.quantity) ELSE NULL END AS est_margin,
  COALESCE(lc.channels, ARRAY[]::text[]) AS channels,
  lc.primary_channel
FROM ops.qbo_invoice_lines l
JOIN ops.qbo_invoices i ON i.id = l.invoice_id
LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.item_ref_id
LEFT JOIN ops.item_segments is_map ON is_map.item_name = l.item_name
LEFT JOIN ops.segments s_item ON s_item.segment_code = is_map.segment_code AND s_item.is_active
LEFT JOIN ops.category_segments cs ON cs.category = l.revenue_line
LEFT JOIN ops.segments s_cat ON s_cat.segment_code = cs.segment_code AND s_cat.is_active
LEFT JOIN LATERAL (
  SELECT array_agg(c.label ORDER BY c.sort_order) AS channels,
         max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
  FROM ops.customer_channels cc
  JOIN ops.channels c ON c.channel_code = cc.channel_code
  WHERE cc.qbo_customer_id = i.customer_ref_id AND c.is_active
) lc ON TRUE;

GRANT SELECT ON ops.v_sales_lines TO anon, authenticated;

-- (RPCs were recreated unchanged from 20260502b/d signatures; full SQL applied
-- via apply_migration "segment_subdivision_v2".)
