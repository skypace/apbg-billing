// Data layer for the QBO Purchase Order picker (Pull POs from QBO).
//
// Receipt-level summary: the inventory page's "On Order" column sums lines
// from BOTH ops.purchase_orders (BRIX-native) AND ops.qbo_purchase_orders
// (imported from QBO via this picker). Picking a PO here writes a shadow
// row that fn_items_master joins against.

import { _sbToken } from './supabase';

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
  /** Raw POStatus straight from QBO ('Open' / 'Closed'). Useful when the
   *  derived status differs because Bills were linked. */
  po_status_raw: string | null;
  /** True if QBO has any LinkedTxn of type Bill — meaning some/all of the
   *  PO has been received against. */
  has_linked_bills: boolean;
  linked_bill_count: number;
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
  /** When the strict filter is in effect (include_all=false), these
   *  counts tell the UI how many POs were hidden so it can surface a
   *  "N hidden — show all" toggle. */
  hidden: { closed: number; billed: number; total: number };
  include_all: boolean;
  items: QboPoPickerItem[];
}

async function bearer(): Promise<string> {
  const token = await _sbToken();
  if (!token) throw new Error('Not signed in');
  return `Bearer ${token}`;
}

export async function fetchQboPosPreview(opts: { includeAll?: boolean } = {}): Promise<QboPoPickerPreview> {
  const qs = opts.includeAll ? '?include_all=true' : '';
  const res = await fetch('/margin/.netlify/functions/qbo-pos-preview' + qs, {
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
