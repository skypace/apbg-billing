-- Compliance & Safety document vault (Phase 1 — the filing cabinet).
--
-- Tracks the company's own compliance paper (insurance COIs, health permits,
-- CERS/CUPA, FDA registrations, food-safety audit reports, safety programs)
-- AND third parties' documents we're required to keep current (co-packer GMP
-- audits, contractor COIs). Born out of the 2026-07 Compass Group/Foodbuy
-- supplier-QA onboarding, where the needed documents lived in ten places.
--
-- Phase 2 (separate change) adds the contractor upload portal: per-party
-- coverage REQUIREMENTS, token-gated public upload, Claude ACORD extraction,
-- auto-chase emails. insured_parties exists now so Phase 2 needs no remodel.
--
-- Surfaces: Refractor → Production → Compliance & Safety tab (staff CRUD via
-- direct PostgREST under fn_is_staff RLS) + compliance-expiry-cron.mjs
-- (weekly expiration digest, read-only, service role).

-- ── 1. insured_parties — counterparties whose documents we track ────────────
CREATE TABLE IF NOT EXISTS ops.insured_parties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  party_type    TEXT NOT NULL DEFAULT 'vendor'
                CHECK (party_type IN ('co_packer','contractor','vendor','landlord','customer','other')),
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. compliance_documents ─────────────────────────────────────────────────
-- One row per document. Ours (holder_entity set, party_id null) or a third
-- party's (party_id set). expiration_date null = never expires.
CREATE TABLE IF NOT EXISTS ops.compliance_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category         TEXT NOT NULL
                   CHECK (category IN ('insurance','permit','food_safety','safety','tax','other')),
  doc_type         TEXT NOT NULL,            -- 'GL COI', 'Health permit', 'GMP audit report', 'CERS/CUPA', ...
  holder_entity    TEXT
                   CHECK (holder_entity IN ('alameda_soda','brix','freeflow','shared')),
  party_id         UUID REFERENCES ops.insured_parties(id),
  facility         TEXT,                     -- facility name/address the doc covers
  issuer           TEXT,                     -- issuing authority / carrier / audit firm
  reference_number TEXT,                     -- permit #, policy #, certificate #
  issue_date       DATE,
  expiration_date  DATE,
  storage_path     TEXT,                     -- object path in bucket compliance-docs
  file_name        TEXT,                     -- original filename
  notes            TEXT,
  archived_at      TIMESTAMPTZ,
  archived_by      TEXT,
  created_by       UUID REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (holder_entity IS NOT NULL OR party_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS compliance_documents_expiry_idx
  ON ops.compliance_documents (expiration_date)
  WHERE archived_at IS NULL AND expiration_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS compliance_documents_party_idx
  ON ops.compliance_documents (party_id);

-- updated_at touch triggers (same shape as product_formulas_touch)
CREATE OR REPLACE FUNCTION ops.tg_compliance_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS insured_parties_touch ON ops.insured_parties;
CREATE TRIGGER insured_parties_touch
  BEFORE UPDATE ON ops.insured_parties
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

DROP TRIGGER IF EXISTS compliance_documents_touch ON ops.compliance_documents;
CREATE TRIGGER compliance_documents_touch
  BEFORE UPDATE ON ops.compliance_documents
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

-- ── 3. Grants + RLS — staff only, in BOTH directions ────────────────────────
-- This Supabase project's auth is shared with brix-order customers and outside
-- agencies; insurance limits and audit corrective actions must not be readable
-- by every authenticated login (same lesson as expense_requests_select_sf).
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.insured_parties       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.compliance_documents  TO authenticated;
GRANT ALL ON ops.insured_parties      TO service_role;
GRANT ALL ON ops.compliance_documents TO service_role;

ALTER TABLE ops.insured_parties      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.compliance_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS insured_parties_staff_all ON ops.insured_parties;
CREATE POLICY insured_parties_staff_all ON ops.insured_parties
  FOR ALL TO authenticated
  USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

DROP POLICY IF EXISTS compliance_documents_staff_all ON ops.compliance_documents;
CREATE POLICY compliance_documents_staff_all ON ops.compliance_documents
  FOR ALL TO authenticated
  USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

-- ── 4. Private bucket compliance-docs, staff-gated storage policies ─────────
-- Unlike product-formulas (all authenticated), these objects are staff-only.
DO $storage$
BEGIN
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('compliance-docs', 'compliance-docs', false)
  ON CONFLICT (id) DO NOTHING;

  BEGIN
    CREATE POLICY compliance_docs_read ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'compliance-docs' AND ops.fn_is_staff());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY compliance_docs_insert ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'compliance-docs' AND ops.fn_is_staff());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY compliance_docs_update ON storage.objects
      FOR UPDATE TO authenticated
      USING (bucket_id = 'compliance-docs' AND ops.fn_is_staff())
      WITH CHECK (bucket_id = 'compliance-docs' AND ops.fn_is_staff());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    CREATE POLICY compliance_docs_delete ON storage.objects
      FOR DELETE TO authenticated
      USING (bucket_id = 'compliance-docs' AND ops.fn_is_staff());
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$storage$;

-- ── 5. Seed the known parties ────────────────────────────────────────────────
INSERT INTO ops.insured_parties (name, party_type, notes)
SELECT 'Alameda Quantum Canning', 'co_packer', 'Primary canning co-packer. Compass/Foodbuy supplier QA needs their annual third-party GMP audit report (full report incl. corrective actions) + facility operating permit, refreshed yearly.'
WHERE NOT EXISTS (SELECT 1 FROM ops.insured_parties WHERE name = 'Alameda Quantum Canning');
