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
