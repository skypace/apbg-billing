-- Tier-1 payout: record vendor payments on expense_requests + link the QBO BillPayment.
-- payment_account_{id,name,type} already exist. status gains a 'paid' value (text column, no enum change).
alter table ops.expense_requests
  add column if not exists payment_method      text,
  add column if not exists payment_reference   text,
  add column if not exists paid_at             timestamptz,
  add column if not exists paid_by             text,
  add column if not exists qbo_billpayment_id  text;

comment on column ops.expense_requests.payment_method     is 'How the bill was paid: qbo_bill_pay | amex | zelle | venmo | check | ach | other';
comment on column ops.expense_requests.payment_reference  is 'Confirmation / check / transaction number for the payment';
comment on column ops.expense_requests.paid_at            is 'When the payment was recorded';
comment on column ops.expense_requests.paid_by            is 'Email of the user who recorded the payment';
comment on column ops.expense_requests.qbo_billpayment_id is 'QBO BillPayment.Id when the payment was written back to QuickBooks';
