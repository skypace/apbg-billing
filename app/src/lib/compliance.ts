import { sbq, sbInsert, sbUpdate } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────

export type ComplianceCategory = 'insurance' | 'permit' | 'food_safety' | 'safety' | 'tax' | 'other';
export type HolderEntity = 'alameda_soda' | 'brix' | 'freeflow' | 'shared';
export type PartyType = 'co_packer' | 'contractor' | 'vendor' | 'landlord' | 'customer' | 'other';

export const CATEGORY_LABEL: Record<ComplianceCategory, string> = {
  insurance: 'Insurance',
  permit: 'Permits & Registrations',
  food_safety: 'Food Safety & QA',
  safety: 'Safety',
  tax: 'Tax',
  other: 'Other',
};

export const ENTITY_LABEL: Record<HolderEntity, string> = {
  alameda_soda: 'Alameda Soda',
  brix: 'Brix Beverage',
  freeflow: 'FreeFlow',
  shared: 'Shared / Both',
};

export const PARTY_TYPE_LABEL: Record<PartyType, string> = {
  co_packer: 'Co-packer',
  contractor: 'Contractor',
  vendor: 'Vendor',
  landlord: 'Landlord',
  customer: 'Customer',
  other: 'Other',
};

export interface InsuredParty {
  id: string;
  name: string;
  party_type: PartyType;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ComplianceDocument {
  id: string;
  category: ComplianceCategory;
  doc_type: string;
  holder_entity: HolderEntity | null;
  party_id: string | null;
  facility: string | null;
  issuer: string | null;
  reference_number: string | null;
  issue_date: string | null;
  expiration_date: string | null;
  storage_path: string | null;
  file_name: string | null;
  notes: string | null;
  archived_at: string | null;
  archived_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComplianceDocumentInput {
  category: ComplianceCategory;
  doc_type: string;
  holder_entity?: HolderEntity | null;
  party_id?: string | null;
  facility?: string | null;
  issuer?: string | null;
  reference_number?: string | null;
  issue_date?: string | null;
  expiration_date?: string | null;
  storage_path?: string | null;
  file_name?: string | null;
  notes?: string | null;
}

// ── Expiration status (computed where displayed — nothing stored) ────────

export type ExpiryStatus = 'expired' | 'expiring' | 'current' | 'no_expiry';
export const EXPIRING_SOON_DAYS = 60;

export function expiryStatus(doc: Pick<ComplianceDocument, 'expiration_date'>): ExpiryStatus {
  if (!doc.expiration_date) return 'no_expiry';
  const exp = new Date(doc.expiration_date + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (exp < today) return 'expired';
  const soon = new Date(today); soon.setDate(soon.getDate() + EXPIRING_SOON_DAYS);
  if (exp <= soon) return 'expiring';
  return 'current';
}

export function daysUntil(dateISO: string): number {
  const target = new Date(dateISO + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function fetchComplianceDocuments(): Promise<ComplianceDocument[]> {
  return sbq<ComplianceDocument>('compliance_documents',
    'select=*&archived_at=is.null&order=expiration_date.asc.nullslast,category.asc');
}

export async function fetchInsuredParties(): Promise<InsuredParty[]> {
  return sbq<InsuredParty>('insured_parties', 'select=*&active=eq.true&order=name.asc');
}

// ── Mutations (direct PostgREST under fn_is_staff RLS) ───────────────────

export async function createComplianceDocument(input: ComplianceDocumentInput): Promise<ComplianceDocument> {
  const rows = await sbInsert<ComplianceDocumentInput>('compliance_documents', input);
  return (rows as unknown as ComplianceDocument[])[0];
}

export async function updateComplianceDocument(
  id: string, patch: Partial<ComplianceDocumentInput>,
): Promise<void> {
  await sbUpdate('compliance_documents', `id=eq.${id}`, patch);
}

export async function archiveComplianceDocument(id: string, by: string): Promise<void> {
  await sbUpdate('compliance_documents', `id=eq.${id}`,
    { archived_at: new Date().toISOString(), archived_by: by } as never);
}

export async function createInsuredParty(input: {
  name: string; party_type: PartyType;
  contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null;
  notes?: string | null;
}): Promise<InsuredParty> {
  const rows = await sbInsert('insured_parties', input);
  return (rows as unknown as InsuredParty[])[0];
}

// ── Files (private bucket compliance-docs, staff-gated storage RLS) ──────

export async function uploadComplianceFile(docContext: string, file: File): Promise<string> {
  const token = await _sbToken();
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = `${docContext}/${Date.now()}-${safeName}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/compliance-docs/${path}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('file upload failed: ' + res.status + ' ' + text);
  }
  return path;
}

/** Download a private-bucket document via an object URL. */
export async function openComplianceFile(path: string): Promise<void> {
  const token = await _sbToken();
  const res = await fetch(`${SB_URL}/storage/v1/object/authenticated/compliance-docs/${path}`, {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('file download failed: ' + res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() ?? 'document';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
