// Vendor registry data layer (Vendor Portal Phase 1).
//
// Plain CRUD on ops.vendors / ops.insured_parties and reads of the
// ops.qbo_vendors mirror + ops.compliance_documents all go straight through
// the Supabase client under staff-only RLS — no function in the middle.
// The ONE server hop is vendorsApi() → /expense/api/expense-vendors, which
// exists only for the actions that must touch QuickBooks live (search /
// create a QBO Vendor through the hardened billing token chain).
import { supabase, getAccessToken } from '@/lib/supabase';
import type {
  Vendor, VendorRequirements, QboVendorMirror, VendorComplianceDoc, VendorType,
  TaxClassification,
} from '@/types/expense';

// ── ops.vendors CRUD ─────────────────────────────────────────────────────────

export async function listVendors(includeArchived = false): Promise<Vendor[]> {
  let q = supabase.from('vendors').select('*').order('display_name');
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as Vendor[]) ?? [];
}

export async function getVendor(id: string): Promise<Vendor | null> {
  const { data, error } = await supabase.from('vendors').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Vendor) ?? null;
}

export async function createVendor(fields: Partial<Vendor>): Promise<Vendor> {
  const { data, error } = await supabase.from('vendors').insert(fields).select('*').single();
  if (error) {
    if (error.code === '23505') throw new Error(`A vendor named "${fields.display_name}" already exists.`);
    throw new Error(error.message);
  }
  return data as Vendor;
}

export async function updateVendor(id: string, patch: Partial<Vendor>): Promise<Vendor> {
  const { data, error } = await supabase.from('vendors').update(patch).eq('id', id).select('*').single();
  if (error) throw new Error(error.message);
  return data as Vendor;
}

export async function archiveVendor(id: string, by: string): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ archived_at: new Date().toISOString(), archived_by: by })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function unarchiveVendor(id: string): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ archived_at: null, archived_by: null })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// ── ops.qbo_vendors mirror (read-only picker source) ─────────────────────────

export async function searchQboMirror(term: string): Promise<QboVendorMirror[]> {
  const { data, error } = await supabase
    .from('qbo_vendors')
    .select('qbo_vendor_id, display_name, company_name, active, email, phone')
    .eq('active', true)
    .ilike('display_name', `%${term.replace(/[%_]/g, '')}%`)
    .order('display_name')
    .limit(15);
  if (error) throw new Error(error.message);
  return (data as QboVendorMirror[]) ?? [];
}

// ── Compliance vault reads (by insured party) ────────────────────────────────

export async function partyDocuments(insuredPartyId: string): Promise<VendorComplianceDoc[]> {
  const { data, error } = await supabase
    .from('compliance_documents')
    .select('id, category, doc_type, issuer, reference_number, issue_date, expiration_date, file_name, storage_path, archived_at')
    .eq('party_id', insuredPartyId)
    .is('archived_at', null)
    .order('expiration_date', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data as VendorComplianceDoc[]) ?? [];
}

/** One query for the roster's chips: every live doc across many parties. */
export async function documentsForParties(partyIds: string[]): Promise<Map<string, VendorComplianceDoc[]>> {
  const out = new Map<string, VendorComplianceDoc[]>();
  if (partyIds.length === 0) return out;
  const { data, error } = await supabase
    .from('compliance_documents')
    .select('id, party_id, category, doc_type, issuer, reference_number, issue_date, expiration_date, file_name, storage_path, archived_at')
    .in('party_id', partyIds)
    .is('archived_at', null);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as (VendorComplianceDoc & { party_id: string })[]) {
    const list = out.get(row.party_id) ?? [];
    list.push(row);
    out.set(row.party_id, list);
  }
  return out;
}

/** Create the compliance-vault party for a vendor that has none and stamp
 *  the link. The Vendors module writes insured_parties ONLY here (registered
 *  in sync-manifest as brixpense-vendors:app-and-fn, multi-writer with
 *  brix-compliance:app). */
export async function ensureInsuredParty(vendor: Vendor): Promise<string> {
  if (vendor.insured_party_id) return vendor.insured_party_id;
  const { data, error } = await supabase
    .from('insured_parties')
    .insert({
      name: vendor.display_name,
      party_type: vendor.vendor_type === 'contractor' ? 'contractor' : 'vendor',
      contact_name: vendor.contact_name,
      contact_email: vendor.contact_email,
      contact_phone: vendor.contact_phone,
      notes: 'Created from Brixpense → Vendors',
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  const partyId = (data as { id: string }).id;
  await updateVendor(vendor.id, { insured_party_id: partyId });
  return partyId;
}

// ── QBO live actions (the only server hop) ───────────────────────────────────

export interface QboLiveVendor {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
}

export async function vendorsApi<T>(body: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch('/expense/api/expense-vendors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const searchQboLive = (term: string) =>
  vendorsApi<{ vendors: QboLiveVendor[] }>({ action: 'qbo_search', term }).then((r) => r.vendors);

/** Staff-triggered "Request documents" — mints a one-time onboarding link and
 *  emails it to the vendor (Phase 2). */
export async function requestDocs(vendorId: string, email?: string): Promise<{ sent_to: string; expires_at: string }> {
  const token = await getAccessToken();
  const res = await fetch('/expense/api/vendor-request-docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ vendor_id: vendorId, ...(email ? { email } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as { sent_to: string; expires_at: string };
}

export interface VendorInvite {
  purpose: 'onboard' | 'docs_refresh';
  sent_to: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** Latest invite/chase link minted for a vendor (staff-readable — hashes only,
 *  never the raw token). */
export async function latestInvite(vendorId: string): Promise<VendorInvite | null> {
  const { data, error } = await supabase
    .from('vendor_onboard_tokens')
    .select('purpose, sent_to, created_by, created_at, expires_at, used_at')
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as VendorInvite) ?? null;
}

export const createQboVendor = (fields: { display_name: string; company_name?: string; email?: string; phone?: string }) =>
  vendorsApi<{ vendor: QboLiveVendor; existed?: boolean }>({ action: 'qbo_create', ...fields });

// ── Compliance rollup (computed where displayed — vault convention) ──────────

export type CoiState = 'current' | 'expiring' | 'expired' | 'missing' | 'untracked';

export interface VendorCompliance {
  coi: CoiState;
  /** Expiration date of the governing (newest-expiring) COI, if any. */
  coiExpires: string | null;
  w9OnFile: boolean;
}

const W9_RE = /w[\s-]?9/i;
const DAY = 86400000;

export function requirementsSet(req: VendorRequirements | null | undefined): boolean {
  if (!req) return false;
  return Boolean(req.gl_each_occurrence || req.wc_required || req.auto_required || req.additional_insured_required);
}

/** COI chip: newest insurance doc's expiration → current / ≤30d expiring /
 *  expired. No insurance doc at all → 'missing' when requirements are set,
 *  'untracked' (neutral) when they aren't. W-9: vault doc OR the registry's
 *  own w9_status flag. */
export function vendorCompliance(vendor: Vendor, docs: VendorComplianceDoc[]): VendorCompliance {
  const insurance = docs.filter((d) => d.category === 'insurance');
  let coi: CoiState;
  let coiExpires: string | null = null;
  if (insurance.length === 0) {
    coi = requirementsSet(vendor.requirements) ? 'missing' : 'untracked';
  } else {
    // The governing certificate is the one that expires last (or never).
    const governing = insurance.reduce((best, d) => {
      if (!best) return d;
      if (!best.expiration_date) return best;
      if (!d.expiration_date) return d;
      return d.expiration_date > best.expiration_date ? d : best;
    }, null as VendorComplianceDoc | null)!;
    coiExpires = governing.expiration_date;
    if (!coiExpires) {
      coi = 'current';
    } else {
      const msLeft = new Date(`${coiExpires}T00:00:00`).getTime() - Date.now();
      coi = msLeft < 0 ? 'expired' : msLeft <= 30 * DAY ? 'expiring' : 'current';
    }
  }
  const w9OnFile = vendor.w9_status === 'on_file' || docs.some((d) => W9_RE.test(d.doc_type));
  return { coi, coiExpires, w9OnFile };
}

// ── Display labels ───────────────────────────────────────────────────────────

export const VENDOR_TYPE_LABEL: Record<VendorType, string> = {
  contractor: 'Contractor',
  supplier: 'Supplier',
  service: 'Service',
  other: 'Other',
};

export const PAYMENT_PREF_LABEL: Record<string, string> = {
  ach: 'ACH',
  paypal: 'PayPal',
  venmo: 'Venmo',
  zelle_manual: 'Zelle (manual)',
  check_manual: 'Check (manual)',
};

export const ONBOARD_LABEL: Record<string, string> = {
  new: 'New',
  invited: 'Invited',
  docs_pending: 'Docs pending',
  complete: 'Complete',
};

// ── 1099 ─────────────────────────────────────────────────────────────────────
//
// The report is a CANDIDATE LIST, not a filing. It reads the QBO expense mirror
// (Bills + Purchases less VendorCredits), which is ACCRUAL, while 1099 is CASH
// basis — a bill entered in December and paid in January lands in the wrong
// year here. QuickBooks' own 1099 module is the source of truth for the forms.
//
// What this is FOR is the part QuickBooks can't help with in August: which
// vendors have crossed the threshold and have no W-9 on file, while they still
// answer the phone.

export interface Vendor1099Row {
  vendor_name: string;
  paid_total: number;
  txn_count: number;
  first_txn: string | null;
  last_txn: string | null;
  qbo_vendor_id: string | null;
  vendor_id: string | null;
  w9_status: 'missing' | 'on_file' | null;
  w9_received_at: string | null;
  tax_classification: TaxClassification | null;
  ein_last4: string | null;
  backup_withholding: boolean;
  /** null = nobody has classified this vendor yet. */
  reportable: boolean | null;
  over_threshold: boolean;
  needs_w9: boolean;
}

export async function list1099Candidates(year: number, threshold = 600): Promise<Vendor1099Row[]> {
  const { data, error } = await supabase.rpc('fn_1099_candidates', {
    p_year: year,
    p_threshold: threshold,
  });
  if (error) throw new Error(error.message);
  return ((data as Vendor1099Row[]) ?? []).map((r) => ({
    ...r,
    paid_total: Number(r.paid_total || 0),
    txn_count: Number(r.txn_count || 0),
  }));
}

// A vendor name that looks like a PERSON. Used only to ORDER the list, never to
// filter it — an individual contractor is the likeliest 1099 and the hardest to
// chase later, so they belong at the top. It is a guess, so it must not be
// allowed to hide anyone: dropping a real obligation because a sole
// proprietorship trades under a company name is the failure that costs money.
const ORG_MARKER = /\b(inc|llc|l\.l\.c|ltd|corp|corporation|co|company|holdings|group|services?|supply|solutions?|systems?|industries|enterprises|partners|associates|bank|city|county|state|dept|department|university|insurance|utilities|energy|gas|electric|telecom|wireless|bros|&)\b/i;

export function looksLikePerson(name: string): boolean {
  const n = String(name || '').trim();
  if (!n || ORG_MARKER.test(n)) return false;
  if (/[0-9@/]/.test(n)) return false;              // account numbers, emails, "CITY OF ALAMEDA/RENT"
  // 2–3 words. Four-word names are almost always organisations
  // ("THE HUB DESIGN INNOVATION"); people rarely file under four.
  const words = n.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 3;
}

/** Most-likely-to-need-chasing first: unclassified people, then everyone else
 *  who needs a W-9, then by spend. */
export function rank1099(rows: Vendor1099Row[]): Vendor1099Row[] {
  return [...rows].sort((a, b) => {
    const score = (r: Vendor1099Row) =>
      (r.needs_w9 ? 2 : 0) + (r.needs_w9 && looksLikePerson(r.vendor_name) ? 2 : 0);
    return score(b) - score(a) || b.paid_total - a.paid_total;
  });
}
