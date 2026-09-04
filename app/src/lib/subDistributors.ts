import { sbq, sbrpc, sbInsert, sbUpdate } from './rpc';
import { SB_URL, SB_KEY, _sbToken } from './supabase';

// ── Types (mirror supabase/migrations/20260818f_sub_distributors.sql) ─────

export type SubDistributorStatus = 'pending' | 'active' | 'inactive';
export type SubDistributorModel = 'consignment' | 'sell_in';

export interface SubDistributor {
  id: string;
  code: string;
  name: string;
  status: SubDistributorStatus;
  model: SubDistributorModel;
  per_case_delivery_fee: number | null;
  qbo_customer_id: string | null;
  qbo_vendor_id: string | null;
  sf_customer_id: number | null;
  inventory_location_id: string | null;
  territory: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type NewSubDistributor = Pick<SubDistributor, 'code' | 'name'> &
  Partial<Omit<SubDistributor, 'id' | 'code' | 'name' | 'created_at' | 'updated_at'>>;

// The lifecycle a BUILT agreement moves through. 'void' predates the builder
// and is kept so historical uploaded rows still render; 'revoked' is what the
// builder writes when a link is switched off before it is signed.
export type AgreementStatus =
  | 'draft' | 'sent' | 'signed' | 'declined' | 'revoked' | 'expired' | 'superseded' | 'void';

export interface FeeLine { label: string; rate: number | string | null; unit: string }
export interface ServiceLevel { level: number; name: string; hours: number; description: string }
export interface InsuranceLine { line: string; limit: string }

/**
 * Everything the Fee and Territory Schedule prints. A key left OUT falls back
 * to the shipped default; an explicitly EMPTY array means "none", which is a
 * real answer — a partner who does no service work has no response times, and
 * silently restoring the defaults there would commit them to hours nobody
 * agreed to.
 */
export interface DealTerms {
  model?: string;
  territory?: string;
  accounts?: string;
  per_case_fee?: number | null;
  per_case_unit?: string;
  other_fees?: FeeLine[];
  service_rate?: string;
  settlement_day?: string;
  payment_term?: string;
  notice_company_email?: string;
  notice_distributor_email?: string;
  service_levels?: ServiceLevel[];
  insurance?: InsuranceLine[];
  extra?: string;
}

export interface SubDistributorAgreement {
  id: string;
  sub_distributor_id: string;
  version: number;
  title: string | null;
  model: SubDistributorModel;
  per_case_delivery_fee: number | null;
  effective_date: string | null;
  expiry_date: string | null;
  terms: string | null;
  scope: string | null;
  file_path: string | null;
  file_name: string | null;
  status: AgreementStatus;
  sent_at: string | null;
  sent_to: string | null;
  signed_at: string | null;
  signer_name: string | null;
  signer_email: string | null;
  signature_data: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  created_at: string;
  updated_at: string;

  // ── Built agreements (the contract builder) ──
  // An uploaded PDF has file_path and no body_source; a built agreement has
  // body_source — the SNAPSHOT of the template text at build time, which is
  // what makes a later template edit unable to change what somebody signed.
  agreement_number: string | null;
  template_id: string | null;
  template_code: string | null;
  template_version: string | null;
  subtitle: string | null;
  body_source: string | null;
  deal_terms: DealTerms | null;
  counterparty_legal_name: string | null;
  counterparty_entity_type: string | null;
  counterparty_state: string | null;
  counterparty_address: string | null;
  signer_title: string | null;
  typed_name: string | null;
  consent_esign: boolean | null;
  company_signer_name: string | null;
  company_signer_title: string | null;
  company_signed_at: string | null;
  expires_at: string | null;
  viewed_at: string | null;
  resent_count: number | null;
  sent_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  executed_pdf_path: string | null;
  executed_pdf_at: string | null;
  notes: string | null;
}

/** True when this row was built from a template rather than uploaded as a PDF. */
export const isBuiltAgreement = (a: Pick<SubDistributorAgreement, 'body_source'>) =>
  !!(a.body_source && a.body_source.length);

export type NewAgreement = Pick<SubDistributorAgreement, 'sub_distributor_id' | 'version' | 'model'> &
  Partial<Omit<SubDistributorAgreement, 'id' | 'sub_distributor_id' | 'version' | 'model' | 'created_at' | 'updated_at'>>;

export type DistributorUserRole = 'admin' | 'member';

export interface SubDistributorUser {
  id: string;
  sub_distributor_id: string;
  email: string;
  user_id: string | null;
  role: DistributorUserRole;
  is_active: boolean;
  created_at: string;
}

export interface SubDistributorAccount {
  id: string;
  sub_distributor_id: string;
  qbo_customer_id: string;
  account_name: string | null;
  chain: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export type DistributorOrderStatus = 'submitted' | 'fulfilled' | 'cancelled';

export interface SubDistributorOrder {
  id: string;
  sub_distributor_id: string;
  order_number: string;
  status: DistributorOrderStatus;
  requested_date: string | null;
  notes: string | null;
  submitted_by_email: string | null;
  submitted_at: string;
  decided_at: string | null;
  decision_notes: string | null;
  transfer_id: string | null;
  created_at: string;
}

export interface SubDistributorOrderLine {
  id: string;
  order_id: string;
  qbo_item_id: string;
  qty: number;
  unit_price: number | null;
  notes: string | null;
  created_at: string;
}

export interface SubDistributorDepletion {
  id: string;
  batch_id: string;
  sub_distributor_id: string;
  account_id: string | null;
  qbo_item_id: string;
  cases: number;
  delivered_date: string;
  reference: string | null;
  movement_id: string | null;
  fee_per_case: number | null;
  fee_amount: number | null;
  settlement_id: string | null;
  recorded_by_email: string | null;
  created_at: string;
}

export type SettlementStatus = 'open' | 'void';

export interface SubDistributorSettlement {
  id: string;
  sub_distributor_id: string;
  period_start: string;
  period_end: string;
  depletion_count: number;
  total_cases: number;
  total_fee: number;
  status: SettlementStatus;
  expense_request_id: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

export interface SettlementCreateResult {
  settlement_id: string;
  reference: string;
  depletions: number;
  total_cases: number;
  total_fee: number;
  expense_request_id: string;
  vendor: string;
}

export interface QboVendorLite {
  qbo_vendor_id: string;
  display_name: string;
  company_name: string | null;
  active: boolean | null;
  city: string | null;
  state: string | null;
}

export interface QboExpenseLine {
  id: number;
  qbo_txn_id: string | null;
  qbo_txn_type: string | null;
  item_name: string | null;
  account_name: string | null;
  description: string | null;
  amount: number | null;
  txn_date: string | null;
  vendor_name: string | null;
}

export interface QboCustomerLite {
  qbo_customer_id: string;
  display_name: string;
}

export interface QboItemLite {
  qbo_item_id: string;
  name: string;
  fully_qualified_name: string | null;
  active: boolean | null;
}

// ── Registry CRUD ─────────────────────────────────────────────────────────

export async function fetchSubDistributors(): Promise<SubDistributor[]> {
  return sbq<SubDistributor>('sub_distributors', 'select=*&order=name.asc');
}

function first<T>(v: T | T[]): T {
  return Array.isArray(v) ? v[0] : v;
}

export async function createSubDistributor(row: NewSubDistributor): Promise<SubDistributor> {
  const inserted = await sbInsert<NewSubDistributor>('sub_distributors', row);
  return first(inserted) as SubDistributor;
}

export async function updateSubDistributor(
  id: string,
  patch: Partial<SubDistributor>,
): Promise<SubDistributor> {
  const updated = await sbUpdate<SubDistributor>('sub_distributors', `id=eq.${id}`, patch);
  return first(updated) as SubDistributor;
}

// ── Agreements ────────────────────────────────────────────────────────────

export async function fetchAgreements(subDistributorId: string): Promise<SubDistributorAgreement[]> {
  return sbq<SubDistributorAgreement>(
    'sub_distributor_agreements',
    `select=*&sub_distributor_id=eq.${subDistributorId}&order=version.desc`,
  );
}

export async function createAgreement(row: NewAgreement): Promise<SubDistributorAgreement> {
  const inserted = await sbInsert<NewAgreement>('sub_distributor_agreements', row);
  return first(inserted) as SubDistributorAgreement;
}

export async function updateAgreement(
  id: string,
  patch: Partial<SubDistributorAgreement>,
): Promise<SubDistributorAgreement> {
  const updated = await sbUpdate<SubDistributorAgreement>(
    'sub_distributor_agreements',
    `id=eq.${id}`,
    patch,
  );
  return first(updated) as SubDistributorAgreement;
}

/** Flip a draft agreement to 'sent' with a timestamp + recipient stamp. */
export async function sendAgreement(id: string, sentTo: string): Promise<SubDistributorAgreement> {
  return updateAgreement(id, {
    status: 'sent',
    sent_at: new Date().toISOString(),
    sent_to: sentTo,
  });
}

// ── QuickBooks vendor ─────────────────────────────────────────────────────

export interface QboVendorPushResult {
  ok: true;
  /** created | linked_existing | already_linked — never a second vendor. */
  outcome: 'created' | 'linked_existing' | 'already_linked';
  qbo_vendor_id: string;
  display_name: string;
  /** Things a human needs to know: a name collision, a missing remit-to. */
  notes: string[];
}

/**
 * Create the partner's QuickBooks vendor (or link the one already there) and
 * stamp the id on the row. Backed by netlify/functions/distributor-qbo-vendor.mjs
 * because the QBO token lives in the Netlify env, never in the browser.
 */
export async function pushDistributorToQbo(
  subDistributorId: string,
  displayName?: string,
): Promise<QboVendorPushResult> {
  const token = await _sbToken();
  const res = await fetch('/margin/.netlify/functions/distributor-qbo-vendor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ distributor_id: subDistributorId, display_name: displayName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as QboVendorPushResult;
}

// ── Agreement files (private bucket distributor-docs, staff storage RLS) ──

export const MAX_AGREEMENT_FILE_BYTES = 25 * 1024 * 1024;

export async function uploadAgreementFile(
  subDistributorId: string,
  file: File,
): Promise<{ path: string; name: string }> {
  const token = await _sbToken();
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = `${subDistributorId}/agreements/${Date.now()}-${safeName}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/distributor-docs/${path}`, {
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
  return { path, name: file.name };
}

/** Download a private-bucket agreement document via a blob URL. */
export async function downloadAgreementFile(path: string, downloadName?: string): Promise<void> {
  const token = await _sbToken();
  const res = await fetch(`${SB_URL}/storage/v1/object/authenticated/distributor-docs/${path}`, {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('file download failed: ' + res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName || path.split('/').pop() || 'agreement';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ── Portal users ──────────────────────────────────────────────────────────

export async function fetchDistributorUsers(subDistributorId: string): Promise<SubDistributorUser[]> {
  return sbq<SubDistributorUser>(
    'sub_distributor_users',
    `select=*&sub_distributor_id=eq.${subDistributorId}&order=created_at.asc`,
  );
}

export async function addDistributorUser(
  subDistributorId: string,
  email: string,
  role: DistributorUserRole,
): Promise<SubDistributorUser> {
  const inserted = await sbInsert('sub_distributor_users', {
    sub_distributor_id: subDistributorId,
    email: email.trim(),
    role,
    is_active: true,
  });
  return first(inserted) as SubDistributorUser;
}

export async function updateDistributorUser(
  id: string,
  patch: Partial<Pick<SubDistributorUser, 'role' | 'is_active' | 'email'>>,
): Promise<SubDistributorUser> {
  const updated = await sbUpdate<SubDistributorUser>('sub_distributor_users', `id=eq.${id}`, patch);
  return first(updated) as SubDistributorUser;
}

// ── Serviced accounts ─────────────────────────────────────────────────────

export async function fetchDistributorAccounts(subDistributorId: string): Promise<SubDistributorAccount[]> {
  return sbq<SubDistributorAccount>(
    'sub_distributor_accounts',
    `select=*&sub_distributor_id=eq.${subDistributorId}&order=account_name.asc`,
  );
}

export async function addDistributorAccount(row: {
  sub_distributor_id: string;
  qbo_customer_id: string;
  account_name: string | null;
  chain: string | null;
  notes?: string | null;
}): Promise<SubDistributorAccount> {
  const inserted = await sbInsert('sub_distributor_accounts', { ...row, is_active: true });
  return first(inserted) as SubDistributorAccount;
}

export async function updateDistributorAccount(
  id: string,
  patch: Partial<Pick<SubDistributorAccount, 'account_name' | 'chain' | 'is_active' | 'notes'>>,
): Promise<SubDistributorAccount> {
  const updated = await sbUpdate<SubDistributorAccount>('sub_distributor_accounts', `id=eq.${id}`, patch);
  return first(updated) as SubDistributorAccount;
}

// ── QBO lookups ───────────────────────────────────────────────────────────

export async function searchQboCustomers(term: string): Promise<QboCustomerLite[]> {
  const t = term.trim().replace(/[%*,()]/g, ' ').trim();
  if (!t) return [];
  return sbq<QboCustomerLite>(
    'qbo_customers',
    `select=qbo_customer_id,display_name&display_name=ilike.${encodeURIComponent('*' + t + '*')}&order=display_name.asc&limit=20`,
  );
}

export async function searchQboVendors(term: string): Promise<QboVendorLite[]> {
  const t = term.trim().replace(/[%*,()]/g, ' ').trim();
  if (!t) return [];
  return sbq<QboVendorLite>(
    'qbo_vendors',
    `select=qbo_vendor_id,display_name,company_name,active,city,state`
      + `&display_name=ilike.${encodeURIComponent('*' + t + '*')}`
      + `&order=active.desc.nullslast,display_name.asc&limit=15`,
  );
}

export async function fetchQboVendor(qboVendorId: string): Promise<QboVendorLite | null> {
  const rows = await sbq<QboVendorLite>(
    'qbo_vendors',
    `select=qbo_vendor_id,display_name,company_name,active,city,state`
      + `&qbo_vendor_id=eq.${encodeURIComponent(qboVendorId)}&limit=1`,
  );
  return rows[0] ?? null;
}

/** Last N QBO bill/expense lines for a vendor, from the ops mirror. */
export async function fetchVendorExpenseLines(
  vendorDisplayName: string,
  limit = 25,
): Promise<QboExpenseLine[]> {
  return sbq<QboExpenseLine>(
    'qbo_expense_lines',
    `select=id,qbo_txn_id,qbo_txn_type,item_name,account_name,description,amount,txn_date,vendor_name`
      + `&vendor_name=eq.${encodeURIComponent(vendorDisplayName)}`
      + `&order=txn_date.desc.nullslast&limit=${limit}`,
  );
}

export async function fetchQboItems(): Promise<QboItemLite[]> {
  return sbq<QboItemLite>(
    'qbo_items',
    'select=qbo_item_id,name,fully_qualified_name,active&order=name.asc',
  );
}

// ── Orders ────────────────────────────────────────────────────────────────

export async function fetchDistributorOrders(subDistributorId: string): Promise<SubDistributorOrder[]> {
  return sbq<SubDistributorOrder>(
    'sub_distributor_orders',
    `select=*&sub_distributor_id=eq.${subDistributorId}&order=submitted_at.desc`,
  );
}

export async function fetchOrderLines(orderId: string): Promise<SubDistributorOrderLine[]> {
  return sbq<SubDistributorOrderLine>(
    'sub_distributor_order_lines',
    `select=*&order_id=eq.${orderId}&order=created_at.asc`,
  );
}

export async function fetchAllOrderLines(subDistributorId: string): Promise<SubDistributorOrderLine[]> {
  // One round-trip line count per order list — PostgREST in() over the order ids
  // would need them first, so filter via the embedded FK instead.
  return sbq<SubDistributorOrderLine>(
    'sub_distributor_order_lines',
    `select=*,sub_distributor_orders!inner(sub_distributor_id)&sub_distributor_orders.sub_distributor_id=eq.${subDistributorId}`,
  );
}

/** STAFF: fulfill an order — creates the draft BOL transfer, returns transfer id. */
export async function fulfillDistributorOrder(
  orderId: string,
  fromLocationId: string,
  notes?: string | null,
): Promise<string> {
  return sbrpc<string>('fn_fulfill_distributor_order', {
    p_order_id: orderId,
    p_from_location_id: fromLocationId,
    p_notes: notes ?? null,
  });
}

// ── Depletions ────────────────────────────────────────────────────────────

export async function fetchDepletions(
  subDistributorId: string,
  month?: string | null, // 'YYYY-MM'
): Promise<SubDistributorDepletion[]> {
  let q = `select=*&sub_distributor_id=eq.${subDistributorId}&order=delivered_date.desc,created_at.desc&limit=500`;
  if (month) {
    const [y, m] = month.split('-').map(Number);
    if (y && m) {
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      q += `&delivered_date=gte.${start}&delivered_date=lt.${next}`;
    }
  }
  return sbq<SubDistributorDepletion>('sub_distributor_depletions', q);
}

// ── Settlements ───────────────────────────────────────────────────────────

export async function fetchSettlements(subDistributorId: string): Promise<SubDistributorSettlement[]> {
  return sbq<SubDistributorSettlement>(
    'sub_distributor_settlements',
    `select=*&sub_distributor_id=eq.${subDistributorId}&order=created_at.desc`,
  );
}

/**
 * STAFF: sweep un-settled fee-carrying depletions in the period into a
 * settlement + a Brixpense expense request (posting to QBO stays behind
 * Brixpense's "Post to QuickBooks" button).
 */
export async function createSettlement(
  subDistributorId: string,
  periodStart: string,
  periodEnd: string,
  notes?: string | null,
): Promise<SettlementCreateResult> {
  return sbrpc<SettlementCreateResult>('fn_distributor_settlement_create', {
    p_sub_distributor_id: subDistributorId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_notes: notes ?? null,
  });
}

/** STAFF: void an unposted settlement — releases its depletions. */
export async function voidSettlement(settlementId: string, reason?: string | null): Promise<void> {
  await sbrpc('fn_distributor_settlement_void', {
    p_settlement_id: settlementId,
    p_reason: reason ?? null,
  });
}

// ── On-hand at the distributor's location ─────────────────────────────────

export interface OnHandAtLocationRow {
  qbo_item_id: string;
  location_id: string;
  on_hand: number;
}

export async function fetchOnHandAtLocation(locationId: string): Promise<OnHandAtLocationRow[]> {
  return sbq<OnHandAtLocationRow>(
    'v_inventory_on_hand',
    `select=*&location_id=eq.${locationId}`,
  );
}
