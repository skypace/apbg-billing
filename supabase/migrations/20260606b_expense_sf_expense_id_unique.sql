-- Guarantee one Brixpense row per SF expense, even if the ResQ sync
-- (resq-sf-sync-background, */5) and the sf-receipt-sync edge function
-- (*/10 crawl, */15 fresh) race on the same expense. Both landers dedup on
-- sf_expense_id via a SELECT-then-INSERT check, which is racy under concurrency;
-- a UNIQUE index makes the loser's INSERT fail cleanly (both code paths treat
-- insert errors as non-fatal) instead of writing a duplicate draft.
drop index if exists ops.expense_requests_sf_expense_id_idx;
create unique index if not exists expense_requests_sf_expense_id_key
  on ops.expense_requests (sf_expense_id) where sf_expense_id is not null;
