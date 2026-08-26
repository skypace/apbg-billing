import { supabase } from './supabase';

export interface VendorQboPushResult {
  ok: boolean;
  qbo_vendor_id: string;
  outcome: 'created' | 'linked_existing' | 'already_linked';
  qbo_display_name: string;
  attachments: { document: string; status: string; error?: string }[];
  message: string;
}

/** Create (or link) the QuickBooks vendor and attach their W-9 / COI to it. */
export async function pushVendorToQuickBooks(vendorId: string): Promise<VendorQboPushResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch('/expense/api/vendor-qbo-push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify({ vendor_id: vendorId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || 'QuickBooks push failed.');
  return data as VendorQboPushResult;
}
