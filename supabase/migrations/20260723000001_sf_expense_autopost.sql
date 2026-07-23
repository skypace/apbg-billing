-- Auto-post support for the SF-expense → QBO-bill pipeline
-- (netlify/functions/sf-expense-autopost-background.mjs).
-- Applied live to gfsdpwiqzshhexkofiif on 2026-07-23 via Supabase MCP.
alter table ops.expense_requests
  add column if not exists autopost_notified_at timestamptz,   -- last "needs attention" email sent (dedup)
  add column if not exists autopost_error text,                -- why it couldn't post (blank vendor / no QBO match / QBO error)
  add column if not exists autopost_bill_emailed_at timestamptz; -- confirmation email sent for the posted bill (dedup)
