// Spending report data layer — reads the two staff-gated RPCs over the QBO
// expense mirror (migration 20260826f). The caller's own JWT rides the RPC;
// ops.fn_assert_staff_or_service() inside the functions is the real gate.
import { supabase } from '@/lib/supabase';

export interface SpendRow {
  name: string;
  total: number;
  txn_count: number;
  prev_total: number;
  by_month: Record<string, number>;
}

export interface SpendReport {
  months: string[];                                  // "YYYY-MM", oldest first
  monthly: { month: string; total: number }[];
  by_vendor: SpendRow[];
  by_account: SpendRow[];
  totals: {
    window_total: number;
    prev_window_total: number;
    this_month: number | null;
    last_month: number | null;
  };
  window: { start: string; months: number };
}

export async function fetchSpendReport(months: number): Promise<SpendReport> {
  const { data, error } = await supabase.rpc('fn_spend_report', { p_months: months });
  if (error) throw new Error(error.message);
  return data as SpendReport;
}

export interface SpendDetailRow {
  txn_date: string;
  qbo_txn_type: string;
  qbo_txn_id: string;
  account_name: string | null;
  description: string | null;
  amount: number;
}

export async function fetchVendorDetail(vendor: string, months: number): Promise<SpendDetailRow[]> {
  const { data, error } = await supabase.rpc('fn_spend_vendor_detail', {
    p_vendor: vendor, p_months: months,
  });
  if (error) throw new Error(error.message);
  return (data as SpendDetailRow[]) ?? [];
}

/** by_month → an array aligned to the window's month list (missing = 0). */
export function alignMonthly(row: SpendRow, months: string[]): number[] {
  return months.map((m) => Number(row.by_month?.[m] ?? 0));
}

/** Change vs the prior window. null = "new" (nothing in the prior window),
 *  so a brand-new vendor reads as NEW instead of a meaningless +∞%. */
export function pctChange(current: number, previous: number): number | null {
  if (!previous || Math.abs(previous) < 0.005) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** CSV cell: quote everything, and prefix-quote =+-@ — these names come off
 *  OCR'd PDFs and QBO free text, and Excel would run them as formulas. */
export function csvCell(v: string | number | null | undefined): string {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildSpendCsv(rows: SpendRow[], months: string[]): string {
  const head = ['Name', 'Total', 'Transactions', 'Prior window', 'Change %', ...months].map(csvCell).join(',');
  const body = rows.map((r) => {
    const chg = pctChange(r.total, r.prev_total);
    return [
      csvCell(r.name), csvCell(r.total.toFixed(2)), csvCell(r.txn_count),
      csvCell(r.prev_total.toFixed(2)), csvCell(chg === null ? 'new' : chg.toFixed(1)),
      ...alignMonthly(r, months).map((n) => csvCell(n.toFixed(2))),
    ].join(',');
  });
  return [head, ...body].join('\n');
}
