// SF asset fetch — pull a Service Fusion job's picture/document bytes.
//
// SF exposes picture METADATA via the API (GET /jobs/{id}?expand=pictures) but
// not the bytes. Two storage classes, two fetch strategies:
//   - pictures/signatures live on a public-read S3 prefix
//     (servicefusion.s3.amazonaws.com/images/estimates|sign/) → anonymous GET.
//   - documents/receipts live behind the web-portal session on
//     admin.servicefusion.com → require the SF portal cookie.
// We try the public S3 URL first and fall back to the portal cookie when the
// asset is on a portal host AND a cookie is available. The cookie lives in the
// shared Supabase row `sf_portal_session` (id=1), readable only with the
// service-role key — so the cookie path is a no-op until SUPABASE_SERVICE_ROLE_KEY
// is set on this site; the public-S3 path works without it.

import { sfRequest } from '../sf-helpers.mjs';

const SF_S3_BASE = 'https://servicefusion.s3.amazonaws.com';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ALLOWED_COOKIE_HOSTS = new Set(['admin.servicefusion.com', 'api.servicefusion.com']);

export function resolveSfAssetUrl(kind, fileLocation) {
  if (/^https?:\/\//i.test(fileLocation)) return fileLocation;
  const fname = String(fileLocation).replace(/^\/+/, '');
  const prefix = kind === 'signature' ? 'images/sign' : 'images/estimates';
  return `${SF_S3_BASE}/${prefix}/${fname}`;
}

function inferMime(name = '') {
  const l = name.toLowerCase();
  if (l.endsWith('.png')) return 'image/png';
  if (l.endsWith('.jpg') || l.endsWith('.jpeg')) return 'image/jpeg';
  if (l.endsWith('.gif')) return 'image/gif';
  if (l.endsWith('.webp')) return 'image/webp';
  if (l.endsWith('.heic')) return 'image/heic';
  if (l.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

// Cookie lookup is memoized per cold start. undefined = not looked up yet,
// null = looked up and unavailable, string = the assembled Cookie header.
let _cookieCache;
export async function getPortalCookies() {
  if (_cookieCache !== undefined) return _cookieCache;
  _cookieCache = null;
  if (!SERVICE_KEY) return _cookieCache;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sf_portal_session?id=eq.1&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Accept-Profile': 'orders' },
    });
    if (!res.ok) return _cookieCache;
    const rows = await res.json();
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r) return _cookieCache;
    const parts = [];
    if (r.xsrf_token) parts.push(`XSRF-TOKEN=${r.xsrf_token}`);
    if (r.servicefusion_session) parts.push(`servicefusion_session=${r.servicefusion_session}`);
    if (r.session_token) parts.push(`session_token=${r.session_token}`);
    if (r.phpsessid) parts.push(`PHPSESSID=${r.phpsessid}`);
    if (r.remember_me_company) parts.push(`remember_me_company=${r.remember_me_company}`);
    if (r.remember_me_user) parts.push(`remember_me_user=${r.remember_me_user}`);
    if (r.remember_me_company_id) parts.push(`remember_me_company_id=${r.remember_me_company_id}`);
    _cookieCache = parts.length ? parts.join('; ') : null;
  } catch { /* leave as null */ }
  return _cookieCache;
}

function isBinaryOk(res, ct) {
  return res.ok && !/text\/html|application\/xml/i.test(ct);
}

// Fetch asset bytes. For SF portal hosts (admin/api.servicefusion.com) the
// cookie is required, so try it FIRST; for the public S3 prefix, anonymous.
export async function fetchSfAssetBytes(url) {
  const baseHeaders = { Accept: 'image/*,application/pdf,*/*', 'User-Agent': 'apbg-billing-sync/1.0' };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* malformed */ }
  const isCookieHost = ALLOWED_COOKIE_HOSTS.has(host);
  const cookie = isCookieHost ? await getPortalCookies() : null;

  // Attempt order: cookie first for portal hosts, then anonymous (S3 / fallback).
  const attempts = [];
  if (cookie) attempts.push({ Cookie: cookie });
  attempts.push(null);

  let lastErr = `${url} not fetchable`;
  for (const extra of attempts) {
    try {
      const res = await fetch(url, { headers: { ...baseHeaders, ...(extra || {}) }, redirect: 'follow' });
      const ct = res.headers.get('content-type') || 'application/octet-stream';
      if (isBinaryOk(res, ct)) return { ok: true, bytes: await res.arrayBuffer(), contentType: ct };
      lastErr = `${url} -> ${res.status} ${ct}${extra ? ' (cookie)' : ' (anon)'}`;
    } catch (e) {
      lastErr = `${url} threw ${e.message}`;
    }
  }
  if (isCookieHost && !cookie) lastErr += ' — needs portal cookie (no sf_portal_session loaded)';
  return { ok: false, error: lastErr };
}

// List a SF job's non-private pictures (metadata only).
export async function listJobPictures(sfJobId) {
  const job = await sfRequest('GET', `/jobs/${encodeURIComponent(sfJobId)}?expand=pictures`);
  return (job.pictures || []).filter((p) => !p.is_private && p.file_location);
}

// Resolve one SF picture object to base64 bytes ready for the ResQ mutation.
export async function pictureToBase64(p) {
  const name = (p.name && p.name.trim()) || String(p.file_location).split('/').pop() || 'pic';
  const url = resolveSfAssetUrl('picture', p.file_location);
  const r = await fetchSfAssetBytes(url);
  if (!r.ok) return { ok: false, error: `${name}: ${r.error}` };
  return {
    ok: true,
    name,
    base64: Buffer.from(r.bytes).toString('base64'),
    contentType: r.contentType || inferMime(name),
  };
}
