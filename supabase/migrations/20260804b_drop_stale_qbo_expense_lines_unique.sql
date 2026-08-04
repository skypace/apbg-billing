-- 20260804b — unblock the QBO AP mirror (applied live 2026-08-04).
--
-- ops.qbo_expense_lines carried TWO overlapping unique constraints:
--   qbo_expense_lines_qbo_txn_id_qbo_txn_type_line_num_key  (txn_id, txn_type, line_num)
--   qbo_expense_lines_txn_line_key_unique                   (txn_type, txn_id, line_key)
--
-- sync-qbo-expenses v10 (2026-07-04) introduced line_key and moved its upsert to
-- the second one, precisely because QBO Purchase lines usually have LineNum NULL
-- (7,078 of 9,507 rows here) so line_num is not an identity. But the old
-- constraint was never dropped. An upsert can only resolve ONE conflict target:
-- any line whose line_key differs from what is stored but whose line_num matches
-- an existing row is attempted as an INSERT and trips the other constraint,
-- aborting the chunk — and with it the entire nightly run.
--
-- Result: the mirror froze at 2026-07-03 and the 09:40 UTC cron logged
-- status='error' EVERY night for a month. Every report reading this table was
-- silently a month stale, including the SF-expense duplicate check that has to
-- know whether a bill was already entered into QBO by hand.
--
-- line_key (Line.Id -> LineNum -> content hash) is the real identity. Drop the
-- superseded constraint. After this the catch-up run took 7 seconds.
alter table ops.qbo_expense_lines
  drop constraint if exists qbo_expense_lines_qbo_txn_id_qbo_txn_type_line_num_key;

comment on column ops.qbo_expense_lines.line_num is
  'QBO Line.LineNum — NULL on most Purchase lines. NOT an identity column; '
  'uniqueness is (qbo_txn_type, qbo_txn_id, line_key). A unique constraint on '
  'line_num was dropped 2026-08-04 after it deadlocked the upsert for a month.';
