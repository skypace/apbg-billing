// Data layer for the QBO Purchase Order picker (Pull POs from QBO).
//
// Receipt-level summary: the inventory page's "On Order" column sums lines
// from BOTH ops.purchase_orders (BRIX-native) AND ops.qbo_purchase_orders
// (imported from QBO via this picker). Picking a PO here writes a shadow
// row that fn_items_master joins against.

import { supabase } from './supabase';

export interface QboPoPickerLine {
  line_num: number;
  description: string;
  amount: number | null;
  qbo_item_id: string | null;
  qbo_item_name: string | null;
  qty: number | null;
  unit_cost: number | null;
  account_id: string | null;
  account_name: string | null;
}

export interface QboPoPickerItem {
  qbo_id: string;
  doc_number: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  txn_date: string | null;
  total_amt: number | null;
  status: string;
  memo: string | null;
  line_count: number;
  lines: QboPoPickerLine[];
  /** True if this PO has been imported before via this picker. */
  already_imported: boolean;
  imported_at: string | null;
  last_synced_at: string | null;
  /** True if a BRIX-native PO in ops.purchase_orders already links to this
   *  QBO id. Re-importing would double-count, so the UI disables these. */
  brix_native: boolean;
}

export interface QboPoPickerPreview {
  count: number;
  open_pickable: number;
  items: QboPoPickerItem[];
}

async function bearer(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return `Bearer ${token}`;
}

export async function fetchQboPosPreview(): Promise<QboPoPickerPreview> {
  const res = await fetch('/margin/.netlify/functions/qbo-pos-preview', {
    method: 'GET',
    headers: { Authorization: await bearer() },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Preview failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as QboPoPickerPreview;
}

export interface ImportResult {
  requested: number;
  imported: number;
  skipped: number;
  missing: number;
  details: {
    imported: Array<{ qbo_id: string; doc_number: string | null; lines: number }>;
    skipped: Array<{ qbo_id: string; reason: string }>;
    missing: string[];
  };
}

export async function importQboPos(ids: string[]): Promise<ImportResult> {
  if (ids.length === 0) return { requested: 0, imported: 0, skipped: 0, missing: 0, details: { imported: [], skipped: [], missing: [] } };
  const res = await fetch('/margin/.netlify/functions/qbo-pos-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: await bearer() },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Import failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as ImportResult;
}
