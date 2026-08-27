-- 20260826d_pay_run.sql
-- Pay run: pay SEVERAL bills to one vendor with ONE payment + ONE remittance.
--
-- The Phase 3 ledger (20260820c) is one ops.vendor_payments row per bill, and
-- its partial unique index (one LIVE payment per qbo_bill_id) is the duplicate
-- guard that must survive batching. So a batch does NOT collapse the ledger:
-- it keeps one row per bill and adds a PARENT — ops.vendor_payment_groups —
-- carrying what is singular about the payment itself: the one Stripe payout id,
-- the one QBO BillPayment id, the check number, and the remittance-advice
-- send record. external_payout_id moves to the group for batches because the
-- ledger's own unique index on that column (correct for single payments)
-- cannot hold when five rows share one payout.
--
-- Watcher: NONE ADDED, deliberately. Batch rows are ordinary vendor_payments
-- rows ('initiated' stripe rows stuck >48h, failures in 7d), so the existing
-- ops.fn_vendor_payments_health() covers a stuck or failed pay run with zero
-- change — the group is grouping metadata, not a new pipeline.

-- ── 1. the payment group (one per vendor per pay-run action) ─────────────────
CREATE TABLE IF NOT EXISTS ops.vendor_payment_groups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           UUID NOT NULL REFERENCES ops.vendors(id),
  rail                TEXT NOT NULL CHECK (rail IN
                        ('stripe_payout','venmo_manual','zelle_manual','check_manual','qbo_billpay')),
  total_amount        NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  bill_count          INT NOT NULL DEFAULT 1 CHECK (bill_count > 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  status              TEXT NOT NULL DEFAULT 'initiated'
                      CHECK (status IN ('initiated','settled','failed','recorded')),
  external_payout_id  TEXT,                    -- the ONE Stripe OutboundPayment for the batch
  qbo_billpayment_id  TEXT,                    -- the ONE QBO BillPayment (multi-line) once booked
  reference           TEXT,                    -- check #, Venmo txn, …
  initiated_by        TEXT,
  failure_reason      TEXT,
  notes               TEXT,
  -- Remittance advice: what we told the vendor, when, and to whom. An error
  -- here never fails a payment — it is stamped so the UI can offer a resend.
  remit_to            TEXT,                    -- chosen recipient (falls back to the vendor's contact email)
  remittance_sent_at  TIMESTAMPTZ,
  remittance_sent_to  TEXT,
  remittance_error    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_payment_groups_vendor_idx
  ON ops.vendor_payment_groups (vendor_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_payment_groups_external_idx
  ON ops.vendor_payment_groups (external_payout_id) WHERE external_payout_id IS NOT NULL;

DROP TRIGGER IF EXISTS vendor_payment_groups_touch ON ops.vendor_payment_groups;
CREATE TRIGGER vendor_payment_groups_touch
  BEFORE UPDATE ON ops.vendor_payment_groups
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

GRANT SELECT ON ops.vendor_payment_groups TO authenticated;
GRANT ALL ON ops.vendor_payment_groups TO service_role;

ALTER TABLE ops.vendor_payment_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_payment_groups_staff_select ON ops.vendor_payment_groups;
CREATE POLICY vendor_payment_groups_staff_select ON ops.vendor_payment_groups
  FOR SELECT TO authenticated
  USING (ops.fn_is_staff());

-- ── 2. link the per-bill ledger rows to their group ─────────────────────────
ALTER TABLE ops.vendor_payments
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES ops.vendor_payment_groups(id);
CREATE INDEX IF NOT EXISTS vendor_payments_group_idx
  ON ops.vendor_payments (group_id) WHERE group_id IS NOT NULL;
