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

import { sfRequest, getSFAccessToken } from '../sf-helpers.mjs';

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

// Fetch asset bytes, host-aware — mirrors brix-order's get-sf-job-asset:
//   api.servicefusion.com   → Bearer first, then Cookie
//   admin.servicefusion.com → Cookie first, then Bearer
//   public S3 prefix        → anonymous
export async function fetchSfAssetBytes(url) {
  const baseHeaders = { Accept: 'image/*,application/pdf,*/*', 'User-Agent': 'apbg-billing-sync/1.0' };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* malformed */ }
  const isApi = host === 'api.servicefusion.com';
  const isAdmin = host === 'admin.servicefusion.com';

  const attempts = [];
  if (isApi || isAdmin) {
    let bearer = null;
    try { bearer = await getSFAccessToken(); } catch { /* token optional */ }
    const cookie = await getPortalCookies();
    const bearerHdr = bearer ? { Authorization: `Bearer ${bearer}` } : null;
    const cookieHdr = cookie ? { Cookie: cookie } : null;
    if (isApi) { if (bearerHdr) attempts.push(bearerHdr); if (cookieHdr) attempts.push(cookieHdr); }
    else { if (cookieHdr) attempts.push(cookieHdr); if (bearerHdr) attempts.push(bearerHdr); }
  }
  attempts.push(null); // anonymous (public S3 / last resort)

  let lastErr = `${url} not fetchable`;
  for (const extra of attempts) {
    try {
      const res = await fetch(url, { headers: { ...baseHeaders, ...(extra || {}) }, redirect: 'follow' });
      const ct = res.headers.get('content-type') || 'application/octet-stream';
      if (isBinaryOk(res, ct)) return { ok: true, bytes: await res.arrayBuffer(), contentType: ct };
      const mode = extra?.Authorization ? 'bearer' : extra?.Cookie ? 'cookie' : 'anon';
      lastErr = `${url} -> ${res.status} ${ct} (${mode})`;
    } catch (e) {
      lastErr = `${url} threw ${e.message}`;
    }
  }
  if ((isApi || isAdmin) && !(await getPortalCookies())) lastErr += ' — portal cookie unavailable (sf_portal_session)';
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

const RELAY_BUCKET = 'resq-photo-relay';

function extFor(contentType, name) {
  const m = (contentType || '').split('/')[1] || (name || '').split('.').pop() || 'jpg';
  return m.toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg';
}

// Upload bytes to the PUBLIC relay bucket and return a public URL with a short
// filename. ResQ stores the image reference in a varchar(100) column, so it
// needs a short fetchable URL — not an inline base64 data URL.
export async function uploadToRelay(path, bytes, contentType) {
  if (!SERVICE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${RELAY_BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: Buffer.from(bytes),
  });
  if (!res.ok) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${RELAY_BUCKET}/${encodeURI(path)}`;
}

// Fetch a SF picture and relay it to the public bucket; returns a short public URL.
export async function pictureToPublicUrl(p, sfJobId, index) {
  const name = (p.name && p.name.trim()) || String(p.file_location).split('/').pop() || `pic${index}`;
  const srcUrl = resolveSfAssetUrl('picture', p.file_location);
  const r = await fetchSfAssetBytes(srcUrl);
  if (!r.ok) return { ok: false, error: `${name}: ${r.error}` };
  const ext = extFor(r.contentType, name);
  // ResQ stores the image reference in a varchar(100) column, and the public
  // URL prefix (host + /storage/v1/object/public/<bucket>/) already eats ~83 of
  // those chars — so the path must stay tiny. The old
  // `${sfJobId}/${Date.now()}-${i}.${ext}` ran ~113 chars and ResQ rejected the
  // push with "value too long for character varying(100)". A 6-char token + ext
  // keeps the whole URL under 100. The relay bucket is transient, so the path
  // doesn't need the job id — the WO↔job link lives in resq_sf_links.
  const token = Math.random().toString(36).slice(2, 8); // 6 chars
  const path = `${token}.${ext}`;
  const publicUrl = await uploadToRelay(path, r.bytes, r.contentType || inferMime(name));
  if (!publicUrl) return { ok: false, error: `${name}: relay upload failed (SUPABASE_SERVICE_ROLE_KEY set?)` };
  return { ok: true, url: publicUrl };
}
