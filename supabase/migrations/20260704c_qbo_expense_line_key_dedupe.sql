-- QBO expense-line duplicate guard.
--
-- sync-qbo-expenses used qbo_txn_id/qbo_txn_type/line_num as its upsert key,
-- but QBO Purchase rows often land with line_num = NULL. PostgreSQL unique
-- constraints treat NULL values as distinct, so every expense sync appended
-- another copy of the same Purchase lines. That inflated overhead totals and
-- actual-cost calculations in Margin.

ALTER TABLE ops.qbo_expense_lines
  ADD COLUMN IF NOT EXISTS line_key text;

UPDATE ops.qbo_expense_lines
SET line_key = COALESCE(
  line_num::text,
  md5(concat_ws('|',
    detail_type,
    COALESCE(item_ref_id, ''),
    COALESCE(item_name, ''),
    COALESCE(account_ref_id, ''),
    COALESCE(account_name, ''),
    COALESCE(description, ''),
    COALESCE(quantity::text, ''),
    COALESCE(unit_cost::text, ''),
    COALESCE(amount::text, ''),
    COALESCE(txn_date::text, ''),
    COALESCE(vendor_name, '')
  ))
)
WHERE line_key IS NULL;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY qbo_txn_type, qbo_txn_id, line_key
      ORDER BY synced_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM ops.qbo_expense_lines
)
DELETE FROM ops.qbo_expense_lines q
USING ranked r
WHERE q.id = r.id
  AND r.rn > 1;

ALTER TABLE ops.qbo_expense_lines
  ALTER COLUMN line_key SET NOT NULL;

ALTER TABLE ops.qbo_expense_lines
  DROP CONSTRAINT IF EXISTS qbo_expense_lines_txn_line_key_unique;

ALTER TABLE ops.qbo_expense_lines
  ADD CONSTRAINT qbo_expense_lines_txn_line_key_unique
  UNIQUE (qbo_txn_type, qbo_txn_id, line_key);

COMMENT ON COLUMN ops.qbo_expense_lines.line_key IS
  'Stable per-transaction line identity used for QBO expense upserts. Handles QBO Purchase lines where line_num is null.';
