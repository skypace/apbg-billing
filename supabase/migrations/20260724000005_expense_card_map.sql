-- Card → user map for company-card attribution (applied live 2026-07-24 via
-- Supabase MCP). Bank memos on QBO card Purchases carry the card's last four
-- (verified live: 'XXXX1029' Capital One style, trailing '- 5939' style), so
-- each swipe can be attributed to its cardholder. Managed from Master Control
-- → Card & Expense Match → Cardholders (expense-cc-match assign_card action).
-- No per-cardholder sub-accounts exist in QBO (one flat account per card
-- program), so memo-parsing is the only attribution path.
create table if not exists ops.expense_card_map (
  last4 text primary key check (last4 ~ '^[0-9]{4}$'),
  label text,
  user_id uuid,
  user_email text,
  user_name text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table ops.expense_card_map enable row level security;
create policy expense_card_map_select_staff on ops.expense_card_map
  for select to authenticated using (ops.fn_is_staff());
-- writes via service role only (expense-cc-match function)
