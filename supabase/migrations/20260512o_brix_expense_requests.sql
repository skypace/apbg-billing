-- ============================================================================
-- Brix Expense — request workflow schema + RLS + storage + seed
-- ============================================================================
-- Creates the four tables the app-expense/ frontend reads/writes against:
--   ops.expense_requests             — one row per Expense or Purchase Request
--   ops.expense_request_attachments  — receipts, quotes, supporting files
--   ops.expense_request_approvals    — audit log (decision, signature, IP, UA)
--   ops.expense_settings             — KV store: threshold, manager list,
--                                       COGS account list, tags, departments
-- Also creates the `expense-attachments` storage bucket + policies, and seeds
-- ops.expense_settings with the lists from BRIX-EXPENSE-SPEC.md.
--
-- Frontend uses the anon key + RLS. Netlify functions use the service-role
-- key and bypass RLS for cross-cutting status changes (notify, decide,
-- link-bill).
-- ============================================================================

-- ── 1. expense_requests ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.expense_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                  TEXT NOT NULL CHECK (type IN ('expense', 'purchase_request')),
  status                TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'pending', 'approved', 'denied',
                                              'awaiting_invoice', 'fulfilled', 'posted')),

  submitted_by          UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  vendor_name           TEXT,
  vendor_id             TEXT,
  total_amount          NUMERIC(12, 2),
  currency              TEXT NOT NULL DEFAULT 'USD',
  receipt_date          DATE,

  cogs_account_id       TEXT,
  cogs_account_label    TEXT,
  tag                   TEXT,
  department            TEXT,

  customer_name         TEXT,
  job_number            TEXT,
  memo                  TEXT,

  line_items            JSONB NOT NULL DEFAULT '[]'::jsonb,

  manager_email         TEXT,
  approval_threshold    NUMERIC(12, 2) NOT NULL DEFAULT 500,

  linked_pr_id          UUID REFERENCES ops.expense_requests(id) ON DELETE SET NULL,

  qbo_bill_id           TEXT,
  qbo_invoice_match     TEXT,
  margin_result         JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expense_requests_submitted_by_idx
  ON ops.expense_requests (submitted_by, created_at DESC);

CREATE INDEX IF NOT EXISTS expense_requests_manager_status_idx
  ON ops.expense_requests (manager_email, status)
  WHERE manager_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS expense_requests_linked_pr_idx
  ON ops.expense_requests (linked_pr_id)
  WHERE linked_pr_id IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION ops.tg_expense_requests_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expense_requests_touch ON ops.expense_requests;
CREATE TRIGGER expense_requests_touch
  BEFORE UPDATE ON ops.expense_requests
  FOR EACH ROW EXECUTE FUNCTION ops.tg_expense_requests_touch();


-- ── 2. expense_request_attachments ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.expense_request_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES ops.expense_requests(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  file_type     TEXT,
  file_size     BIGINT,
  storage_path  TEXT NOT NULL,
  ocr_result    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expense_request_attachments_request_idx
  ON ops.expense_request_attachments (request_id);


-- ── 3. expense_request_approvals ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.expense_request_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES ops.expense_requests(id) ON DELETE CASCADE,
  decision        TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  decided_by      TEXT NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  signature_url   TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  reason_note     TEXT,
  magic_token     TEXT
);

CREATE INDEX IF NOT EXISTS expense_request_approvals_request_idx
  ON ops.expense_request_approvals (request_id, decided_at DESC);


-- ── 4. expense_settings ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.expense_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ── RLS policies ───────────────────────────────────────────────────────────
ALTER TABLE ops.expense_requests             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_request_attachments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_request_approvals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_settings             ENABLE ROW LEVEL SECURITY;

-- expense_requests: submitter sees their own; manager sees rows routed to them;
-- INSERT only as self; UPDATE own drafts (other status transitions go through
-- netlify functions on the service role).
DROP POLICY IF EXISTS expense_requests_select ON ops.expense_requests;
CREATE POLICY expense_requests_select ON ops.expense_requests
  FOR SELECT TO authenticated
  USING (
    submitted_by = auth.uid()
    OR manager_email = lower(auth.jwt() ->> 'email')
  );

DROP POLICY IF EXISTS expense_requests_insert ON ops.expense_requests;
CREATE POLICY expense_requests_insert ON ops.expense_requests
  FOR INSERT TO authenticated
  WITH CHECK (submitted_by = auth.uid());

DROP POLICY IF EXISTS expense_requests_update_own_draft ON ops.expense_requests;
CREATE POLICY expense_requests_update_own_draft ON ops.expense_requests
  FOR UPDATE TO authenticated
  USING (submitted_by = auth.uid() AND status IN ('draft', 'pending'))
  WITH CHECK (submitted_by = auth.uid());

-- attachments: visible/insertable by anyone who can see the parent request
DROP POLICY IF EXISTS expense_attachments_select ON ops.expense_request_attachments;
CREATE POLICY expense_attachments_select ON ops.expense_request_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ops.expense_requests r
      WHERE r.id = request_id
        AND (r.submitted_by = auth.uid()
             OR r.manager_email = lower(auth.jwt() ->> 'email'))
    )
  );

DROP POLICY IF EXISTS expense_attachments_insert ON ops.expense_request_attachments;
CREATE POLICY expense_attachments_insert ON ops.expense_request_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ops.expense_requests r
      WHERE r.id = request_id AND r.submitted_by = auth.uid()
    )
  );

-- approvals: read-only from the client; writes go through netlify function
DROP POLICY IF EXISTS expense_approvals_select ON ops.expense_request_approvals;
CREATE POLICY expense_approvals_select ON ops.expense_request_approvals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ops.expense_requests r
      WHERE r.id = request_id
        AND (r.submitted_by = auth.uid()
             OR r.manager_email = lower(auth.jwt() ->> 'email'))
    )
  );

-- settings: any authenticated user can read; no client writes
DROP POLICY IF EXISTS expense_settings_select ON ops.expense_settings;
CREATE POLICY expense_settings_select ON ops.expense_settings
  FOR SELECT TO authenticated
  USING (true);


-- ── 5. Storage bucket: expense-attachments ─────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
  VALUES ('expense-attachments', 'expense-attachments', false)
  ON CONFLICT (id) DO NOTHING;

-- Submitters can upload into a folder named with their user id; reads are
-- gated to the submitter (or anyone who can SELECT the parent request via
-- the attachments table, enforced through netlify functions emitting signed
-- URLs for managers).
DROP POLICY IF EXISTS expense_attach_storage_insert ON storage.objects;
CREATE POLICY expense_attach_storage_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS expense_attach_storage_select ON storage.objects;
CREATE POLICY expense_attach_storage_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- ── 6. Seed expense_settings ───────────────────────────────────────────────
-- COGS / expense account dropdown (BRIX-EXPENSE-SPEC.md §4).
-- IDs for the two existing QBO accounts (Service COGS=101, Equipment=42)
-- are populated; the seven new accounts have null IDs until they are either
-- created in QBO or mapped to existing accounts. expense-request-link-bill
-- falls back to '101' (Service COGS) when cogs_account_id is null.
INSERT INTO ops.expense_settings (key, value) VALUES
  ('approval_threshold', '500'::jsonb),

  ('cogs_accounts', $$[
    {"id": "101", "label": "Service COGS"},
    {"id": "42",  "label": "Equipment COGS"},
    {"id": null,  "label": "Fuel"},
    {"id": null,  "label": "Office Supplies"},
    {"id": null,  "label": "Working Meals"},
    {"id": null,  "label": "Travel"},
    {"id": null,  "label": "Repair & Maintenance — Building"},
    {"id": null,  "label": "New Fountain Installs COGS"},
    {"id": null,  "label": "Ice Machine Rental COGS"}
  ]$$::jsonb),

  ('manager_emails', $$[
    "anthonyv@brixbev.com",
    "skypace@brixbev.com",
    "asloan@brixbev.com",
    "marco@brixbev.com",
    "joel@brixbev.com"
  ]$$::jsonb),

  ('tags', $$[
    "project","event","vehicle","customer","store","general"
  ]$$::jsonb),

  ('departments', $$[
    "delivery","service","reman","ops","freeflow","melt"
  ]$$::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();
