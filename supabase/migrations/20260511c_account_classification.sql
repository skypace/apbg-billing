-- v0.9.8 — Auto-classify P&L accounts by their relationship to items.
--
-- For each account in qbo_expense_lines, we derive:
--   1) how many active items point to it (income / expense / asset),
--   2) whether its name suggests a balance-sheet / financial account
--      that shouldn't roll into overhead at all,
--   3) a suggested bucket the user can accept with one click.
--
-- Rule highlights:
--   * 'Payroll Expenses:%' is always operating (the trailing "to Reclass
--     to Due from..." wording must NOT trigger balance-sheet detection).
--   * 'Cost of Goods Sold%' is always operating (P&L), regardless of any
--     'Inventory' keyword in the subtree.
--   * 'Asset Cost%' is financial (capex / depreciation-adjacent).
--   * Item-tied expense accounts (items_as_expense > 0) suggest
--     cogs_material — they're already in est_cost.

CREATE OR REPLACE VIEW ops.v_account_classification AS
WITH item_links AS (
  SELECT expense_account_name AS account_name, 'expense'::text AS role, COUNT(*) AS items_tied
  FROM ops.qbo_items WHERE expense_account_name IS NOT NULL AND active
  GROUP BY expense_account_name
  UNION ALL
  SELECT income_account_name,  'income',  COUNT(*) FROM ops.qbo_items
  WHERE income_account_name IS NOT NULL AND active GROUP BY income_account_name
  UNION ALL
  SELECT asset_account_name,   'asset',   COUNT(*) FROM ops.qbo_items
  WHERE asset_account_name  IS NOT NULL AND active GROUP BY asset_account_name
),
account_rolls AS (
  SELECT
    account_name,
    SUM(items_tied) FILTER (WHERE role = 'expense') AS items_as_expense,
    SUM(items_tied) FILTER (WHERE role = 'income')  AS items_as_income,
    SUM(items_tied) FILTER (WHERE role = 'asset')   AS items_as_asset,
    SUM(items_tied)                                  AS items_total
  FROM item_links
  GROUP BY account_name
),
expense_rolls AS (
  SELECT account_name FROM ops.qbo_expense_lines WHERE account_name IS NOT NULL GROUP BY account_name
)
SELECT
  e.account_name,
  COALESCE(r.items_as_expense, 0) AS items_as_expense,
  COALESCE(r.items_as_income,  0) AS items_as_income,
  COALESCE(r.items_as_asset,   0) AS items_as_asset,
  COALESCE(r.items_total,      0) AS items_total,
  CASE
    WHEN upper(e.account_name) LIKE 'PAYROLL EXPENSES%' THEN 'operating'
    WHEN upper(e.account_name) LIKE 'COST OF GOODS SOLD%' THEN 'operating'
    WHEN upper(e.account_name) LIKE 'ASSET COST%' THEN 'financial'
    WHEN upper(e.account_name) ~ '(RECEIVABLE|PAYABLE|LINE OF CREDIT|^DUE FROM|^DUE TO|CHECKING|SAVINGS|^CASH|SUSPENSE|EQUITY|RETAINED|CAPITAL|FORD CREDIT|CHASE|SBA|EIDL|^LOAN|MORTGAGE|UNDEPOSITED)'
      THEN 'balance_sheet'
    WHEN upper(e.account_name) ~ '(INTEREST EXPENSE|DEPRECIATION|AMORTIZATION)'
      THEN 'financial'
    ELSE 'operating'
  END AS account_role,
  CASE
    WHEN upper(e.account_name) LIKE 'ASSET COST%' THEN NULL
    WHEN upper(e.account_name) ~ '(INTEREST EXPENSE|DEPRECIATION|AMORTIZATION)' THEN NULL
    WHEN upper(e.account_name) NOT LIKE 'PAYROLL EXPENSES%'
      AND upper(e.account_name) NOT LIKE 'COST OF GOODS SOLD%'
      AND upper(e.account_name) ~ '(RECEIVABLE|PAYABLE|LINE OF CREDIT|^DUE FROM|^DUE TO|CHECKING|SAVINGS|^CASH|SUSPENSE|EQUITY|RETAINED|CAPITAL|FORD CREDIT|CHASE|SBA|EIDL|^LOAN|MORTGAGE|UNDEPOSITED)'
      THEN NULL
    WHEN COALESCE(r.items_as_expense, 0) > 0 THEN 'cogs_material'
    WHEN upper(e.account_name) ~ '(FREIGHT|SHIPPING|3RD PARTY DELIVERY)' THEN 'cogs_material'
    WHEN upper(e.account_name) ~ '(OFFICER|MANAGEMENT|EXECUTIVE)' THEN 'labor_management'
    WHEN upper(e.account_name) ~ '(SERVICE.*LABOR|REMAN.*LABOR|SERVICE.*DIRECT|REMAN.*DIRECT|SERVICE EXPENSE)' THEN 'labor_service'
    WHEN upper(e.account_name) ~ '(DELIVERY.*LABOR|B2B.*DIRECT|WAGES|PAYROLL)' THEN 'labor_delivery'
    WHEN upper(e.account_name) ~ '(RENT)' THEN 'rent'
    WHEN upper(e.account_name) ~ '(INSURANCE|WORKERS COMP|LIABILITY)' THEN 'insurance'
    WHEN upper(e.account_name) ~ '(FUEL|GASOLINE|BRIDGE|TOLL)' THEN 'fuel'
    ELSE 'oh'
  END AS suggested_bucket
FROM expense_rolls e
LEFT JOIN account_rolls r ON r.account_name = e.account_name;

GRANT SELECT ON ops.v_account_classification TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_propose_account_buckets(
  p_start DATE,
  p_end   DATE
)
RETURNS TABLE (
  account_name      TEXT,
  ytd               NUMERIC,
  items_total       INTEGER,
  items_as_expense  INTEGER,
  items_as_income   INTEGER,
  account_role      TEXT,
  current_bucket    TEXT,
  suggested_bucket  TEXT
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ops, public
AS $$
  WITH y AS (
    SELECT account_name, SUM(ABS(amount))::NUMERIC AS ytd
    FROM ops.qbo_expense_lines
    WHERE txn_date BETWEEN p_start AND p_end
      AND account_name IS NOT NULL
    GROUP BY account_name
  )
  SELECT
    y.account_name,
    ROUND(y.ytd, 0)                              AS ytd,
    v.items_total::INTEGER                       AS items_total,
    v.items_as_expense::INTEGER                  AS items_as_expense,
    v.items_as_income::INTEGER                   AS items_as_income,
    v.account_role,
    (
      SELECT eb.bucket_code FROM ops.expense_buckets eb
      WHERE eb.account_name = y.account_name
        OR regexp_replace(eb.account_name, '^.*:', '') = regexp_replace(y.account_name, '^.*:', '')
      LIMIT 1
    )                                            AS current_bucket,
    v.suggested_bucket
  FROM y
  LEFT JOIN ops.v_account_classification v ON v.account_name = y.account_name
  ORDER BY y.ytd DESC;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_propose_account_buckets(DATE, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_bulk_set_account_buckets(
  p_assignments JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ops, public
AS $$
DECLARE
  upserted INTEGER := 0;
  rec      RECORD;
BEGIN
  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR rec IN SELECT * FROM jsonb_to_recordset(p_assignments) AS x(account_name TEXT, bucket_code TEXT)
  LOOP
    IF rec.bucket_code IS NULL OR rec.account_name IS NULL THEN CONTINUE; END IF;
    PERFORM ops.fn_set_account_bucket(rec.account_name, rec.bucket_code);
    upserted := upserted + 1;
  END LOOP;
  RETURN upserted;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_bulk_set_account_buckets(JSONB) TO authenticated;
