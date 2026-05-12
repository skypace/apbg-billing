-- Brix Expense — request + approval tables.
--
-- Single table `ops.expense_requests` holds both "Expense" submissions
-- (with the actual receipt; auto-approve when amount ≤ threshold) and
-- "Purchase Request" submissions (pre-spend; always require approval).
-- A second table `ops.expense_request_approvals` is a thin audit log so
-- we can keep multi-step approval history if/when we add escalation.
--
-- The `ops.expense_settings` singleton holds the auto-approve threshold
-- (default $500) so it can be changed without a redeploy.

BEGIN;

CREATE TABLE IF NOT EXISTS ops.expense_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('expense', 'purchase_request')),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'denied', 'auto_approved', 'fulfilled')),

  submitter_email     text NOT NULL,
  manager_email       text NULL,

  vendor_id           text NULL,
  vendor_name         text NULL,
  customer_id         text NULL,
  customer_name       text NULL,

  account_key         text NOT NULL,
  account_label       text NOT NULL,
  job_number          text NULL,

  tag                 text NULL,
  department          text NULL,

  total_amount        numeric(12, 2) NOT NULL CHECK (total_amount >= 0),
  memo                text NULL,
  line_items          jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachment_url      text NULL,

  -- Filled in when the actual bill is posted to QBO (either on auto-approve
  -- or after manager approval for amounts over threshold).
  qbo_bill_id         text NULL,
  qbo_bill_number     text NULL,
  invoice_match       jsonb NULL,

  -- Approval audit (denormalized for the common case of single-step approval).
  decided_at          timestamptz NULL,
  decided_by          text NULL,
  decision_note       text NULL,
  signature_data_url  text NULL,

  -- Single-use approval URL token (HMAC of id + secret; verified by the
  -- expense-request-decide function). NULL once the request is decided.
  approve_token       text NULL UNIQUE,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_requests_submitter ON ops.expense_requests (submitter_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expense_requests_manager   ON ops.expense_requests (manager_email, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expense_requests_status    ON ops.expense_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.expense_request_approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid NOT NULL REFERENCES ops.expense_requests(id) ON DELETE CASCADE,
  decided_by          text NOT NULL,
  decision            text NOT NULL CHECK (decision IN ('approve', 'deny')),
  note                text NULL,
  signature_data_url  text NULL,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  source_ip           text NULL
);

CREATE INDEX IF NOT EXISTS idx_expense_approvals_request ON ops.expense_request_approvals (request_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS ops.expense_settings (
  id                          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  approval_threshold_amount   numeric(12, 2) NOT NULL DEFAULT 500,
  approver_emails             text[] NOT NULL DEFAULT ARRAY[
                                'Anthonyv@brixbev.com',
                                'skypace@brixbev.com',
                                'asloan@brixbev.com',
                                'marco@brixbev.com',
                                'joel@brixbev.com'
                              ],
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.expense_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE ops.expense_requests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_request_approvals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_settings           ENABLE ROW LEVEL SECURITY;

-- Submitters see their own rows; managers see rows routed to them; the
-- Netlify functions run with the service key so they bypass RLS for
-- writes that need to cross those boundaries (creating a request,
-- recording an approval, posting the bill).
DROP POLICY IF EXISTS expense_requests_read ON ops.expense_requests;
CREATE POLICY expense_requests_read ON ops.expense_requests
  FOR SELECT TO authenticated
  USING (
    submitter_email = (auth.jwt() ->> 'email')
    OR manager_email = (auth.jwt() ->> 'email')
    OR coalesce((auth.jwt() ->> 'role'), '') IN ('admin', 'superadmin')
  );

DROP POLICY IF EXISTS expense_approvals_read ON ops.expense_request_approvals;
CREATE POLICY expense_approvals_read ON ops.expense_request_approvals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ops.expense_requests r
      WHERE r.id = ops.expense_request_approvals.request_id
        AND (
          r.submitter_email = (auth.jwt() ->> 'email')
          OR r.manager_email = (auth.jwt() ->> 'email')
          OR coalesce((auth.jwt() ->> 'role'), '') IN ('admin', 'superadmin')
        )
    )
  );

DROP POLICY IF EXISTS expense_settings_read ON ops.expense_settings;
CREATE POLICY expense_settings_read ON ops.expense_settings
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON ops.expense_requests          TO authenticated;
GRANT SELECT ON ops.expense_request_approvals TO authenticated;
GRANT SELECT ON ops.expense_settings          TO authenticated;

COMMIT;
