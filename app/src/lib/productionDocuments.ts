// Documents on the production order, the work order and the purchase order
// (migration 20260912d). One row per file; a row points at a run, a flavour
// (work order) and/or a PO — any combination. `kind` says what the paper is,
// `stage` which pipeline step it belongs to, so a screen can say "no documents
// yet at Yield Recorded" without knowing anything else. Nothing here gates a
// step: the paperwork arrives days after the step (Quantum's final invoice,
// Deibel's micro results), so the marker is a nudge, never a wall.
//
// Files live in the private `production-attachments` bucket under storage RLS
// (every internal role reads; every internal role but Read-only writes), so the
// upload and the download both ride the caller's own JWT — same shape as
// lib/compliance.ts, deliberately not the compliance-docs bucket (that vault is
// per-party compliance paper; a run's invoices and batch sheets are operations).
import { SB_URL, SB_KEY, _sbToken } from './supabase';
import { sbq, sbInsert, sbUpdate } from './rpc';
import type { WorkOrderStatus } from './production';

export type DocKind =
  | 'ingredient_invoice' | 'deposit_invoice' | 'can_invoice' | 'final_invoice'
  | 'ingredient_coa' | 'finished_coa' | 'batch_sheet' | 'micro_results'
  | 'freight_quote' | 'freight_invoice' | 'bol_signed' | 'photo' | 'other';

export type DocStage = 'ordered' | 'at_copacker' | 'in_production' | 'yield_recorded' | 'in_transit' | 'received' | 'other';

/** Calli's list (2026-09-11): which paper belongs to which step. The stage is the default when a
 *  document of that kind is filed; it can be changed on the row. */
export const DOC_KINDS: { kind: DocKind; label: string; stage: DocStage; hint: string }[] = [
  { kind: 'ingredient_invoice', label: 'Ingredient invoice (Calderoni)', stage: 'ordered',        hint: 'the syrup / ingredients bill' },
  { kind: 'deposit_invoice',    label: 'Co-packer deposit invoice',      stage: 'ordered',        hint: 'Quantum\'s deposit — note SKUs, month and gallons, they leave those off' },
  { kind: 'can_invoice',        label: 'Can invoice',                    stage: 'ordered',        hint: 'the empty cans' },
  { kind: 'final_invoice',      label: 'Co-packer final balance invoice', stage: 'yield_recorded', hint: 'Quantum\'s final — updates the deposit bill in QuickBooks via Bills' },
  { kind: 'ingredient_coa',     label: 'Ingredient COA',                 stage: 'at_copacker',    hint: 'one per ingredient lot' },
  { kind: 'batch_sheet',        label: 'Batch sheet (as run)',           stage: 'yield_recorded', hint: 'the co-packer\'s completed sheet' },
  { kind: 'micro_results',      label: 'Micro results',                  stage: 'yield_recorded', hint: 'Deibel or whoever ran them' },
  { kind: 'finished_coa',       label: 'Finished-goods COA',             stage: 'yield_recorded', hint: 'per lot' },
  { kind: 'freight_quote',      label: 'Freight quote',                  stage: 'in_transit',     hint: '' },
  { kind: 'freight_invoice',    label: 'Freight invoice',                stage: 'in_transit',     hint: 'the one you rarely see — chase it' },
  { kind: 'bol_signed',         label: 'Signed BOL',                     stage: 'received',       hint: 'uploaded by the Alameda team when the truck is received' },
  { kind: 'photo',              label: 'Photo',                          stage: 'other',          hint: '' },
  { kind: 'other',              label: 'Other',                          stage: 'other',          hint: '' },
];

export const STAGE_LABEL: Record<DocStage, string> = {
  ordered: 'POs issued', at_copacker: 'Materials at co-packer', in_production: 'In production',
  yield_recorded: 'Yield recorded', in_transit: 'Shipping to us', received: 'Received', other: 'Other',
};
export const STAGE_ORDER: DocStage[] = ['ordered', 'at_copacker', 'in_production', 'yield_recorded', 'in_transit', 'received', 'other'];

/** The pipeline steps a document is EXPECTED at — the marker reads "no documents yet" only for a
 *  stage the order has reached or passed; a stage still ahead is not missing anything. */
export function stageReached(status: WorkOrderStatus | string, stage: DocStage): boolean {
  const order: string[] = ['draft', 'ordered', 'at_copacker', 'in_production', 'yield_recorded', 'in_transit', 'received', 'closed'];
  const cur = order.indexOf(status);
  const st = order.indexOf(stage);
  if (cur < 0 || st < 0) return false;
  return cur >= st;
}

export interface ProductionDocument {
  id: string;
  run_id: string | null;
  wo_id: string | null;
  po_id: string | null;
  kind: DocKind;
  stage: DocStage | null;
  title: string;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_date: string | null;
  reference: string | null;
  notes: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  archived_at: string | null;
  // v_production_documents
  uploaded_by_name: string | null;
  run_number: string | null;
  batch_code: string | null;
  flavour: string | null;
  po_number: string | null;
  vendor_name: string | null;
  effective_run_id: string | null;
}

/** Everything filed against this order — on the order itself, on any of its flavours, or on any of its POs. */
export async function fetchRunDocuments(runId: string): Promise<ProductionDocument[]> {
  return sbq<ProductionDocument>('v_production_documents', `select=*&effective_run_id=eq.${runId}&archived_at=is.null&order=uploaded_at.desc`);
}
/** Filed against this flavour, plus anything filed on its order (a run-level COA shows on every flavour). */
export async function fetchWorkOrderDocuments(woId: string, runId: string | null): Promise<ProductionDocument[]> {
  const or = runId ? `or=(wo_id.eq.${woId},run_id.eq.${runId})` : `wo_id=eq.${woId}`;
  return sbq<ProductionDocument>('v_production_documents', `select=*&${or}&archived_at=is.null&order=uploaded_at.desc`);
}
export async function fetchPoDocuments(poId: string): Promise<ProductionDocument[]> {
  return sbq<ProductionDocument>('v_production_documents', `select=*&po_id=eq.${poId}&archived_at=is.null&order=uploaded_at.desc`);
}

export const MAX_DOC_BYTES = 25 * 1024 * 1024;

export interface FileDocArgs {
  file: File;
  kind: DocKind;
  stage: DocStage;
  title?: string;
  run_id?: string | null;
  wo_id?: string | null;
  po_id?: string | null;
  doc_date?: string | null;
  reference?: string | null;
  notes?: string | null;
}

/** Upload the bytes FIRST, then write the row that names them — a row pointing at a file that never
 *  landed is worse than a stray file (the same order the NDA and signature flows use). */
export async function fileProductionDocument(a: FileDocArgs): Promise<void> {
  if (!a.run_id && !a.wo_id && !a.po_id) throw new Error('a document must belong to an order, a work order or a PO');
  if (a.file.size > MAX_DOC_BYTES) throw new Error('file is over 25 MB');
  const token = await _sbToken();
  const safeName = a.file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const folder = a.run_id ?? a.wo_id ?? a.po_id;
  const path = `${folder}/${Date.now()}-${safeName}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/production-attachments/${path}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': a.file.type || 'application/octet-stream', 'x-upsert': 'true' },
    body: a.file,
  });
  if (!res.ok) throw new Error('file upload failed: ' + res.status + ' ' + (await res.text().catch(() => '')));
  await sbInsert('production_documents', {
    run_id: a.run_id ?? null, wo_id: a.wo_id ?? null, po_id: a.po_id ?? null,
    kind: a.kind, stage: a.stage,
    title: (a.title ?? '').trim() || a.file.name,
    file_name: a.file.name, storage_path: path, mime_type: a.file.type || null, size_bytes: a.file.size,
    doc_date: a.doc_date || null, reference: (a.reference ?? '').trim() || null, notes: (a.notes ?? '').trim() || null,
  });
}

export async function archiveProductionDocument(id: string): Promise<void> {
  await sbUpdate('production_documents', `id=eq.${id}`, { archived_at: new Date().toISOString() });
}

export async function updateProductionDocument(id: string, patch: Partial<Pick<ProductionDocument, 'title' | 'kind' | 'stage' | 'doc_date' | 'reference' | 'notes'>>): Promise<void> {
  await sbUpdate('production_documents', `id=eq.${id}`, patch);
}

/** Open a private-bucket file in a new tab via a blob URL — the bucket needs the bearer and a plain link cannot carry one. */
export async function openProductionDocument(doc: ProductionDocument): Promise<void> {
  const token = await _sbToken();
  const w = window.open('', '_blank');
  try {
    const res = await fetch(`${SB_URL}/storage/v1/object/authenticated/production-attachments/${doc.storage_path}`, {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('file download failed: ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (w) w.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { if (w) w.close(); throw e; }
}
