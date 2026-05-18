-- Make ops.qbo_invoices polymorphic across QBO sales-transaction types.
--
-- Until now the cache only held QBO Invoice rows. QBO P&L revenue actually
-- comes from FOUR entities — Invoice, SalesReceipt, CreditMemo, RefundReceipt
-- — and the cache was missing the latter three. Reconciliation showed the
-- 3-Gallon bucket was $16.6K below QBO truth (SalesReceipts), Equipment
-- Sales was $234K over (un-applied CreditMemos), and Shopify Sales / Sales
-- of Product Income were 100% missing (Shopify uses SalesReceipts).
--
-- Paired with sync-qbo edge function v38 which loops over all four entity
-- types, sign-flips CreditMemo + RefundReceipt amounts (they REDUCE income),
-- and parses DiscountLineDetail (which v36 silently skipped).

ALTER TABLE ops.qbo_invoices
  ADD COLUMN IF NOT EXISTS txn_type text NOT NULL DEFAULT 'Invoice';

ALTER TABLE ops.qbo_invoices
  ADD CONSTRAINT qbo_invoices_txn_type_check
  CHECK (txn_type IN ('Invoice','SalesReceipt','CreditMemo','RefundReceipt'));

ALTER TABLE ops.qbo_invoices
  DROP CONSTRAINT qbo_invoices_qbo_invoice_id_key;

ALTER TABLE ops.qbo_invoices
  ADD CONSTRAINT qbo_invoices_qbo_id_type_key UNIQUE (qbo_invoice_id, txn_type);

CREATE INDEX IF NOT EXISTS qbo_invoices_txn_type_idx ON ops.qbo_invoices (txn_type);
