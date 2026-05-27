-- expense_bucket_types only had SELECT grants — the new is_allocable +
-- allocation_basis toggles in Settings silently failed because authenticated
-- couldn't UPDATE the row. Grant write perms + add RLS policies matching
-- the pattern used by other ops tables.

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.expense_bucket_types TO authenticated;

ALTER TABLE ops.expense_bucket_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_bucket_types_read  ON ops.expense_bucket_types;
DROP POLICY IF EXISTS expense_bucket_types_write ON ops.expense_bucket_types;

CREATE POLICY expense_bucket_types_read
  ON ops.expense_bucket_types FOR SELECT TO anon, authenticated USING (TRUE);

CREATE POLICY expense_bucket_types_write
  ON ops.expense_bucket_types FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);
