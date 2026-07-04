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
let memCache = { accessToken: null, accessExpires: 0, refreshToken: null };

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
  if (row.refresh_token) memCache.refreshToken = row.refresh_token;
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

  // 3. Get the freshest refresh token: shared DB > memory > blob > env var.
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  let refreshToken = dbCached?.refresh_token || memCache.refreshToken || null;
  let blobRefreshToken = null;

  // Try blob (survives across invocations)
  if (store) {
    try {
      const blobRT = await store.get('refresh-token');
      if (blobRT) {
        blobRefreshToken = blobRT;
        if (!refreshToken) refreshToken = blobRT;
      }
    } catch (e) {}
  }

  // Fall back to env var
  if (!refreshToken) {
    refreshToken = process.env.SF_REFRESH_TOKEN;
  }

  if (!refreshToken) {
    throw new Error('SF_REFRESH_TOKEN not set. Go to /setup.html and connect Service Fusion.');
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
      // If the shared DB token was stale, let Netlify heal it from Blob/env.
      const fallbacks = [blobRefreshToken, process.env.SF_REFRESH_TOKEN]
        .filter((token, index, arr) => token && token !== refreshToken && arr.indexOf(token) === index);
      for (const fallbackToken of fallbacks) {
        const retry = await fetch(SF_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId || '',
            client_secret: clientSecret || '',
            refresh_token: fallbackToken,
          }),
        });
        if (retry.ok) {
          const data2 = await retry.json();
          await cacheTokens(store, data2);
          return data2.access_token;
        }
        const retryMessage = sfTokenError(retry.status, await retry.text());
        await noteDbRefreshError(retryMessage);
      }
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
  if (data.refresh_token) {
    memCache.refreshToken = data.refresh_token;
  }

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

  // Cache new refresh token in blob (immediate availability)
  if (store && data.refresh_token) {
    try {
      await store.set('refresh-token', data.refresh_token);
    } catch (e) {}
  }

  // Also persist to Netlify env var (survives deploys)
  if (data.refresh_token) {
    await updateSFEnvVar(data.refresh_token);
  }
}

async function updateSFEnvVar(newToken) {
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!token || !siteId) return;

  try {
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = `https://api.netlify.com/api/v1/sites/${siteId}/env`;
    await fetch(`${base}/SF_REFRESH_TOKEN`, { method: 'DELETE', headers });
    await fetch(base, {
      method: 'POST', headers,
      body: JSON.stringify([{
        key: 'SF_REFRESH_TOKEN',
        scopes: ['builds', 'functions', 'runtime', 'post_processing'],
        values: [{ value: newToken, context: 'all' }],
      }]),
    });
  } catch (e) {
    console.warn('SF token env save failed:', e.message);
  }
}

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
  const payload = {
    customer_name: customerName,
    contacts: [{
      fname: firstName || '',
      lname: lastName || '',
      phone: phone || '',
      email: email || '',
    }],
    locations: [{
      street: address || '',
      city: city || '',
      state: state || '',
      zip: zip || '',
    }],
  };

  return sfRequest('POST', '/customers', payload);
}
