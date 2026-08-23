-- P&L-backed net margin.
--
-- Margin rows still use invoice lines for drilldown, but the company-level net
-- margin total must reconcile to QuickBooks P&L. The old overhead function read
-- qbo_expense_lines directly, missed unmapped P&L expense accounts, and ignored
-- the gross-margin gap between invoice-line estimates and the P&L.

CREATE OR REPLACE FUNCTION ops.fn_pl_margin_summary(
  p_start date DEFAULT '2025-01-01',
  p_end date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  revenue numeric,
  cogs numeric,
  gross_margin numeric,
  operating_expenses numeric,
  net_margin numeric,
  gross_margin_pct numeric,
  net_margin_pct numeric,
  account_count bigint,
  period_start date,
  period_end date,
  months numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH base AS (
    SELECT
      period::date AS period,
      account_name,
      account_type,
      amount::numeric AS amount
    FROM ops.pl_snapshots
    WHERE period::date >= p_start
      AND period::date <= p_end
  ),
  agg AS (
    SELECT
      COALESCE(sum(amount) FILTER (
        WHERE account_type = 'Income'
           OR (account_type = 'Other' AND account_name ~* '(income|fee)')
      ), 0)::numeric AS revenue,
      COALESCE(sum(amount) FILTER (WHERE account_type = 'Cost of Goods Sold'), 0)::numeric AS cogs,
      COALESCE(sum(amount) FILTER (
        WHERE account_type IN ('Expense', 'Other Expense')
           OR (account_type = 'Other' AND account_name !~* '(income|fee)')
      ), 0)::numeric AS operating_expenses,
      count(DISTINCT account_name)::bigint AS account_count,
      min(period)::date AS period_start,
      max(period)::date AS period_end,
      GREATEST(1, (p_end - p_start + 1))::numeric / 30.4375 AS months
    FROM base
  )
  SELECT
    revenue,
    cogs,
    revenue - cogs AS gross_margin,
    operating_expenses,
    revenue - cogs - operating_expenses AS net_margin,
    CASE WHEN revenue <> 0 THEN (revenue - cogs) / revenue ELSE NULL END::numeric AS gross_margin_pct,
    CASE WHEN revenue <> 0 THEN (revenue - cogs - operating_expenses) / revenue ELSE NULL END::numeric AS net_margin_pct,
    account_count,
    period_start,
    period_end,
    round(months, 4) AS months
  FROM agg;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_pl_margin_summary(date, date) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_overhead_total(
  p_start date,
  p_end date,
  p_entity text DEFAULT NULL
)
RETURNS TABLE(
  pool_id bigint,
  pool_name text,
  basis text,
  entity text,
  monthly_amount numeric,
  pool_total numeric,
  months numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH win AS (
    SELECT GREATEST(1, (p_end - p_start + 1))::numeric / 30.4375 AS months
  ),
  pl_expense AS (
    SELECT
      account_name,
      account_type,
      sum(amount)::numeric AS amount
    FROM ops.pl_snapshots
    WHERE period::date >= p_start
      AND period::date <= p_end
      AND (
        account_type IN ('Expense', 'Other Expense')
        OR (account_type = 'Other' AND account_name !~* '(income|fee)')
      )
    GROUP BY 1, 2
  ),
  mapped AS (
    SELECT
      COALESCE(
        CASE WHEN ebt.is_allocable THEN eb.bucket_code END,
        'oh'
      ) AS bucket_code,
      pl.amount
    FROM pl_expense pl
    LEFT JOIN ops.expense_buckets eb
      ON pl.account_name = eb.account_name
      OR regexp_replace(pl.account_name, '^.*:', '') = eb.account_name
      OR regexp_replace(eb.account_name, '^.*:', '') = pl.account_name
    LEFT JOIN ops.expense_bucket_types ebt ON ebt.bucket_code = eb.bucket_code
    -- p_entity is reserved but currently a no-op: pl_snapshots has no entity
    -- attribution. Wire it up if/when P&L snapshots gain that dimension.
  ),
  agg AS (
    SELECT
      ebt.bucket_code,
      ebt.label,
      ebt.allocation_basis,
      round(sum(abs(mapped.amount))::numeric, 2) AS pool_total
    FROM mapped
    JOIN ops.expense_bucket_types ebt ON ebt.bucket_code = mapped.bucket_code
    WHERE ebt.is_allocable = TRUE
    GROUP BY ebt.bucket_code, ebt.label, ebt.allocation_basis
  )
  SELECT
    (abs(hashtext(a.bucket_code)))::bigint AS pool_id,
    a.label AS pool_name,
    a.allocation_basis AS basis,
    NULL::text AS entity,
    round((a.pool_total / NULLIF(win.months, 0))::numeric, 2) AS monthly_amount,
    a.pool_total AS pool_total,
    round(win.months, 4) AS months
  FROM agg a, win
  WHERE a.pool_total <> 0
  ORDER BY a.pool_total DESC;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_overhead_total(date, date, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
