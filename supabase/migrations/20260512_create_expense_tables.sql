-- =============================================================
-- Brixpense: Expense Request Tables
-- Migration: 20260512_create_expense_tables
-- Schema:    ops (shared APBG schema with RLS)
-- Project:   gfsdpwiqzshhexkofiif
-- =============================================================

-- Ensure ops schema exists (idempotent)
CREATE SCHEMA IF NOT EXISTS ops;

-- -----------------------------------------------------------
-- 1. expense_requests — one row per expense or purchase request
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.expense_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- submitter
  submitted_by    UUID REFERENCES auth.users(id),
  submitter_name  TEXT NOT NULL,
  submitter_email TEXT NOT NULL,

  -- request metadata
  request_type    TEXT NOT NULL CHECK (request_type IN ('expense', 'purchase_request')),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN (
                    'draft','pending','approved','denied',
                    'awaiting_invoice','fulfilled','posted'
                  )),
  entity          TEXT NOT NULL CHECK (entity IN ('brix', 'freeflow', 'shared')),
  department      TEXT NOT NULL,
  description     TEXT,
  vendor_name     TEXT,
  notes           TEXT,

  -- financials
  line_items      JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'USD',

  -- approval
  approval_token  TEXT UNIQUE,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  denial_reason   TEXT,
  auto_approved   BOOLEAN NOT NULL DEFAULT false,

  -- QBO link
  qbo_bill_id     TEXT,
  posted_at       TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_expense_requests_status
  ON ops.expense_requests (status);
CREATE INDEX IF NOT EXISTS idx_expense_requests_entity
  ON ops.expense_requests (entity);
CREATE INDEX IF NOT EXISTS idx_expense_requests_submitted_by
  ON ops.expense_requests (submitted_by);
CREATE INDEX IF NOT EXISTS idx_expense_requests_approval_token
  ON ops.expense_requests (approval_token);
CREATE INDEX IF NOT EXISTS idx_expense_requests_created_at
  ON ops.expense_requests (created_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION ops.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expense_requests_updated_at ON ops.expense_requests;
CREATE TRIGGER trg_expense_requests_updated_at
  BEFORE UPDATE ON ops.expense_requests
  FOR EACH ROW EXECUTE FUNCTION ops.set_updated_at();

-- -----------------------------------------------------------
-- 2. expense_request_attachments — receipts / supporting docs
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.expense_request_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES ops.expense_requests(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  file_name     TEXT NOT NULL,
  file_url      TEXT NOT NULL,
  file_type     TEXT,
  file_size     INTEGER,
  ocr_result    JSONB
);

CREATE INDEX IF NOT EXISTS idx_attachments_request_id
  ON ops.expense_request_attachments (request_id);

-- -----------------------------------------------------------
-- 3. expense_approvals — audit log for every approval action
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.expense_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES ops.expense_requests(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  action          TEXT NOT NULL CHECK (action IN ('approved', 'denied')),
  decided_by      TEXT NOT NULL,
  decided_by_email TEXT,
  signature_url   TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  notes           TEXT,
  token_used      TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_request_id
  ON ops.expense_approvals (request_id);

-- -----------------------------------------------------------
-- 4. expense_settings — key/value config store
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.expense_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed defaults
INSERT INTO ops.expense_settings (key, value) VALUES
  ('auto_approve_threshold', '250'::jsonb),
  ('approval_email', '"wgrandell@brixbev.com"'::jsonb),
  ('departments', '["Operations","Sales","Marketing","Engineering","Finance","Admin","Warehouse"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------
-- 5. RLS Policies
-- -----------------------------------------------------------

-- Enable RLS on all tables
ALTER TABLE ops.expense_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_request_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.expense_settings ENABLE ROW LEVEL SECURITY;

-- expense_requests: authenticated users can read all, insert own, update own drafts
CREATE POLICY expense_requests_select ON ops.expense_requests
  FOR SELECT TO authenticated USING (true);

CREATE POLICY expense_requests_insert ON ops.expense_requests
  FOR INSERT TO authenticated WITH CHECK (submitted_by = auth.uid());

CREATE POLICY expense_requests_update ON ops.expense_requests
  FOR UPDATE TO authenticated USING (submitted_by = auth.uid());

-- Allow anon to read by approval_token (for magic-link approval page)
CREATE POLICY expense_requests_anon_select ON ops.expense_requests
  FOR SELECT TO anon USING (approval_token IS NOT NULL);

-- Allow anon to update status via approval token (the decide function does this)
CREATE POLICY expense_requests_anon_update ON ops.expense_requests
  FOR UPDATE TO anon USING (approval_token IS NOT NULL);

-- attachments: follow parent request access
CREATE POLICY attachments_select ON ops.expense_request_attachments
  FOR SELECT TO authenticated USING (true);

CREATE POLICY attachments_insert ON ops.expense_request_attachments
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY attachments_anon_select ON ops.expense_request_attachments
  FOR SELECT TO anon USING (
    EXISTS (
      SELECT 1 FROM ops.expense_requests
      WHERE id = request_id AND approval_token IS NOT NULL
    )
  );

-- approvals: authenticated can read, anon can insert (via decide function)
CREATE POLICY approvals_select ON ops.expense_approvals
  FOR SELECT TO authenticated USING (true);

CREATE POLICY approvals_insert_auth ON ops.expense_approvals
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY approvals_insert_anon ON ops.expense_approvals
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY approvals_anon_select ON ops.expense_approvals
  FOR SELECT TO anon USING (true);

-- settings: everyone can read, only authenticated can update
CREATE POLICY settings_select ON ops.expense_settings
  FOR SELECT USING (true);

CREATE POLICY settings_update ON ops.expense_settings
  FOR UPDATE TO authenticated USING (true);
