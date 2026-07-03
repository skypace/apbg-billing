import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function opsHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
  };
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: opsHeaders() });
  if (!res.ok) throw new Error(`Supabase read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function classifyProduct(name) {
  const value = String(name || '').toLowerCase();
  if (/\b(co2|co₂|carbon dioxide)\b/.test(value)) return 'co2';
  if (/\b(bib|bag in box|syrup|postmix|fountain)\b/.test(value)) return 'bib';
  if (/\b(can|cans|12oz|16oz|case)\b/.test(value)) return 'can';
  if (/\b(tea|chai|mate)\b/.test(value)) return 'tea';
  if (/\b(lemonade|limeade)\b/.test(value)) return 'lemonade';
  if (/\b(juice|orange|apple|cranberry|grapefruit|pineapple)\b/.test(value)) return 'juice';
  if (/\b(mixer|tonic|ginger beer|club soda|seltzer|bitters)\b/.test(value)) return 'mixer';
  return 'other';
}

function packageSize(name) {
  const value = String(name || '');
  const match = value.match(/\b(\d+(?:\.\d+)?)\s?(gal|gallon|gallons|oz|ounce|ounces|lb|lbs|liter|liters|l|case|cs|bag|keg|bib|can|cans)\b/i);
  return match ? match[0] : undefined;
}

function descriptionFor(row, price) {
  const parts = [row.name || row.item_name || row.qbo_item_id];
  const size = packageSize(parts[0]);
  if (size) parts.push(size);
  if (price != null) parts.push(`BX-1 ${Number(price).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`);
  return parts.filter(Boolean).join(' · ');
}

function imageFor(name, category) {
  const value = String(name || '').toLowerCase();
  if (category === 'can' || /\b(alameda|soda|craft soda)\b/.test(value)) {
    return '/sales-next/Alameda-Soda-Cans-Die-Cut.png';
  }
  if (category === 'bib' || category === 'mixer' || /\b(brix|syrup|fountain)\b/.test(value)) {
    return '/sales-next/Brix-Round-Logo.png';
  }
  return undefined;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'GET') return json({ error: 'GET only' }, 405);

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const books = await supabaseGet('price_books?code=eq.BX-1&select=id&limit=1');
    const bookId = books[0]?.id;
    const [items, prices] = await Promise.all([
      supabaseGet('qbo_items?active=eq.true&select=qbo_item_id,name,active&order=name'),
      bookId
        ? supabaseGet(`price_book_items?price_book_id=eq.${bookId}&effective_from=lte.${today}&or=(effective_to.is.null,effective_to.gte.${today})&select=qbo_item_id,item_name,unit_price,effective_from&order=effective_from.desc`)
        : Promise.resolve([]),
    ]);

    const priceByItem = new Map();
    for (const row of prices) {
      if (!priceByItem.has(row.qbo_item_id)) priceByItem.set(row.qbo_item_id, Number(row.unit_price));
    }

    const products = items.map((row) => {
      const name = row.name || row.qbo_item_id;
      const price = priceByItem.get(row.qbo_item_id);
      return {
        id: String(row.qbo_item_id),
        name,
        category: classifyProduct(name),
        price,
        packageSize: packageSize(name),
        description: descriptionFor(row, price),
        imageUrl: imageFor(name, classifyProduct(name)),
        active: row.active !== false,
      };
    });

    return json({ products, count: products.length });
  } catch (e) {
    console.error('proposal-products error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
