-- Workstream B revision: source overhead from expense_buckets (real QBO $)
-- instead of the manually-typed overhead_pools system.
--
-- 1) Extend expense_bucket_types with allocable flag + allocation_basis.
-- 2) Seed sensible defaults (Overhead, Rent, Insurance, Mgmt Labor all
--    flagged as allocable, basis = revenue).
-- 3) Rewrite fn_overhead_total to aggregate qbo_expense_lines by bucket,
--    joining on the leaf account name (last token after ':'). Keeps the
--    same return shape so the Margin frontend keeps working unchanged.
-- 4) Drop the obsolete overhead_pools + overhead_overrides tables.

------------------------------------------------------------------------
-- 1. Schema extension
------------------------------------------------------------------------
ALTER TABLE ops.expense_bucket_types
  ADD COLUMN IF NOT EXISTS is_allocable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allocation_basis TEXT NOT NULL DEFAULT 'revenue'
    CHECK (allocation_basis IN ('revenue', 'unit_volume', 'sku_equal_share', 'margin_contribution'));

------------------------------------------------------------------------
-- 2. Defaults — turn on allocable for traditional overhead buckets
------------------------------------------------------------------------
UPDATE ops.expense_bucket_types
SET is_allocable = TRUE, allocation_basis = 'revenue'
WHERE bucket_code IN ('oh', 'rent', 'insurance', 'labor_management');

------------------------------------------------------------------------
-- 3. fn_overhead_total — source from real QBO expense lines
------------------------------------------------------------------------
-- The leaf-name normalizer strips QBO hierarchy prefixes like
-- 'Automobile Expense:Fuel' -> 'Fuel'. We fall back to exact match when
-- the bucket account already includes the prefix ('67100 Rent Expense').
DROP FUNCTION IF EXISTS ops.fn_overhead_total(DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION ops.fn_overhead_total(
  p_start  DATE,
  p_end    DATE,
  p_entity TEXT DEFAULT NULL
)
RETURNS TABLE (
  pool_id        BIGINT,
  pool_name      TEXT,
  basis          TEXT,
  entity         TEXT,
  monthly_amount NUMERIC,
  pool_total     NUMERIC,
  months         NUMERIC
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ops, public
AS $$
  WITH win AS (
    SELECT GREATEST(1, (p_end - p_start + 1))::NUMERIC / 30.4375 AS months
  ),
  matched AS (
    SELECT
      ebt.bucket_code,
      ebt.label,
      ebt.allocation_basis,
      qel.amount
    FROM ops.expense_bucket_types ebt
    JOIN ops.expense_buckets       eb  ON eb.bucket_code = ebt.bucket_code
    JOIN ops.qbo_expense_lines     qel
      ON  qel.txn_date BETWEEN p_start AND p_end
      AND (
           qel.account_name = eb.account_name
        OR regexp_replace(qel.account_name, '^.*:', '') = eb.account_name
        OR regexp_replace(eb.account_name,  '^.*:', '') = qel.account_name
      )
    WHERE ebt.is_allocable = TRUE
      AND (p_entity IS NULL OR p_entity = p_entity)
  ),
  agg AS (
    SELECT
      bucket_code,
      label,
      allocation_basis,
      ROUND(SUM(ABS(amount))::NUMERIC, 2) AS pool_total
    FROM matched
    GROUP BY bucket_code, label, allocation_basis
  )
  SELECT
    (ABS(hashtext(a.bucket_code)))::BIGINT   AS pool_id,
    a.label                                   AS pool_name,
    a.allocation_basis                        AS basis,
    NULL::TEXT                                AS entity,
    ROUND((a.pool_total / NULLIF(win.months, 0))::NUMERIC, 2) AS monthly_amount,
    a.pool_total                              AS pool_total,
    ROUND(win.months, 4)                      AS months
  FROM agg a, win
  WHERE a.pool_total > 0
  ORDER BY a.pool_total DESC;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_overhead_total(DATE, DATE, TEXT) TO authenticated;

------------------------------------------------------------------------
-- 4. Drop the parallel system
------------------------------------------------------------------------
DROP TABLE IF EXISTS ops.overhead_overrides;
DROP TABLE IF EXISTS ops.overhead_pools;
