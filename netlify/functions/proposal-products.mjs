import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];

// orders.catalog categories that are not proposal beverages: gas cylinders and
// pickup/service rows. Everything else in the catalog is a sellable drink.
const EXCLUDED_CATALOG_CATEGORIES = new Set(['gas', 'other']);

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function restHeaders(profile = 'ops') {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Profile': profile,
    'Content-Profile': profile,
  };
}

async function supabaseGet(path, profile = 'ops') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders(profile) });
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

// fountain = dispensed (bag-in-box / post-mix); packaged = ready-to-drink cans
// or bottles. The catalog's structural fields decide — never the flavor name,
// which is how "Oaktown Root Beer" (no bib/can token) used to vanish.
function beverageClassFor(row) {
  const container = String(row.container_type || '').toLowerCase();
  const category = String(row.category || '').toLowerCase();
  if (container.includes('bag-in-box') || container.includes('bib') || category.includes('bib')) return 'fountain';
  if (container.includes('can') || container.includes('bottle') || category.includes('pack')) return 'packaged';
  return 'packaged';
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

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Collect every full/absolute image URL a catalog row carries, most specific
// first. orders.catalog image columns hold complete public URLs (Supabase
// Storage `brix-catalog-images` bucket + Shopify CDN) — no bucket guessing.
function catalogImageUrls(row) {
  const urls = [row.image_url, row.image_thumb_url, row.bib_image_url]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => /^https?:\/\//i.test(value) || value.startsWith('/'));
  return [...new Set(urls)];
}

// "1 × 3-gal BIB" → "3-gal BIB"; used to tell same-named pack sizes apart.
function packLabel(row) {
  return String(row.pack_size || row.container_type || '').replace(/^1\s*[×x]\s*/i, '').trim();
}

function currencyLabel(value) {
  return Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
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
    // orders.catalog is the curated BRIX / Alameda Soda beverage catalog — the
    // same rows the order portal sells. It is the single source for the
    // proposal product picker. (The old approach swept every active ops.qbo_item
    // through name regexes and fuzzy-matched Melt equipment contract_items onto
    // them: single-character equipment SKUs like "3" substring-matched every
    // beverage, stamping grill specs onto soda rows, while Sugar-Free BIBs and
    // 24-packs whose names carry no bib/can token were dropped entirely.)
    const [catalogRows, prices] = await Promise.all([
      supabaseGet('catalog?select=qbo_item_id,name,display_name,sku,category,description,pack_size,volume_oz,weight_lbs,container_type,list_price,image_url,image_thumb_url,bib_image_url,active,orderable&order=name', 'orders'),
      bookId
        ? supabaseGet(`price_book_items?price_book_id=eq.${bookId}&effective_from=lte.${today}&or=(effective_to.is.null,effective_to.gte.${today})&select=qbo_item_id,item_name,unit_price,effective_from&order=effective_from.desc`)
        : Promise.resolve([]),
    ]);

    const priceByItem = new Map();
    for (const row of prices) {
      const key = String(row.qbo_item_id);
      if (!priceByItem.has(key)) priceByItem.set(key, Number(row.unit_price));
    }

    const seenIds = new Set();
    const products = [];
    for (const row of catalogRows) {
      if (row.active === false || row.orderable === false) continue;
      if (EXCLUDED_CATALOG_CATEGORIES.has(String(row.category || '').toLowerCase())) continue;
      const id = row.qbo_item_id != null ? String(row.qbo_item_id) : `catalog:${normalizeKey(row.sku || row.name)}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const name = row.display_name || row.name;
      const beverageClass = beverageClassFor(row);
      // Chip category for the UI; when the flavor name gives the classifier
      // nothing, fall back to the structural class instead of 'other'.
      const classified = classifyProduct(`${row.category || ''} ${name}`);
      let category = classified !== 'other' ? classified : (beverageClass === 'fountain' ? 'bib' : 'can');
      // A packaged can whose flavor NAME contains a fountain word ("Olde
      // Fountain Creme" 24-pack) must not chip as BIB.
      if (beverageClass === 'packaged' && category === 'bib') category = 'can';
      const price = priceByItem.get(id) ?? (row.list_price != null ? Number(row.list_price) : undefined);
      const imageUrls = catalogImageUrls(row);
      const description = row.description
        || [row.pack_size, row.sku, price != null ? `BX-1 ${currencyLabel(price)}` : null].filter(Boolean).join(' · ');

      products.push({
        id,
        name,
        category,
        beverageClass,
        price,
        packageSize: row.pack_size || undefined,
        description,
        imageUrl: imageUrls[0] || imageFor(name, category),
        imageUrls,
        specSheetUrl: undefined,
        sku: row.sku || undefined,
        manufacturer: undefined,
        model: undefined,
        weightLbs: row.weight_lbs != null ? Number(row.weight_lbs) : undefined,
        source: 'brix-order',
        active: row.active !== false,
        catalogRow: row,
      });
    }

    // Same flavor in several pack sizes shares one display name — suffix the
    // pack so "Hangar 25 Cola (3-gal BIB)" and "(24 × 12 oz cans)" don't read
    // as duplicate rows in the picker.
    const nameCounts = new Map();
    for (const product of products) {
      const key = normalizeKey(product.name);
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    for (const product of products) {
      if (nameCounts.get(normalizeKey(product.name)) > 1) {
        const label = packLabel(product.catalogRow);
        if (label) product.name = `${product.name} (${label})`;
      }
      delete product.catalogRow;
    }

    products.sort((a, b) => {
      if (a.beverageClass !== b.beverageClass) return a.beverageClass === 'fountain' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return json({ products, count: products.length });
  } catch (e) {
    console.error('proposal-products error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
