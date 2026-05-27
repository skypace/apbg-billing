-- Item-level expense lines from Bills/Purchases for true weighted-avg
-- landed cost. Pairs with the sync-qbo-expenses edge function.
-- Applied to live DB on 2026-05-03.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qbo_expenses_txn_unique') THEN
    ALTER TABLE ops.qbo_expenses ADD CONSTRAINT qbo_expenses_txn_unique UNIQUE (qbo_txn_id, qbo_txn_type);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ops.qbo_expense_lines (
  id              bigserial PRIMARY KEY,
  qbo_txn_id      text NOT NULL,
  qbo_txn_type    text NOT NULL,
  line_num        int,
  detail_type     text,
  item_ref_id     text,
  item_name       text,
  account_ref_id  text,
  account_name    text,
  description     text,
  quantity        numeric,
  unit_cost       numeric,
  amount          numeric,
  txn_date        date,
  vendor_name     text,
  synced_at       timestamptz DEFAULT now(),
  UNIQUE (qbo_txn_id, qbo_txn_type, line_num)
);

CREATE INDEX IF NOT EXISTS idx_qel_item ON ops.qbo_expense_lines(item_ref_id);
CREATE INDEX IF NOT EXISTS idx_qel_date ON ops.qbo_expense_lines(txn_date);
CREATE INDEX IF NOT EXISTS idx_qel_txn  ON ops.qbo_expense_lines(qbo_txn_id, qbo_txn_type);

ALTER TABLE ops.qbo_expense_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qbo_expense_lines_read ON ops.qbo_expense_lines;
CREATE POLICY qbo_expense_lines_read ON ops.qbo_expense_lines FOR SELECT USING (true);
GRANT SELECT ON ops.qbo_expense_lines TO anon, authenticated;
GRANT ALL ON ops.qbo_expense_lines TO service_role;

CREATE OR REPLACE FUNCTION ops.fn_item_avg_cost(
  p_start date DEFAULT '2025-01-01', p_end date DEFAULT current_date
) RETURNS TABLE (
  qbo_item_id text, item_name text,
  total_qty numeric, total_cost numeric,
  avg_unit_cost numeric, txn_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  SELECT
    item_ref_id,
    mode() WITHIN GROUP (ORDER BY item_name),
    sum(quantity)::numeric, sum(amount)::numeric,
    CASE WHEN sum(quantity) > 0 THEN sum(amount) / sum(quantity) ELSE NULL END,
    count(*)::bigint
  FROM ops.qbo_expense_lines
  WHERE detail_type = 'ItemBasedExpenseLineDetail'
    AND item_ref_id IS NOT NULL
    AND txn_date >= p_start AND txn_date <= p_end
    AND quantity IS NOT NULL AND quantity > 0
  GROUP BY 1
  ORDER BY total_cost DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_item_avg_cost(date, date) TO anon, authenticated;
