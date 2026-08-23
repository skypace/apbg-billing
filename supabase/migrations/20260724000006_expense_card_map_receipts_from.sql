-- Accountability start date per card (applied live 2026-07-24 via Supabase
-- MCP). The weekly card-receipt audit only expects receipts for transactions
-- dated ON/AFTER expense_card_map.receipts_from — stamped when the card is
-- assigned, so a newly onboarded employee is never chased for swipes made
-- before they had the Brixpense app (the same forward-only principle as
-- SF_AUTOPOST_MIN_RECEIPT_DATE). Back/future-datable from the assign flow.
alter table ops.expense_card_map
  add column if not exists receipts_from date default current_date;
