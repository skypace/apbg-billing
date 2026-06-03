-- QBO Location tracking ("Department") on expenses.
-- Submitters can tag any expense with a QBO Department (dropdown + add-new on
-- the form, sourced from /api/expense-departments). The id is posted as
-- DepartmentRef on the resulting QBO Bill / Purchase (expense-request-notify).
alter table ops.expense_requests
  add column if not exists qbo_department_id   text,
  add column if not exists qbo_department_name text;

comment on column ops.expense_requests.qbo_department_id   is 'QBO Department.Id (Location tracking) → posted as DepartmentRef on the bill/purchase';
comment on column ops.expense_requests.qbo_department_name is 'Cached QBO Department name for display/reporting without a QBO round-trip';
