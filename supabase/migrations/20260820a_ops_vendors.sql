-- Vendor Portal Phase 1 — the vendor registry.
--
-- One row per real-world vendor, linking the four places vendor truth lives:
--  1. The books      — qbo_vendor_id → ops.qbo_vendors (daily mirror; READ-ONLY
--                      here — push-qbo-item:vendors stays that mirror's writer).
--  2. Compliance     — insured_party_id → ops.insured_parties, whose
--                      ops.compliance_documents rows (COI, W-9) the Vendors UI
--                      reads. The registry LINKS to the vault, never duplicates.
--  3. How they're paid — payment_method_pref + payment_handle. HARD RULE: the
--                      handle (Venmo @name / PayPal email) is the ONLY payment
--                      datum stored. Bank account numbers live with the payment
--                      rail (Melio / QBO Bill Pay), never in this database.
--  4. Tax identity   — w9_status + ein_last4 ONLY. The full EIN/SSN lives
--                      inside the W-9 PDF in the private compliance-docs
--                      bucket, never in a column.
--
-- Surfaces: Brixpense → Vendors (app-expense, superadmin/admin). Coverage
-- requirements ride the requirements jsonb (gl_each_occurrence numeric,
-- wc_required / auto_required / additional_insured_required booleans);
-- compliance status is computed where displayed, nothing stored.
-- Plan: architecture/VENDOR-PORTAL-PLAN.md. Phase 2 adds token-gated intake,
-- Phase 3 adds the payments ledger.

-- ── 1. vendors ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.vendors (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        TEXT NOT NULL,             -- how we refer to them (usually = QBO DisplayName)
  legal_name          TEXT,                      -- as printed on the W-9
  vendor_type         TEXT NOT NULL DEFAULT 'supplier'
                      CHECK (vendor_type IN ('contractor','supplier','service','other')),
  contact_name        TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  qbo_vendor_id       TEXT,                      -- → ops.qbo_vendors.qbo_vendor_id (mirror; nullable until linked)
  insured_party_id    UUID REFERENCES ops.insured_parties(id),  -- → the compliance vault party
  payment_method_pref TEXT CHECK (payment_method_pref IN
                        ('ach','paypal','venmo','zelle_manual','check_manual')),
  payment_handle      TEXT,                      -- Venmo @handle or PayPal email — NEVER bank details
  default_terms       TEXT,                      -- e.g. 'Net 30'
  requirements        JSONB NOT NULL DEFAULT '{}'::jsonb,
  w9_status           TEXT NOT NULL DEFAULT 'missing'
                      CHECK (w9_status IN ('missing','on_file')),
  ein_last4           TEXT CHECK (ein_last4 IS NULL OR ein_last4 ~ '^[0-9]{4}$'),
  onboard_status      TEXT NOT NULL DEFAULT 'new'
                      CHECK (onboard_status IN ('new','invited','docs_pending','complete')),
  notes               TEXT,
  archived_at         TIMESTAMPTZ,               -- soft archive — never hard delete
  archived_by         TEXT,
  created_by          UUID REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live vendor per name; archived rows free the name back up.
CREATE UNIQUE INDEX IF NOT EXISTS vendors_display_name_live_idx
  ON ops.vendors (lower(display_name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS vendors_qbo_vendor_idx
  ON ops.vendors (qbo_vendor_id) WHERE qbo_vendor_id IS NOT NULL;

-- ── 2. Touch trigger (same shared fn as 20260726a) ─────────────────────────
DROP TRIGGER IF EXISTS vendors_touch ON ops.vendors;
CREATE TRIGGER vendors_touch
  BEFORE UPDATE ON ops.vendors
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

-- ── 3. Grants + staff-only RLS (both directions, same lesson as 20260726a:
--       auth is shared with brix-order customers / distributors — USING (true)
--       would leak every vendor's contact + payment handle) ─────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.vendors TO authenticated;
GRANT ALL ON ops.vendors TO service_role;

ALTER TABLE ops.vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendors_staff_all ON ops.vendors;
CREATE POLICY vendors_staff_all ON ops.vendors
  FOR ALL TO authenticated
  USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
