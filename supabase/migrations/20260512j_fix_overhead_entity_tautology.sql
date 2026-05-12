-- v0.9.35a — Remove tautological p_entity filter on fn_overhead_total.
--
-- The function shipped with `AND (p_entity IS NULL OR p_entity = p_entity)`,
-- which is always true — and qbo_expense_lines has no entity column to
-- filter against anyway. The parameter stays in the signature so existing
-- callers don't break, but it's now a documented no-op. If/when QBO
-- expense lines gain an entity attribution, the filter can be wired up
-- with a real predicate.

CREATE OR REPLACE FUNCTION ops.fn_overhead_total(
  p_start date,
  p_end   date,
  p_entity text DEFAULT NULL
)
RETURNS TABLE(pool_id bigint, pool_name text, basis text, entity text,
              monthly_amount numeric, pool_total numeric, months numeric)
LANGUAGE sql STABLE SET search_path = ops, public
AS $function$
  WITH win AS (
    SELECT GREATEST(1, (p_end - p_start + 1))::numeric / 30.4375 AS months
  ),
  matched AS (
    SELECT ebt.bucket_code, ebt.label, ebt.allocation_basis, qel.amount
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
    -- p_entity is reserved but currently a no-op: qbo_expense_lines has no
    -- entity column. Wire it up if/when expense-line attribution exists.
  ),
  agg AS (
    SELECT bucket_code, label, allocation_basis,
           round(sum(abs(amount))::numeric, 2) AS pool_total
    FROM matched
    GROUP BY bucket_code, label, allocation_basis
  )
  SELECT
    (abs(hashtext(a.bucket_code)))::bigint           AS pool_id,
    a.label                                          AS pool_name,
    a.allocation_basis                               AS basis,
    NULL::text                                       AS entity,
    round((a.pool_total / NULLIF(win.months, 0))::numeric, 2) AS monthly_amount,
    a.pool_total                                     AS pool_total,
    round(win.months, 4)                             AS months
  FROM agg a, win
  WHERE a.pool_total > 0
  ORDER BY a.pool_total DESC;
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_overhead_total(date, date, text) TO authenticated;
