// Bills against a production run (migration 20260903h): the vendor bill for a
// closed PO, the co-packer's deposit, and the final invoice that UPDATES the
// deposit's bill in place. Every one is an ops.expense_requests row; posting to
// QuickBooks is a human click in Brixpense (the 2026-08-14 gate), and a final
// that changed a posted deposit is re-sent onto the SAME QuickBooks bill with
// Brixpense's "Update in QuickBooks".
import { sbq, sbrpc } from './rpc';

export type BillKind = 'deposit' | 'final' | 'po';
export type BillState = 'to_post' | 'posted' | 'needs_update' | 'paid' | 'archived';

export interface RunBill {
  id: string;
  run_id: string | null;
  po_id: string | null;
  kind: BillKind;
  expense_request_id: string;
  linked_deposit_bill_id: string | null;
  qbo_vendor_id: string;
  vendor_invoice_number: string | null;
  invoice_date: string | null;
  amount_gross: number;
  amount_net: number | null;
  note: string | null;
  created_at: string;
  // v_production_run_bills
  run_number: string | null;
  po_number: string | null;
  vendor_name: string | null;
  request_status: string;
  qbo_bill_id: string | null;
  posted_at: string | null;
  paid_at: string | null;
  qbo_balance: number | null;
  request_total: number;
  qbo_posted_amount: number | null;
  archived_at: string | null;
  bill_number: string | null;
  bill_state: BillState;
}

export const BILL_STATE_COPY: Record<BillState, { label: string; color: string; detail: string }> = {
  to_post:      { label: 'To post',   color: 'var(--am)', detail: 'Approved in Brixpense; a human posts it to QuickBooks from Expense History.' },
  posted:       { label: 'Posted',    color: 'var(--ac)', detail: 'In QuickBooks; money still owed.' },
  needs_update: { label: 'Update QB', color: 'var(--am)', detail: 'The total changed since it was posted (the final replaced a deposit) — press Update in QuickBooks in Brixpense; the same bill is re-sent and any payment stays applied.' },
  paid:         { label: 'Paid',      color: 'var(--gn)', detail: 'Paid in QuickBooks.' },
  archived:     { label: 'Archived',  color: '#64748b',   detail: 'Archived in Brixpense — not a live payable.' },
};

const norm = (b: RunBill): RunBill => ({ ...b,
  amount_gross: Number(b.amount_gross), amount_net: b.amount_net == null ? null : Number(b.amount_net),
  request_total: Number(b.request_total), qbo_posted_amount: b.qbo_posted_amount == null ? null : Number(b.qbo_posted_amount),
  qbo_balance: b.qbo_balance == null ? null : Number(b.qbo_balance) });

export async function fetchRunBills(runId: string): Promise<RunBill[]> {
  return (await sbq<RunBill>('v_production_run_bills', `select=*&run_id=eq.${runId}&order=created_at.asc`)).map(norm);
}
export async function fetchPoBills(poId: string): Promise<RunBill[]> {
  return (await sbq<RunBill>('v_production_run_bills', `select=*&po_id=eq.${poId}&order=created_at.asc`)).map(norm);
}

export async function createPoBill(poId: string, invoiceNumber: string | null, invoiceDate: string | null, totalOverride: number | null): Promise<{ bill_id: string; expense_request_id: string; total: number; lines: number }> {
  return sbrpc('fn_po_create_bill', { p_po_id: poId, p_vendor_invoice_number: invoiceNumber, p_invoice_date: invoiceDate, p_total_override: totalOverride });
}
export async function recordDeposit(runId: string, vendorId: string, amount: number, invoiceNumber: string | null, invoiceDate: string | null, memo: string | null): Promise<{ bill_id: string; expense_request_id: string; amount: number }> {
  return sbrpc('fn_run_record_deposit', { p_run_id: runId, p_qbo_vendor_id: vendorId, p_amount: amount, p_invoice_number: invoiceNumber, p_invoice_date: invoiceDate, p_memo: memo });
}
export async function recordFinalBill(runId: string, vendorId: string, amountGross: number, invoiceNumber: string | null, invoiceDate: string | null, depositBillId: string | null): Promise<{ bill_id: string; expense_request_id: string; amount_gross: number; amount_net: number; updates_existing_qbo_bill: boolean; qbo_bill_id: string | null }> {
  return sbrpc('fn_run_record_final_bill', { p_run_id: runId, p_qbo_vendor_id: vendorId, p_amount_gross: amountGross, p_invoice_number: invoiceNumber, p_invoice_date: invoiceDate, p_deposit_bill_id: depositBillId, p_lines: null });
}
export async function linkRunBill(runId: string, kind: BillKind, expenseRequestId: string, poId?: string | null): Promise<string> {
  return sbrpc<string>('fn_run_link_bill', { p_run_id: runId, p_kind: kind, p_expense_request_id: expenseRequestId, p_po_id: poId ?? null });
}

/** Where a human finishes the job: Brixpense → Expense History. */
export function brixpenseHistoryUrl(): string {
  const base = typeof location !== 'undefined' && location.pathname.startsWith('/margin') ? '' : '';
  return base + '/expense/pending';
}
