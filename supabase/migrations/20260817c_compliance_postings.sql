-- Required workplace postings — the board by the time clock, as data.
--
-- Federal, state, and local notices an employer must display. Two things make
-- this table earn its keep over a folder of PDFs:
--   1. `source_url` is the AGENCY's own page/PDF. Posters get revised (minimum
--      wage every year, agency rebrands, new statutes), so the official link is
--      the source of truth and our stored copy is a convenience — never the
--      other way round.
--   2. `posted_location` + `verified_on` record that the thing is actually on a
--      wall, which is what an inspector checks. A file in a vault is not a
--      posting.
--
-- Staff-only both directions, same as every other compliance table.

CREATE TABLE IF NOT EXISTS ops.compliance_postings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction     TEXT NOT NULL CHECK (jurisdiction IN ('federal','state','local','company')),
  agency           TEXT,
  title            TEXT NOT NULL,
  form_code        TEXT,                 -- e.g. 'DE 1857A', 'S-500', 'MW-2026'
  source_url       TEXT,                 -- the agency's own page or PDF
  applies_when     TEXT,                 -- 'all employers', '50+ employees', …
  posted_location  TEXT,                 -- 'Break room board, Hangar 200'
  version_label    TEXT,                 -- 'Rev. 2026', 'effective 1/1/2026'
  effective_date   DATE,
  review_by        DATE,                 -- when to re-check the agency for a new edition
  verified_on      DATE,                 -- last time someone confirmed it is on the wall
  verified_by      TEXT,
  languages        TEXT,                 -- 'English, Spanish'
  storage_path     TEXT,                 -- our copy in the compliance-docs bucket
  file_name        TEXT,
  required         BOOLEAN NOT NULL DEFAULT true,
  notes            TEXT,
  archived_at      TIMESTAMPTZ,
  archived_by      TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compliance_postings_live_idx
  ON ops.compliance_postings (jurisdiction, title) WHERE archived_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.compliance_postings TO authenticated;
GRANT ALL ON ops.compliance_postings TO service_role;

ALTER TABLE ops.compliance_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compliance_postings_staff_all ON ops.compliance_postings;
CREATE POLICY compliance_postings_staff_all ON ops.compliance_postings
  FOR ALL TO authenticated
  USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

DROP TRIGGER IF EXISTS compliance_postings_touch ON ops.compliance_postings;
CREATE TRIGGER compliance_postings_touch BEFORE UPDATE ON ops.compliance_postings
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();
