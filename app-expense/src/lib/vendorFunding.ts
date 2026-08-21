// Stripe vendor-funding data layer (Vendor Portal Phase 3b).
//
// The float lives in Stripe; QuickBooks mirrors it as the "Stripe Vendor
// Funding" bank account, and every vendor BillPayment is drawn on that
// account — so its QBO balance should equal the balance shown here. All calls
// go through /api/vendor-funding, which is superadmin-gated server side.
//
// Stripe has no low-balance auto-pull: a bank pull is manual per transfer and
// settles in 2–6 business days, which is why the card talks about a float you
// keep topped up rather than just-in-time funding.
import { getAccessToken } from '@/lib/supabase';

export type FundingKind = 'inbound_transfer' | 'received_credit';
export type FundingSource = 'app' | 'dashboard' | 'external';
export type FundingStatus = 'pending' | 'settled' | 'failed' | 'canceled';

export interface FundingEvent {
  id: string;
  stripe_object_id: string;
  kind: FundingKind;
  source: FundingSource;
  amount: number;
  currency: string;
  status: FundingStatus;
  qbo_transfer_id: string | null;
  qbo_booked_at: string | null;
  book_error: string | null;
  initiated_by: string | null;
  failure_reason: string | null;
  stripe_created_at: string | null;
  created_at: string;
}

export interface FundingConfig {
  floor: number;
  target: number;
  auto_top_up: boolean;
  max_per_day: number;
}

export interface FundingStatusResponse {
  configured: boolean;
  bank_configured: boolean;
  qbo_account_configured: boolean;
  config: FundingConfig;
  settlement_days: string;
  max_per_txn: number;
  pulled_today: number;
  events: FundingEvent[];
  unbooked: number;
  balance?: number;
  below_floor?: boolean;
  financial_account?: string;
  balance_error?: string;
}

export async function fundingApi<T>(body: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch('/expense/api/vendor-funding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const fundingStatus = () => fundingApi<FundingStatusResponse>({ action: 'status' });

export const topUpFunding = (amount: number) =>
  fundingApi<{ ok: true; stripe_object_id: string; status: string; note: string }>({
    action: 'top_up', amount,
  });

export const syncFundingNow = () =>
  fundingApi<{ ok: boolean; seen: number; inserted: number; updated: number; booked: number; errors: string[] }>({
    action: 'sync',
  });

export const saveFundingConfig = (patch: Partial<FundingConfig>) =>
  fundingApi<{ ok: true; config: FundingConfig }>({ action: 'save_config', ...patch });

export const FUNDING_KIND_LABEL: Record<FundingKind, string> = {
  inbound_transfer: 'Pull from bank',
  received_credit: 'Deposit into Stripe',
};

/** What a funding row means for the books, in one chip. */
export function fundingChip(e: FundingEvent): { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' } {
  if (e.status === 'failed') return { label: 'Failed', variant: 'destructive' };
  if (e.status === 'canceled') return { label: 'Canceled', variant: 'secondary' };
  if (e.status === 'pending') return { label: 'In transit', variant: 'warning' };
  if (e.qbo_transfer_id) return { label: 'Booked to QuickBooks', variant: 'success' };
  return { label: e.book_error ? 'Booking failed' : 'Not booked yet', variant: e.book_error ? 'destructive' : 'warning' };
}
