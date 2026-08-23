-- Add hosted-payment URL to the invoice mirror.
--
-- QBO exposes Invoice.InvoiceLink (a hosted "Pay now" page) when QuickBooks
-- e-invoicing is enabled on the company. brix-order's /invoices/:id surface
-- renders a "Pay now" CTA pointing at this URL so customers can settle their
-- balance by ACH or card; the resulting payment lands in QBO and flows back
-- through sync-qbo into ops.qbo_invoices.balance / .status.
--
-- Populated by sync-qbo v40+: when fetching per-invoice detail (the read used
-- to mirror line items), the function passes ?include=invoiceLink&minorversion=70
-- and writes the returned InvoiceLink on the header row. NULL for txn_types
-- that don't have a hosted invoice (SalesReceipt / CreditMemo / RefundReceipt)
-- and for Invoice rows where QBO e-invoicing was off at sync time.

ALTER TABLE ops.qbo_invoices
  ADD COLUMN IF NOT EXISTS invoice_payment_url text;

COMMENT ON COLUMN ops.qbo_invoices.invoice_payment_url IS
  'QBO-hosted payment-page URL (Invoice.InvoiceLink). Populated by sync-qbo on each per-invoice read. Used by brix-order /invoices/:id "Pay now" CTA. NULL for non-Invoice txn_types or invoices without e-invoicing enabled.';
