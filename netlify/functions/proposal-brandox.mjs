import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';

const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];

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

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'GET') return json({ error: 'GET only' }, 405);

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  const workspaceUrl = process.env.BRANDOX_WORKSPACE_URL;
  if (!workspaceUrl) return json({ assets: [], configured: false });

  try {
    const base = new URL(workspaceUrl);
    const cookie = await loginCookie(base.origin);
    const res = await fetch(workspaceUrl, {
      headers: cookie ? { Cookie: cookie, Accept: 'text/html, application/json' } : { Accept: 'text/html, application/json' },
    });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!res.ok) throw new Error(`Brandox returned ${res.status}: ${text.slice(0, 160)}`);

    if (contentType.includes('application/json')) {
      const parsed = JSON.parse(text);
      return json({ assets: [...extractAssetsFromJson(parsed, workspaceUrl).values()], configured: true });
    }
    return json({ assets: extractAssetsFromHtml(text, workspaceUrl), configured: true });
  } catch (e) {
    console.error('proposal-brandox error:', e);
    return json({ assets: [], configured: true, error: e instanceof Error ? e.message : String(e) }, 502);
  }
}
