-- Safety-handbook digital acknowledgments (new-hire + annual sign-off).
--
-- One row per signature event: who signed which handbook version, when, with
-- the drawn signature stored inline as a PNG data-URL (kept small by the
-- signing page; inline so the record is immutable and self-contained — no
-- storage-object lifecycle to audit separately). The ERCP (§I / §J2) promises
-- signed training records; this table + ops.compliance_training are that
-- system of record.
--
-- Signing surface: public/safety-handbook.html (any authenticated login on the
-- shared project — gateway staff, Brixpense, brix-order drivers — because new
-- warehouse hires won't pass fn_is_staff). Rows are INSERT-only for the signer
-- and read-own; staff (ops.fn_is_staff) read all. No UPDATE/DELETE for anyone
-- but service_role: a signed acknowledgment is evidence, not editable state.

CREATE TABLE IF NOT EXISTS ops.safety_handbook_acks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id),
  signer_name       TEXT NOT NULL,           -- typed full legal name
  signer_email      TEXT NOT NULL,           -- from the auth session at signing time
  handbook_version  TEXT NOT NULL,           -- e.g. '1.0 (2026-08-17)'
  signature_data    TEXT NOT NULL,           -- PNG data-URL from the signature pad
  signed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One signature per person per handbook version (re-signing a NEW version is
-- the annual/refresh path; accidental double-submit of the same version is not).
CREATE UNIQUE INDEX IF NOT EXISTS safety_handbook_acks_user_version_idx
  ON ops.safety_handbook_acks (user_id, handbook_version);

CREATE INDEX IF NOT EXISTS safety_handbook_acks_signed_idx
  ON ops.safety_handbook_acks (signed_at DESC);

GRANT SELECT, INSERT ON ops.safety_handbook_acks TO authenticated;
GRANT ALL ON ops.safety_handbook_acks TO service_role;

ALTER TABLE ops.safety_handbook_acks ENABLE ROW LEVEL SECURITY;

-- Sign as yourself, only as yourself.
DROP POLICY IF EXISTS safety_handbook_acks_insert_self ON ops.safety_handbook_acks;
CREATE POLICY safety_handbook_acks_insert_self ON ops.safety_handbook_acks
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Read your own record; staff read the roster.
DROP POLICY IF EXISTS safety_handbook_acks_select ON ops.safety_handbook_acks;
CREATE POLICY safety_handbook_acks_select ON ops.safety_handbook_acks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR ops.fn_is_staff());

-- No UPDATE/DELETE policies on purpose: acknowledgments are immutable evidence.
