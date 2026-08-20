// Shared QBO token management
// Refreshes access token using stored refresh token, makes API calls
// Uses Netlify Blobs for instant token storage (no redeploy needed)
// with env vars as fallback

import { getStore } from "@netlify/blobs";

const QBO_BASE = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function getBlobStore() {
  return getStore({
    name: "qbo-tokens",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
    // Blobs default to EVENTUAL consistency — a read moments after a write
    // returns the previous value. Intuit rotates the refresh token (~24h), so
    // a stale read here hands Intuit a rotated-out token → invalid_grant →
    // dead chain (2026-08-19). Strong reads are mandatory for this store.
    consistency: "strong",
  });
}

// ── Break-glass: shared lease-managed edge token (ops.qbo_token_cache) ──
// Read-only — the edge lease machinery is the sole refresher, so this can
// never cause a rotation race. Used ONLY when this site's own chain fails.
async function readSharedOpsToken() {
  try {
    const sbUrl = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) return null;
    const r = await fetch(
      `${sbUrl}/rest/v1/qbo_token_cache?realm_id=eq.${process.env.QBO_REALM_ID}&select=access_token,access_token_expires_at&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ops' } },
    );
    if (!r.ok) return null;
    const row = (await r.json())[0];
    if (row?.access_token && new Date(row.access_token_expires_at).getTime() > Date.now() + 60000) {
      return row.access_token;
    }
  } catch (e) { /* no shared token available */ }
  return null;
}

// Signal a chain problem into ops.sync_log (throttled to one row per 6h via
// blob stamp) — the qbo_netlify_chain health check turns RED off this row and
// the 15-min alerter emails: "re-auth the billing app at setup.html /
// Connections". Callers pass the full human-readable message.
async function noteChainSignal(store, message) {
  try {
    const last = await store.get("shared-fallback-noted");
    if (last && Date.now() - Number(last) < 6 * 3600 * 1000) return;
    await store.set("shared-fallback-noted", String(Date.now()));
  } catch (e) { /* still try to log */ }
  try {
    const sbUrl = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) return;
    await fetch(`${sbUrl}/rest/v1/sync_log`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Profile': 'ops', 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        source: 'qbo', sync_type: 'netlify_token_fallback', status: 'error',
        records_synced: 0, completed_at: new Date().toISOString(),
        error_message: String(message).slice(0, 380),
      }),
    });
  } catch (e) { /* best-effort */ }
}

const LOCK_TTL_MS = 15000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readCachedAccessToken(store) {
  try {
    const cached = await store.get("access-token");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.token && parsed.expires > Date.now()) return parsed.token;
    }
  } catch(e) {}
  return null;
}

// Wait for another function's in-flight refresh to land its access token.
async function waitForAccessToken(store, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const token = await readCachedAccessToken(store);
    if (token) return token;
  }
  return null;
}

// Best-effort mutex over blobs. Blobs have no compare-and-swap, so: write our
// id, wait a beat, read back — last writer wins, everyone else backs off.
// consistency:"strong" on the store is what makes the read-back meaningful.
async function acquireRefreshLock(store, lockId) {
  try {
    const raw = await store.get("refresh-lock");
    if (raw) {
      const lock = JSON.parse(raw);
      if (lock.ts && Date.now() - lock.ts < LOCK_TTL_MS) return false;
    }
    await store.set("refresh-lock", JSON.stringify({ ts: Date.now(), id: lockId }));
    await sleep(150 + Math.floor(Math.random() * 250));
    const back = await store.get("refresh-lock");
    const lock = JSON.parse(back || "{}");
    return lock.id === lockId;
  } catch(e) {
    return true; // blobs unreachable — proceed, same as the pre-lock era
  }
}

async function releaseRefreshLock(store, lockId) {
  try {
    const raw = await store.get("refresh-lock");
    if (raw) {
      const lock = JSON.parse(raw);
      if (lock.id && lock.id !== lockId) return; // another function owns it now
    }
    await store.delete("refresh-lock");
  } catch(e) {}
}

export async function getAccessToken() {
  const store = getBlobStore();

  // 1. Return cached access token if still valid
  const cached = await readCachedAccessToken(store);
  if (cached) return cached;

  // NOTE (2026-07-24): the shared ops.qbo_token_cache token is BREAK-GLASS
  // ONLY (see readSharedOpsToken below) — own chain refreshes FIRST, per the
  // multi-app architecture (separate Intuit apps, separate refresh tokens, no
  // rotation races). An earlier revision consulted the shared token here,
  // before the own refresh; that inverted the architecture and let this app's
  // refresh token idle toward Intuit's 100-day expiry.

  // 2. Serialize the refresh. Intuit ROTATES the refresh token (~24h), so two
  // concurrent refreshes — or one racing a just-persisted rotation — leaves a
  // one-generation-stale token in play, which is exactly the invalid_grant
  // that killed the chain on 2026-08-19. Losers wait for the winner's token.
  const lockId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await acquireRefreshLock(store, lockId);
  if (!acquired) {
    const waited = await waitForAccessToken(store, 12000);
    if (waited) return waited;
    // Lock holder died or is slow — refresh ourselves; the invalid_grant
    // retry below tolerates a collision if it is in fact still running.
  }

  try {
    return await refreshAccessToken(store);
  } finally {
    await releaseRefreshLock(store, lockId);
  }
}

async function refreshAccessToken(store) {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;

  // Refresh token — blob first, then env var fallback
  let refreshToken;
  try {
    const blobRT = await store.get("refresh-token");
    if (blobRT) refreshToken = blobRT;
  } catch(e) {}
  if (!refreshToken) refreshToken = process.env.QBO_REFRESH_TOKEN;

  if (!refreshToken) {
    // Break-glass: no refresh token at all (blob purged after a prior
    // invalid_grant) — ride the shared edge token + signal red. See below.
    const shared = await readSharedOpsToken();
    if (shared) {
      await noteChainSignal(store, 'Netlify QBO chain broken (riding shared edge token): No QBO refresh token available — reconnect required');
      return shared;
    }
    throw new Error('No QBO refresh token available — reconnect required');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  // Up to 2 attempts: an invalid_grant on attempt 1 may only mean another
  // function rotated the token while we held a stale copy — re-read the blob
  // (strong consistency) and retry with the newer token before declaring the
  // chain dead. Only a token that fails while ALSO being the freshest stored
  // one is genuinely dead.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
    });

    if (res.ok) {
      const data = await res.json();
      await persistRefreshedTokens(store, data, refreshToken);
      return data.access_token;
    }

    const err = await res.text();

    if (err.includes('invalid_grant') && attempt === 1) {
      try {
        const latest = await store.get("refresh-token");
        if (latest && latest !== refreshToken) {
          refreshToken = latest;
          continue;
        }
      } catch(e) {}
    }

    // Genuinely dead token: purge it so the next caller goes straight to
    // break-glass instead of hammering Intuit with a known-bad grant.
    if (err.includes('invalid_grant')) {
      try { await store.delete("refresh-token"); } catch(e) {}
    }

    // BREAK-GLASS (2026-07-24): own chain is broken — ride the shared
    // lease-managed edge token (ops.qbo_token_cache, same realm; a valid
    // access token is a bearer credential regardless of which Intuit app
    // minted it) so nothing goes down, and write a throttled sync_log signal
    // that flips the qbo_netlify_chain health check RED. Own chain stays
    // PRIMARY (per the multi-app architecture: separate apps, separate
    // refresh tokens, no rotation races) — this fallback exists so a rotted
    // chain pages a human in 15 minutes instead of silently killing expense
    // posting for six weeks like it did June 10 → July 24.
    const shared = await readSharedOpsToken();
    if (shared) {
      await noteChainSignal(store, `Netlify QBO chain broken (riding shared edge token): Token refresh failed: ${res.status} ${err.slice(0, 200)}`);
      return shared;
    }
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }
  throw new Error('QBO token refresh: unreachable'); // loop always returns/throws
}

async function persistRefreshedTokens(store, data, previousRefreshToken) {
  // Refresh token FIRST — losing a rotated refresh token kills the chain on
  // the NEXT refresh, so this write retries and, if it still fails, flips
  // qbo_netlify_chain RED now instead of failing silently and dying tomorrow.
  if (data.refresh_token) {
    let persisted = false;
    for (let i = 0; i < 3 && !persisted; i++) {
      try {
        await store.set("refresh-token", data.refresh_token);
        await store.set("refresh-token-updated", new Date().toISOString());
        persisted = true;
      } catch(e) {
        console.error(`refresh-token persist attempt ${i + 1} failed:`, e.message);
        await sleep(400);
      }
    }
    if (!persisted && data.refresh_token !== previousRefreshToken) {
      await noteChainSignal(store, 'Netlify QBO chain AT RISK: rotated refresh token could not be persisted to blobs — the chain will break on its next refresh. Re-auth via Master Control → Connections.');
    }
  }

  // Cache access token in blobs (50 min)
  try {
    await store.set("access-token", JSON.stringify({
      token: data.access_token,
      expires: Date.now() + 50 * 60 * 1000,
    }));
  } catch(e) {
    console.error('access-token cache write failed:', e.message);
  }

  // Also update env var as backup
  if (data.refresh_token && data.refresh_token !== previousRefreshToken) {
    try {
      await updateNetlifyEnvVar('QBO_REFRESH_TOKEN', data.refresh_token);
    } catch (e) {
      console.error('Failed to update refresh token env var:', e.message);
    }
  }
}

async function updateNetlifyEnvVar(key, value) {
  const token = process.env.NETLIFY_ACCESS_TOKEN || process.env.MCP_API_KEY;
  if (!token) return;

  // Only update this site — each site (apbg-billing, pacerfinance, melt-dashboard)
  // has its own independent QBO connection and realm
  const sites = [
    process.env.NETLIFY_SITE_ID,
  ].filter(Boolean);

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  for (const siteId of sites) {
    try {
      const base = `https://api.netlify.com/api/v1/sites/${siteId}/env`;
      await fetch(`${base}/${key}`, { method: 'DELETE', headers });
      const res = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify([{
          key,
          scopes: ['builds', 'functions', 'runtime', 'post_processing'],
          values: [{ value, context: 'all' }],
        }]),
      });
      if (!res.ok) console.warn(`Env var ${key} update on ${siteId} returned ${res.status}`);
    } catch (e) {
      console.warn(`Failed to update ${key} on ${siteId}:`, e.message);
    }
  }
}

export async function qboRequest(method, endpoint, body = null) {
  const accessToken = await getAccessToken();
  const realmId = process.env.QBO_REALM_ID;
  const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`QBO API error: ${res.status} ${err}`);
  }

  return res.json();
}

export async function qboQuery(query) {
  const encoded = encodeURIComponent(query);
  return qboRequest('GET', `/query?query=${encoded}`);
}

// CORS headers helper
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}
