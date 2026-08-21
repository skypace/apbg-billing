// Rebate Maker client — contract rebate programs, rules, annual settlements.
// Talks straight to PostgREST (staff-only RLS) + the guarded ops RPCs
// (fn_rebate_calculate / fn_rebate_settlement_create / _void). Migration
// 20260821a is the schema + rule-type reference.

import { sbq, sbrpc, sbInsert, sbUpdate, sbDelete } from './rpc';

export type RebateRuleType =
  | 'volume_growth'
  | 'ordering_cadence'
  | 'flat_per_unit'
  | 'tiered_volume'
  | 'fixed_per_store';

export const RULE_TYPE_LABELS: Record<RebateRuleType, string> = {
  volume_growth: 'YoY volume growth ($/unit, per store)',
  ordering_cadence: 'Ordering cadence compliance ($/unit, per store)',
  flat_per_unit: 'Flat $/unit on all in-scope volume',
  tiered_volume: 'Volume tiers (chain-level)',
  fixed_per_store: 'Fixed $ per active store',
};

export interface RebateProgram {
  id: string;
  code: string;
  name: string;
  qbo_customer_id: string;
  qbo_vendor_id: string | null;
  pricing_contract_id: string | null;
  entity: 'brix' | 'freeflow' | 'shared';
  status: 'active' | 'ended';
  notes: string | null;
  created_at: string;
}

export interface RebateRule {
  id: string;
  program_id: string;
  rule_type: RebateRuleType;
  label: string;
  amount: number;
  item_ids: string[];
  item_patterns: string[];
  config: Record<string, unknown>;
  active: boolean;
  sort: number;
}

export interface RebateSettlement {
  id: string;
  program_id: string;
  period_year: number;
  reference: string;
  status: 'open' | 'void';
  total_amount: number;
  notes: string | null;
  expense_request_id: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  detail: RebateCalc | null;
}

export interface RebateCalcStore {
  store: string;
  qbo_customer_id?: string;
  cur_units: number | null;
  prior_units?: number | null;
  growth_pct?: number | null;
  windows_met?: number;
  windows_total?: number;
  qualified: boolean;
  reason?: string | null;
  payable_units: number | null;
  amount: number;
  rate?: number | null;
  retroactive?: boolean;
}

export interface RebateCalcRule {
  rule_id: string;
  rule_type: RebateRuleType;
  label: string;
  amount: number;
  total: number;
  stores: RebateCalcStore[];
}

export interface RebateCalc {
  program_id: string;
  program: string;
  code: string;
  year: number;
  period_start: string;
  period_end: string;
  stores_in_family: number;
  rules: RebateCalcRule[];
  grand_total: number;
  calculated_at: string;
}

export interface VendorOpt { qbo_vendor_id: string; display_name: string }

export async function listRebatePrograms(): Promise<RebateProgram[]> {
  return sbq<RebateProgram>('rebate_programs', 'select=*&order=created_at.asc');
}

export async function listRebateRules(programId: string): Promise<RebateRule[]> {
  return sbq<RebateRule>('rebate_rules',
    `select=*&program_id=eq.${programId}&order=sort.asc,created_at.asc`);
}

export async function listRebateSettlements(programId: string): Promise<RebateSettlement[]> {
  return sbq<RebateSettlement>('rebate_settlements',
    `select=*&program_id=eq.${programId}&order=period_year.desc,created_at.desc`);
}

export async function createRebateProgram(row: {
  code: string; name: string; qbo_customer_id: string; qbo_vendor_id?: string | null;
  pricing_contract_id?: string | null; entity?: string; notes?: string | null;
}): Promise<void> {
  await sbInsert('rebate_programs', row);
}

export async function updateRebateProgram(id: string, patch: Partial<RebateProgram>): Promise<void> {
  await sbUpdate('rebate_programs', `id=eq.${id}`, { ...patch, updated_at: new Date().toISOString() });
}

export async function createRebateRule(row: {
  program_id: string; rule_type: RebateRuleType; label: string; amount: number;
  item_ids: string[]; item_patterns: string[]; config: Record<string, unknown>; sort: number;
}): Promise<void> {
  await sbInsert('rebate_rules', row);
}

export async function updateRebateRule(id: string, patch: Partial<RebateRule>): Promise<void> {
  await sbUpdate('rebate_rules', `id=eq.${id}`, patch);
}

export async function deleteRebateRule(id: string): Promise<void> {
  await sbDelete('rebate_rules', `id=eq.${id}`);
}

export async function calculateRebate(programId: string, year: number): Promise<RebateCalc> {
  return sbrpc<RebateCalc>('fn_rebate_calculate', { p_program_id: programId, p_year: year });
}

export async function createRebateSettlement(
  programId: string, year: number, notes?: string,
): Promise<{ settlement_id: string; reference: string; total_amount: number; expense_request_id: string; vendor: string }> {
  return sbrpc('fn_rebate_settlement_create', { p_program_id: programId, p_year: year, p_notes: notes ?? null });
}

export async function voidRebateSettlement(settlementId: string, reason?: string): Promise<void> {
  await sbrpc('fn_rebate_settlement_void', { p_settlement_id: settlementId, p_reason: reason ?? null });
}

export async function searchVendors(term: string): Promise<VendorOpt[]> {
  const t = term.trim().replace(/[%*,()]/g, '');
  if (!t) return [];
  return sbq<VendorOpt>('qbo_vendors',
    `select=qbo_vendor_id,display_name&active=eq.true&display_name=ilike.*${encodeURIComponent(t)}*&order=display_name.asc&limit=20`);
}

export async function vendorName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const rows = await sbq<VendorOpt>('qbo_vendors', `select=qbo_vendor_id,display_name&qbo_vendor_id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows[0]?.display_name ?? null;
}
