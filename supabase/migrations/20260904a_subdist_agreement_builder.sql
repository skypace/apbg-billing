-- 20260904a — the sub-distribution agreement: a builder, an emailed signature,
-- and an executed document that cannot change afterwards.
--
-- Ask (Sky): "let me see the sub distributor contract builder. if there isnt
-- one, lets build one. then make an email with an e sign accptance just like
-- with melt items. same colors etc on pdf."
--
-- What existed: ops.sub_distributor_agreements held a title, a model, a fee,
-- two dates, two blocks of free text and a slot to upload a PDF somebody made
-- elsewhere. Nothing rendered a document, nothing emailed it, and signing was
-- only possible for a partner who already had a portal login — which none of
-- the four have. This migration adds the three missing halves.
--
-- Design, and why:
--
--  * THE TEXT IS SNAPSHOTTED, NOT REFERENCED. `body_source` is copied onto the
--    agreement when it is sent. Templates stay editable — publish 1.1 without a
--    deploy — but editing one can never change what somebody already signed. A
--    signature pointing at mutable text is not evidence of anything. Same rule
--    as the NDA (20260826a), and the freeze trigger below enforces it rather
--    than trusting convention.
--
--  * THE TERMS ARE STRUCTURED, NOT PROSE. `deal_terms` carries the fee
--    schedule, the service levels, the territory and the accounts as data, and
--    the document renders them into the [FEE_SCHEDULE] and [SERVICE_LEVELS]
--    blocks. That is what makes it a BUILDER: the same numbers that print on
--    the contract are the ones a settlement can later be checked against,
--    instead of a paragraph somebody retyped.
--
--  * ONE COMPANY SIGNATURE, NOT A SECOND COPY. company_signatory_id points at
--    ops.nda_signatories — the signature Sky already drew once on the portal.
--    A second signature store would drift from the first.
--
--  * THE TOKEN IS A CREDENTIAL. Only its sha256 is stored, so no read of this
--    table yields a working signing link; the raw token exists once, in the
--    send response and the email. A lost link is RE-ISSUED, never recovered.
--
-- ⚠ Service levels: Level 1 is the EMERGENCY tier (24h), Level 2 is 48h,
--   Level 3 is 72h routine. Sky's first statement of the hours ran the other
--   way and he corrected it — the numbering is conventional severity, and the
--   seeded default below is the corrected direction.
BEGIN;

-- ── 1. Templates ─────────────────────────────────────────────────────────────
-- Deliberately empty at migration time. The shipped template in
-- lib/distributor/subdist-agreement-v1.mjs is the seed, published on first use
-- by the send path — so the 34-section text has exactly ONE home (a file under
-- version control, where a diff is the record of a wording change) rather than
-- a copy pasted into a migration that can then disagree with it.
CREATE TABLE IF NOT EXISTS ops.subdist_agreement_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL,
  version     TEXT NOT NULL,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  body_source TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT FALSE,
  notes       TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS subdist_tpl_one_active_per_code
  ON ops.subdist_agreement_templates (code) WHERE active;

-- ── 2. The agreement grows a document, a deal, and a signature ───────────────
ALTER TABLE ops.sub_distributor_agreements
  ADD COLUMN IF NOT EXISTS agreement_number      TEXT,
  ADD COLUMN IF NOT EXISTS template_id           UUID REFERENCES ops.subdist_agreement_templates(id),
  ADD COLUMN IF NOT EXISTS template_code         TEXT,
  ADD COLUMN IF NOT EXISTS template_version      TEXT,
  ADD COLUMN IF NOT EXISTS subtitle              TEXT,
  -- the frozen text of THIS agreement, copied from the template at send
  ADD COLUMN IF NOT EXISTS body_source           TEXT,
  -- the deal as data: fees, service levels, territory, accounts, term
  ADD COLUMN IF NOT EXISTS deal_terms            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- who the counterparty legally is (they fill this in on the signing page)
  ADD COLUMN IF NOT EXISTS counterparty_legal_name  TEXT,
  ADD COLUMN IF NOT EXISTS counterparty_entity_type TEXT,
  ADD COLUMN IF NOT EXISTS counterparty_state       TEXT,
  ADD COLUMN IF NOT EXISTS counterparty_address     TEXT,
  ADD COLUMN IF NOT EXISTS signer_title             TEXT,
  ADD COLUMN IF NOT EXISTS typed_name               TEXT,
  ADD COLUMN IF NOT EXISTS consent_esign            BOOLEAN,
  -- our side, snapshotted from ops.nda_signatories at send
  ADD COLUMN IF NOT EXISTS company_signatory_id     UUID REFERENCES ops.nda_signatories(id),
  ADD COLUMN IF NOT EXISTS company_signer_name      TEXT,
  ADD COLUMN IF NOT EXISTS company_signer_title     TEXT,
  ADD COLUMN IF NOT EXISTS company_signature_data   TEXT,
  ADD COLUMN IF NOT EXISTS company_signed_at        TIMESTAMPTZ,
  -- the emailed signing link
  ADD COLUMN IF NOT EXISTS token_hash            TEXT,
  ADD COLUMN IF NOT EXISTS expires_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS viewed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resent_count          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_by               TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by            TEXT,
  ADD COLUMN IF NOT EXISTS declined_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decline_reason        TEXT,
  -- the executed PDF we rendered and sent (file_path stays the UPLOAD slot)
  ADD COLUMN IF NOT EXISTS executed_pdf_path     TEXT,
  ADD COLUMN IF NOT EXISTS executed_pdf_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes                 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS subdist_agreements_number_idx
  ON ops.sub_distributor_agreements (agreement_number) WHERE agreement_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS subdist_agreements_token_idx
  ON ops.sub_distributor_agreements (token_hash) WHERE token_hash IS NOT NULL;

-- The status vocabulary the builder uses. Dropped and re-added by name-agnostic
-- lookup because the original CHECK (if any) was written inline.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'ops.sub_distributor_agreements'::regclass
              AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP EXECUTE format('ALTER TABLE ops.sub_distributor_agreements DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE ops.sub_distributor_agreements
  ADD CONSTRAINT sub_distributor_agreements_status_check
  CHECK (status IN ('draft','sent','signed','declined','revoked','expired','superseded'));

-- ── 3. SDA-YYYY-NNNNN ────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ops.subdist_agreement_seq;

CREATE OR REPLACE FUNCTION ops.fn_next_subdist_agreement_number()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'ops','pg_temp' AS $$
  SELECT 'SDA-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('ops.subdist_agreement_seq')::text, 5, '0');
$$;
REVOKE ALL ON FUNCTION ops.fn_next_subdist_agreement_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_next_subdist_agreement_number() TO authenticated, service_role;

-- ── 4. A signed agreement is frozen ──────────────────────────────────────────
-- By TRIGGER, not by convention. Filing columns may still land after signature
-- (the PDF is rendered and stored moments later, and that is the same execution
-- event finishing) — everything the signature attests to may not.
CREATE OR REPLACE FUNCTION ops.fn_subdist_agreement_freeze()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    IF NEW.body_source     IS DISTINCT FROM OLD.body_source
    OR NEW.deal_terms      IS DISTINCT FROM OLD.deal_terms
    OR NEW.title           IS DISTINCT FROM OLD.title
    OR NEW.model           IS DISTINCT FROM OLD.model
    OR NEW.scope           IS DISTINCT FROM OLD.scope
    OR NEW.terms           IS DISTINCT FROM OLD.terms
    OR NEW.per_case_delivery_fee IS DISTINCT FROM OLD.per_case_delivery_fee
    OR NEW.effective_date  IS DISTINCT FROM OLD.effective_date
    OR NEW.expiry_date     IS DISTINCT FROM OLD.expiry_date
    OR NEW.signed_at       IS DISTINCT FROM OLD.signed_at
    OR NEW.signer_name     IS DISTINCT FROM OLD.signer_name
    OR NEW.signer_email    IS DISTINCT FROM OLD.signer_email
    OR NEW.signer_title    IS DISTINCT FROM OLD.signer_title
    OR NEW.typed_name      IS DISTINCT FROM OLD.typed_name
    OR NEW.signature_data  IS DISTINCT FROM OLD.signature_data
    OR NEW.signer_ip       IS DISTINCT FROM OLD.signer_ip
    OR NEW.signer_user_agent IS DISTINCT FROM OLD.signer_user_agent
    OR NEW.consent_esign   IS DISTINCT FROM OLD.consent_esign
    OR NEW.company_signature_data IS DISTINCT FROM OLD.company_signature_data
    OR NEW.company_signer_name    IS DISTINCT FROM OLD.company_signer_name
    OR NEW.company_signer_title   IS DISTINCT FROM OLD.company_signer_title
    OR NEW.counterparty_legal_name IS DISTINCT FROM OLD.counterparty_legal_name
    OR NEW.counterparty_address    IS DISTINCT FROM OLD.counterparty_address
    OR NEW.status <> 'signed' THEN
      RAISE EXCEPTION 'agreement % is signed — its terms and signature cannot be changed. Supersede it with a new version instead.',
        COALESCE(OLD.agreement_number, OLD.id::text);
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_subdist_agreement_freeze ON ops.sub_distributor_agreements;
CREATE TRIGGER tg_subdist_agreement_freeze
  BEFORE UPDATE ON ops.sub_distributor_agreements
  FOR EACH ROW EXECUTE FUNCTION ops.fn_subdist_agreement_freeze();

-- ── 5. RLS + grants (written together — Postgres checks grants BEFORE RLS) ───
ALTER TABLE ops.subdist_agreement_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subdist_tpl_staff ON ops.subdist_agreement_templates;
CREATE POLICY subdist_tpl_staff ON ops.subdist_agreement_templates
  FOR ALL USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

DROP POLICY IF EXISTS subdist_tpl_no_distributor ON ops.subdist_agreement_templates;
CREATE POLICY subdist_tpl_no_distributor ON ops.subdist_agreement_templates
  AS RESTRICTIVE FOR ALL USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor());

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.subdist_agreement_templates TO authenticated;
GRANT ALL ON ops.subdist_agreement_templates TO service_role;
REVOKE ALL ON ops.subdist_agreement_templates FROM anon;

COMMIT;
