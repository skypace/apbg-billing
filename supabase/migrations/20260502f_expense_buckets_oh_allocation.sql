-- Expense buckets for OH allocation. Maps every QBO expense / COGS account
-- name to one of: labor_service, labor_delivery, labor_management, fuel,
-- rent, insurance, oh, or cogs_material. Anything unmapped collapses into
-- 'oh' so total operating expense is preserved.
--
-- Material COGS accounts are tagged 'cogs_material' so the dashboard knows
-- to EXCLUDE them from allocation (already counted via Item.PurchaseCost
-- in v_sales_lines.est_cost).
--
-- Applied to live DB on 2026-05-02.

CREATE TABLE IF NOT EXISTS ops.expense_bucket_types (
  bucket_code text PRIMARY KEY,
  label       text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 100
);

INSERT INTO ops.expense_bucket_types (bucket_code, label, sort_order) VALUES
  ('labor_service',    'Service Labor',     10),
  ('labor_delivery',   'Delivery Labor',    20),
  ('labor_management', 'Mgmt Labor',        30),
  ('fuel',             'Fuel',              40),
  ('rent',             'Rent',              50),
  ('insurance',        'Insurance',         60),
  ('oh',               'Overhead',          70),
  ('cogs_material',    'Material COGS (already in est_cost)', 99)
ON CONFLICT (bucket_code) DO UPDATE SET label=EXCLUDED.label, sort_order=EXCLUDED.sort_order;

GRANT SELECT ON ops.expense_bucket_types TO anon, authenticated;

CREATE TABLE IF NOT EXISTS ops.expense_buckets (
  account_name text PRIMARY KEY,
  bucket_code  text NOT NULL REFERENCES ops.expense_bucket_types(bucket_code),
  notes        text,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.expense_buckets (account_name, bucket_code, set_by) VALUES
  ('Service - Direct Labor (COGS)',           'labor_service',    'seed'),
  ('Reman - Direct Labor (COGS)',             'labor_service',    'seed'),
  ('Freshpet Service Cost',                   'labor_service',    'seed'),
  ('Equipment Remanufacturing',               'labor_service',    'seed'),
  ('Ice Machine Repair (COGS)',               'labor_service',    'seed'),
  ('CO2 Cylinder Repair',                     'labor_service',    'seed'),
  ('Fountain Repairs (COGS)',                 'labor_service',    'seed'),
  ('B2B - Direct Labor (COGS)',               'labor_delivery',   'seed'),
  ('Wages',                                   'labor_delivery',   'seed (mostly drivers; reclassify if wrong)'),
  ('Officers Wages',                          'labor_management', 'seed'),
  ('Officer Salary to Reclass to Due from',   'labor_management', 'seed'),
  ('Fuel',                                    'fuel',             'seed'),
  ('Bridge & Toll',                           'fuel',             'seed'),
  ('67100 Rent Expense',                      'rent',             'seed'),
  ('Vehicle Insurance',                       'insurance',        'seed'),
  ('Workers Compensation',                    'insurance',        'seed'),
  ('AR Insurance',                            'insurance',        'seed'),
  ('63330 Life and Disability',               'insurance',        'seed'),
  ('General Liability',                       'insurance',        'seed'),
  ('Equipment Sales COGS',                    'cogs_material',    'seed'),
  ('3 Gal',                                   'cogs_material',    'seed'),
  ('5 Gal',                                   'cogs_material',    'seed'),
  ('Packaged Beverage (COGS)',                'cogs_material',    'seed'),
  ('100% CO2',                                'cogs_material',    'seed'),
  ('Mixed Gas and Nitro',                     'cogs_material',    'seed'),
  ('Fountain - New Installs',                 'cogs_material',    'seed'),
  ('Repack - leaking 24pks',                  'cogs_material',    'seed'),
  ('Inventory Shrinkage',                     'cogs_material',    'seed'),
  ('Shipping Inbound (COGS)',                 'cogs_material',    'seed'),
  ('Shipping Outbound (COGS)',                'cogs_material',    'seed'),
  ('Shopify - Shipping Outbound (COGS)',      'cogs_material',    'seed'),
  ('3rd Party Delivery COGS',                 'cogs_material',    'seed')
ON CONFLICT (account_name) DO NOTHING;

ALTER TABLE ops.expense_buckets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_buckets_read  ON ops.expense_buckets;
DROP POLICY IF EXISTS expense_buckets_write ON ops.expense_buckets;
CREATE POLICY expense_buckets_read  ON ops.expense_buckets FOR SELECT USING (true);
CREATE POLICY expense_buckets_write ON ops.expense_buckets FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.expense_buckets TO anon, authenticated;
GRANT ALL ON ops.expense_buckets TO service_role;

CREATE OR REPLACE FUNCTION ops.fn_period_cost_buckets(
  p_start date DEFAULT '2025-01-01',
  p_end   date DEFAULT current_date
) RETURNS TABLE (
  bucket_code   text,
  label         text,
  sort_order    int,
  total         numeric,
  account_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH period AS (
    SELECT pl.account_name, pl.account_type, sum(pl.amount)::numeric AS amount
    FROM ops.pl_snapshots pl
    WHERE pl.period::date >= p_start AND pl.period::date <= p_end
      AND pl.account_type IN ('Expense', 'Cost of Goods Sold', 'Other Expense')
    GROUP BY 1, 2
  ),
  bucketed AS (
    SELECT COALESCE(eb.bucket_code, 'oh') AS bucket_code,
           p.account_name,
           ABS(p.amount)::numeric AS amount
    FROM period p
    LEFT JOIN ops.expense_buckets eb ON eb.account_name = p.account_name
  )
  SELECT bt.bucket_code, bt.label, bt.sort_order,
         COALESCE(sum(b.amount), 0)::numeric,
         count(b.account_name)::bigint
  FROM ops.expense_bucket_types bt
  LEFT JOIN bucketed b ON b.bucket_code = bt.bucket_code
  GROUP BY bt.bucket_code, bt.label, bt.sort_order
  ORDER BY bt.sort_order;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_period_cost_buckets(date, date) TO anon, authenticated;
