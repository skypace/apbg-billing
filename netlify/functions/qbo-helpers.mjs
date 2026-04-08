// Shared QBO token management
// Refreshes access token using stored refresh token, makes API calls
// Uses Netlify Blobs for instant token storage (no redeploy needed)
// with env vars as fallback

import { getStore } from "@netlify/blobs";

const QBO_BASE = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export async function getAccessToken() {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const store = getStore("qbo-tokens");

  // 1. Return cached access token if still valid
  try {
    const cached = await store.get("access-token");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.token && parsed.expires > Date.now()) return parsed.token;
    }
  } catch(e) {}

  // 2. Simple lock — if another function is already refreshing, wait for it
  try {
    const lockRaw = await store.get("refresh-lock");
    if (lockRaw) {
      const lock = JSON.parse(lockRaw);
      if (lock.ts && Date.now() - lock.ts < 15000) {
        await new Promise(r => setTimeout(r, 3000));
        const retryCache = await store.get("access-token");
        if (retryCache) {
          const parsed = JSON.parse(retryCache);
          if (parsed.token && parsed.expires > Date.now()) return parsed.token;
        }
      }
    }
  } catch(e) {}

  // 3. Acquire lock
  try { await store.set("refresh-lock", JSON.stringify({ ts: Date.now() })); } catch(e) {}

  // 4. Get refresh token — blob first, then env var fallback
  let refreshToken;
  try {
    const blobRT = await store.get("refresh-token");
    if (blobRT) refreshToken = blobRT;
  } catch(e) {}
  if (!refreshToken) refreshToken = process.env.QBO_REFRESH_TOKEN;

  if (!refreshToken) {
    try { await store.delete("refresh-lock"); } catch(e) {}
    throw new Error('No QBO refresh token available — reconnect required');
  }

  // 5. Exchange refresh token for new access + refresh tokens
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
  });

  if (!res.ok) {
    try { await store.delete("refresh-lock"); } catch(e) {}
    const err = await res.text();
    if (err.includes('invalid_grant')) {
      try { await store.delete("refresh-token"); } catch(e) {}
    }
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();

  // 6. Cache access token in blobs (50 min)
  try {
    await store.set("access-token", JSON.stringify({
      token: data.access_token,
      expires: Date.now() + 50 * 60 * 1000,
    }));
  } catch(e) {}

  // 7. Store new refresh token in blobs (instant, no redeploy!)
  if (data.refresh_token) {
    try {
      await store.set("refresh-token", data.refresh_token);
      await store.set("refresh-token-updated", new Date().toISOString());
    } catch(e) {}
  }

  // 8. Also update env var as backup
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    try {
      await updateNetlifyEnvVar('QBO_REFRESH_TOKEN', data.refresh_token);
    } catch (e) {
      console.error('Failed to update refresh token env var:', e.message);
    }
  }

  // 9. Release lock
  try { await store.delete("refresh-lock"); } catch(e) {}

  return data.access_token;
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
