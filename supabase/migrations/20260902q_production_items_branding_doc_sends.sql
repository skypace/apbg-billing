-- 2026-09-02  One place to set what we buy, from whom, and at what price.
--
-- Ask (Sky): "give me a section where I can adjust the items and the materials
-- and their prices and to whom I'm buying them from since I can't manage those
-- in QuickBooks."  Until now a stocked component's PRICE came from the QBO item
-- mirror (refreshed nightly, and stale -- $0.26 a can against $0.31-0.37
-- billed) and its VENDOR lived on each BOM line separately, so changing who
-- supplies trays meant editing seven BOMs.
--
-- ops.production_items is the master: one row per stocked QBO item the
-- production system buys.  Precedence, everywhere a cost or vendor is read:
--
--   BOM line explicit override  >  production_items  >  raw_ingredients  >  QBO mirror
--
-- The BOM line keeps its override slot for the genuine exception (this one BOM
-- buys its tray elsewhere), but the seed below CLEARS every line vendor that
-- merely repeated what the master now says, so the master actually governs
-- instead of being shadowed by seven copies of the same answer.
--
-- Also here, because the same ask covered the documents that carry these
-- numbers: the company identity printed on every PO / BOL / batch sheet
-- (production_settings), a log of every document emailed (production_doc_sends
-- -- "what did we send them" must stay answerable after prices move), the
-- private bucket the sent PDFs are kept in, and the two location addresses the
-- BOL prints that were blank.

BEGIN;

-- ── 1. The item master ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.production_items (
  qbo_item_id    TEXT PRIMARY KEY,
  qbo_vendor_id  TEXT,
  unit_cost      NUMERIC,
  cost_uom       TEXT NOT NULL DEFAULT 'each',
  cost_note      TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE ops.production_items IS
  'Vendor + price for each stocked component the production system buys. Beats the QBO mirror; a BOM line override beats this.';

ALTER TABLE ops.production_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_items_select ON ops.production_items;
DROP POLICY IF EXISTS production_items_write  ON ops.production_items;
CREATE POLICY production_items_select ON ops.production_items
  FOR SELECT TO authenticated USING (ops.fn_is_staff());
CREATE POLICY production_items_write ON ops.production_items
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
GRANT SELECT, INSERT, UPDATE ON ops.production_items TO authenticated;
GRANT ALL ON ops.production_items TO service_role;

-- Seed from what the BOMs already say.  Vendor: the one the lines carry.
-- Cost: a line's explicit cost if any, else the QBO purchase cost -- and the
-- note says which, so a stale mirror price is visible as such, not silently
-- promoted to "our price".
INSERT INTO ops.production_items (qbo_item_id, qbo_vendor_id, unit_cost, cost_uom, cost_note)
SELECT l.component_qbo_item_id,
       (array_agg(l.preferred_qbo_vendor_id ORDER BY l.created_at)
          FILTER (WHERE l.preferred_qbo_vendor_id IS NOT NULL))[1],
       COALESCE((array_agg(l.default_cost) FILTER (WHERE l.default_cost IS NOT NULL))[1],
                qi.purchase_cost),
       COALESCE(min(l.qty_uom), 'each'),
       CASE WHEN bool_or(l.default_cost IS NOT NULL) THEN 'from BOM line'
            WHEN qi.purchase_cost IS NOT NULL THEN 'seeded from QuickBooks purchase cost — confirm against the vendor''s current sheet'
            ELSE NULL END
  FROM ops.product_bom_lines l
  LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.component_qbo_item_id
 WHERE l.line_type = 'component' AND l.component_qbo_item_id IS NOT NULL
 GROUP BY l.component_qbo_item_id, qi.purchase_cost
ON CONFLICT (qbo_item_id) DO NOTHING;

-- The master governs: a line vendor that just repeats the master is cleared.
UPDATE ops.product_bom_lines l
   SET preferred_qbo_vendor_id = NULL
  FROM ops.production_items pi
 WHERE pi.qbo_item_id = l.component_qbo_item_id
   AND l.preferred_qbo_vendor_id IS NOT DISTINCT FROM pi.qbo_vendor_id;

-- ── 2. Company identity on the documents ───────────────────────────────────
ALTER TABLE ops.production_settings
  ADD COLUMN IF NOT EXISTS company_name           TEXT NOT NULL DEFAULT 'Brix Beverage Dba Alameda Point Beverage Group',
  ADD COLUMN IF NOT EXISTS company_addr1          TEXT NOT NULL DEFAULT '1951 Monarch St',
  ADD COLUMN IF NOT EXISTS company_addr2          TEXT          DEFAULT 'Suite 200',
  ADD COLUMN IF NOT EXISTS company_city_state_zip TEXT NOT NULL DEFAULT 'Alameda, CA 94501',
  ADD COLUMN IF NOT EXISTS company_phone          TEXT,
  ADD COLUMN IF NOT EXISTS company_email          TEXT NOT NULL DEFAULT 'service@brixbev.com',
  ADD COLUMN IF NOT EXISTS company_web            TEXT NOT NULL DEFAULT 'alamedapointbg.com',
  ADD COLUMN IF NOT EXISTS doc_accent             TEXT NOT NULL DEFAULT '#dc2626',
  ADD COLUMN IF NOT EXISTS doc_from               TEXT NOT NULL DEFAULT 'Brix Beverage Purchasing <alerts@alamedapointbg.com>';
COMMENT ON COLUMN ops.production_settings.doc_from IS
  'From: on emailed POs / BOLs / batch sheets. Must be a Resend-verified sender; sendEmail() falls back to alerts@ if not.';

-- ── 3. What we sent, and to whom ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.production_doc_sends (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_kind      TEXT NOT NULL CHECK (doc_kind IN ('po','bol','batch_sheet')),
  ref_id        UUID NOT NULL,
  ref_label     TEXT,
  recipients    TEXT[] NOT NULL,
  cc            TEXT[] NOT NULL DEFAULT '{}',
  subject       TEXT NOT NULL,
  message       TEXT,
  storage_path  TEXT,
  resend_id     TEXT,
  status        TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error         TEXT,
  sent_by       UUID,
  sent_by_email TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_doc_sends_ref ON ops.production_doc_sends (doc_kind, ref_id, sent_at DESC);
ALTER TABLE ops.production_doc_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_doc_sends_select ON ops.production_doc_sends;
CREATE POLICY production_doc_sends_select ON ops.production_doc_sends
  FOR SELECT TO authenticated USING (ops.fn_is_staff());
GRANT SELECT ON ops.production_doc_sends TO authenticated;
GRANT ALL   ON ops.production_doc_sends TO service_role;

INSERT INTO storage.buckets (id, name, public)
VALUES ('production-docs', 'production-docs', false)
ON CONFLICT (id) DO NOTHING;

-- ── 4. The two addresses the BOL prints that were blank ────────────────────
UPDATE ops.inventory_locations
   SET address_line1 = '1951 Monarch St', address_line2 = 'Suite 200',
       city = 'Alameda', state = 'CA', postal_code = '94501', country = 'US'
 WHERE code = 'BRIX-WAREHOUSE' AND address_line1 IS NULL;

-- Quantum J's Canning LLC (the compliance vault has the same address on its
-- GMP certificate).  ZIP deliberately left blank rather than guessed.
UPDATE ops.inventory_locations
   SET address_line1 = '3540 State Hwy 52', address_line2 = 'Unit A2',
       city = 'Frederick', state = 'CO', country = 'US'
 WHERE code = 'QUANTUM-CANNING' AND address_line1 IS NULL;

COMMIT;
