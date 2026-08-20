-- Compliance vault Phase 1.5 — SDS library + safety training log.
--
-- Born out of the 2026-08-17 CUPA inspection prep (Alameda County Env. Health,
-- CERS 10666381): the facility had zero SDS on file in any form, and the signed
-- Emergency Response Plan (§I) promises annual training records that had no
-- system of record.
--
-- WHY SDS IS ITS OWN TABLE, not a compliance_documents category:
--  1. SDS don't expire — they get REVISED. compliance_documents' whole UI is
--     built around expiration_date; an SDS row's freshness question is "is this
--     the current revision from the manufacturer we actually buy from".
--  2. The inspector's question is BY PRODUCT ("show me the SDS for that spray
--     paint / where is it stored / how much is on hand"), so product identity,
--     storage location, and quantity are first-class columns.
--  3. Scope: Cal/OSHA HazCom (8 CCR §5194) requires an SDS for EVERY hazardous
--     chemical on site regardless of quantity — small paints, cleaners,
--     aerosols, lubricants included. The 55 gal / 500 lb / 200 cu ft numbers
--     are CERS *reporting* thresholds only, so this table is deliberately a
--     LONGER list than the CERS inventory. cers_reported marks the rows that
--     also appear on the CERS Hazardous Materials Inventory.
--
-- Surfaces: Refractor → Production → Compliance & Safety (SDS Library +
-- Safety & Training sections). Files reuse the private staff-gated bucket
-- compliance-docs (paths sds/* and training/*).

-- ── 1. compliance_sds — one row per hazardous chemical product on site ─────
CREATE TABLE IF NOT EXISTS ops.compliance_sds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name     TEXT NOT NULL,             -- as printed on the container label
  manufacturer     TEXT,                      -- SDS must be from the maker of the product we buy
  cas_number       TEXT,                      -- pure substances; mixtures may be null
  physical_state   TEXT CHECK (physical_state IN ('liquid','solid','gas','aerosol')),
  hazard_summary   TEXT,                      -- e.g. 'flammable aerosol', 'simple asphyxiant'
  storage_location TEXT,                      -- e.g. '#2300 CO2 storage area outside', 'tool room closet'
  container_desc   TEXT,                      -- e.g. '12 oz aerosol cans', 'bulk tank + 20 lb cylinders'
  max_quantity     NUMERIC,                   -- max amount on site at any one time
  quantity_units   TEXT,                      -- 'lb' / 'gal' / 'cu ft' / 'cans' ...
  cers_reported    BOOLEAN NOT NULL DEFAULT false, -- also a line on the CERS inventory
  sds_revision_date DATE,                     -- the revision date printed on the sheet
  storage_path     TEXT,                      -- object path in bucket compliance-docs (sds/*)
  file_name        TEXT,
  entity           TEXT CHECK (entity IN ('alameda_soda','brix','freeflow','shared')),
  notes            TEXT,
  archived_at      TIMESTAMPTZ,               -- product no longer on site — keep the record
  archived_by      TEXT,
  created_by       UUID REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compliance_sds_product_idx
  ON ops.compliance_sds (lower(product_name)) WHERE archived_at IS NULL;

-- ── 2. compliance_training — HMBP / safety training sessions ───────────────
-- ERCP §I: within 6 months of hire, refreshed annually, 14 required topics.
-- One row per SESSION; attendees as text (names), signed roster as the file.
CREATE TABLE IF NOT EXISTS ops.compliance_training (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  training_date  DATE NOT NULL,
  training_type  TEXT NOT NULL DEFAULT 'hmbp_annual'
                 CHECK (training_type IN ('hmbp_annual','new_hire','tailgate','drill','other')),
  topics         TEXT,                        -- what was covered (SDS, evacuation, CO2 response, ...)
  trainer        TEXT,
  attendees      TEXT,                        -- names, one per line
  storage_path   TEXT,                        -- signed roster / sign-in sheet in compliance-docs (training/*)
  file_name      TEXT,
  notes          TEXT,
  created_by     UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compliance_training_date_idx
  ON ops.compliance_training (training_date DESC);

-- ── 3. Touch triggers (same fn as 20260726a) ───────────────────────────────
DROP TRIGGER IF EXISTS compliance_sds_touch ON ops.compliance_sds;
CREATE TRIGGER compliance_sds_touch
  BEFORE UPDATE ON ops.compliance_sds
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

DROP TRIGGER IF EXISTS compliance_training_touch ON ops.compliance_training;
CREATE TRIGGER compliance_training_touch
  BEFORE UPDATE ON ops.compliance_training
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

-- ── 4. Grants + staff-only RLS (both directions, same lesson as 20260726a) ─
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.compliance_sds       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.compliance_training  TO authenticated;
GRANT ALL ON ops.compliance_sds      TO service_role;
GRANT ALL ON ops.compliance_training TO service_role;

ALTER TABLE ops.compliance_sds      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.compliance_training ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compliance_sds_staff_all ON ops.compliance_sds;
CREATE POLICY compliance_sds_staff_all ON ops.compliance_sds
  FOR ALL TO authenticated
  USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

DROP POLICY IF EXISTS compliance_training_staff_all ON ops.compliance_training;
CREATE POLICY compliance_training_staff_all ON ops.compliance_training
  FOR ALL TO authenticated
  USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

-- ── 5. Seed: carbon dioxide, from CERS 10666381's inventory ────────────────
-- The one chemical the facility formally reports. SDS file itself still needs
-- to come from the gas supplier (must match the product actually received).
INSERT INTO ops.compliance_sds
  (product_name, manufacturer, cas_number, physical_state, hazard_summary,
   storage_location, container_desc, max_quantity, quantity_units,
   cers_reported, entity, notes)
SELECT
  'Carbon Dioxide', NULL, '124-38-9', 'gas',
  'Nonflammable gas (DOT 2.2) · gas under pressure · simple asphyxiant',
  '#2300 CO2 storage area outside',
  'Bulk tank (#4461, Map A1) + cylinders',
  1000, 'lb',
  true, 'shared',
  'CERS chemical library CCL-101711 / EPA SRS 33548. Max daily per 2026-08-10 inventory — verify against the bulk tank nameplate (inspection prep finding #1). SDS must be requested from the actual gas supplier.'
WHERE NOT EXISTS (
  SELECT 1 FROM ops.compliance_sds WHERE lower(product_name) = 'carbon dioxide'
);
