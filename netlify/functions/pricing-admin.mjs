// pricing-admin — manage the Pricing Control Center (ops.* pricing model).
//
//   GET  /margin/.netlify/functions/pricing-admin?action=get
//   POST /margin/.netlify/functions/pricing-admin   { action, ... }
//
// Superadmin-gated (requireAuth). Service-role REST against the ops schema.
// Actions: get | setBookItemPrice | bulkIncrease | setContractItemPrice | setContractDates
//
// Pricing layers: contract (BX-3) → BX-1 standard book → list. Increases are
// effective-dated inserts on price_book_items (no destructive overwrite).

import { requireAuth } from './lib/auth.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function ops(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    ...extra,
  };
}
async function og(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: ops() });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function op(method, path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: ops({ Prefer: prefer }),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return prefer.includes('minimal') ? null : r.json();
}
const json = (status, body) => ({ statusCode: status, headers: HEADERS, body: JSON.stringify(body) });
const today = () => new Date().toISOString().slice(0, 10);
const dayBefore = (d) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
};
const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function bx1BookId() {
  const books = await og('price_books?code=eq.BX-1&select=id');
  if (!books.length) throw new Error('BX-1 price book missing');
  return books[0].id;
}

export async function handler(event) {
  try {
    const auth = await requireAuth(event);
    if (!auth.ok) return auth.response;

    const action = (event.queryStringParameters && event.queryStringParameters.action)
      || (event.body ? (JSON.parse(event.body).action || '') : '');

    if (event.httpMethod === 'GET' || action === 'get') {
      const t = today();
      const [books, standard, contracts, citems, ccusts] = await Promise.all([
        og('price_books?select=id,code,name,active&order=code'),
        og(`price_book_items?select=id,qbo_item_id,item_name,unit_price,effective_from,effective_to&effective_from=lte.${t}&or=(effective_to.is.null,effective_to.gte.${t})&order=item_name`),
        og('pricing_contracts?select=id,name,start_date,end_date,active&order=name'),
        og('pricing_contract_items?select=contract_id,qbo_item_id,item_name,unit_price&order=item_name'),
        og('pricing_contract_customers?select=contract_id,qbo_customer_id'),
      ]);
      const byContract = (id, arr, key) => arr.filter((r) => r.contract_id === id).map(key);
      const contractsOut = contracts.map((c) => ({
        ...c,
        items: byContract(c.id, citems, (r) => ({ qbo_item_id: r.qbo_item_id, item_name: r.item_name, unit_price: Number(r.unit_price) })),
        locations: byContract(c.id, ccusts, (r) => r.qbo_customer_id),
      }));
      return json(200, { ok: true, books, standard, contracts: contractsOut });
    }

    const body = event.body ? JSON.parse(event.body) : {};

    if (action === 'setBookItemPrice') {
      const { qbo_item_id, item_name, unit_price } = body;
      const eff = body.effective_from || today();
      if (!qbo_item_id || !Number.isFinite(Number(unit_price)) || Number(unit_price) < 0) {
        return json(400, { ok: false, error: 'qbo_item_id + non-negative unit_price required' });
      }
      const book = await bx1BookId();
      // Close the currently-open row, then insert the new effective-dated price.
      await op('PATCH', `price_book_items?price_book_id=eq.${book}&qbo_item_id=eq.${encodeURIComponent(qbo_item_id)}&effective_to=is.null`,
        { effective_to: dayBefore(eff) }, 'return=minimal');
      const row = await op('POST', 'price_book_items',
        { price_book_id: book, qbo_item_id, item_name: item_name ?? null, unit_price: round2(unit_price), effective_from: eff });
      return json(200, { ok: true, row: Array.isArray(row) ? row[0] : row });
    }

    if (action === 'bulkIncrease') {
      const pct = Number(body.pct);
      const eff = body.effective_from || today();
      if (!Number.isFinite(pct)) return json(400, { ok: false, error: 'pct (number) required' });
      const book = await bx1BookId();
      const open = await og(`price_book_items?price_book_id=eq.${book}&effective_to=is.null&select=qbo_item_id,item_name,unit_price`);
      if (open.length === 0) return json(200, { ok: true, updated: 0 });
      await op('PATCH', `price_book_items?price_book_id=eq.${book}&effective_to=is.null`,
        { effective_to: dayBefore(eff) }, 'return=minimal');
      const rows = open.map((r) => ({
        price_book_id: book, qbo_item_id: r.qbo_item_id, item_name: r.item_name,
        unit_price: round2(Number(r.unit_price) * (1 + pct / 100)), effective_from: eff,
      }));
      await op('POST', 'price_book_items', rows, 'return=minimal');
      return json(200, { ok: true, updated: rows.length });
    }

    if (action === 'setContractItemPrice') {
      const { contract_id, qbo_item_id, unit_price } = body;
      if (!contract_id || !qbo_item_id || !Number.isFinite(Number(unit_price)) || Number(unit_price) < 0) {
        return json(400, { ok: false, error: 'contract_id + qbo_item_id + non-negative unit_price required' });
      }
      await op('PATCH', `pricing_contract_items?contract_id=eq.${contract_id}&qbo_item_id=eq.${encodeURIComponent(qbo_item_id)}`,
        { unit_price: round2(unit_price), updated_at: new Date().toISOString() }, 'return=minimal');
      return json(200, { ok: true });
    }

    if (action === 'setContractDates') {
      const { contract_id } = body;
      if (!contract_id) return json(400, { ok: false, error: 'contract_id required' });
      const patch = { updated_at: new Date().toISOString() };
      if ('start_date' in body) patch.start_date = body.start_date;
      if ('end_date' in body) patch.end_date = body.end_date || null;
      if ('active' in body) patch.active = !!body.active;
      await op('PATCH', `pricing_contracts?id=eq.${contract_id}`, patch, 'return=minimal');
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: `unknown action: ${action}` });
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
