-- Proposal Builder saved drafts + public share links.

CREATE SCHEMA IF NOT EXISTS ops;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ops.proposal_builder_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  customer_name   text,
  customer_email  text,
  business_type   text,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'shared', 'archived')),
  proposal        jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_email text,
  gamma_url       text,
  pdf_url         text,
  share_enabled   boolean NOT NULL DEFAULT false,
  share_slug      text NOT NULL DEFAULT encode(gen_random_bytes(9), 'hex'),
  created_by      text,
  updated_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_builder_proposals_share_slug_key UNIQUE (share_slug)
);

CREATE INDEX IF NOT EXISTS idx_proposal_builder_proposals_updated_at
  ON ops.proposal_builder_proposals (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_proposal_builder_proposals_share_slug
  ON ops.proposal_builder_proposals (share_slug)
  WHERE share_enabled;

CREATE OR REPLACE FUNCTION ops.set_proposal_builder_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_builder_proposals_updated_at
  ON ops.proposal_builder_proposals;

CREATE TRIGGER trg_proposal_builder_proposals_updated_at
  BEFORE UPDATE ON ops.proposal_builder_proposals
  FOR EACH ROW EXECUTE FUNCTION ops.set_proposal_builder_updated_at();

ALTER TABLE ops.proposal_builder_proposals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ops.proposal_builder_proposals FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.proposal_builder_proposals TO service_role;
