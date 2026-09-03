// Licensing agreements client — a licensor's royalty accrued per production
// run (rate × cases produced, by default) and settled per period into a
// Brixpense payable. Mirrors lib/rebates.ts; migration 20260903a is the
// schema + RPC reference. Programs/rules are edited straight through
// PostgREST under staff-only RLS; accruals and settlements only move through
// the guarded RPCs.

import { sbq, sbrpc, sbInsert, sbUpdate, sbDelete } from './rpc';

export type LicensingBasis = 'cases_produced' | 'concentrate_gal_produced' | 'finished_gal_produced';
export type LicensingPeriodBasis = 'month' | 'quarter';

export const BASIS_LABELS: Record<LicensingBasis, string> = {
  cases_produced: 'Cases produced (final yield)',
  concentrate_gal_produced: 'Raw (concentrate) gallons produced',
  finished_gal_produced: 'Finished gallons produced',
};

export interface LicensingProgram {
  id: string;
  code: string;
  name: string;
  qbo_vendor_id: string;
  entity: 'brix' | 'freeflow' | 'shared';
  period_basis: LicensingPeriodBasis;
  status: 'active' | 'ended';
  starts_on: string;
  notes: string | null;
  created_at: string;
}

export interface LicensingRule {
  id: string;
  program_id: string;
  label: string;
  basis: LicensingBasis;
  rate: number;
  rate_unit: string;
  rate_effective_from: string | null;
  rate_note: string | null;
  formula_ids: string[];
  active: boolean;
  sort: number;
}

export interface LicensingRuleRate {
  id: string;
  rule_id: string;
  rate: number;
  rate_unit: string;
  effective_from: string;
  note: string | null;
  created_at: string;
}

export interface LicensingSettlement {
  id: string;
  program_id: string;
  period_key: string;
  period_start: string;
  period_end: string;
  reference: string;
  status: 'open' | 'void';
  total_basis_qty: number;
  total_amount: number;
  notes: string | null;
  expense_request_id: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  detail: LicensingCalc | null;
}

export interface LicensingCalcWo {
  accrual_id: string;
  wo_id: string;
  batch_code: string | null;
  flavour: string | null;
  finished_item: string | null;
  basis_date: string;
  cases: number | null;
  concentrate_gal_per_case: number | null;
  basis_qty: number;
  rate: number;
  rate_unit: string;
  amount: number;
  wo_status: string;
  settlement_id: string | null;
  settlement_reference: string | null;
}

export interface LicensingCalcRule {
  rule_id: string;
  label: string;
  basis: LicensingBasis;
  current_rate: number;
  rate_unit: string;
  active: boolean;
  work_orders: LicensingCalcWo[];
  total_basis_qty: number;
  total: number;
  unsettled_total: number;
}

export interface LicensingPending {
  wo_id: string;
  batch_code: string;
  status: string;
  flavour: string | null;
  qty_to_produce: number;
  production_started_at: string | null;
}

export interface LicensingCalc {
  program_id: string;
  code: string;
  program: string;
  vendor_id: string;
  vendor_name: string | null;
  period_start: string;
  period_end: string;
  period_key: string;
  period_ended: boolean;
  rules: LicensingCalcRule[];
  pending: LicensingPending[];
  already_settled: { settlement_id: string; reference: string; period_key: string; total_amount: number; status: string }[];
  grand_total: number;
  unsettled_total: number;
  calculated_at: string;
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function listLicensingPrograms(): Promise<LicensingProgram[]> {
  return sbq<LicensingProgram>('licensing_programs', 'select=*&order=created_at.asc');
}
export async function listLicensingRules(programId: string): Promise<LicensingRule[]> {
  return sbq<LicensingRule>('licensing_rules', `select=*&program_id=eq.${programId}&order=sort.asc,created_at.asc`);
}
export async function listRuleRates(ruleId: string): Promise<LicensingRuleRate[]> {
  return sbq<LicensingRuleRate>('licensing_rule_rates', `select=*&rule_id=eq.${ruleId}&order=effective_from.desc`);
}
export async function listLicensingSettlements(programId: string): Promise<LicensingSettlement[]> {
  return sbq<LicensingSettlement>('licensing_settlements',
    `select=*&program_id=eq.${programId}&order=period_start.desc,created_at.desc`);
}

// ── writes (PostgREST, staff RLS) ────────────────────────────────────────────

export async function createLicensingProgram(row: {
  code: string; name: string; qbo_vendor_id: string; entity: string;
  period_basis: LicensingPeriodBasis; starts_on: string; notes?: string | null;
}): Promise<LicensingProgram> {
  return sbInsert<LicensingProgram>('licensing_programs', row as LicensingProgram);
}
export async function updateLicensingProgram(id: string, patch: Partial<LicensingProgram>): Promise<void> {
  await sbUpdate('licensing_programs', `id=eq.${id}`, { ...patch, updated_at: new Date().toISOString() });
}
export async function createLicensingRule(row: {
  program_id: string; label: string; basis: LicensingBasis; rate: number; rate_unit: string;
  rate_effective_from?: string | null; rate_note?: string | null; formula_ids: string[]; sort: number;
}): Promise<void> {
  await sbInsert('licensing_rules', row);
}
export async function updateLicensingRule(id: string, patch: Partial<LicensingRule>): Promise<void> {
  await sbUpdate('licensing_rules', `id=eq.${id}`, patch);
}
export async function deleteLicensingRule(id: string): Promise<void> {
  // Refused by the FK once accruals exist — the message says so; deactivate instead.
  await sbDelete('licensing_rules', `id=eq.${id}`);
}

// ── RPCs ─────────────────────────────────────────────────────────────────────

export async function calculateLicensing(programId: string, start: string, end: string): Promise<LicensingCalc> {
  return sbrpc<LicensingCalc>('fn_licensing_calculate', { p_program_id: programId, p_period_start: start, p_period_end: end });
}
export async function recomputeLicensing(programId: string, start: string, end: string): Promise<number> {
  return sbrpc<number>('fn_licensing_recompute', { p_program_id: programId, p_period_start: start, p_period_end: end });
}
export async function backfillLicensing(programId: string): Promise<number> {
  return sbrpc<number>('fn_licensing_backfill', { p_program_id: programId });
}
export async function createLicensingSettlement(programId: string, periodKey: string, notes?: string): Promise<{
  settlement_id: string; reference: string; period_key: string; total_basis_qty: number;
  total_amount: number; runs: number; expense_request_id: string; vendor: string;
}> {
  return sbrpc('fn_licensing_settlement_create', { p_program_id: programId, p_period_key: periodKey, p_notes: notes ?? null });
}
export async function voidLicensingSettlement(settlementId: string, reason?: string): Promise<void> {
  await sbrpc('fn_licensing_settlement_void', { p_settlement_id: settlementId, p_reason: reason ?? null });
}

// ── period helpers (pure; mirror ops.fn_licensing_period_key/_bounds) ────────

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function isoDate(d: Date): string { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

export function periodKey(basis: LicensingPeriodBasis, d: Date): string {
  const y = d.getUTCFullYear(); const m = d.getUTCMonth();
  return basis === 'quarter' ? `${y}-Q${Math.floor(m / 3) + 1}` : `${y}-${pad2(m + 1)}`;
}

export function periodBounds(basis: LicensingPeriodBasis, key: string): { start: string; end: string } {
  if (basis === 'quarter') {
    const y = Number(key.slice(0, 4)); const q = Number(key.slice(-1));
    const s = new Date(Date.UTC(y, (q - 1) * 3, 1));
    const e = new Date(Date.UTC(y, (q - 1) * 3 + 3, 0));
    return { start: isoDate(s), end: isoDate(e) };
  }
  const y = Number(key.slice(0, 4)); const m = Number(key.slice(5, 7));
  const s = new Date(Date.UTC(y, m - 1, 1));
  const e = new Date(Date.UTC(y, m, 0));
  return { start: isoDate(s), end: isoDate(e) };
}

export function periodLabel(basis: LicensingPeriodBasis, key: string): string {
  if (basis === 'quarter') return `Q${key.slice(-1)} ${key.slice(0, 4)}`;
  const y = Number(key.slice(0, 4)); const m = Number(key.slice(5, 7));
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The current period plus the `n-1` before it, newest first. */
export function recentPeriods(basis: LicensingPeriodBasis, n: number, from = new Date()): string[] {
  const out: string[] = [];
  const y = from.getUTCFullYear(); const m = from.getUTCMonth();
  for (let i = 0; i < n; i++) {
    const d = basis === 'quarter'
      ? new Date(Date.UTC(y, Math.floor(m / 3) * 3 - i * 3, 1))
      : new Date(Date.UTC(y, m - i, 1));
    out.push(periodKey(basis, d));
  }
  return out;
}

/** A period can be settled only once it has fully ended (server refuses too). */
export function periodHasEnded(basis: LicensingPeriodBasis, key: string, today = new Date()): boolean {
  return periodBounds(basis, key).end < isoDate(today);
}
