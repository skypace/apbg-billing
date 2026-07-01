// pricing-admin — manage the Pricing Control Center (ops.* pricing model).
//
//   GET  /margin/.netlify/functions/pricing-admin?action=get
//   POST /margin/.netlify/functions/pricing-admin   { action, ... }
//
// Superadmin-gated (requireAuth). Service-role REST against the ops schema +
// the private 'pricing-contracts' storage bucket. Pricing layers:
// contract (BX-3) → price book (BX-1 standard) → list. Increases are
// effective-dated inserts on price_book_items (no destructive overwrite).
//
// Actions: get | createPriceBook | setBookItemPrice | removeBookItem | bulkIncrease |
//          createContract | setContractDates | addContractItem |
//          removeContractItem | addContractCustomer | removeContractCustomer |
//          uploadContractFile | contractFileUrl

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
const dayBefore = (d) => { const dt = new Date(`${d}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); };
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const first = (x) => (Array.isArray(x) ? x[0] : x);

async function bookIdByCode(code) {
  const books = await og(`price_books?code=eq.${encodeURIComponent(code)}&select=id`);
  if (!books.length) throw new Error(`price book ${code} not found`);
  return books[0].id;
}

export async function handler(event) {
  try {
    const auth = await requireAuth(event);
    if (!auth.ok) return auth.response;

    const qp = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};
    const action = qp.action || body.action || '';

    if (event.httpMethod === 'GET' || action === 'get') {
      const t = today();
      const [books, standard, contracts, citems, ccusts, items, customers] = await Promise.all([
        og('price_books?select=id,code,name,active&order=code'),
        og(`price_book_items?select=id,price_book_id,qbo_item_id,item_name,unit_price,effective_from,effective_to&effective_from=lte.${t}&or=(effective_to.is.null,effective_to.gte.${t})&order=item_name`),
        og('pricing_contracts?select=id,name,kind,start_date,end_date,active,contract_file_name&order=name'),
        og('pricing_contract_items?select=contract_id,qbo_item_id,item_name,unit_price&order=item_name'),
        og('pricing_contract_customers?select=contract_id,qbo_customer_id'),
        og('qbo_items?active=eq.true&select=qbo_item_id,name&order=name'),
        og('qbo_customers?select=qbo_customer_id,display_name&display_name=not.ilike.*(deleted)*&order=display_name'),
      ]);
      const pick = (id, arr, fn) => arr.filter((r) => r.contract_id === id).map(fn);
      const contractsOut = contracts.map((c) => ({
        ...c,
        items: pick(c.id, citems, (r) => ({ qbo_item_id: r.qbo_item_id, item_name: r.item_name, unit_price: Number(r.unit_price) })),
        locations: pick(c.id, ccusts, (r) => r.qbo_customer_id),
      }));
      return json(200, { ok: true, books, standard, contracts: contractsOut, items, customers });
    }

    if (action === 'createPriceBook') {
      const code = (body.code || '').trim();
      const name = (body.name || '').trim();
      if (!code || !name) return json(400, { ok: false, error: 'code + name required' });
      const row = await op('POST', 'price_books', { code, name, active: true });
      return json(200, { ok: true, book: first(row) });
    }

    if (action === 'setBookItemPrice') {
      const { qbo_item_id, item_name, unit_price } = body;
      const eff = body.effective_from || today();
      const code = body.book_code || 'BX-1';
      if (!qbo_item_id || !Number.isFinite(Number(unit_price)) || Number(unit_price) < 0) {
        return json(400, { ok: false, error: 'qbo_item_id + non-negative unit_price required' });
      }
      const book = await bookIdByCode(code);
      // Insert-first: open the new row BEFORE closing the prior one, so a failed
      // insert can never leave the item with no open price. The resolver picks the
      // newest effective_from, so a momentary pair of open rows still resolves.
      const row = first(await op('POST', 'price_book_items',
        { price_book_id: book, qbo_item_id, item_name: item_name ?? null, unit_price: round2(unit_price), effective_from: eff }));
      await op('PATCH', `price_book_items?price_book_id=eq.${book}&qbo_item_id=eq.${encodeURIComponent(qbo_item_id)}&effective_to=is.null&id=neq.${row.id}`,
        { effective_to: dayBefore(eff) }, 'return=minimal');
      return json(200, { ok: true, row });
    }

    if (action === 'removeBookItem') {
      const { qbo_item_id } = body;
      const code = body.book_code || 'BX-1';
      if (!qbo_item_id) return json(400, { ok: false, error: 'qbo_item_id required' });
      const book = await bookIdByCode(code);
      // Hard-delete every effective-dated row for this book/item (mirrors
      // removeContractItem). The item drops out of the book entirely.
      await op('DELETE', `price_book_items?price_book_id=eq.${book}&qbo_item_id=eq.${encodeURIComponent(qbo_item_id)}`, null, 'return=minimal');
      return json(200, { ok: true });
    }

    if (action === 'bulkIncrease') {
      const pct = Number(body.pct);
      const eff = body.effective_from || today();
      const code = body.book_code || 'BX-1';
      if (!Number.isFinite(pct)) return json(400, { ok: false, error: 'pct (number) required' });
      // Sanity cap: a price change beyond ±100% is almost certainly a fat-finger
      // (e.g. 1000 meant as 10). Refuse rather than rewrite the whole book.
      if (pct < -100 || pct > 100) return json(400, { ok: false, error: 'pct must be between -100 and 100' });
      const book = await bookIdByCode(code);
      const open = await og(`price_book_items?price_book_id=eq.${book}&effective_to=is.null&select=qbo_item_id,item_name,unit_price`);
      if (open.length === 0) return json(200, { ok: true, updated: 0 });
      // Insert-first: write the new open rows, capture their ids, then close every
      // OTHER open row. A crash mid-flight leaves duplicate open rows (resolver
      // tolerates) rather than a book with no open prices.
      const rows = open.map((r) => ({ price_book_id: book, qbo_item_id: r.qbo_item_id, item_name: r.item_name, unit_price: round2(Number(r.unit_price) * (1 + pct / 100)), effective_from: eff }));
      const inserted = await op('POST', 'price_book_items', rows, 'return=representation');
      const newIds = (Array.isArray(inserted) ? inserted : [inserted]).map((r) => r.id);
      await op('PATCH', `price_book_items?price_book_id=eq.${book}&effective_to=is.null&id=not.in.(${newIds.join(',')})`,
        { effective_to: dayBefore(eff) }, 'return=minimal');
      return json(200, { ok: true, updated: rows.length });
    }

    if (action === 'createContract') {
      const name = (body.name || '').trim();
      if (!name || !body.start_date) return json(400, { ok: false, error: 'name + start_date required' });
      const kind = body.kind === 'exclusivity' ? 'exclusivity' : 'contract';
      const c = first(await op('POST', 'pricing_contracts', {
        name, kind, start_date: body.start_date, end_date: body.end_date || null,
        active: body.active === false ? false : true, notes: body.notes || null,
      }));
      const cid = c.id;
      const customers = Array.isArray(body.customers) ? body.customers : [];
      const items = Array.isArray(body.items) ? body.items : [];
      if (customers.length) {
        await op('POST', 'pricing_contract_customers',
          customers.map((q) => ({ contract_id: cid, qbo_customer_id: String(q) })),
          'return=minimal,resolution=merge-duplicates');
      }
      if (items.length) {
        await op('POST', 'pricing_contract_items',
          items.map((it) => ({ contract_id: cid, qbo_item_id: String(it.qbo_item_id), item_name: it.item_name || null, unit_price: round2(it.unit_price) })),
          'return=minimal,resolution=merge-duplicates');
      }
      return json(200, { ok: true, id: cid });
    }

    if (action === 'setContractDates') {
      const { contract_id } = body;
      if (!contract_id) return json(400, { ok: false, error: 'contract_id required' });
      const patch = { updated_at: new Date().toISOString() };
      if ('start_date' in body) patch.start_date = body.start_date;
      if ('end_date' in body) patch.end_date = body.end_date || null;
      if ('active' in body) patch.active = !!body.active;
      if ('kind' in body) patch.kind = body.kind === 'exclusivity' ? 'exclusivity' : 'contract';
      if ('name' in body && body.name) patch.name = String(body.name).trim();
      await op('PATCH', `pricing_contracts?id=eq.${contract_id}`, patch, 'return=minimal');
      return json(200, { ok: true });
    }

    if (action === 'addContractItem' || action === 'setContractItemPrice') {
      const { contract_id, qbo_item_id, item_name, unit_price } = body;
      if (!contract_id || !qbo_item_id || !Number.isFinite(Number(unit_price)) || Number(unit_price) < 0) {
        return json(400, { ok: false, error: 'contract_id + qbo_item_id + non-negative unit_price required' });
      }
      await op('POST', 'pricing_contract_items',
        [{ contract_id, qbo_item_id: String(qbo_item_id), item_name: item_name ?? null, unit_price: round2(unit_price), updated_at: new Date().toISOString() }],
        'return=minimal,resolution=merge-duplicates');
      return json(200, { ok: true });
    }

    if (action === 'removeContractItem') {
      const { contract_id, qbo_item_id } = body;
      if (!contract_id || !qbo_item_id) return json(400, { ok: false, error: 'contract_id + qbo_item_id required' });
      await op('DELETE', `pricing_contract_items?contract_id=eq.${contract_id}&qbo_item_id=eq.${encodeURIComponent(qbo_item_id)}`, null, 'return=minimal');
      return json(200, { ok: true });
    }

    if (action === 'addContractCustomer') {
      const { contract_id, qbo_customer_id } = body;
      if (!contract_id || !qbo_customer_id) return json(400, { ok: false, error: 'contract_id + qbo_customer_id required' });
      await op('POST', 'pricing_contract_customers',
        [{ contract_id, qbo_customer_id: String(qbo_customer_id) }], 'return=minimal,resolution=merge-duplicates');
      return json(200, { ok: true });
    }

    if (action === 'removeContractCustomer') {
      const { contract_id, qbo_customer_id } = body;
      if (!contract_id || !qbo_customer_id) return json(400, { ok: false, error: 'contract_id + qbo_customer_id required' });
      await op('DELETE', `pricing_contract_customers?contract_id=eq.${contract_id}&qbo_customer_id=eq.${encodeURIComponent(qbo_customer_id)}`, null, 'return=minimal');
      return json(200, { ok: true });
    }

    if (action === 'uploadContractFile') {
      const { contract_id, filename, content_type, content_base64 } = body;
      if (!contract_id || !filename || !content_base64) return json(400, { ok: false, error: 'contract_id + filename + content_base64 required' });
      const safe = String(filename).replace(/[^\w.\-]+/g, '_');
      const path = `${contract_id}/${Date.now()}-${safe}`;
      const bytes = Buffer.from(content_base64, 'base64');
      const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — a contract PDF, not a media dump
      if (bytes.length > MAX_FILE_BYTES) return json(413, { ok: false, error: `file too large (${(bytes.length / 1048576).toFixed(1)} MB > 25 MB)` });
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/pricing-contracts/${encodeURI(path)}`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': content_type || 'application/octet-stream', 'x-upsert': 'true' },
        body: bytes,
      });
      if (!up.ok) throw new Error(`storage upload: ${up.status} ${await up.text()}`);
      await op('PATCH', `pricing_contracts?id=eq.${contract_id}`, { contract_file_path: path, contract_file_name: filename, updated_at: new Date().toISOString() }, 'return=minimal');
      return json(200, { ok: true, path });
    }

    if (action === 'contractFileUrl') {
      const { contract_id } = body.contract_id ? body : qp;
      if (!contract_id) return json(400, { ok: false, error: 'contract_id required' });
      const rows = await og(`pricing_contracts?id=eq.${contract_id}&select=contract_file_path`);
      const path = rows[0]?.contract_file_path;
      if (!path) return json(404, { ok: false, error: 'no file attached' });
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/pricing-contracts/${encodeURI(path)}`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      if (!r.ok) throw new Error(`sign: ${r.status} ${await r.text()}`);
      const { signedURL } = await r.json();
      return json(200, { ok: true, url: `${SUPABASE_URL}/storage/v1${signedURL}` });
    }

    return json(400, { ok: false, error: `unknown action: ${action}` });
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
