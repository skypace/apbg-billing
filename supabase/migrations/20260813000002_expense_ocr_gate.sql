-- SF-expense OCR gate: hold auto-post until a bill has gone through OCR and
-- carries a real bill/invoice number. See netlify/functions/sf-expense-ocr-
-- background.mjs (new) + sf-expense-autopost-background.mjs (gated).
--
-- ops.expense_request_attachments.ocr_result already existed (declared in the
-- original 20260512_create_expense_tables.sql) but nothing ever wrote to it —
-- it's the per-attachment home for the raw Claude extraction. The columns
-- below are the per-request rollup the autopost gate actually queries on.

alter table ops.expense_requests
  add column if not exists bill_number text,          -- OCR-extracted vendor invoice/bill number; flows to QBO Bill.DocNumber
  add column if not exists ocr_status text,            -- null (not yet run) | 'processed' | 'no_attachment' | 'failed'
  add column if not exists ocr_processed_at timestamptz,
  add column if not exists ocr_error text,
  add column if not exists ocr_notified_at timestamptz; -- dedup for the "needs review" email

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'expense_requests_ocr_status_check'
  ) then
    alter table ops.expense_requests
      add constraint expense_requests_ocr_status_check
      check (ocr_status is null or ocr_status in ('processed', 'no_attachment', 'failed'));
  end if;
end $$;
