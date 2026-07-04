// Brand asset library backed by the public Supabase Storage bucket `brand-assets`.
// Replaces the old Brandox scrape (a Meteor DDP single-page app that can't be read
// server-side). Operators upload/manage brand art here from the Proposal Builder,
// and the 4 built-in local logos are merged in as a never-empty fallback.
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

async function listPrefix(prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error(`Storage list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// List the bucket root plus one level of type folders (assets are stored as
// `<type>/<filename>`), returning renderable brand assets.
async function listBrandAssets() {
  const assets = new Map();
  const rootEntries = await listPrefix('');
  const folders = [];
  for (const entry of rootEntries) {
    if (!entry?.name) continue;
    if (entry.id === null || entry.metadata == null) { folders.push(entry.name); continue; }
    addStorageAsset(assets, entry.name, '');
  }
  for (const folder of folders) {
    let entries = [];
    try { entries = await listPrefix(folder); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry?.name || entry.id === null) continue;
      addStorageAsset(assets, `${folder}/${entry.name}`, folder);
    }
  }
  return [...assets.values()];
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
  const url = publicUrl(objectPath);
  return {
    id: assetId(objectPath),
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
      let stored = [];
      let warning;
      try {
        stored = await listBrandAssets();
      } catch (e) {
        warning = e instanceof Error ? e.message : String(e);
        console.warn('brand-assets list failed:', warning);
      }
      return json({ assets: mergeAssets(stored, fallbackAssets(event)), bucket: BUCKET, warning });
    }
    if (method === 'POST') return await handleUpload(event);
    if (method === 'DELETE') return await handleDelete(event);
    return json({ error: 'Method not allowed.' }, 405);
  } catch (e) {
    console.error('proposal-brand-assets error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
