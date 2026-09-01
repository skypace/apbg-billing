-- 20260901a — signed line quantities on CreditMemo / RefundReceipt
--
-- QBO returns a POSITIVE Qty on a credit memo: the DOCUMENT is the negation,
-- not the line. sync-qbo stored that Qty verbatim while negating the amount,
-- and ops.v_sales_lines computes
--     est_cost   = effective_unit_cost * quantity
--     est_margin = amount - (effective_unit_cost * quantity)
-- so a credit reversed the sale's REVENUE while ADDING its COST.
--
-- Measured before this ran: 82 CreditMemo lines (21 carrying a cost),
-- revenue -$107,467.83, est_cost +$18,084.62 where it should be -$18,084.62 —
-- margin understated by $36,169.24 (twice the cost, because it lands on the
-- wrong side of the subtraction).
--
-- sync-qbo v47 fixes the WRITE path (signedQty). This repairs the rows already
-- on file, which the code fix cannot reach: syncOneType skips any invoice that
-- already has lines, and CDC only revisits transactions that change in QBO, so
-- these 2025-2026 credits would never be re-read.
--
-- The transform reproduces exactly what v47 now writes: stored value * -1 for a
-- sign=-1 transaction type. (v47 uses lineSign, which differs from the txn sign
-- only on DiscountLineDetail — and those lines carry no quantity, so the two
-- agree on every row this touches.) Idempotent: it only matches quantity > 0.
-- Reversible: negate the negatives back.
--
-- Checked before applying — the 3 rows here whose amount is NOT negative
-- (a restocking fee, two zero-value cylinder-return lines) all have
-- effective_unit_cost = 0, so their quantity sign cannot move est_cost at all.
--
-- RefundReceipt is included for correctness but matches 0 rows today: QBO
-- returns no Qty on refund-receipt lines (146 lines, all NULL quantity).

update ops.qbo_invoice_lines l
   set quantity = -l.quantity
  from ops.qbo_invoices i
 where i.id = l.invoice_id
   and i.txn_type in ('CreditMemo', 'RefundReceipt')
   and l.quantity > 0;

-- Margin Minder reads the materialized view, not the table, so it must be
-- rebuilt or it keeps serving the old numbers.
refresh materialized view ops.mv_sales_lines;
