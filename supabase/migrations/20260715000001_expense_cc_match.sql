-- Card/expense feed merge: link a Brixpense expense_request to the QBO Purchase
-- (card charge / cash expense / check) that represents the same real-world spend.
-- Applied live to gfsdpwiqzshhexkofiif on 2026-07-15 via Supabase MCP.
alter table ops.expense_requests
  add column if not exists qbo_purchase_id text,
  add column if not exists qbo_purchase_matched_at timestamptz,
  add column if not exists qbo_purchase_matched_by text;

-- One QBO Purchase links to at most one Brixpense record.
create unique index if not exists expense_requests_qbo_purchase_id_key
  on ops.expense_requests (qbo_purchase_id)
  where qbo_purchase_id is not null;
