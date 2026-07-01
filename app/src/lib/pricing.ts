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
  price_book_id: string;
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
export type ContractKind = 'contract' | 'exclusivity';
export interface Contract {
  id: string;
  name: string;
  kind: ContractKind;
  start_date: string;
  end_date: string | null;
  active: boolean;
  contract_file_name: string | null;
  items: ContractItem[];
  locations: string[];
}
export interface ItemOpt { qbo_item_id: string; name: string }
export interface CustomerOpt { qbo_customer_id: string; display_name: string }
export interface PricingData {
  ok: boolean;
  books: Array<{ id: string; code: string; name: string; active: boolean }>;
  standard: BookItem[];
  contracts: Contract[];
  items: ItemOpt[];
  customers: CustomerOpt[];
}

export interface NewContract {
  name: string;
  kind: ContractKind;
  start_date: string;
  end_date: string | null;
  customers: string[];
  items: Array<{ qbo_item_id: string; item_name: string | null; unit_price: number }>;
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
  book_code?: string,
) => post({ action: 'setBookItemPrice', qbo_item_id, item_name, unit_price, effective_from, book_code });

export const removeBookItem = (qbo_item_id: string, book_code?: string) =>
  post({ action: 'removeBookItem', qbo_item_id, book_code });

export const bulkIncrease = (pct: number, effective_from: string, book_code?: string) =>
  post({ action: 'bulkIncrease', pct, effective_from, book_code });

export const setContractItemPrice = (contract_id: string, qbo_item_id: string, unit_price: number) =>
  post({ action: 'setContractItemPrice', contract_id, qbo_item_id, unit_price });

export const setContractDates = (
  contract_id: string,
  start_date: string,
  end_date: string | null,
  active: boolean,
) => post({ action: 'setContractDates', contract_id, start_date, end_date, active });

export const setContractMeta = (
  contract_id: string,
  patch: { name?: string; kind?: ContractKind; start_date?: string; end_date?: string | null; active?: boolean },
) => post({ action: 'setContractDates', contract_id, ...patch });

export const createPriceBook = (code: string, name: string) =>
  post({ action: 'createPriceBook', code, name });

export const createContract = (c: NewContract) => post({ action: 'createContract', ...c }) as Promise<{ id: string }>;

export const addContractItem = (contract_id: string, qbo_item_id: string, item_name: string | null, unit_price: number) =>
  post({ action: 'addContractItem', contract_id, qbo_item_id, item_name, unit_price });

export const removeContractItem = (contract_id: string, qbo_item_id: string) =>
  post({ action: 'removeContractItem', contract_id, qbo_item_id });

export const addContractCustomer = (contract_id: string, qbo_customer_id: string) =>
  post({ action: 'addContractCustomer', contract_id, qbo_customer_id });

export const removeContractCustomer = (contract_id: string, qbo_customer_id: string) =>
  post({ action: 'removeContractCustomer', contract_id, qbo_customer_id });

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
export async function uploadContractFile(contract_id: string, file: File): Promise<void> {
  const content_base64 = await fileToBase64(file);
  await post({ action: 'uploadContractFile', contract_id, filename: file.name, content_type: file.type, content_base64 });
}
export async function contractFileUrl(contract_id: string): Promise<string> {
  const r = (await post({ action: 'contractFileUrl', contract_id })) as { url: string };
  return r.url;
}

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
