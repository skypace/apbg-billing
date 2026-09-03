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
    : kind === 'purchase_order' ? 'fn_void_purchase_orders' : 'fn_void_transfers';
  return norm(await sbrpc<BulkResult>(fn, { p_ids: ids, p_reason: reason }));
}

export async function deleteDrafts(kind: DocKind, ids: string[]): Promise<BulkResult> {
  if (!ids.length) return EMPTY;
  return norm(await sbrpc<BulkResult>('fn_delete_drafts', { p_kind: kind, p_ids: ids }));
}

/** Whitelisted per kind on the server: PO expected_date/notes · WO scheduled_date/notes · transfer notes/special_instructions/carrier/tracking_number. */
export async function updateDocs(kind: DocKind, ids: string[], patch: Record<string, string | null>): Promise<BulkResult> {
  if (!ids.length) return EMPTY;
  const fn = kind === 'work_order' ? 'fn_update_work_orders'
    : kind === 'purchase_order' ? 'fn_update_purchase_orders' : 'fn_update_transfers';
  return norm(await sbrpc<BulkResult>(fn, { p_ids: ids, p_patch: patch }));
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
