-- Add a natural unique key so sync-qbo can UPSERT lines instead of DELETE+INSERT.
-- The previous flow (delete all lines for an invoice, then re-insert) created a
-- brief empty-lines window where the cache reported $0 revenue for that invoice;
-- if the function got killed mid-loop (Supabase 150s idle timeout), some
-- invoices were left with NO lines. sync-qbo v39 uses ON CONFLICT(invoice_id,
-- line_num) instead.

-- Strip any pre-existing dupes first so the constraint can be added.
DELETE FROM ops.qbo_invoice_lines a
USING ops.qbo_invoice_lines b
WHERE a.id < b.id
  AND a.invoice_id = b.invoice_id
  AND a.line_num = b.line_num;

ALTER TABLE ops.qbo_invoice_lines
  ADD CONSTRAINT qbo_invoice_lines_inv_line_unique
  UNIQUE (invoice_id, line_num);
