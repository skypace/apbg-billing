-- Sales reps taxonomy + per-customer M2M assignment, mirroring channels.
-- Adds 'sales_rep' as a new dim everywhere (filter / Group By / sparkline /
-- drill-through). Push-back-to-QBO support is deferred to a separate slice
-- (push-qbo-customer-types edge function will mirror primary rep into QBO Class).
-- Applied to live DB on 2026-05-03.

CREATE TABLE IF NOT EXISTS ops.sales_reps (
  rep_code   text PRIMARY KEY,
  name       text NOT NULL,
  email      text,
  notes      text,
  sort_order int  NOT NULL DEFAULT 100,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ops.sales_reps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_reps_read  ON ops.sales_reps;
DROP POLICY IF EXISTS sales_reps_write ON ops.sales_reps;
CREATE POLICY sales_reps_read  ON ops.sales_reps FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY sales_reps_write ON ops.sales_reps FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.sales_reps TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.sales_reps TO authenticated;

CREATE TABLE IF NOT EXISTS ops.customer_sales_reps (
  qbo_customer_id text NOT NULL REFERENCES ops.qbo_customers(qbo_customer_id) ON DELETE CASCADE,
  rep_code        text NOT NULL REFERENCES ops.sales_reps(rep_code) ON DELETE RESTRICT,
  is_primary      boolean NOT NULL DEFAULT false,
  notes           text, set_by text,
  set_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (qbo_customer_id, rep_code)
);
CREATE INDEX IF NOT EXISTS idx_csr_rep ON ops.customer_sales_reps(rep_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_csr_one_primary ON ops.customer_sales_reps(qbo_customer_id) WHERE is_primary;
ALTER TABLE ops.customer_sales_reps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS csr_read  ON ops.customer_sales_reps;
DROP POLICY IF EXISTS csr_write ON ops.customer_sales_reps;
CREATE POLICY csr_read  ON ops.customer_sales_reps FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY csr_write ON ops.customer_sales_reps FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.customer_sales_reps TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.customer_sales_reps TO authenticated;

-- v_sales_lines exposes sales_reps[] + primary_sales_rep, mirroring channels.
-- All RPCs (fn_sales_pivot, fn_sales_pivot_compare, fn_sales_totals,
-- fn_pivot_drill, fn_sparkline, fn_sales_dim_values, fn_customer_classification_list)
-- recreated with p_sales_reps support. fn_set_customer_sales_reps mirrors
-- fn_set_customer_channels.
-- Full SQL applied via mcp apply_migration "sales_reps_taxonomy_v2".
