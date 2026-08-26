-- 20260826e_vendor_credits.sql
-- Vendor credits: a credit memo from a vendor gets a home.
--
-- A credit memo is filed like a bill (same OCR, same review, same manual
-- Post gate) but posts to QuickBooks as a VENDOR CREDIT, and is consumed by
-- applying it inside a pay run: the QBO BillPayment takes credit lines
-- natively, so one payment = selected bills − applied credits, and the
-- remittance advice shows the vendor exactly which credit offset which bills.
--
-- Design choices that matter:
--   * `is_credit` rides expense_requests (amounts stay POSITIVE — the flag
--     carries the sign) so every existing pipeline (OCR, attachments,
--     duplicate gate, lifecycle tabs) works on credits unchanged.
--   * Credits are EXCLUDED from ops.v_ap_aging: aging answers "what do we
--     owe and how late is it", and a credit is not a payable — it shows up
--     where it is actionable instead (the Pay Bills page).
--   * The paid-sync (lib/qbo-bill-status.mjs) queries the VendorCredit
--     entity for credit rows — Balance 0 there means FULLY APPLIED, which is
--     a credit's "paid". Asking the Bill entity about a VendorCredit id
--     would repeat this morning's false-"missing" bug with the sign flipped.

-- ── 1. the flag ───────────────────────────────────────────────────────────────
ALTER TABLE ops.expense_requests
  ADD COLUMN IF NOT EXISTS is_credit BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN ops.expense_requests.is_credit IS
  'Vendor credit memo: posts to QBO as a VendorCredit (not a Bill) and is consumed by applying it in a pay run. Amount stays positive — this flag carries the sign.';

-- ── 2. credits are not payables — keep them out of the aging view ─────────────
create or replace view ops.v_ap_aging
with (security_invoker = true) as
select
  r.id,
  r.vendor_name,
  r.bill_number,
  r.total_amount,
  r.receipt_date,
  r.due_date,
  r.payment_terms,
  r.status,
  r.tag,
  r.entity,
  r.department,
  r.manager_email,
  r.submitter_email,
  r.qbo_bill_id,
  (r.qbo_bill_id is not null) as posted,
  case when r.due_date is null then null
       else (current_date - r.due_date) end as days_overdue,
  case
    when r.due_date is null                        then 'no due date'
    when r.due_date >= current_date                then 'current'
    when current_date - r.due_date <= 30           then '1-30'
    when current_date - r.due_date <= 60           then '31-60'
    when current_date - r.due_date <= 90           then '61-90'
    else '90+'
  end as aging_bucket
from ops.expense_requests r
where r.archived_at is null
  and r.paid_at is null
  and r.as_bill is true
  and r.is_credit is not true
  and r.request_type = 'expense'
  and r.status not in ('denied','cancelled');

comment on view ops.v_ap_aging is
  'Unpaid vendor bills held in Brixpense, bucketed by days past due. Covers the window before a bill reaches QuickBooks as well as after — a posted-but-unpaid bill stays here until paid_at is stamped. Vendor credits (is_credit) are excluded: a credit is not a payable — it lives on the Pay Bills page where it can be applied.';

-- ── 3. a pure credit application moves no money — the group total may be 0 ────
ALTER TABLE ops.vendor_payment_groups
  DROP CONSTRAINT IF EXISTS vendor_payment_groups_total_amount_check;
ALTER TABLE ops.vendor_payment_groups
  ADD CONSTRAINT vendor_payment_groups_total_amount_check CHECK (total_amount >= 0);
