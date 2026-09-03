// Bulk void / delete / edit on the production documents (migration 20260903b).
// Every RPC returns {done, skipped}: a row the server refused is NAMED with its
// reason, never silently dropped — the screen shows both lists.

import { sbrpc } from './rpc';
import type { DocKind } from './lifecycleBuckets';

export interface BulkRow { id: string; number: string | null; reason?: string }
export interface BulkResult { done: BulkRow[]; skipped: BulkRow[] }

const EMPTY: BulkResult = { done: [], skipped: [] };
function norm(r: Partial<BulkResult> | null | undefined): BulkResult {
  return { done: r?.done ?? [], skipped: r?.skipped ?? [] };
}

export async function voidDocs(kind: DocKind, ids: string[], reason: string): Promise<BulkResult> {
  if (!ids.length) return EMPTY;
  const fn = kind === 'work_order' ? 'fn_void_work_orders'
    : kind === 'purchase_order' ? 'fn_void_purchase_orders'
    : kind === 'run' ? 'fn_void_runs' : 'fn_void_transfers';
  return norm(await sbrpc<BulkResult>(fn, { p_ids: ids, p_reason: reason }));
}

export async function deleteDrafts(kind: DocKind, ids: string[]): Promise<BulkResult> {
  if (!ids.length) return EMPTY;
  if (kind === 'run') return norm(await sbrpc<BulkResult>('fn_run_delete_drafts', { p_ids: ids }));
  return norm(await sbrpc<BulkResult>('fn_delete_drafts', { p_kind: kind, p_ids: ids }));
}

/** Whitelisted per kind on the server: PO expected_date/notes · WO scheduled_date/notes · transfer notes/special_instructions/carrier/tracking_number. */
export async function updateDocs(kind: DocKind, ids: string[], patch: Record<string, string | null>): Promise<BulkResult> {
  if (!ids.length) return EMPTY;
  if (kind === 'run') throw new Error('runs are edited from their detail');
  const fn = kind === 'work_order' ? 'fn_update_work_orders'
    : kind === 'purchase_order' ? 'fn_update_purchase_orders' : 'fn_update_transfers';
  return norm(await sbrpc<BulkResult>(fn, { p_ids: ids, p_patch: patch }));
}

/** Closed → open again (PO status recomputed from lines; transfer lines reversed to TRANSIT). */
export async function reopenDocs(kind: DocKind, ids: string[], reason: string): Promise<BulkResult> {
  if (!ids.length) return EMPTY;
  if (kind === 'run') {
    // one at a time on the server; the same {done, skipped} shape comes back
    const done: BulkRow[] = []; const skipped: BulkRow[] = [];
    for (const id of ids) {
      try { await sbrpc('fn_run_reopen', { p_run_id: id, p_reason: reason }); done.push({ id, number: null }); }
      catch (e) { skipped.push({ id, number: null, reason: e instanceof Error ? e.message : String(e) }); }
    }
    return { done, skipped };
  }
  return norm(await sbrpc<BulkResult>('fn_reopen_docs', { p_kind: kind, p_ids: ids, p_reason: reason }));
}

export async function closePurchaseOrders(ids: string[]): Promise<BulkResult> {
  if (!ids.length) return EMPTY;
  return norm(await sbrpc<BulkResult>('fn_close_purchase_orders', { p_ids: ids }));
}

export interface ReceiveLineInput { po_line_id: string; qty: number; unit_cost?: number | null; receipt_date?: string | null }
/** Many lines, one call; each line in its own sub-transaction on the server. */
export async function receivePoLines(lines: ReceiveLineInput[]): Promise<BulkResult> {
  if (!lines.length) return EMPTY;
  return norm(await sbrpc<BulkResult>('fn_receive_po_lines', { p_lines: lines }));
}

/** One sentence for the toast: "3 voided · 1 skipped (PO-2026-00012: has receipts)". */
export function summarizeBulk(r: BulkResult, verb: string): string {
  const parts = [`${r.done.length} ${verb}`];
  if (r.skipped.length) {
    const first = r.skipped.slice(0, 2).map((s) => `${s.number ?? s.id.slice(0, 8)}: ${s.reason ?? 'refused'}`).join('; ');
    parts.push(`${r.skipped.length} skipped (${first}${r.skipped.length > 2 ? '; …' : ''})`);
  }
  return parts.join(' · ');
}
