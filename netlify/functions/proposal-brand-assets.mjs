// Brand-asset feed for the Margin Control Proposal Builder. Now sourced from
// Fountain DAM (skypace/DAM-Fountain → the `dam` schema on this Supabase project);
// files still live in the shared `brand-assets` bucket. GET returns the curated,
// tagged DAM library (+ 4 built-in local logos as a never-empty fallback); uploads
// register a dam.assets row and deletes remove it, so both stay in sync.
import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const BUCKET = 'brand-assets';
const READ_ROLES = ['superadmin', 'admin', 'sales'];
const WRITE_ROLES = ['superadmin', 'admin', 'sales'];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ASSET_TYPES = ['logo', 'can', 'equipment', 'hero', 'testimonial', 'sell-sheet', 'other'];
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
};
const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXT));

const LOCAL_BRAND_ASSETS = [
  { name: 'Brix Round Logo', type: 'logo', path: '/sales-next/Brix-Round-Logo.png', tags: ['brix', 'logo', 'local-brand'] },
  { name: 'Alameda Soda Cans', type: 'can', path: '/sales-next/Alameda-Soda-Cans-Die-Cut.png', tags: ['alameda', 'cans', 'local-brand'] },
  { name: 'Alameda Soda Seal Logo', type: 'logo', path: '/sales-next/Alameda-Soda-Seal-Logo-Red-2024.png', tags: ['alameda', 'logo', 'local-brand'] },
  { name: 'Alameda Soda Logo', type: 'logo', path: '/sales-next/ASC-Logo---Red.png', tags: ['alameda', 'logo', 'local-brand'] },
];

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function siteOrigin(event) {
  const host = event.headers?.['x-forwarded-host'] || event.headers?.host || 'alamedapointbg.com';
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function assetId(value) {
  return Buffer.from(String(value)).toString('base64url').slice(0, 24);
}

function prettyName(filename) {
  return decodeURIComponent(String(filename).split('/').pop() || filename)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Brand asset';
}

function classifyAsset(name, folder) {
  if (ASSET_TYPES.includes(folder)) return folder;
  const value = `${name || ''} ${folder || ''}`.toLowerCase();
  if (/\b(logo|mark|seal)\b/.test(value)) return 'logo';
  if (/\b(can|package|packaging|bottle|bib)\b/.test(value)) return 'can';
  if (/\b(equipment|dispenser|fountain|cooler|ice|tower)\b/.test(value)) return 'equipment';
  if (/\b(hero|banner|cover|lifestyle)\b/.test(value)) return 'hero';
  if (/\b(testimonial|quote|review)\b/.test(value)) return 'testimonial';
  if (/\b(sell|sheet|brochure|one-pager|onepager|flyer)\b/.test(value)) return 'sell-sheet';
  return 'other';
}

function publicUrl(path) {
  const clean = String(path).replace(/^\/+/, '');
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

function isImagePath(path) {
  return /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(path);
}

function storageHeaders(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

// The brand library is now owned by Fountain DAM (skypace/DAM-Fountain), whose
// metadata lives in the `dam` schema on this same Supabase project. Read/write
// it here so the Proposal Builder shows the same curated, tagged assets.
function damHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
    'Accept-Profile': 'dam', 'Content-Profile': 'dam',
    Accept: 'application/json', 'Content-Type': 'application/json', ...extra,
  };
}
async function damGet(qs) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${qs}`, { headers: damHeaders() });
  if (!res.ok) throw new Error(`dam read failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function listPrefix(prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error(`Storage list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// The DAM brand + folder registries, so the Proposal Builder can offer "pick a
// brand and a collection" pickers scoped to exactly what the user needs.
async function listDamBrands() {
  try { return await damGet('brands?select=slug,label&order=sort_order.asc,label.asc'); }
  catch { return []; }
}
async function listDamCollections() {
  try { return await damGet('collections?select=id,name,parent_id&order=name.asc'); }
  catch { return []; }
}

// Pull the curated brand library from Fountain DAM (dam.assets), excluding
// archived + trashed assets, optionally scoped to a brand and/or collection,
// mapped to the BrandAsset shape the Proposal Builder expects.
async function listBrandAssets({ brand, collection } = {}) {
  const sel = 'id,storage_path,title,filename,type,brand,status,deleted_at,asset_tags(tag:tags(name))';
  let rows;
  if (collection) {
    const links = await damGet(`collection_assets?collection_id=eq.${encodeURIComponent(collection)}&select=asset:assets(${sel})&order=sort_order.asc`);
    rows = links.map((l) => l.asset).filter(Boolean).filter((r) => r.status !== 'archived' && !r.deleted_at);
    if (brand) rows = rows.filter((r) => r.brand === brand);
  } else {
    const filters = ['status=neq.archived', 'deleted_at=is.null'];
    if (brand) filters.push(`brand=eq.${encodeURIComponent(brand)}`);
    rows = await damGet(`assets?${filters.join('&')}&select=${sel}&order=created_at.desc`);
  }
  return rows.map((r) => {
    const url = publicUrl(r.storage_path);
    const name = r.title || prettyName(r.filename || r.storage_path);
    return {
      id: r.id,
      name,
      type: ASSET_TYPES.includes(r.type) ? r.type : classifyAsset(name, r.type),
      brand: r.brand || 'shared',
      url,
      thumbnailUrl: isImagePath(r.storage_path) ? url : undefined,
      tags: (r.asset_tags || []).map((t) => t.tag?.name).filter(Boolean),
      path: r.storage_path,
      source: 'supabase',
    };
  });
}

function addStorageAsset(map, path, folder) {
  if (path.startsWith('.') || /(^|\/)\.emptyFolderPlaceholder$/.test(path)) return;
  const url = publicUrl(path);
  if (map.has(url)) return;
  const name = prettyName(path);
  map.set(url, {
    id: assetId(path),
    name,
    type: classifyAsset(name, folder),
    url,
    thumbnailUrl: isImagePath(path) ? url : undefined,
    tags: ['brand-library', ...(folder ? [folder] : [])],
    path,
    source: 'supabase',
  });
}

function fallbackAssets(event) {
  const origin = siteOrigin(event);
  return LOCAL_BRAND_ASSETS.map((asset) => {
    const url = `${origin}${asset.path}`;
    return {
      id: assetId(asset.path),
      name: asset.name,
      type: asset.type,
      url,
      thumbnailUrl: url,
      tags: asset.tags,
      source: 'local',
    };
  });
}

function mergeAssets(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const asset of list) {
      if (!asset?.url || map.has(asset.url)) continue;
      map.set(asset.url, asset);
    }
  }
  return [...map.values()];
}

function safeSegment(value, fallback) {
  const clean = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return clean || fallback;
}

function extFromName(name, contentType) {
  const fromName = String(name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (fromName && MIME_BY_EXT[fromName]) return fromName;
  const fromMime = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === contentType)?.[0];
  return fromMime || 'png';
}

async function storeBytes(bytes, filename, contentType, type) {
  const folder = ASSET_TYPES.includes(type) ? type : 'other';
  const ext = extFromName(filename, contentType);
  const mime = contentType && ALLOWED_MIME.has(contentType) ? contentType : MIME_BY_EXT[ext];
  if (!ALLOWED_MIME.has(mime)) throw new Error(`Unsupported file type: ${mime}`);
  const base = safeSegment(String(filename || '').replace(/\.[a-z0-9]+$/i, ''), 'asset');
  const objectPath = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${base}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': mime, 'x-upsert': 'true', 'Cache-Control': '3600' }),
    body: bytes,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  // Register in Fountain DAM so it appears in both the Proposal Builder and the DAM.
  let damId;
  try {
    const reg = await fetch(`${SUPABASE_URL}/rest/v1/assets`, {
      method: 'POST',
      headers: damHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ storage_path: objectPath, filename: filename || objectPath.split('/').pop(), title: prettyName(objectPath), type: folder, brand: 'shared', content_type: mime, bytes: bytes.length }),
    });
    if (reg.ok) { const rows = await reg.json(); damId = rows[0]?.id; }
  } catch (e) { console.warn('dam register failed:', e instanceof Error ? e.message : e); }
  const url = publicUrl(objectPath);
  return {
    id: damId || assetId(objectPath),
    name: prettyName(objectPath),
    type: folder,
    url,
    thumbnailUrl: isImagePath(objectPath) ? url : undefined,
    tags: ['brand-library', folder],
    path: objectPath,
    source: 'supabase',
  };
}

// Server-side import: fetch remote asset URLs and store them in the bucket.
// The migration path off Brandox (or any web source) — no service key needed
// client-side, and it dodges browser CORS since the fetch runs here.
async function handleImport(payload) {
  const urls = Array.isArray(payload.urls) ? payload.urls : [payload.url];
  const cleanUrls = [...new Set(urls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)))];
  if (!cleanUrls.length) return json({ error: 'Provide one or more http(s) asset URLs.' }, 400);
  if (cleanUrls.length > 60) return json({ error: 'Import is limited to 60 URLs at a time.' }, 400);

  const imported = [];
  const errors = [];
  for (const url of cleanUrls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 apbg-brandbox-import' } });
      if (!res.ok) { errors.push({ url, error: `HTTP ${res.status}` }); continue; }
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) { errors.push({ url, error: 'empty response' }); continue; }
      if (bytes.length > MAX_UPLOAD_BYTES) { errors.push({ url, error: 'exceeds 25MB' }); continue; }
      const nameFromUrl = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'asset');
      const asset = await storeBytes(bytes, nameFromUrl, contentType, payload.type);
      imported.push(asset);
    } catch (e) {
      errors.push({ url, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ imported, errors, importedCount: imported.length, errorCount: errors.length }, imported.length ? 201 : 502);
}

async function handleUpload(event) {
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

  if (payload.action === 'delete') return handleDeletePath(payload.path);
  if (payload.action === 'import') return handleImport(payload);

  const { filename, dataBase64, type } = payload;
  if (!dataBase64) return json({ error: 'dataBase64 is required.' }, 400);

  const bytes = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!bytes.length) return json({ error: 'Upload is empty.' }, 400);
  if (bytes.length > MAX_UPLOAD_BYTES) return json({ error: 'File exceeds the 25MB limit.' }, 413);

  try {
    const asset = await storeBytes(bytes, filename, payload.contentType, type);
    return json({ asset }, 201);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, /unsupported file type/i.test(message) ? 415 : 502);
  }
}

async function handleDeletePath(path) {
  if (!path) return json({ error: 'path is required.' }, 400);
  const clean = String(path).replace(/^\/+/, '');
  // Remove the Fountain DAM row (best-effort) then the storage object.
  await fetch(`${SUPABASE_URL}/rest/v1/assets?storage_path=eq.${encodeURIComponent(clean)}`, {
    method: 'DELETE', headers: damHeaders({ Prefer: 'return=minimal' }),
  }).catch(() => {});
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${clean.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'DELETE',
    headers: storageHeaders(),
  });
  if (!res.ok) return json({ error: `Delete failed (${res.status}): ${(await res.text()).slice(0, 200)}` }, 502);
  return json({ ok: true, path: clean });
}

function handleDelete(event) {
  return handleDeletePath(event.queryStringParameters?.path);
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  const method = event.httpMethod;
  const roles = method === 'GET' ? READ_ROLES : WRITE_ROLES;
  const auth = await requireAuth(event, roles);
  if (!auth.ok) return auth.response;

  try {
    if (method === 'GET') {
      const brand = event.queryStringParameters?.brand || undefined;
      const collection = event.queryStringParameters?.collection || undefined;
      let stored = [];
      let warning;
      try {
        stored = await listBrandAssets({ brand, collection });
      } catch (e) {
        warning = e instanceof Error ? e.message : String(e);
        console.warn('brand-assets list failed:', warning);
      }
      const [brands, collections] = await Promise.all([listDamBrands(), listDamCollections()]);
      // The local fallback logos only make sense when browsing everything.
      const assets = (brand || collection) ? stored : mergeAssets(stored, fallbackAssets(event));
      return json({ assets, brands, collections, bucket: BUCKET, warning });
    }
    if (method === 'POST') return await handleUpload(event);
    if (method === 'DELETE') return await handleDelete(event);
    return json({ error: 'Method not allowed.' }, 405);
  } catch (e) {
    console.error('proposal-brand-assets error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
