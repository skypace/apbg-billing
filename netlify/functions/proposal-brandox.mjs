import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';

const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];
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

function classifyAsset(name, url) {
  const value = `${name || ''} ${url || ''}`.toLowerCase();
  if (/\b(logo|mark|seal)\b/.test(value)) return 'logo';
  if (/\b(can|package|packaging)\b/.test(value)) return 'can';
  if (/\b(equipment|dispenser|fountain|cooler|ice)\b/.test(value)) return 'equipment';
  if (/\b(hero|banner|cover)\b/.test(value)) return 'hero';
  if (/\b(testimonial|quote)\b/.test(value)) return 'testimonial';
  if (/\b(sell|sheet|pdf|brochure|one-pager)\b/.test(value)) return 'sell-sheet';
  return 'other';
}

function assetName(url) {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(tail).replace(/[-_]+/g, ' ');
  } catch {
    return String(url).split('/').pop() || 'Brand asset';
  }
}

function assetId(url) {
  return Buffer.from(String(url)).toString('base64url').slice(0, 24);
}

function normalizeUrl(url, base) {
  try { return new URL(url, base).toString(); } catch { return null; }
}

function addAsset(map, rawUrl, base) {
  const url = normalizeUrl(rawUrl, base);
  if (!url || map.has(url)) return;
  const name = assetName(url);
  if (/brandox[-_\s]?og/i.test(name) && /brandox\.com\/img\//i.test(url)) return;
  const type = classifyAsset(name, url);
  map.set(url, {
    id: assetId(url),
    name,
    type,
    url,
    thumbnailUrl: /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(url) ? url : undefined,
    tags: ['brandox'],
  });
}

function siteOrigin(event) {
  const host = event.headers?.['x-forwarded-host'] || event.headers?.host || 'alamedapointbg.com';
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function fallbackAssets(event) {
  const origin = siteOrigin(event);
  return LOCAL_BRAND_ASSETS.map((asset) => {
    const url = `${origin}${asset.path}`;
    return {
      id: assetId(url),
      name: asset.name,
      type: asset.type,
      url,
      thumbnailUrl: url,
      tags: asset.tags,
    };
  });
}

function configuredAssets(base) {
  const raw = process.env.BRANDOX_ASSET_URLS || process.env.BRANDOX_ASSET_URL || '';
  if (!raw.trim()) return [];
  const assets = new Map();
  raw
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => addAsset(assets, item, base));
  return [...assets.values()].map((asset) => ({ ...asset, tags: [...new Set([...(asset.tags || []), 'configured-brandox'])] }));
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

function extractAssetsFromHtml(html, base) {
  const assets = new Map();
  const attrRe = /\b(?:src|href)=["']([^"']+\.(?:png|jpe?g|webp|gif|avif|svg|pdf)(?:\?[^"']*)?)["']/gi;
  for (const match of html.matchAll(attrRe)) addAsset(assets, match[1], base);
  const urlRe = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif|avif|svg|pdf)(?:\?[^\s"'<>]+)?/gi;
  for (const match of html.matchAll(urlRe)) addAsset(assets, match[0], base);
  return [...assets.values()];
}

function extractAssetsFromJson(value, base, assets = new Map()) {
  if (!value) return assets;
  if (Array.isArray(value)) {
    value.forEach((item) => extractAssetsFromJson(item, base, assets));
    return assets;
  }
  if (typeof value === 'object') {
    const record = value;
    const possibleUrl = record.url || record.downloadUrl || record.thumbnailUrl || record.src || record.href;
    if (typeof possibleUrl === 'string') addAsset(assets, possibleUrl, base);
    Object.values(record).forEach((item) => extractAssetsFromJson(item, base, assets));
  }
  return assets;
}

async function loginCookie(origin) {
  const email = process.env.BRANDOX_EMAIL;
  const password = process.env.BRANDOX_PASSWORD;
  if (!email || !password) return '';
  try {
    const res = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }).toString(),
      redirect: 'manual',
    });
    const cookie = res.headers.get('set-cookie') || '';
    return cookie.split(',').map((part) => part.split(';')[0]).join('; ');
  } catch (e) {
    console.warn('Brandox login attempt failed:', e instanceof Error ? e.message : e);
    return '';
  }
}

function candidateUrls(workspaceUrl) {
  const base = new URL(workspaceUrl);
  const candidates = new Set([base.toString()]);
  for (const path of ['/assets', '/files', '/media', '/api/assets', '/api/files', '/api/v1/assets']) {
    candidates.add(new URL(path, base.origin).toString());
  }
  return [...candidates];
}

async function fetchBrandoxAssets(workspaceUrl, cookie) {
  const assets = new Map();
  let lastError = null;
  for (const url of candidateUrls(workspaceUrl)) {
    try {
      const res = await fetch(url, {
        headers: cookie ? { Cookie: cookie, Accept: 'text/html, application/json' } : { Accept: 'text/html, application/json' },
      });
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      if (!res.ok) {
        lastError = `Brandox returned ${res.status} for ${new URL(url).pathname}`;
        continue;
      }
      if (contentType.includes('application/json')) {
        const parsed = JSON.parse(text);
        for (const asset of extractAssetsFromJson(parsed, url).values()) assets.set(asset.url, asset);
      } else {
        for (const asset of extractAssetsFromHtml(text, url)) assets.set(asset.url, asset);
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { assets: [...assets.values()], error: lastError };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'GET') return json({ error: 'GET only' }, 405);

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  const workspaceUrl = process.env.BRANDOX_WORKSPACE_URL;
  const localAssets = fallbackAssets(event);
  if (!workspaceUrl) return json({ assets: mergeAssets(configuredAssets(siteOrigin(event)), localAssets), configured: false });

  try {
    const base = new URL(workspaceUrl);
    const cookie = await loginCookie(base.origin);
    const brandox = await fetchBrandoxAssets(workspaceUrl, cookie);
    const assets = mergeAssets(brandox.assets, configuredAssets(workspaceUrl), localAssets);
    return json({
      assets,
      configured: true,
      warning: brandox.assets.length ? undefined : (brandox.error || 'Brandox returned no usable assets; showing local brand assets.'),
    });
  } catch (e) {
    console.error('proposal-brandox error:', e);
    return json({
      assets: mergeAssets(configuredAssets(siteOrigin(event)), localAssets),
      configured: true,
      warning: e instanceof Error ? e.message : String(e),
    });
  }
}
