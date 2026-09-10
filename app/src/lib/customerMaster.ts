import { sbqOrders } from './rpc';
import { getOrders, postOrders, type WriteResult } from './customerBilling';

/**
 * customerMaster — the rest of the customer record, on the Refractor customer
 * page: locations (incl. the bill-to), contacts (who runs the account), and
 * the document vault (tax id, resale certificate, the signed application, the
 * ACH form).
 *
 * Sky, 2026-09-10: "if were saying that refractor is the customer master, we
 * need to be able to edit the rest of the customer data here too. like
 * addresses, files and attachments, etc changes to the customer not just
 * portal settings. these need to be merged or whatever to qbo. we need to be
 * able to write changes from here then everthing syncs back to qbo."
 *
 * Same shape as lib/customerBilling.ts and for the same reasons:
 *   READS  — PostgREST under the staff JWT (`Accept-Profile: orders`), through
 *            the `*_select_staff` policies (20260909a, 20260910a).
 *   WRITES — brix-order's admin endpoints, which are the ONE writer and hold
 *            the ONE outward push to QuickBooks:
 *              PRIMARY location  → Customer.ShipAddr
 *              bill-to location  → Customer.BillAddr + PrimaryPhone
 *              primary contact   → Customer.GivenName / FamilyName
 *              notes             → Customer.Notes
 *              a vault document  → a QBO Attachable on the Customer
 *            Service Fusion has NO customer-update API (PUT → 405, brix-order
 *            §1.129), so a push there is a RETYPE INSTRUCTION in push_notes.
 *
 * ⚠ Documents are the one read that does NOT go through PostgREST: the file
 * bytes live in the private `customer-docs` bucket, and the 1-hour signed URL
 * is minted by brix-order from the service-role key. The browser sees a URL,
 * never the bucket.
 */

// ── the shared customer handle — one read for four cards ────────────────────

export interface OrdersCustomer {
  id: string;                    // orders.customers.id
  name: string | null;
  qbo_customer_id: string | null;
  billing_contact_name: string | null;
}

const customerCache = new Map<string, Promise<OrdersCustomer | null>>();

/**
 * The portal record for a QuickBooks customer id — `null` when the customer
 * has never been enabled in the portal (most of them: ~204 of ~850).
 *
 * Memoised per page load so the four cards on the customer page make ONE
 * request between them rather than four. `forgetOrdersCustomer` clears it
 * after an Enable, which is the only thing that turns a null into a row.
 */
export function fetchOrdersCustomer(qboCustomerId: string): Promise<OrdersCustomer | null> {
  const id = String(qboCustomerId).replace(/[^0-9A-Za-z_-]/g, '');
  if (!id) return Promise.resolve(null);
  let p = customerCache.get(id);
  if (!p) {
    p = sbqOrders<OrdersCustomer>(
      'customers',
      `qbo_customer_id=eq.${encodeURIComponent(id)}&select=id,name,qbo_customer_id,billing_contact_name&limit=1`,
    ).then((rows) => rows[0] ?? null);
    customerCache.set(id, p);
    // A failed read must not be cached as "no customer".
    p.catch(() => customerCache.delete(id));
  }
  return p;
}
const CHANGED_EVENT = 'apbg:orders-customer-changed';

/**
 * Drop the memo AND tell every card on the page. Found by the screenshot,
 * not the assertions: after "Set up this customer" the billing card
 * reloaded while the Locations card under it still read "not set up in the
 * portal", because it held the memoised null and nothing told it the record
 * now existed. Four cards share one read, so they must share one invalidation.
 */
export function forgetOrdersCustomer(qboCustomerId?: string) {
  const id = qboCustomerId ? String(qboCustomerId).replace(/[^0-9A-Za-z_-]/g, '') : '';
  if (id) customerCache.delete(id); else customerCache.clear();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { qboCustomerId: id || null } }));
  }
}

/** Subscribe a card to that invalidation; returns the unsubscribe. */
export function onOrdersCustomerChanged(qboCustomerId: string, cb: () => void): () => void {
  const mine = String(qboCustomerId).replace(/[^0-9A-Za-z_-]/g, '');
  const handler = (e: Event) => {
    const id = (e as CustomEvent<{ qboCustomerId: string | null }>).detail?.qboCustomerId;
    if (!id || id === mine) cb();
  };
  window.addEventListener(CHANGED_EVENT, handler);
  return () => window.removeEventListener(CHANGED_EVENT, handler);
}

// ── locations ───────────────────────────────────────────────────────────────

export interface CustomerLocation {
  id: string;
  customer_id: string;
  qbo_sub_customer_id: number | null;
  location_code: string | null;
  display_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  delivery_notes: string | null;
  phone: string | null;
  sf_location_id: number | null;
  active: boolean | null;
  is_billing: boolean | null;
}

const LOCATION_SELECT = 'id,customer_id,qbo_sub_customer_id,location_code,display_name,'
  + 'address_line1,address_line2,city,state,zip,delivery_notes,phone,sf_location_id,active,is_billing';

export async function fetchLocations(customerId: string): Promise<CustomerLocation[]> {
  return sbqOrders<CustomerLocation>(
    'customer_locations',
    `customer_id=eq.${encodeURIComponent(customerId)}&select=${LOCATION_SELECT}`
      + '&order=is_billing.desc.nullslast,active.desc,display_name.asc',
  );
}

/** The columns brix-order's endpoint lets a human edit (its EDITABLE_COLS). */
export interface LocationFields {
  display_name?: string | null;
  location_code?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  delivery_notes?: string | null;
  phone?: string | null;
}

export function createLocation(customerId: string, location: LocationFields) {
  return postOrders<{ locations: CustomerLocation[] }>('admin-customer-locations',
    { customer_id: customerId, action: 'create', location });
}
export function updateLocation(customerId: string, locationId: string, location: LocationFields) {
  return postOrders<{ locations: CustomerLocation[] }>('admin-customer-locations',
    { customer_id: customerId, action: 'update', location_id: locationId, location });
}
export function setLocationActive(customerId: string, locationId: string, value: boolean) {
  return postOrders<{ locations: CustomerLocation[] }>('admin-customer-locations',
    { customer_id: customerId, action: 'set_active', location_id: locationId, value });
}
/** Make this location the bill-to — pushes BillAddr (+ PrimaryPhone) to QBO. */
export function setBillingLocation(customerId: string, locationId: string) {
  return postOrders<{ locations: CustomerLocation[] }>('admin-customer-locations',
    { customer_id: customerId, action: 'set_billing', location_id: locationId });
}

/** One line of address, the pieces that exist, in reading order. */
export function formatAddress(l: Pick<CustomerLocation,
  'address_line1' | 'address_line2' | 'city' | 'state' | 'zip'>): string {
  const cityState = [l.city, l.state].filter((v) => v && v.trim()).join(', ');
  return [l.address_line1, l.address_line2, cityState, l.zip]
    .filter((v) => v && v.trim()).join(' · ');
}

/** Which QuickBooks field a location feeds, if any — what the row's tag says. */
export function locationQboRole(l: CustomerLocation): 'bill-to' | 'ship-to' | null {
  if (l.is_billing) return 'bill-to';
  if ((l.location_code ?? '').toUpperCase() === 'PRIMARY') return 'ship-to';
  return null;
}

// ── contacts ────────────────────────────────────────────────────────────────

/** brix-order's ROLES, verbatim. The KEYS are what the endpoint validates. */
export const CONTACT_ROLES = [
  { key: 'gm',               label: 'General manager' },
  { key: 'district_manager', label: 'District manager' },
  { key: 'vp_ops',           label: 'VP operations' },
  { key: 'facilities',       label: 'Facilities' },
  { key: 'ap',               label: 'Accounts payable' },
  { key: 'ordering',         label: 'Ordering' },
  { key: 'receiving',        label: 'Receiving' },
  { key: 'other',            label: 'Other' },
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number]['key'];

export function contactRoleLabel(role: string | null | undefined): string {
  return CONTACT_ROLES.find((r) => r.key === role)?.label ?? (role || 'Other');
}

export interface CustomerContact {
  id: string;
  customer_id: string;
  name: string;
  role: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  source: string | null;
  active: boolean | null;
  created_at: string;
  updated_at: string | null;
}

export async function fetchContacts(customerId: string): Promise<CustomerContact[]> {
  return sbqOrders<CustomerContact>(
    'customer_contacts',
    `customer_id=eq.${encodeURIComponent(customerId)}`
      + '&select=id,customer_id,name,role,title,email,phone,notes,source,active,created_at,updated_at'
      + '&order=active.desc,role.asc,name.asc&limit=200',
  );
}

export interface ContactFields {
  name?: string;
  role?: ContactRole;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export function createContact(customerId: string, fields: ContactFields) {
  return postOrders<{ contact: CustomerContact | null }>('admin-customer-contacts',
    { customer_id: customerId, action: 'create', ...fields });
}
export function updateContact(customerId: string, contactId: string, fields: ContactFields) {
  return postOrders<{ contact: CustomerContact | null }>('admin-customer-contacts',
    { customer_id: customerId, action: 'update', contact_id: contactId, ...fields });
}
export function setContactActive(customerId: string, contactId: string, active: boolean) {
  return postOrders<{ contact: CustomerContact | null }>('admin-customer-contacts',
    { customer_id: customerId, action: 'set_active', contact_id: contactId, active });
}

// ── documents ───────────────────────────────────────────────────────────────

export const DOC_TYPES = [
  { key: 'tax_id',      label: 'Tax ID (W-9 / EIN)' },
  { key: 'resale_cert', label: 'Resale certificate' },
  { key: 'other',       label: 'Other' },
] as const;
export type DocType = (typeof DOC_TYPES)[number]['key'];

export function docTypeLabel(t: string | null | undefined): string {
  return DOC_TYPES.find((d) => d.key === t)?.label ?? (t || 'Document');
}

export interface CustomerDocument {
  id: string;
  customer_id: string;
  doc_type: string;
  label: string | null;
  doc_number: string | null;
  file_path: string | null;
  file_name: string | null;
  /** 1-hour signed URL minted by brix-order; null when no file is attached. */
  file_url: string | null;
  expires_on: string | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
  archived_at: string | null;
  qbo_attachable_id: string | null;
  qbo_attached_at: string | null;
}

/**
 * Through brix-order, NOT PostgREST — this is where the signed file URLs
 * come from. `archived` flips to the archived list (the endpoint serves one
 * or the other, never both).
 */
export async function fetchDocuments(customerId: string, archived = false): Promise<CustomerDocument[]> {
  const out = await getOrders<{ ok: boolean; documents?: CustomerDocument[] }>(
    'admin-customer-documents',
    `customer_id=${encodeURIComponent(customerId)}${archived ? '&archived=1' : ''}`,
  );
  return out.documents ?? [];
}

export interface DocumentUpload {
  doc_type: DocType;
  label?: string | null;
  doc_number?: string | null;
  expires_on?: string | null;   // YYYY-MM-DD
  notes?: string | null;
  /** data-URL (from fileToDataUrl) — pdf / png / jpeg / webp, ≤ 4 MB decoded. */
  file?: { name: string; data: string } | null;
}

/** Files the document; with a file, also pushes it onto the QBO Customer. */
export function uploadDocument(customerId: string, doc: DocumentUpload):
  Promise<WriteResult<{ documents: CustomerDocument[] }>> {
  return postOrders<{ documents: CustomerDocument[] }>('admin-customer-documents',
    { action: 'upload', customer_id: customerId, ...doc });
}
export function updateDocument(id: string, patch: {
  label?: string | null; doc_number?: string | null; expires_on?: string | null; notes?: string | null;
}) {
  return postOrders('admin-customer-documents', { action: 'update', id, ...patch });
}
export function archiveDocument(id: string) {
  return postOrders('admin-customer-documents', { action: 'archive', id });
}

export const DOC_MAX_BYTES = 4 * 1024 * 1024;
export const DOC_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('could not read the file'));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
}

/**
 * Expiry status, computed where displayed and never stored — the same rule
 * the compliance vault uses (expired / expiring within 60 days / current).
 * A document with no expiry is simply `none`, not "current".
 */
export function docExpiryStatus(expiresOn: string | null, today = new Date()):
  'expired' | 'expiring' | 'current' | 'none' {
  if (!expiresOn) return 'none';
  const d = new Date(expiresOn + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return 'none';
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.floor((d.getTime() - t0) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 60) return 'expiring';
  return 'current';
}
