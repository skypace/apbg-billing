-- QBO inventory adjustments sync. Each adjustment line has a signed
-- qty_diff: negative = shrinkage / write-off / damage, positive =
-- found / count-up. Feeds fn_inventory_health so velocity reflects real
-- consumption (sold + |negative adjustments|), not just sales.
-- Applied to live DB on 2026-05-03.

CREATE TABLE IF NOT EXISTS ops.qbo_inventory_adjustments (
  id                       bigserial PRIMARY KEY,
  qbo_txn_id               text UNIQUE NOT NULL,
  txn_date                 date,
  ref_number               text,
  adjustment_account_id    text,
  adjustment_account_name  text,
  memo                     text,
  total_lines              int,
  synced_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.qbo_inventory_adjustment_lines (
  id            bigserial PRIMARY KEY,
  qbo_txn_id    text NOT NULL,
  line_num      int,
  item_ref_id   text,
  item_name     text,
  qty_diff      numeric,
  new_qty       numeric,
  description   text,
  txn_date      date,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (qbo_txn_id, line_num)
);

CREATE INDEX IF NOT EXISTS idx_qia_lines_item ON ops.qbo_inventory_adjustment_lines(item_ref_id);
CREATE INDEX IF NOT EXISTS idx_qia_lines_date ON ops.qbo_inventory_adjustment_lines(txn_date);

ALTER TABLE ops.qbo_inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.qbo_inventory_adjustment_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qia_read       ON ops.qbo_inventory_adjustments;
DROP POLICY IF EXISTS qia_lines_read ON ops.qbo_inventory_adjustment_lines;
CREATE POLICY qia_read       ON ops.qbo_inventory_adjustments      FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY qia_lines_read ON ops.qbo_inventory_adjustment_lines FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON ops.qbo_inventory_adjustments      TO anon, authenticated;
GRANT SELECT ON ops.qbo_inventory_adjustment_lines TO anon, authenticated;
GRANT ALL    ON ops.qbo_inventory_adjustments      TO service_role;
GRANT ALL    ON ops.qbo_inventory_adjustment_lines TO service_role;

-- fn_inventory_health was redefined to include adjustment_qty +
-- shrinkage_qty in its return, and to add the negative adjustments to
-- the velocity numerator. Full SQL applied via apply_migration
-- "qbo_inventory_adjustments".
