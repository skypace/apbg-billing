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

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|svg)(\?|#|$)/i;
const DOC_EXT_RE = /\.(pdf|ai|eps|psd|zip|indd|mp4|mov|webm)(\?|#|$)/i;
// DAM/CDN asset URLs are often extension-less signed links. Treat a URL as a
// renderable image when its host/path carries asset-ish hints and it is not
// clearly a document/archive/video.
const IMAGEISH_HINT_RE = /(image|images|img|thumb|thumbnail|preview|photo|asset|assets|media|file|files|render|resize|cdn|storage|upload|uploads)/i;

// Skip obvious non-asset URLs (tracking pixels, sprites, icons, analytics).
function isNoiseUrl(url, name) {
  const value = `${name || ''} ${url || ''}`.toLowerCase();
  if (/brandox[-_\s]?og/i.test(name || '') && /brandox\.com\/img\//i.test(url)) return true;
  if (/(sprite|favicon|apple-touch|\bicon\b|logo-brandox|placeholder|spacer|pixel\.gif|1x1|analytics|gtag|gtm|facebook|linkedin|twitter)/i.test(value)) return true;
  return false;
}

function looksLikeImage(url) {
  if (IMAGE_EXT_RE.test(url)) return true;
  if (DOC_EXT_RE.test(url)) return false;
  return IMAGEISH_HINT_RE.test(url);
}

function addAsset(map, rawUrl, base) {
  const url = normalizeUrl(rawUrl, base);
  if (!url || map.has(url)) return;
  if (!/^https?:\/\//i.test(url)) return;
  const name = assetName(url);
  if (isNoiseUrl(url, name)) return;
  const isDoc = DOC_EXT_RE.test(url);
  const isImage = looksLikeImage(url);
  // Keep images (renderable) and documents (sell sheets / brochures); drop the rest.
  if (!isImage && !isDoc) return;
  const type = classifyAsset(name, url);
  map.set(url, {
    id: assetId(url),
    name,
    type,
    url,
    thumbnailUrl: isImage ? url : undefined,
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
  // src / href / data-* lazy-load attributes / poster / og:image content.
  const attrRe = /\b(?:src|href|poster|content|data-(?:src|original|lazy|lazy-src|image|thumb|thumbnail|full|download|url|bg))=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrRe)) addAsset(assets, match[1], base);
  // srcset: take each candidate URL (strip the descriptor).
  const srcsetRe = /\bsrcset=["']([^"']+)["']/gi;
  for (const match of html.matchAll(srcsetRe)) {
    for (const candidate of match[1].split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) addAsset(assets, url, base);
    }
  }
  // CSS background-image: url(...).
  const bgRe = /background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  for (const match of html.matchAll(bgRe)) addAsset(assets, match[1], base);
  // Bare absolute URLs with an image/pdf extension anywhere in the markup.
  const urlRe = /https?:\/\/[^\s"'<>()]+\.(?:png|jpe?g|webp|gif|avif|svg|pdf)(?:\?[^\s"'<>()]+)?/gi;
  for (const match of html.matchAll(urlRe)) addAsset(assets, match[0], base);
  // Embedded JSON payloads (SPA hydration data) carry the real asset library.
  for (const parsed of extractEmbeddedJson(html)) {
    for (const asset of extractAssetsFromJson(parsed, base).values()) {
      if (!assets.has(asset.url)) assets.set(asset.url, asset);
    }
  }
  return [...assets.values()];
}

// Pull JSON out of hydration script tags so SPA-rendered portals still yield assets.
function extractEmbeddedJson(html) {
  const payloads = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const raw = match[1].trim();
    if (!raw || raw.length > 4_000_000) continue;
    // Direct JSON body (application/json, application/ld+json, __NEXT_DATA__).
    if (/^[[{]/.test(raw)) {
      try { payloads.push(JSON.parse(raw)); continue; } catch { /* fall through */ }
    }
    // `window.__X__ = {...};` / `self.__next_f.push([...])` style assignments.
    const assignMatch = raw.match(/=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/);
    if (assignMatch) {
      try { payloads.push(JSON.parse(assignMatch[1])); } catch { /* ignore */ }
    }
  }
  return payloads;
}

const JSON_URL_KEYS = [
  'url', 'downloadurl', 'download_url', 'download', 'thumbnailurl', 'thumbnail_url',
  'thumburl', 'thumb_url', 'thumb', 'thumbnail', 'src', 'href', 'preview', 'previewurl',
  'preview_url', 'original', 'originalurl', 'original_url', 'file', 'fileurl', 'file_url',
  'image', 'imageurl', 'image_url', 'path', 'publicurl', 'public_url', 'cdnurl', 'cdn_url',
  'asset', 'asseturl', 'asset_url', 'large', 'medium', 'small', 'full', 'fullurl', 'full_url',
];

function extractAssetsFromJson(value, base, assets = new Map()) {
  if (!value) return assets;
  if (Array.isArray(value)) {
    value.forEach((item) => extractAssetsFromJson(item, base, assets));
    return assets;
  }
  if (typeof value === 'object') {
    const record = value;
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === 'string') {
        // A known asset-bearing key, or any absolute image/pdf URL string.
        if (JSON_URL_KEYS.includes(key.toLowerCase()) || /^https?:\/\//i.test(item)) {
          addAsset(assets, item, base);
        }
      } else {
        extractAssetsFromJson(item, base, assets);
      }
    }
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
  // A JSON representation of the same page (many DAM portals content-negotiate).
  const jsonVariant = new URL(base.toString());
  jsonVariant.searchParams.set('format', 'json');
  candidates.add(jsonVariant.toString());
  // Preserve any workspace/portal slug in the base path when probing sub-resources.
  const basePath = base.pathname.replace(/\/+$/, '');
  for (const path of [
    '/assets', '/files', '/media', '/downloads',
    '/api/assets', '/api/files', '/api/media', '/api/v1/assets',
    '/api/portal', '/api/public/assets', '/api/portal/assets',
  ]) {
    candidates.add(new URL(path, base.origin).toString());
    if (basePath) candidates.add(new URL(`${basePath}${path}`, base.origin).toString());
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
