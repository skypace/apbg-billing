import { supabase } from './supabase';

export interface BillPaidSyncResult {
  ok: boolean;
  checked: number;
  paid: number;
  partial: number;
  still_open: number;
  missing: number;
  errors: string[];
}

/** Ask QuickBooks which posted bills have been paid outside Brixpense.
 *  Read-only against QBO — it creates nothing and pays nothing. */
export async function checkQuickBooksPaid(): Promise<BillPaidSyncResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch('/expense/api/bill-paid-sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Could not reach QuickBooks.');
  return data as BillPaidSyncResult;
}
