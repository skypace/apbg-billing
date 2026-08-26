// Vendor payments data layer (Vendor Portal Phase 3).
//
// Everything money-moving goes through /api/vendor-pay (superadmin-gated
// server side — this module never decides authorization). The ledger itself
// is read directly under staff RLS.
import { supabase, getAccessToken } from '@/lib/supabase';

export type PaymentRail = 'stripe_payout' | 'venmo_manual' | 'zelle_manual' | 'check_manual' | 'qbo_billpay';
export type PaymentStatus = 'initiated' | 'settled' | 'failed' | 'recorded';

export interface VendorPayment {
  id: string;
  vendor_id: string;
  expense_request_id: string | null;
  qbo_bill_id: string | null;
  rail: PaymentRail;
  amount: number;
  currency: string;
  status: PaymentStatus;
  external_payout_id: string | null;
  qbo_billpayment_id: string | null;
  reference: string | null;
  initiated_by: string | null;
  failure_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const RAIL_LABEL: Record<PaymentRail, string> = {
  stripe_payout: 'Bank transfer (Stripe)',
  venmo_manual: 'Venmo (sent by hand)',
  zelle_manual: 'Zelle (sent by hand)',
  check_manual: 'Check',
  qbo_billpay: 'QuickBooks Bill Pay',
};

export const MANUAL_RAILS: PaymentRail[] = ['venmo_manual', 'zelle_manual', 'check_manual', 'qbo_billpay'];

export async function payApi<T>(body: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch('/expense/api/vendor-pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export interface StripeStatus {
  configured: boolean;
  ready: boolean;
  recipient?: string | null;
  capability_status?: string;
  payout_methods?: number;
  balance_cents?: number;
  error?: string;
}

export const stripeStatus = (vendorId: string) =>
  payApi<StripeStatus>({ action: 'stripe_status', vendor_id: vendorId });

export const stripeSetup = (vendorId: string) =>
  payApi<{ ok: true; sent_to: string; recipient: string; link_expires_minutes: number }>({
    action: 'stripe_setup', vendor_id: vendorId,
  });

export interface PayPreview {
  ok: boolean;
  problems: string[];
  amount: number;
  vendor: {
    id: string; display_name: string;
    payment_method_pref: string | null; payment_handle: string | null;
    stripe_recipient_id: string | null;
  } | null;
  stripe: { configured: boolean; ready: boolean; funded?: boolean; balance_cents?: number; error?: string };
}

export const previewPayment = (expenseRequestId: string) =>
  payApi<PayPreview>({ action: 'preview', expense_request_id: expenseRequestId });

export const payViaStripe = (expenseRequestId: string) =>
  payApi<{ ok: true; payout_id: string; payout_status: string; note: string }>({
    action: 'pay', expense_request_id: expenseRequestId,
  });

export const recordManualPayment = (
  expenseRequestId: string, rail: PaymentRail, reference?: string, notes?: string,
) => payApi<{ ok: true; qbo_billpayment_id: string | null }>({
  action: 'record', expense_request_id: expenseRequestId, rail, reference, notes,
});

// ── Pay run (/api/vendor-pay-run) — several bills, one vendor, one payment,
// one remittance advice. Superadmin-gated server side, same as vendor-pay.

async function payRunApi<T>(body: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch('/expense/api/vendor-pay-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export interface PayRunBill {
  id: string;
  bill_number: string | null;
  job_number: string | null;
  receipt_date: string | null;
  due_date: string | null;
  amount: number;
  qbo_bill_id: string;
  payment_status?: PaymentStatus;
  payment_rail?: PaymentRail;
}

export interface PayRunVendorGroup {
  qbo_vendor_id: string | null;
  vendor_name: string;
  vendor: {
    id: string; display_name: string; contact_email: string | null;
    payment_method_pref: string | null; stripe_recipient_id: string | null;
  } | null;
  bills: PayRunBill[];
  in_flight: PayRunBill[];
  total: number;
}

export interface PayRunList {
  ok: boolean;
  stripe: { configured: boolean; balance_cents: number | null; error?: string };
  vendors: PayRunVendorGroup[];
}

export const payRunList = () => payRunApi<PayRunList>({ action: 'list' });

export const payRunStripe = (expenseRequestIds: string[], remitTo?: string) =>
  payRunApi<{ ok: true; group_id: string; payout_id: string; bills: number; total: number; note: string }>({
    action: 'pay_stripe', expense_request_ids: expenseRequestIds, remit_to: remitTo,
  });

export const payRunRecord = (
  expenseRequestIds: string[], rail: PaymentRail, opts?: { reference?: string; notes?: string; remitTo?: string },
) => payRunApi<{
  ok: true; group_id: string; qbo_billpayment_id: string | null; bills: number; total: number;
  remittance: { sent: boolean; to: string | null; error: string | null };
}>({
  action: 'record', expense_request_ids: expenseRequestIds, rail,
  reference: opts?.reference, notes: opts?.notes, remit_to: opts?.remitTo,
});

export const payRunRemit = (groupId: string, to?: string) =>
  payRunApi<{ ok: true; sent_to: string }>({ action: 'remit', group_id: groupId, to });

export interface VendorPaymentGroup {
  id: string;
  vendor_id: string;
  rail: PaymentRail;
  total_amount: number;
  bill_count: number;
  status: PaymentStatus;
  external_payout_id: string | null;
  qbo_billpayment_id: string | null;
  reference: string | null;
  initiated_by: string | null;
  failure_reason: string | null;
  remit_to: string | null;
  remittance_sent_at: string | null;
  remittance_sent_to: string | null;
  remittance_error: string | null;
  created_at: string;
}

/** Recent pay-run groups + their vendor names (staff-readable under RLS). */
export async function recentPaymentGroups(limit = 20): Promise<(VendorPaymentGroup & { vendor_name: string })[]> {
  const { data, error } = await supabase
    .from('vendor_payment_groups')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const groups = (data as VendorPaymentGroup[]) ?? [];
  const vendorIds = [...new Set(groups.map((g) => g.vendor_id))];
  const names = new Map<string, string>();
  if (vendorIds.length) {
    const { data: vs } = await supabase.from('vendors').select('id,display_name').in('id', vendorIds);
    for (const v of (vs as { id: string; display_name: string }[]) ?? []) names.set(v.id, v.display_name);
  }
  return groups.map((g) => ({ ...g, vendor_name: names.get(g.vendor_id) || 'Vendor' }));
}

/** Ledger rows for one vendor (staff-readable under RLS). */
export async function vendorPayments(vendorId: string): Promise<VendorPayment[]> {
  const { data, error } = await supabase
    .from('vendor_payments')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data as VendorPayment[]) ?? [];
}

/** Live payment rows for a set of expenses — drives the "Paid"/"Sending"
 *  chip on bill lists so a paid bill can't be paid twice by eye. */
export async function paymentsForExpenses(expenseIds: string[]): Promise<Map<string, VendorPayment>> {
  const out = new Map<string, VendorPayment>();
  if (expenseIds.length === 0) return out;
  const { data, error } = await supabase
    .from('vendor_payments')
    .select('*')
    .in('expense_request_id', expenseIds)
    .in('status', ['initiated', 'settled', 'recorded'])
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  for (const row of (data as VendorPayment[]) ?? []) {
    if (row.expense_request_id && !out.has(row.expense_request_id)) out.set(row.expense_request_id, row);
  }
  return out;
}

export function statusLabel(p: VendorPayment): { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' } {
  if (p.status === 'settled') return { label: 'Paid', variant: 'success' };
  if (p.status === 'recorded') return { label: 'Paid (recorded)', variant: 'success' };
  if (p.status === 'initiated') return { label: 'Sending…', variant: 'warning' };
  return { label: 'Payment failed', variant: 'destructive' };
}
