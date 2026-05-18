-- v0.9.33 — Product family + product type taxonomies.
--
-- Adds two orthogonal item-attribute dimensions so margin reports can slice
-- by form factor (BIB, Can, Equipment, …) and by product nature (CSD, Juice,
-- Tea, …) independently of segment. Auto-populates assignments from existing
-- income_account_name + category_path + item-name patterns.
--
-- New segment: 'foodservice_equipment' (for Melt Equipment + non-bev kitchen
-- equipment). The existing 'equipment_sales' segment stays as the parent
-- bucket for non-foodservice equipment.

-- ── 1. New segment ────────────────────────────────────────────────────────
INSERT INTO ops.segments (segment_code, label, sort_order, is_active) VALUES
  ('foodservice_equipment', 'Foodservice Equipment', 6, true),
  ('rental',                'Rental',                85, true)
ON CONFLICT (segment_code) DO UPDATE
  SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- ── 2. Product Families taxonomy ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.product_families (
  family_code text PRIMARY KEY,
  label       text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.product_families (family_code, label, sort_order) VALUES
  ('bib',         'Bag in Box',          10),
  ('can',         'Can',                 20),
  ('bottle',      'Bottle',              25),
  ('postmix',     'Postmix',             30),
  ('melt_equip',  'Melt Equipment',      40),
  ('bev_equip',   'Beverage Equipment',  50),
  ('service',     'Service',             60),
  ('pm',          'Preventative Maintenance', 65),
  ('gas',         'Gas',                 70),
  ('rental',      'Rental',              80),
  ('parts',       'Parts',               85),
  ('reman',       'Remanufacturing',     90),
  ('scrap',       'Scrap',               95),
  ('other',       'Other',               99)
ON CONFLICT (family_code) DO UPDATE
  SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

ALTER TABLE ops.product_families ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_families_read  ON ops.product_families;
DROP POLICY IF EXISTS product_families_write ON ops.product_families;
CREATE POLICY product_families_read  ON ops.product_families FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY product_families_write ON ops.product_families FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.product_families TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.product_families TO authenticated;

-- ── 3. Product Types taxonomy ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.product_types (
  type_code   text PRIMARY KEY,
  label       text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.product_types (type_code, label, sort_order) VALUES
  ('csd',         'Carbonated Soft Drink', 10),
  ('juice',       'Juice',                 20),
  ('tea',         'Tea',                   30),
  ('lemonade',    'Lemonade',              40),
  ('energy',      'Energy',                50),
  ('mixer',       'Tonic / Mixer',         60),
  ('water',       'Water',                 70),
  ('coffee',      'Coffee',                75),
  ('hardware',    'Hardware',              80),
  ('consumable',  'Consumable',            85),
  ('labor',       'Labor / Service',       90),
  ('na',          'N/A',                   99)
ON CONFLICT (type_code) DO UPDATE
  SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

ALTER TABLE ops.product_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_types_read  ON ops.product_types;
DROP POLICY IF EXISTS product_types_write ON ops.product_types;
CREATE POLICY product_types_read  ON ops.product_types FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY product_types_write ON ops.product_types FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.product_types TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.product_types TO authenticated;

-- ── 4. Per-item assignment tables (keyed by qbo_item_id for stability) ────
CREATE TABLE IF NOT EXISTS ops.item_product_families (
  qbo_item_id text PRIMARY KEY,
  family_code text NOT NULL REFERENCES ops.product_families(family_code) ON DELETE RESTRICT,
  set_by      text,
  set_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.item_product_types (
  qbo_item_id text PRIMARY KEY,
  type_code   text NOT NULL REFERENCES ops.product_types(type_code) ON DELETE RESTRICT,
  set_by      text,
  set_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ipf_family ON ops.item_product_families(family_code);
CREATE INDEX IF NOT EXISTS idx_ipt_type   ON ops.item_product_types(type_code);

ALTER TABLE ops.item_product_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.item_product_types    ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ipf_read  ON ops.item_product_families;
DROP POLICY IF EXISTS ipf_write ON ops.item_product_families;
DROP POLICY IF EXISTS ipt_read  ON ops.item_product_types;
DROP POLICY IF EXISTS ipt_write ON ops.item_product_types;
CREATE POLICY ipf_read  ON ops.item_product_families FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY ipf_write ON ops.item_product_families FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY ipt_read  ON ops.item_product_types    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY ipt_write ON ops.item_product_types    FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.item_product_families, ops.item_product_types TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.item_product_families, ops.item_product_types TO authenticated;

-- ── 5. Auto-match: SEGMENTS (override existing category-level via item_segments)
-- Order matters: later patterns can override earlier; we use ON CONFLICT DO UPDATE.
INSERT INTO ops.item_segments (item_name, segment_code, set_by)
SELECT it.name,
       CASE
         WHEN it.category_path = 'The Melt Equipment'                              THEN 'foodservice_equipment'
         WHEN it.income_account_name IN ('Equipment Sales')                        THEN 'equipment_sales'
         WHEN it.income_account_name IN ('BIB Income','3 Gallon','5 Gallon')       THEN 'fountain'
         WHEN it.income_account_name IN ('Packaged Beverage Income','Shopify Sales','Beverage Fee Income') THEN 'packaged'
         WHEN it.income_account_name IN ('100% CO2','Mixed Gas and Nitro','Hazmat Del Fees','Gas COGS') THEN 'foodservice_gas'
         WHEN it.income_account_name IN ('Service Income','PM and Contract Service Income','Freshpet Service Income') THEN 'service'
         WHEN it.income_account_name = 'Scrap Income'                              THEN 'scrapping'
         WHEN it.income_account_name = 'Equipment Remanufacturing'                 THEN 'reman'
         WHEN it.income_account_name IN ('Equipment Rental Income','Tank Rental Income','Sublet Rental Income') THEN 'rental'
         ELSE 'other'
       END,
       'auto-match v0.9.33'
FROM ops.qbo_items it
WHERE it.active AND it.name IS NOT NULL
ON CONFLICT (item_name) DO UPDATE
  SET segment_code = EXCLUDED.segment_code,
      set_by       = EXCLUDED.set_by,
      set_at       = now()
  WHERE ops.item_segments.set_by LIKE 'auto-match%' OR ops.item_segments.set_by IS NULL;

-- ── 6. Auto-match: PRODUCT FAMILY ─────────────────────────────────────────
-- PM family is name-driven (explicit "PM" in item name); the income account
-- 'PM and Contract Service Income' mixes PM with general contract service,
-- so we don't classify by income_account alone.
INSERT INTO ops.item_product_families (qbo_item_id, family_code, set_by)
SELECT it.qbo_item_id,
       CASE
         WHEN it.category_path = 'The Melt Equipment'                              THEN 'melt_equip'
         WHEN it.income_account_name = 'Equipment Sales'                           THEN 'bev_equip'
         WHEN it.income_account_name IN ('BIB Income','3 Gallon','5 Gallon')
              OR it.name ~* '^([1-9]GSF|[1-9]GNS|[1-9]G)[0-9]'                     THEN 'bib'
         WHEN it.income_account_name IN ('Packaged Beverage Income','Shopify Sales','Beverage Fee Income')
              OR it.name ~* '^(24P|12P|6P|12OZ|16OZ)'                              THEN 'can'
         WHEN it.income_account_name IN ('100% CO2','Mixed Gas and Nitro','Hazmat Del Fees','Gas COGS') THEN 'gas'
         WHEN it.name ~* '\m(PM|PREVENTATIVE *MAINTENANCE)\M'                      THEN 'pm'
         WHEN it.income_account_name IN ('Service Income','PM and Contract Service Income','Freshpet Service Income') THEN 'service'
         WHEN it.income_account_name IN ('Equipment Rental Income','Tank Rental Income','Sublet Rental Income') THEN 'rental'
         WHEN it.income_account_name = 'Equipment Remanufacturing'                 THEN 'reman'
         WHEN it.income_account_name = 'Scrap Income'                              THEN 'scrap'
         ELSE 'other'
       END,
       'auto-match v0.9.33'
FROM ops.qbo_items it
WHERE it.active AND it.qbo_item_id IS NOT NULL
ON CONFLICT (qbo_item_id) DO UPDATE
  SET family_code = EXCLUDED.family_code,
      set_by      = EXCLUDED.set_by,
      set_at      = now()
  WHERE ops.item_product_families.set_by LIKE 'auto-match%' OR ops.item_product_families.set_by IS NULL;

-- ── 7. Auto-match: PRODUCT TYPE ───────────────────────────────────────────
-- For beverage SKUs (BIB/Can), classify by flavor keyword. For everything
-- else assign a structural type (hardware/labor/consumable/na).
INSERT INTO ops.item_product_types (qbo_item_id, type_code, set_by)
SELECT it.qbo_item_id,
       CASE
         -- Equipment / parts / scrap / reman → hardware
         WHEN it.category_path = 'The Melt Equipment'                              THEN 'hardware'
         WHEN it.income_account_name IN ('Equipment Sales','Equipment Remanufacturing','Scrap Income','Equipment Rental Income','Tank Rental Income','Sublet Rental Income') THEN 'hardware'
         -- Service / labor
         WHEN it.income_account_name IN ('Service Income','PM and Contract Service Income','Freshpet Service Income') THEN 'labor'
         -- Gas
         WHEN it.income_account_name IN ('100% CO2','Mixed Gas and Nitro','Hazmat Del Fees','Gas COGS') THEN 'consumable'
         -- Beverages — flavor keyword match
         WHEN it.name ~* '\m(JUICE|APPLE|CRANBERRY|FRUIT PUNCH|PINEAPPLE|SWEET *& *SOUR|PEACH|OJ|ORANGE JUICE)\M' THEN 'juice'
         WHEN it.name ~* '\mLEMONADE\M'                                            THEN 'lemonade'
         WHEN it.name ~* '\mTEA\M'                                                 THEN 'tea'
         WHEN it.name ~* '\mENERGY\M'                                              THEN 'energy'
         WHEN it.name ~* '\m(TONIC|MIXER|CLUB SODA)\M'                             THEN 'mixer'
         WHEN it.name ~* '\m(COFFEE)\M'                                            THEN 'coffee'
         WHEN it.name ~* '\m(WATER|H2O)\M' AND it.name !~* 'CARBONATED'            THEN 'water'
         WHEN it.name ~* '\m(COLA|ROOT *BEER|GINGER *ALE|LEMON.LIME|ORANGE|CREME|CRÈME|CHERRY|GRAPEFRUIT|GINGER *BEER|DOCTEUR *POIVRE|DR *POIVRE|DR *PEPPER|SODA|CSD)\M' THEN 'csd'
         -- BIB/Can without keyword match → default CSD (most likely)
         WHEN it.income_account_name IN ('BIB Income','3 Gallon','5 Gallon','Packaged Beverage Income','Shopify Sales')
              OR it.name ~* '^([1-9]GSF|[1-9]GNS|[1-9]G|24P|12P|12OZ|16OZ)'        THEN 'csd'
         ELSE 'na'
       END,
       'auto-match v0.9.33'
FROM ops.qbo_items it
WHERE it.active AND it.qbo_item_id IS NOT NULL
ON CONFLICT (qbo_item_id) DO UPDATE
  SET type_code = EXCLUDED.type_code,
      set_by    = EXCLUDED.set_by,
      set_at    = now()
  WHERE ops.item_product_types.set_by LIKE 'auto-match%' OR ops.item_product_types.set_by IS NULL;

-- ── 8. Expose product_family + product_type in v_sales_lines (append cols) ─
-- CREATE OR REPLACE VIEW requires the existing columns to be preserved in the
-- same order; we append product_family + product_type at the end.
CREATE OR REPLACE VIEW ops.v_sales_lines AS
WITH effective AS (
  SELECT l.id, l.invoice_id, l.item_ref_id, l.item_name, l.revenue_line,
         l.account_name, l.description, l.quantity, l.unit_price, l.amount,
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
       pf.label                                       AS product_family,
       pt.label                                       AS product_type
FROM effective e
  JOIN      ops.qbo_invoices    i      ON i.id              = e.invoice_id
  LEFT JOIN ops.item_segments   is_map ON is_map.item_name  = e.item_name
  LEFT JOIN ops.segments        s_item ON s_item.segment_code = is_map.segment_code AND s_item.is_active
  LEFT JOIN ops.category_segments cs   ON cs.category       = e.revenue_line
  LEFT JOIN ops.segments        s_cat  ON s_cat.segment_code = cs.segment_code AND s_cat.is_active
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = e.item_ref_id
  LEFT JOIN ops.product_families       pf  ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = e.item_ref_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code     = ipt.type_code  AND pt.is_active
  LEFT JOIN LATERAL (
    SELECT array_agg(c.label ORDER BY c.sort_order)        AS channels,
           max(c.label) FILTER (WHERE cc.is_primary)       AS primary_channel
    FROM ops.customer_channels cc
      JOIN ops.channels c ON c.channel_code = cc.channel_code
    WHERE cc.qbo_customer_id = i.customer_ref_id
      AND c.is_active
  ) lc ON true;

GRANT SELECT ON ops.v_sales_lines TO anon, authenticated;
