// Service Fusion API helper
// OAuth2 with shared Supabase token cache + legacy Blob fallback
// Token URL: https://api.servicefusion.com/oauth/access_token
// API Base: https://api.servicefusion.com/v1

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const SF_API = 'https://api.servicefusion.com/v1';
const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token';
const TOKEN_LOCK_SECONDS = 45;
const TOKEN_LOCK_WAIT_MS = 3000;

// In-memory token cache (persists across calls within same function invocation)
// Access token only — see cacheTokens for why the refresh token is not kept here.
let memCache = { accessToken: null, accessExpires: 0 };

let blobStore = null;
let blobsAvailable = null;
let tokenDb = null;

async function getStore() {
  if (blobStore) return blobStore;
  if (blobsAvailable === false) return null;
  try {
    const { getStore } = await import('@netlify/blobs');
    blobStore = getStore({
      name: 'sf-tokens',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    blobsAvailable = true;
    return blobStore;
  } catch (e) {
    blobsAvailable = false;
    return null;
  }
}

function getTokenDb() {
  if (tokenDb) return tokenDb;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  tokenDb = createClient(SUPABASE_URL, key, {
    db: { schema: 'ops' },
    auth: { persistSession: false },
  });
  return tokenDb;
}

async function readDbTokenCache() {
  const sb = getTokenDb();
  if (!sb) return null;
  try {
    const { data } = await sb.from('sf_token_cache').select('*').eq('id', 1).maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

function hasFreshAccessToken(row) {
  return !!(
    row?.access_token
    && row?.access_expires_at
    && new Date(row.access_expires_at).getTime() > Date.now() + 30000
  );
}

function useDbAccessToken(row) {
  memCache.accessToken = row.access_token;
  memCache.accessExpires = new Date(row.access_expires_at).getTime();
  return row.access_token;
}

async function claimDbRefreshLock(owner) {
  const sb = getTokenDb();
  if (!sb) return null;
  try {
    const { data, error } = await sb.rpc('fn_sf_token_claim_refresh', {
      p_owner: owner,
      p_lock_seconds: TOKEN_LOCK_SECONDS,
    });
    if (error) return null;
    return data === true;
  } catch {
    return null;
  }
}

async function releaseDbRefreshLock(owner) {
  const sb = getTokenDb();
  if (!sb) return;
  try { await sb.rpc('fn_sf_token_release_refresh', { p_owner: owner }); } catch {}
}

async function noteDbRefreshError(message) {
  const sb = getTokenDb();
  if (!sb) return;
  try {
    await sb.from('sf_token_cache').update({
      last_refresh_error: String(message || '').slice(0, 500),
      last_refresh_error_at: new Date().toISOString(),
    }).eq('id', 1);
  } catch {}
}

async function writeDbTokenCache(data, expires) {
  const sb = getTokenDb();
  if (!sb || !data?.access_token) return;
  const row = {
    id: 1,
    access_token: data.access_token,
    access_expires_at: new Date(expires).toISOString(),
    updated_at: new Date().toISOString(),
    refresh_locked_until: null,
    refresh_lock_owner: null,
    last_refresh_error: null,
    last_refresh_error_at: null,
    // Cleared too, though the health check no longer reads it: a column that
    // is permanently set is a trap for whoever reads this row next. It sat
    // non-null from an outage in July until 2026-09-07 and kept the board
    // yellow through a perfectly good re-auth.
    last_error: null,
  };
  if (data.refresh_token) row.refresh_token = data.refresh_token;
  try {
    const { error } = await sb.from('sf_token_cache').upsert(row);
    if (!error) return;
    const fallback = { ...row };
    delete fallback.refresh_locked_until;
    delete fallback.refresh_lock_owner;
    delete fallback.last_refresh_error;
    delete fallback.last_refresh_error_at;
    await sb.from('sf_token_cache').upsert(fallback);
  } catch {}
}

async function waitForDbAccessToken() {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, TOKEN_LOCK_WAIT_MS));
    const retry = await readDbTokenCache();
    if (hasFreshAccessToken(retry)) return useDbAccessToken(retry);
  }
  return null;
}

function sfTokenError(status, body) {
  const clean = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const hint = status === 400 ? ' (refresh token rejected or already rotated)' : '';
  return `SF token refresh failed: ${status}${hint}${clean ? ` ${clean}` : ''}`;
}

export async function getSFAccessToken() {
  // 1. Try in-memory cache first (fastest, works without blobs)
  if (memCache.accessToken && memCache.accessExpires > Date.now()) {
    return memCache.accessToken;
  }

  const store = await getStore();
  const dbCached = await readDbTokenCache();
  if (hasFreshAccessToken(dbCached)) return useDbAccessToken(dbCached);

  // 2. Try blob-cached access token as a legacy fallback.
  if (store) {
    try {
      const cached = await store.get('access-token');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.token && parsed.expires > Date.now()) {
          memCache.accessToken = parsed.token;
          memCache.accessExpires = parsed.expires;
          return parsed.token;
        }
      }
    } catch (e) {}
  }

  // 3. The refresh token has exactly ONE home: ops.sf_token_cache, serialised
  //    by the lease claimed below.
  //
  //    ⚠ Service Fusion ROTATES the refresh token on every use — each refresh
  //    spends the previous one. So a second copy is not a backup; it is a
  //    spent credential waiting to be replayed. This function used to keep
  //    four (database, memory, Netlify Blobs, a Netlify env var) and reach
  //    for the older ones when a refresh failed. See the note where that
  //    retry used to be, below.
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  let refreshToken = dbCached?.refresh_token || null;

  // SF_REFRESH_TOKEN is a BOOTSTRAP, not a fallback. It is read only when the
  // database holds no refresh token at all — a fresh environment, or a wiped
  // row — which is precisely the case where there is no live token for a
  // replay to endanger. Nothing writes it back any more, so it ages out by
  // design and re-auth is the cure rather than a silent stale retry.
  if (!refreshToken) {
    refreshToken = process.env.SF_REFRESH_TOKEN || null;
    if (refreshToken) {
      console.warn('[sf] no refresh token in ops.sf_token_cache — bootstrapping from SF_REFRESH_TOKEN. If this fails, re-auth (billing app).');
    }
  }

  if (!refreshToken) {
    throw new Error('No Service Fusion refresh token cached. Re-auth the billing app — apbg-billing CLAUDE.md → Service Fusion OAuth.');
  }

  const owner = `netlify-sf:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const dbLock = await claimDbRefreshLock(owner);
  let blobLockHeld = false;

  if (dbLock === false) {
    const waited = await waitForDbAccessToken();
    if (waited) return waited;
    throw new Error('SF token refresh already running; no fresh access token appeared');
  }

  // Legacy fallback lock for deployments that have not applied the DB lease yet.
  if (dbLock === null && store) {
    try {
      const lockRaw = await store.get('refresh-lock');
      if (lockRaw) {
        const lock = JSON.parse(lockRaw);
        if (lock.ts && Date.now() - lock.ts < 15000) {
          // Another function is refreshing — wait and check for cached token
          await new Promise(r => setTimeout(r, 3000));
          const retryCache = await store.get('access-token');
          if (retryCache) {
            const parsed = JSON.parse(retryCache);
            if (parsed.token && parsed.expires > Date.now()) {
              memCache.accessToken = parsed.token;
              memCache.accessExpires = parsed.expires;
              return parsed.token;
            }
          }
        }
      }
      await store.set('refresh-lock', JSON.stringify({ ts: Date.now() }));
      blobLockHeld = true;
    } catch(e) {}
  }

  try {
    if (dbLock === true) {
      const latest = await readDbTokenCache();
      if (hasFreshAccessToken(latest)) return useDbAccessToken(latest);
      refreshToken = latest?.refresh_token || refreshToken;
    }

    // 4. Refresh
    const res = await fetch(SF_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId || '',
        client_secret: clientSecret || '',
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      const message = sfTokenError(res.status, err);
      await noteDbRefreshError(message);
      // ⚠ DO NOT retry here with a copy from Blobs or the env var.
      //
      // That is what this did until 2026-09-07, under the comment "let Netlify
      // heal it from Blob/env", and it could never have worked: the database
      // copy is the freshest by construction, so every other copy is one
      // Service Fusion has already rotated away. At best the retry fails; at
      // worst presenting a spent refresh token reads as a replayed credential
      // and costs the whole token family.
      //
      // It is a trip-wire, not a safety net: everything is fine until one
      // refresh fails for any reason — and SF rate-limits hard, so blips are
      // routine — and then the "recovery" turns a transient failure into a
      // dead credential only a human re-auth can fix. That is the shape of the
      // record: 14 dead days from 2026-07-09, six clean weeks, then 46 hours
      // from 2026-09-05, with nothing in between.
      //
      // Fail honestly instead. noteDbRefreshError above stamps
      // last_refresh_error_at, the board goes red within 15 minutes, and the
      // alert says to re-auth.
      throw new Error(message);
    }

    const data = await res.json();
    await cacheTokens(store, data);
    return data.access_token;
  } finally {
    if (dbLock === true) await releaseDbRefreshLock(owner);
    if (blobLockHeld && store) { try { await store.delete('refresh-lock'); } catch(e) {} }
  }
}

async function cacheTokens(store, data) {
  const expires = Date.now() + 50 * 60 * 1000;

  // Always cache in memory (works even without blobs)
  if (data.access_token) {
    memCache.accessToken = data.access_token;
    memCache.accessExpires = expires;
  }
  // ⚠ The refresh token is deliberately NOT cached in memory, in Blobs or in a
  // Netlify env var. It is single-use; the database row written below is its
  // only home. See the note in getSFAccessToken.
  await writeDbTokenCache(data, expires);

  // Cache access token in blob (50 min, SF tokens last ~1hr)
  if (store && data.access_token) {
    try {
      await store.set('access-token', JSON.stringify({
        token: data.access_token,
        expires,
      }));
    } catch (e) {}
  }

}

// updateSFEnvVar was removed on 2026-09-07. It rewrote SF_REFRESH_TOKEN on
// every refresh with a DELETE followed by a POST — not atomic, so a failed
// POST loses the variable outright — and its only purpose was to maintain a
// second copy of a single-use credential. Nothing should recreate it.

export async function sfRequest(method, endpoint, body = null) {
  const accessToken = await getSFAccessToken();
  const url = `${SF_API}${endpoint}`;

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };

  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (!res.ok) {
    const rawErr = await res.text();
    // Truncate HTML error pages — SF returns full HTML on 404s
    const err = rawErr.length > 300 ? rawErr.substring(0, 200) + '... [truncated]' : rawErr;
    throw new Error(`SF API error: ${res.status} ${err}`);
  }

  // Handle empty responses (204, or 200 with no body)
  const text = await res.text();
  if (!text || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`SF API returned invalid JSON (${res.status}): ${text.substring(0, 200)}`);
  }
}

export async function createSFCustomer({ customerName, firstName, lastName, phone, email, address, city, state, zip }) {
  // SF changed POST /customers (2026 — same wave as the /items removal): the
  // old flat contact { phone, email } and location { street/state/zip } keys
  // now 422 with "invalid field's name". Current spec (verified live from
  // brix-order 2026-07-09):
  //   contacts[]: fname + lname REQUIRED; phones: [{phone, type}] with a
  //   strict ^\d{3}-\d{3}-\d{4}$ phone regex; emails: [{email, class}].
  //   locations[]: street_1 REQUIRED + city / state_prov / postal_code.
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const sfPhone = digits.length === 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : null;
  const fname = (firstName || '').trim() || (lastName || '').trim();
  const lname = (lastName || '').trim() || fname;

  const payload = {
    customer_name: customerName,
    ...(fname && lname ? {
      contacts: [{
        fname,
        lname,
        is_primary: true,
        ...(sfPhone ? { phones: [{ phone: sfPhone, type: 'Work' }] } : {}),
        ...(email ? { emails: [{ email, class: 'Business' }] } : {}),
      }],
    } : {}),
    ...(address ? {
      locations: [{
        street_1: address,
        city: city || '',
        state_prov: state || '',
        postal_code: zip || '',
        is_primary: true,
      }],
    } : {}),
  };

  return sfRequest('POST', '/customers', payload);
}
