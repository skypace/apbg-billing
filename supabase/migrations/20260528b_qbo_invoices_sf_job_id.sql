-- Add Service Fusion job-id link to the invoice mirror.
--
-- Brix-order /invoices/:id wants to show "Job #1089501883" so customers
-- can cross-reference their delivery / service record with the invoice
-- that bills it. The link doesn't exist natively in QBO — there's no
-- foreign-key field — so sync-qbo extracts it best-effort from QBO's
-- PrivateNote / CustomerMemo via a regex (`Job #?\d{8,12}` or
-- `SF[-\s]?\d{8,12}`).
--
-- For invoices that were created by an automation that already includes
-- the SF job number in the memo, this will populate immediately on the
-- next sync. For older invoices (or invoices created without the
-- convention), the column stays NULL and brix-order's UI omits the
-- "Job #" line. Future work can cross-reference SF directly by
-- customer+date+amount, but the regex path covers the common case at
-- zero extra API cost.
--
-- Populated by sync-qbo v41+.

ALTER TABLE ops.qbo_invoices
  ADD COLUMN IF NOT EXISTS sf_job_id text;

CREATE INDEX IF NOT EXISTS qbo_invoices_sf_job_id_idx
  ON ops.qbo_invoices (sf_job_id)
  WHERE sf_job_id IS NOT NULL;

COMMENT ON COLUMN ops.qbo_invoices.sf_job_id IS
  'Service Fusion job id linked to this invoice. Extracted by sync-qbo from the QBO PrivateNote / CustomerMemo via regex. NULL when the memo carries no job reference; brix-order omits the Job# row in that case.';
