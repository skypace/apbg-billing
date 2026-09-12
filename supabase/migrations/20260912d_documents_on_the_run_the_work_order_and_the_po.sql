-- 20260912d · documents live on the production order, the work order and the PO
--
-- From the production team's test notes (Calli, 2026-09-11), the main ask:
--   "Would like to be able to add attachments to work orders and POs such as
--    the attached Quantum Deposit invoice … Ability to add a folder with
--    multiple documents … put all COAs for each PO or canning run in one folder
--    … For example I have folders on my computer for June 2026 and October 2026
--    where I'm adding docs related to those runs … Maybe there is an extra tab
--    within the work orders that says 'associated documents' where all
--    attachments go … have it allow to move to the next production step without
--    the associated attachments — but maybe there is an indicator if there are
--    no attachments."
-- She also listed where each document belongs — ingredient invoices and the
-- deposit/can invoices at POs Issued, ingredient COAs at Materials at co-packer,
-- batch sheets and micro results at Yield Recorded, the freight paperwork at
-- Shipping to us, the signed BOL at Received — and said SDS and spec sheets stay
-- in Compliance & Safety because they are per ingredient, not per batch.
--
-- The model:
--   • ops.production_documents — one row per file, pointing at a production
--     ORDER (run_id), a WORK ORDER (wo_id) or a PURCHASE ORDER (po_id); at least
--     one, and any combination. Her "June 2026 folder" IS the production order:
--     a COA for the whole run is filed once against the run and shows on every
--     flavour's screen; a Quantum deposit invoice is filed against its PO (and
--     shows on the run that PO belongs to); a batch sheet is filed against the
--     flavour it was written for.
--   • `kind` is the vocabulary she listed (ingredient_invoice, deposit_invoice,
--     can_invoice, final_invoice, ingredient_coa, finished_coa, batch_sheet,
--     micro_results, freight_quote, freight_invoice, bol_signed, photo, other)
--     and `stage` is the pipeline step the document belongs to. Both are data
--     on the row so a screen can say "no documents yet at Yield Recorded"
--     without knowing anything else.
--   • ⚠ Nothing here GATES a step. A document arrives days after the step it
--     belongs to (Quantum's final invoice, Deibel's micro results), so a stage
--     advances with or without its paperwork and the screen shows a marker. A
--     gate would have been worked around on paper, which is what this replaces.
--   • Files live in a NEW private bucket `production-attachments`, gated by the
--     same internal-role pair as the compliance vault (20260911b): every internal
--     role reads, every internal role but Read-only writes. ⚠ Deliberately NOT
--     the compliance-docs bucket: that vault is per-party compliance paper and
--     its rows are what an inspector is shown; a run's invoices and batch sheets
--     are operations, and a folder that mixes the two is a folder somebody
--     prints the wrong half of.
--   • Rows are archived (archived_at/by), never deleted — a COA is a QC record.
--     No DELETE grant on the table.
--   • ops.v_production_documents joins the uploader's display name (owner-run,
--     gated on fn_is_internal() in the WHERE, the 20260912a shape) plus the
--     run number / batch code / PO number so the screens print names, not ids.
--
-- Manifest: brix-production:app-and-rpcs gains ops.production_documents
-- (written from Refractor → Production under the caller's JWT; the file bytes
-- go to production-attachments under storage RLS).

INSERT INTO storage.buckets (id, name, public)
VALUES ('production-attachments', 'production-attachments', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS production_attachments_read   ON storage.objects;
DROP POLICY IF EXISTS production_attachments_insert ON storage.objects;
DROP POLICY IF EXISTS production_attachments_update ON storage.objects;
DROP POLICY IF EXISTS production_attachments_delete ON storage.objects;
CREATE POLICY production_attachments_read   ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'production-attachments' AND ops.fn_is_internal());
CREATE POLICY production_attachments_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'production-attachments' AND ops.fn_is_internal_writer());
CREATE POLICY production_attachments_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'production-attachments' AND ops.fn_is_internal_writer())
  WITH CHECK (bucket_id = 'production-attachments' AND ops.fn_is_internal_writer());
CREATE POLICY production_attachments_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'production-attachments' AND ops.fn_is_internal_writer());

CREATE TABLE IF NOT EXISTS ops.production_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid REFERENCES ops.production_runs(id)  ON DELETE RESTRICT,
  wo_id         uuid REFERENCES ops.work_orders(id)      ON DELETE RESTRICT,
  po_id         uuid REFERENCES ops.purchase_orders(id)  ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN (
                  'ingredient_invoice','deposit_invoice','can_invoice','final_invoice',
                  'ingredient_coa','finished_coa','batch_sheet','micro_results',
                  'freight_quote','freight_invoice','bol_signed','photo','other')),
  stage         text CHECK (stage IN ('ordered','at_copacker','in_production','yield_recorded','in_transit','received','other')),
  title         text NOT NULL,
  file_name     text NOT NULL,
  storage_path  text NOT NULL UNIQUE,
  mime_type     text,
  size_bytes    bigint,
  doc_date      date,
  reference     text,
  notes         text,
  uploaded_by   uuid REFERENCES auth.users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  archived_by   uuid,
  CONSTRAINT production_documents_has_a_home CHECK (run_id IS NOT NULL OR wo_id IS NOT NULL OR po_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS production_documents_run_idx ON ops.production_documents (run_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS production_documents_wo_idx  ON ops.production_documents (wo_id)  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS production_documents_po_idx  ON ops.production_documents (po_id)  WHERE archived_at IS NULL;

COMMENT ON TABLE ops.production_documents IS
  '20260912d: a file filed against a production order, a work order and/or a purchase order — invoices, COAs, batch sheets, micro results, freight paperwork, the signed BOL. kind + stage say what it is and which step it belongs to; nothing gates a step on it. Archived, never deleted. Files in the private production-attachments bucket.';

ALTER TABLE ops.production_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_documents_select ON ops.production_documents;
DROP POLICY IF EXISTS production_documents_insert ON ops.production_documents;
DROP POLICY IF EXISTS production_documents_update ON ops.production_documents;
CREATE POLICY production_documents_select ON ops.production_documents FOR SELECT TO authenticated USING (ops.fn_is_internal());
CREATE POLICY production_documents_insert ON ops.production_documents FOR INSERT TO authenticated WITH CHECK (ops.fn_is_internal_writer());
CREATE POLICY production_documents_update ON ops.production_documents FOR UPDATE TO authenticated USING (ops.fn_is_internal_writer()) WITH CHECK (ops.fn_is_internal_writer());
-- GRANTs beside the policies (Postgres checks the grant before RLS — the 20260825a lesson). No DELETE.
REVOKE ALL ON ops.production_documents FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON ops.production_documents TO authenticated;
GRANT ALL ON ops.production_documents TO service_role;

CREATE OR REPLACE VIEW ops.v_production_documents AS
SELECT d.*,
       CASE WHEN d.uploaded_by IS NULL THEN 'system'
            ELSE COALESCE(NULLIF(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(u.email, '@', 1), 'unknown user') END AS uploaded_by_name,
       r.run_number, w.batch_code, b.name AS flavour, po.po_number, po.qbo_vendor_id, v.display_name AS vendor_name,
       -- a document filed against a PO or a work order also belongs to the order they sit on
       COALESCE(d.run_id, w.run_id, po.production_run_id) AS effective_run_id
  FROM ops.production_documents d
  LEFT JOIN auth.users u ON u.id = d.uploaded_by
  LEFT JOIN ops.production_runs r ON r.id = d.run_id
  LEFT JOIN ops.work_orders w ON w.id = d.wo_id
  LEFT JOIN ops.product_bom b ON b.id = w.bom_id
  LEFT JOIN ops.purchase_orders po ON po.id = d.po_id
  LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = po.qbo_vendor_id
 WHERE ops.fn_is_internal();

COMMENT ON VIEW ops.v_production_documents IS
  '20260912d: production_documents + uploader name + run number / batch code / flavour / PO number. effective_run_id = the order the document belongs to whether it was filed on the run, a flavour or a PO. Owner-run so the name can be read; gated on fn_is_internal() in the WHERE.';
REVOKE ALL ON ops.v_production_documents FROM PUBLIC, anon;
GRANT SELECT ON ops.v_production_documents TO authenticated, service_role;
