/* Brix Expense — shared types, dropdown data, and Netlify-function API wrappers.
 *
 * QBO data flows through the existing Netlify functions used by the legacy
 * 3rd Party Billing Loader (public/approve.html). Those endpoints proxy to
 * pacerfinance which holds the QBO OAuth tokens. */

import { sbAuth, _sbToken } from './supabase';

const API_BASE = '/.netlify/functions';

async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { error: text || 'Invalid JSON' }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

// ── QBO data (live from pacerfinance via existing Netlify functions) ──

export interface QboVendor { id: string; name: string }
export interface QboCustomer { id: string; name: string; brand?: string | null }

export function fetchVendors() {
  return authedFetch<{ vendors: QboVendor[] }>('/get-vendors').then((r) => r.vendors || []);
}
export function fetchCustomers() {
  return authedFetch<{ customers: QboCustomer[] }>('/get-customers').then((r) => r.customers || []);
}
export function createVendor(displayName: string) {
  return authedFetch<{ success: boolean; vendor: QboVendor; error?: string }>(
    '/create-vendor',
    { method: 'POST', body: JSON.stringify({ displayName }) },
  );
}

// ── COGS account whitelist (9 options, expanded from the existing 2). ──
// `qboAccountId` for accounts beyond Service/Equipment is `null` until Sky
// confirms the IDs via the QBO MCP; the backend create-bill function
// rejects submissions where qboAccountId is missing for now, and the UI
// shows them as "(pending QBO ID — ask Sky)".

export interface CogsAccount {
  key: string;
  label: string;
  qboAccountId: string | null;
  qboAccountName: string;
  category: 'service' | 'equipment' | 'opex' | 'cogs';
}

export const COGS_ACCOUNTS: CogsAccount[] = [
  { key: 'service',        label: 'Service COGS',                       qboAccountId: '101',  qboAccountName: 'Service Expense',          category: 'service' },
  { key: 'equipment',      label: 'Equipment COGS',                     qboAccountId: '42',   qboAccountName: 'Equipment Sales COGS',     category: 'equipment' },
  { key: 'fuel',           label: 'Fuel',                               qboAccountId: null,   qboAccountName: 'Fuel',                     category: 'opex' },
  { key: 'office',         label: 'Office Supplies',                    qboAccountId: null,   qboAccountName: 'Office Supplies',          category: 'opex' },
  { key: 'meals',          label: 'Working Meals',                      qboAccountId: null,   qboAccountName: 'Working Meals',            category: 'opex' },
  { key: 'travel',         label: 'Travel',                             qboAccountId: null,   qboAccountName: 'Travel',                   category: 'opex' },
  { key: 'rm_building',    label: 'Repair & Maintenance — Building',    qboAccountId: null,   qboAccountName: 'Repair & Maintenance — Building', category: 'opex' },
  { key: 'fountain_new',   label: 'New Fountain Installs COGS',         qboAccountId: null,   qboAccountName: 'New Fountain Installs COGS', category: 'cogs' },
  { key: 'ice_rental',     label: 'Ice Machine Rental COGS',            qboAccountId: null,   qboAccountName: 'Ice Machine Rental COGS',  category: 'cogs' },
];

// ── Tags + Departments (defaults — confirm with Sky) ──

export const TAGS = ['project', 'event', 'vehicle', 'customer', 'store', 'general'] as const;
export type Tag = typeof TAGS[number];

export const DEPARTMENTS = ['delivery', 'service', 'reman', 'ops', 'freeflow', 'melt'] as const;
export type Department = typeof DEPARTMENTS[number];

// ── Manager list (Resend recipient targets) ──

export interface Manager { email: string; label: string }

export const MANAGERS: Manager[] = [
  { email: 'Anthonyv@brixbev.com', label: 'Anthony V'   },
  { email: 'skypace@brixbev.com',  label: 'Sky Pace'    },
  { email: 'asloan@brixbev.com',   label: 'Audrey Sloan'},
  { email: 'marco@brixbev.com',    label: 'Marco DiLuca'},
  { email: 'joel@brixbev.com',     label: 'Joel Sanchez'},
];

// ── $500 approval threshold (configurable later via ops.expense_settings) ──
export const APPROVAL_THRESHOLD = 500;

// ── OCR + bill creation (existing Netlify functions, unchanged) ──

export interface ScannedBill {
  vendorName?: string;
  billNumber?: string;
  billDate?: string;
  dueDate?: string;
  total?: number;
  notes?: string;
  lineItems?: { description: string; quantity: number; unitCost: number; category?: string }[];
}

export async function processInbound(file: File): Promise<ScannedBill> {
  const fileData = await new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => no(new Error('read fail'));
    r.readAsDataURL(file);
  });
  const r = await authedFetch<{ success: boolean; approveUrl?: string; billData?: ScannedBill; error?: string }>(
    '/process-inbound',
    {
      method: 'POST',
      body: JSON.stringify({ fileData, mediaType: file.type || 'application/pdf', submittedBy: 'brix-expense' }),
    },
  );
  if (!r.success) throw new Error(r.error || 'OCR failed');
  // The current function returns either billData directly or an approveUrl
  // wrapping a token. Decode the token if we got the wrapper form.
  if (r.billData) return r.billData;
  if (r.approveUrl) {
    const token = new URL(r.approveUrl).searchParams.get('token');
    if (!token) throw new Error('OCR returned no token');
    const d = await authedFetch<{ success: boolean; billData: ScannedBill }>('/decode-token?token=' + encodeURIComponent(token));
    if (!d.success) throw new Error('Token decode failed');
    return d.billData;
  }
  throw new Error('OCR returned no bill data');
}

export interface ApproveBillResult {
  success: boolean;
  bill: { id: string; number?: string; total: number };
  invoiceMatch: null | {
    number: string;
    customerName: string;
    total: number;
    margin: number;
    marginPct: number;
  };
  error?: string;
}

export interface ApproveBillPayload {
  vendorId: string;
  vendorName: string;
  customerId: string;
  customerName: string;
  accountId: string;
  accountName: string;
  jobNumber: string;
  billNumber?: string;
  dueDate?: string;
  memo?: string;
  lineItems: { description: string; quantity: number; unitCost: number; lineTotal: number }[];
}

export function approveBill(payload: ApproveBillPayload) {
  return authedFetch<ApproveBillResult>('/approve-bill', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── New: expense_requests CRUD via Supabase REST (ops schema) ──

export type RequestKind = 'expense' | 'purchase_request';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'auto_approved' | 'fulfilled';

export interface ExpenseRequest {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  submitter_email: string;
  manager_email: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  account_key: string;
  account_label: string;
  job_number: string | null;
  tag: Tag | null;
  department: Department | null;
  total_amount: number;
  memo: string | null;
  line_items: any;
  attachment_url: string | null;
  qbo_bill_id: string | null;
  qbo_bill_number: string | null;
  invoice_match: any;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  signature_data_url: string | null;
}

export async function listMyRequests(): Promise<ExpenseRequest[]> {
  const { data, error } = await sbAuth.schema('ops').from('expense_requests').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data as ExpenseRequest[]) ?? [];
}

export async function getRequestByToken(token: string): Promise<ExpenseRequest> {
  // The Netlify function validates the token + returns the row.
  return authedFetch<ExpenseRequest>('/expense-request-create?token=' + encodeURIComponent(token));
}

export interface CreateRequestPayload {
  kind: RequestKind;
  manager_email: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  account_key: string;
  account_label: string;
  job_number: string | null;
  tag: Tag | null;
  department: Department | null;
  total_amount: number;
  memo: string | null;
  line_items: any;
  attachment_url: string | null;
}

export interface CreateRequestResult {
  success: boolean;
  id: string;
  auto_approved: boolean;       // true when amount ≤ threshold and kind=expense
  notification_sent?: boolean;
  bill?: ApproveBillResult['bill'];
  invoice_match?: ApproveBillResult['invoiceMatch'];
  error?: string;
}

export function createRequest(payload: CreateRequestPayload, billPayload: ApproveBillPayload | null) {
  return authedFetch<CreateRequestResult>('/expense-request-create', {
    method: 'POST',
    body: JSON.stringify({ payload, billPayload }),
  });
}

export interface DecisionPayload {
  token: string;
  decision: 'approve' | 'deny';
  signatureDataUrl: string | null;
  note: string | null;
}

export interface DecisionResult {
  success: boolean;
  status: RequestStatus;
  bill?: ApproveBillResult['bill'];
  invoice_match?: ApproveBillResult['invoiceMatch'];
  error?: string;
}

export function decideRequest(payload: DecisionPayload) {
  return authedFetch<DecisionResult>('/expense-request-decide', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
