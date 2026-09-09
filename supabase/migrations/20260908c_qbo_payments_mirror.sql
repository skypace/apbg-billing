-- ============================================================================
-- ops.qbo_payments — mirror of QuickBooks customer PAYMENTS (2026-09-08)
-- ============================================================================
-- Ask (Sky): a customer should be able to see the unapplied amount of a payment
-- they sent — "payment 9544 applied here and X amount of dollars left open".
--
-- Nothing in this database held customer payments. ops mirrored Invoice,
-- SalesReceipt, CreditMemo and RefundReceipt; ops.vendor_payments is AP (money
-- we pay OUT). So "how much of the cheque is still sitting on the account" was
-- unanswerable from Postgres — it lived only in QuickBooks.
--
-- Two tables, because the ask has two halves: the payment (what came in, what
-- is left) and its APPLICATIONS (which invoices it went to). A remainder with
-- no breakdown does not answer "applied here".
--
-- ⚠ UnappliedAmt IS NOT QUERYABLE in the QBO API (verified 2026-09-08:
--   "property 'UnappliedAmt' is not queryable", code 4001 — the same trap as
--   POStatus on PurchaseOrder). The sync therefore mirrors EVERY payment in its
--   window and filters in SQL here. Do not "optimise" the sync by adding a
--   WHERE UnappliedAmt > 0 to the QBO query; it 400s the whole request.
--
-- ⚠ PaymentRefNum IS queryable and is capped at 21 chars by QBO. That cap is
--   why a Stripe intent lands truncated ("pi_3UDDVNHgMdK5e0gw1A"); match on the
--   truncation, never on the full id.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ops.qbo_payments (
  id                      bigserial PRIMARY KEY,
  qbo_payment_id          text        NOT NULL UNIQUE,
  customer_ref_id         text        NOT NULL,
  txn_date                date        NOT NULL,
  total_amount            numeric(14,2) NOT NULL DEFAULT 0,
  -- What QuickBooks says is still sitting on the account for this payment.
  unapplied_amount        numeric(14,2) NOT NULL DEFAULT 0,
  -- Cheque number, ACH reference, or a truncated Stripe pi_ — whatever the
  -- payer or the rail put on it. This is the number a customer quotes back.
  payment_ref_num         text,
  payment_method_ref_id   text,
  payment_method_name     text,
  deposit_account_ref_id  text,
  private_note            text,
  qbo_created_at          timestamptz,
  qbo_updated_at          timestamptz,
  synced_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.qbo_payments IS
  'Mirror of QBO Payment (customer money IN). Written only by the sync-qbo-payments edge function. unapplied_amount is QBO UnappliedAmt — the part of the payment not yet applied to an invoice.';

CREATE INDEX IF NOT EXISTS qbo_payments_customer_idx  ON ops.qbo_payments (customer_ref_id, txn_date DESC);
-- The working index for every surface this feature adds.
CREATE INDEX IF NOT EXISTS qbo_payments_unapplied_idx ON ops.qbo_payments (customer_ref_id) WHERE unapplied_amount > 0;
-- Duplicate detection joins payments to each other on the reference.
CREATE INDEX IF NOT EXISTS qbo_payments_ref_idx       ON ops.qbo_payments (payment_ref_num) WHERE payment_ref_num IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.qbo_payment_lines (
  id              bigserial PRIMARY KEY,
  payment_id      bigint  NOT NULL REFERENCES ops.qbo_payments(id) ON DELETE CASCADE,
  qbo_payment_id  text    NOT NULL,
  -- Position in the payment's Line array. NOT NULL and set from position when
  -- QBO gives us nothing else.
  -- ⚠ This column is NOT NULL on purpose. ops.qbo_inventory_adjustment_lines
  --   keyed its upsert on a line_num QBO does not send, the key never matched
  --   because NULLs are distinct in a unique index, and every nightly run
  --   re-inserted every line: 125,694 rows for 1,138 real ones, which read as
  --   24,770 units of phantom shrinkage. Never let this be NULL.
  line_num        integer NOT NULL,
  qbo_invoice_id  text,
  linked_txn_type text,
  amount          numeric(14,2) NOT NULL DEFAULT 0,
  UNIQUE (qbo_payment_id, line_num)
);

COMMENT ON TABLE ops.qbo_payment_lines IS
  'What a QBO Payment was applied to, one row per Line. Deleted and rewritten per payment on every sync, so an application removed in QuickBooks disappears here too.';

CREATE INDEX IF NOT EXISTS qbo_payment_lines_invoice_idx ON ops.qbo_payment_lines (qbo_invoice_id);

-- Service-role only, both directions: this is a mirror, written by one edge
-- function and read through scoped views in `orders`. No anon, no authenticated
-- — a customer payment record names amounts and references for every account on
-- a SHARED project (brix-order customers, distributors, foodservice logins all
-- authenticate here), so a permissive read would leak the whole cash book.
ALTER TABLE ops.qbo_payments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.qbo_payment_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.qbo_payments      FROM anon, authenticated;
REVOKE ALL ON ops.qbo_payment_lines FROM anon, authenticated;
GRANT ALL ON ops.qbo_payments      TO service_role;
GRANT ALL ON ops.qbo_payment_lines TO service_role;
GRANT USAGE, SELECT ON SEQUENCE ops.qbo_payments_id_seq      TO service_role;
GRANT USAGE, SELECT ON SEQUENCE ops.qbo_payment_lines_id_seq TO service_role;

-- ── Duplicate detection ─────────────────────────────────────────────────────
-- On 2026-09-08 fourteen portal Stripe payments were found booked into QBO
-- TWICE: the charge path books inline, then patches our row with the QBO id a
-- moment later, and the payment_intent.succeeded webhook fires inside that gap,
-- sees no id and books a second Payment. The invoices are already settled, so
-- QuickBooks parks the twin as a full UnappliedAmt — a credit that does not
-- exist. $6,512.92 of it.
--
-- Until those are cleaned up (and to catch any that slip through afterwards)
-- this flags a payment whose reference, customer, amount AND date match another
-- payment. All four, because a CHEQUE NUMBER LEGITIMATELY REPEATS across years
-- — reference alone would flag honest payments as phantoms.
--
-- ⚠ It flags BOTH twins, deliberately. Which one is real is a human's call, so
--   staff need to see the pair; the customer-facing views exclude both rather
--   than guess. Over-hiding costs a conversation, over-showing invents money.
CREATE OR REPLACE VIEW ops.v_payment_duplicates AS
SELECT p.qbo_payment_id,
       p.customer_ref_id,
       p.payment_ref_num,
       p.txn_date,
       p.total_amount,
       p.unapplied_amount,
       t.qbo_payment_id AS twin_qbo_payment_id,
       t.unapplied_amount AS twin_unapplied_amount
  FROM ops.qbo_payments p
  JOIN ops.qbo_payments t
    ON t.qbo_payment_id <> p.qbo_payment_id
   AND t.payment_ref_num = p.payment_ref_num
   AND t.customer_ref_id = p.customer_ref_id
   AND t.total_amount    = p.total_amount
   AND abs(t.txn_date - p.txn_date) <= 7
 WHERE p.payment_ref_num IS NOT NULL
   AND btrim(p.payment_ref_num) <> '';

COMMENT ON VIEW ops.v_payment_duplicates IS
  'Payments that look double-booked: same reference, customer, amount and within 7 days of another. Both twins appear. Customer-facing surfaces must exclude every id listed here.';

REVOKE ALL ON ops.v_payment_duplicates FROM anon, authenticated;
GRANT SELECT ON ops.v_payment_duplicates TO service_role;

-- Let the health board see the sync. ⚠ ops.sync_log.source carries a CHECK
-- allow-list and every writer wraps its log call in a try/catch, so a source
-- that is not on the list has its inserts SILENTLY REJECTED and the check that
-- reads them stays green forever — that is exactly how `distributor` and
-- `vendors` went dark for three days in August. Extend the list in the same
-- change that adds the writer. Restated in full rather than string-patched:
-- a regex against a live constraint is how you lose a value nobody notices.
ALTER TABLE ops.sync_log DROP CONSTRAINT IF EXISTS sync_log_source_check;
ALTER TABLE ops.sync_log ADD CONSTRAINT sync_log_source_check
  CHECK (source IS NULL OR source = ANY (ARRAY[
    'qbo','sf','sf-receipt-sync','sf-expense-sweep','sf-inbound','sf-cancel',
    'sf-connect','invoice-inbound','resq-sync-tick','resq-sync-watch',
    'resq-inbound','fleet','fleetcomplete','zoho_crm','bambee','pg_net',
    'brixpense','distributor','vendors','sf-reconcile','inventory','dispatch',
    'qbo_payments'
  ])) NOT VALID;
