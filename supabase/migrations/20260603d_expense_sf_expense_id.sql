-- Dedup key for the all-work-order SF expense sweep (sf-expense-sweep):
-- the Service Fusion expense id, so a scheduled re-run never lands the same
-- expense twice. Nullable (only SF-swept rows carry it).
alter table ops.expense_requests add column if not exists sf_expense_id text;
create index if not exists expense_requests_sf_expense_id_idx
  on ops.expense_requests (sf_expense_id) where sf_expense_id is not null;
comment on column ops.expense_requests.sf_expense_id is
  'Service Fusion expense id — dedup key for the all-work-order expense sweep (sf-expense-sweep).';
