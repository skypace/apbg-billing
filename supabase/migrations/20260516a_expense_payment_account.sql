-- Brixpense: receipt expenses post as QBO Purchases (not Bills) so a missing
-- QBO Vendor record no longer blocks the auto-post. A QBO Purchase requires
-- an AccountRef = the account the expense was paid FROM (credit card / bank
-- / petty cash). The submitter picks it on the form via the "Paid with"
-- dropdown.
--
-- payment_account_id   — QBO Account.Id, used as AccountRef on the Purchase
-- payment_account_name — display label cached at submission time
-- payment_account_type — QBO Account.AccountType, drives PaymentType:
--                          'Credit Card' → PaymentType='CreditCard'
--                          'Bank'        → PaymentType='Check'
--                          else          → PaymentType='Cash'

ALTER TABLE ops.expense_requests
  ADD COLUMN IF NOT EXISTS payment_account_id text,
  ADD COLUMN IF NOT EXISTS payment_account_name text,
  ADD COLUMN IF NOT EXISTS payment_account_type text;

COMMENT ON COLUMN ops.expense_requests.payment_account_id IS
  'QBO Account.Id used as AccountRef on the Purchase entry (the account the expense was paid FROM — credit card / bank / petty cash).';
COMMENT ON COLUMN ops.expense_requests.payment_account_type IS
  'QBO Account.AccountType — drives PaymentType on the Purchase. Bank → Check, CreditCard → CreditCard, else Cash.';
