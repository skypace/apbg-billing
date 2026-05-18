-- Sales plans / scenarios. Item-level monthly amounts; rollup by QBO income
-- account is what would be pushed to QBO Budget.
-- Applied to live DB on 2026-05-03.

CREATE TABLE IF NOT EXISTS ops.sales_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  fiscal_year int NOT NULL,
  scenario text NOT NULL DEFAULT 'base',
  notes text,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.sales_plan_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES ops.sales_plans(id) ON DELETE CASCADE,
  line_type text NOT NULL DEFAULT 'item',
  qbo_item_id text,
  item_name text,
  qbo_account_id text,
  account_name text,
  notes text,
  amounts numeric[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::numeric[],
  sort_order int NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(amounts) = 12)
);
CREATE INDEX IF NOT EXISTS idx_spl_plan ON ops.sales_plan_lines(plan_id);

ALTER TABLE ops.sales_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sales_plan_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_plans_read ON ops.sales_plans;
DROP POLICY IF EXISTS sales_plans_write ON ops.sales_plans;
CREATE POLICY sales_plans_read ON ops.sales_plans FOR SELECT TO authenticated USING (true);
CREATE POLICY sales_plans_write ON ops.sales_plans FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.sales_plans TO authenticated;

DROP POLICY IF EXISTS sales_plan_lines_read ON ops.sales_plan_lines;
DROP POLICY IF EXISTS sales_plan_lines_write ON ops.sales_plan_lines;
CREATE POLICY sales_plan_lines_read ON ops.sales_plan_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY sales_plan_lines_write ON ops.sales_plan_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.sales_plan_lines TO authenticated;

-- Account roll-up: groups plan lines by income account (from qbo_items
-- when item-level, or qbo_account_id when account-level) and returns
-- monthly + annual totals — the layer that would map to QBO Budget rows.
CREATE OR REPLACE FUNCTION ops.fn_plan_account_rollup(p_plan_id uuid)
RETURNS TABLE (
  qbo_account_id text, account_name text, line_count int,
  m1 numeric, m2 numeric, m3 numeric, m4 numeric, m5 numeric, m6 numeric,
  m7 numeric, m8 numeric, m9 numeric, m10 numeric, m11 numeric, m12 numeric,
  total numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH resolved AS (
    SELECT
      COALESCE(l.qbo_account_id, it.income_account_ref_id) AS qbo_account_id,
      COALESCE(l.account_name,   it.income_account_name)   AS account_name,
      l.amounts
    FROM ops.sales_plan_lines l
    LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.qbo_item_id
    WHERE l.plan_id = p_plan_id
  ),
  agg AS (
    SELECT
      qbo_account_id, COALESCE(account_name, '(unmapped)') AS account_name,
      count(*)::int AS line_count,
      sum(COALESCE(amounts[1], 0))::numeric AS m1,
      sum(COALESCE(amounts[2], 0))::numeric AS m2,
      sum(COALESCE(amounts[3], 0))::numeric AS m3,
      sum(COALESCE(amounts[4], 0))::numeric AS m4,
      sum(COALESCE(amounts[5], 0))::numeric AS m5,
      sum(COALESCE(amounts[6], 0))::numeric AS m6,
      sum(COALESCE(amounts[7], 0))::numeric AS m7,
      sum(COALESCE(amounts[8], 0))::numeric AS m8,
      sum(COALESCE(amounts[9], 0))::numeric AS m9,
      sum(COALESCE(amounts[10], 0))::numeric AS m10,
      sum(COALESCE(amounts[11], 0))::numeric AS m11,
      sum(COALESCE(amounts[12], 0))::numeric AS m12
    FROM resolved
    GROUP BY qbo_account_id, COALESCE(account_name, '(unmapped)')
  )
  SELECT qbo_account_id, account_name, line_count,
    m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12,
    (m1+m2+m3+m4+m5+m6+m7+m8+m9+m10+m11+m12) AS total
  FROM agg
  ORDER BY (m1+m2+m3+m4+m5+m6+m7+m8+m9+m10+m11+m12) DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_plan_account_rollup(uuid) TO authenticated;
