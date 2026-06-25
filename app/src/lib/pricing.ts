import { _sbToken } from './supabase';

// Pricing Control Center client — talks to netlify/functions/pricing-admin.mjs.
const FN = '/margin/.netlify/functions/pricing-admin';

async function bearer(): Promise<string> {
  const t = await _sbToken();
  if (!t) throw new Error('Not signed in');
  return `Bearer ${t}`;
}

export interface BookItem {
  id: string;
  qbo_item_id: string;
  item_name: string | null;
  unit_price: number;
  effective_from: string;
  effective_to: string | null;
}
export interface ContractItem {
  qbo_item_id: string;
  item_name: string | null;
  unit_price: number;
}
export interface Contract {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  active: boolean;
  items: ContractItem[];
  locations: string[];
}
export interface PricingData {
  ok: boolean;
  books: Array<{ id: string; code: string; name: string; active: boolean }>;
  standard: BookItem[];
  contracts: Contract[];
}

export async function getPricing(): Promise<PricingData> {
  const res = await fetch(`${FN}?action=get`, { headers: { Authorization: await bearer() } });
  if (!res.ok) throw new Error(`Load failed (${res.status})`);
  return (await res.json()) as PricingData;
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: await bearer() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export const setBookItemPrice = (
  qbo_item_id: string,
  item_name: string | null,
  unit_price: number,
  effective_from?: string,
) => post({ action: 'setBookItemPrice', qbo_item_id, item_name, unit_price, effective_from });

export const bulkIncrease = (pct: number, effective_from: string) =>
  post({ action: 'bulkIncrease', pct, effective_from });

export const setContractItemPrice = (contract_id: string, qbo_item_id: string, unit_price: number) =>
  post({ action: 'setContractItemPrice', contract_id, qbo_item_id, unit_price });

export const setContractDates = (
  contract_id: string,
  start_date: string,
  end_date: string | null,
  active: boolean,
) => post({ action: 'setContractDates', contract_id, start_date, end_date, active });

/** Build + download a Service Fusion price-list CSV from the BX-1 standard list. */
export function exportStandardCsv(standard: BookItem[]): void {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['QBO Item ID,Item,BX-1 Price,Effective From'];
  for (const r of standard) {
    lines.push([r.qbo_item_id, r.item_name, r.unit_price, r.effective_from].map(esc).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `brix-bx1-price-list-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
