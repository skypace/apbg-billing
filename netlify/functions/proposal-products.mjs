import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];
const COMMON_IMAGE_BUCKETS = [
  'product-images',
  'product-assets',
  'contract-item-images',
  'contract-item-assets',
  'store-assets',
  'order-assets',
  'brix-order-assets',
  'brix-order',
];
const COMMON_SPEC_BUCKETS = [
  'product-specs',
  'spec-sheets',
  'contract-item-specs',
  'contract-item-assets',
  'store-assets',
  'order-assets',
  'brix-order-assets',
  'brix-order',
];

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

async function supabaseGetOptional(path, profile = 'ops') {
  try {
    return await supabaseGet(path, profile);
  } catch (e) {
    console.warn(`Optional Supabase read skipped (${profile}.${path.split('?')[0]}):`, e instanceof Error ? e.message : e);
    return [];
  }
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

function looksLikeEquipment(value) {
  return /\b(equipment|dispenser|cooler|ice machine|refrigerator|refrigeration|walk[-\s]?in|lancer|avantco|beverage air|stainless|table|sink|shelving|kegerator|fountain unit)\b/i
    .test(String(value || ''));
}

function isOrderProductCandidate(item) {
  const value = [
    item.name,
    item.category,
    item.description,
    item.item_type,
    item.qbo_item_name,
    item.sku,
  ].filter(Boolean).join(' ');
  const category = classifyProduct(value);
  if (category !== 'other' && !looksLikeEquipment(value)) return true;
  return /\b(beverage|drink|soda|cola|root beer|syrup|bib|bag in box|can|cans|tea|lemonade|limeade|juice|mixer|tonic|ginger beer|club soda|seltzer|co2|flavor)\b/i
    .test(value) && !looksLikeEquipment(value);
}

function packageSize(name) {
  const value = String(name || '');
  const match = value.match(/\b(\d+(?:\.\d+)?)\s?(gal|gallon|gallons|oz|ounce|ounces|lb|lbs|liter|liters|l|case|cs|bag|keg|bib|can|cans)\b/i);
  return match ? match[0] : undefined;
}

function descriptionFor(row, price, orderItem) {
  if (orderItem?.description) return orderItem.description;
  const parts = [row.name || row.item_name || row.qbo_item_id];
  const size = packageSize(parts[0]);
  if (size) parts.push(size);
  if (orderItem?.sku || row.sku) parts.push(orderItem?.sku || row.sku);
  if (orderItem?.model) parts.push(orderItem.model);
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

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function envList(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function storagePublicUrl(bucket, path) {
  const cleanPath = String(path || '').replace(/^\/+/, '');
  return `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(bucket)}/${cleanPath.split('/').map(encodeURIComponent).join('/')}`;
}

function assetUrlFor(key, kind) {
  return assetUrlsFor(key, kind)[0];
}

function assetUrlsFor(key, kind) {
  const raw = String(key || '').trim();
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  if (raw.startsWith('/')) return [raw];

  const assetBase = process.env.BRIX_ORDER_ASSET_BASE_URL || '';
  if (assetBase) return [`${assetBase.replace(/\/+$/, '')}/${raw.replace(/^\/+/, '')}`];

  const configuredBuckets = kind === 'spec'
    ? envList('BRIX_ORDER_SPEC_BUCKETS', 'BRIX_ORDER_SPEC_BUCKET', 'BRIX_ORDER_ASSET_BUCKET')
    : envList('BRIX_ORDER_IMAGE_BUCKETS', 'BRIX_ORDER_IMAGE_BUCKET', 'BRIX_ORDER_ASSET_BUCKET');
  const fallbackBuckets = kind === 'spec' ? COMMON_SPEC_BUCKETS : COMMON_IMAGE_BUCKETS;
  const buckets = [...new Set([...configuredBuckets, ...fallbackBuckets])];
  const colon = raw.match(/^([^:]+):(.+)$/);
  if (colon) return [storagePublicUrl(colon[1], colon[2])];

  const [first, ...rest] = raw.replace(/^\/+/, '').split('/');
  if (rest.length && buckets.includes(first)) return [storagePublicUrl(first, rest.join('/'))];
  return buckets.map((bucket) => storagePublicUrl(bucket, raw));
}

function indexOrderItems(rows) {
  const byQboId = new Map();
  const byName = new Map();
  for (const item of rows) {
    if (item.qbo_item_id) byQboId.set(String(item.qbo_item_id), item);
    for (const value of [item.qbo_item_name, item.name, item.sku].filter(Boolean)) {
      const key = normalizeKey(value);
      if (key && !byName.has(key)) byName.set(key, item);
    }
  }
  return { byQboId, byName };
}

function findOrderItem(row, index) {
  const byId = index.byQboId.get(String(row.qbo_item_id));
  if (byId) return byId;
  for (const value of [row.name, row.fully_qualified_name].filter(Boolean)) {
    const direct = index.byName.get(normalizeKey(value));
    if (direct) return direct;
  }
  const rowName = normalizeKey(row.name || row.fully_qualified_name || '');
  if (!rowName) return undefined;
  for (const [key, item] of index.byName) {
    if (key && (key.includes(rowName) || rowName.includes(key))) return item;
  }
  return undefined;
}

function orderCategory(orderItem, fallbackName) {
  const raw = orderItem?.category || orderItem?.item_type || fallbackName;
  return classifyProduct(raw);
}

function orderItemToProduct(orderItem, priceByItem) {
  const name = orderItem.name || orderItem.qbo_item_name || orderItem.sku || `Order item ${orderItem.id}`;
  const qboId = orderItem.qbo_item_id ? String(orderItem.qbo_item_id) : '';
  const price = qboId ? priceByItem.get(qboId) : undefined;
  const category = orderCategory(orderItem, name);
  const imageUrls = assetUrlsFor(orderItem.image_key, 'image');
  return {
    id: qboId || `order:${orderItem.id}`,
    name,
    category,
    price: price ?? (orderItem.sales_price != null ? Number(orderItem.sales_price) : undefined),
    packageSize: packageSize([name, orderItem.description, orderItem.sku].filter(Boolean).join(' ')),
    description: orderItem.description || [name, orderItem.sku, orderItem.model].filter(Boolean).join(' · '),
    imageUrl: imageUrls[0] || imageFor(name, category),
    imageUrls,
    specSheetUrl: assetUrlFor(orderItem.spec_sheet_key, 'spec'),
    sku: orderItem.sku || undefined,
    manufacturer: orderItem.manufacturer || undefined,
    model: orderItem.model || undefined,
    weightLbs: orderItem.weight_lbs != null ? Number(orderItem.weight_lbs) : undefined,
    source: 'brix-order',
    active: orderItem.active !== false,
  };
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
    const [items, prices, orderItems] = await Promise.all([
      supabaseGet('qbo_items?active=eq.true&select=qbo_item_id,name,fully_qualified_name,sku,type,active&order=name'),
      bookId
        ? supabaseGet(`price_book_items?price_book_id=eq.${bookId}&effective_from=lte.${today}&or=(effective_to.is.null,effective_to.gte.${today})&select=qbo_item_id,item_name,unit_price,effective_from&order=effective_from.desc`)
        : Promise.resolve([]),
      supabaseGetOptional('contract_items?or=(active.is.null,active.eq.true)&select=id,name,category,description,image_key,item_type,manufacturer,model,qbo_item_id,qbo_item_name,sku,sales_price,spec_sheet_key,weight_lbs&order=sort_order,name', 'public'),
    ]);

    const priceByItem = new Map();
    for (const row of prices) {
      if (!priceByItem.has(row.qbo_item_id)) priceByItem.set(row.qbo_item_id, Number(row.unit_price));
    }
    const orderIndex = indexOrderItems(orderItems);

    const products = items.map((row) => {
      const name = row.name || row.qbo_item_id;
      const orderItem = findOrderItem(row, orderIndex);
      const price = priceByItem.get(row.qbo_item_id);
      const category = orderItem ? orderCategory(orderItem, name) : classifyProduct(name);
      const imageUrls = assetUrlsFor(orderItem?.image_key, 'image');
      return {
        id: String(row.qbo_item_id),
        name,
        category,
        price: price ?? (orderItem?.sales_price != null ? Number(orderItem.sales_price) : undefined),
        packageSize: packageSize([name, orderItem?.description, orderItem?.sku, row.sku].filter(Boolean).join(' ')),
        description: descriptionFor(row, price, orderItem),
        imageUrl: imageUrls[0] || imageFor(name, category),
        imageUrls,
        specSheetUrl: assetUrlFor(orderItem?.spec_sheet_key, 'spec'),
        sku: orderItem?.sku || row.sku || undefined,
        manufacturer: orderItem?.manufacturer || undefined,
        model: orderItem?.model || undefined,
        weightLbs: orderItem?.weight_lbs != null ? Number(orderItem.weight_lbs) : undefined,
        source: orderItem ? 'brix-order' : 'qbo',
        active: row.active !== false,
      };
    });

    const seen = new Set(products.map((product) => product.id));
    const seenNames = new Set(products.map((product) => normalizeKey(product.name)));
    for (const orderItem of orderItems) {
      if (!isOrderProductCandidate(orderItem)) continue;
      const product = orderItemToProduct(orderItem, priceByItem);
      const nameKey = normalizeKey(product.name);
      if (seen.has(product.id) || seenNames.has(nameKey)) continue;
      products.push(product);
      seen.add(product.id);
      seenNames.add(nameKey);
    }

    products.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'brix-order' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return json({ products, count: products.length });
  } catch (e) {
    console.error('proposal-products error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
