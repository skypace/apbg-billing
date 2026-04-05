// Service Fusion API helper
// OAuth2 with blob-cached access token + refresh token rotation
// Token URL: https://api.servicefusion.com/oauth/access_token
// API Base: https://api.servicefusion.com/v1

const SF_API = 'https://api.servicefusion.com/v1';
const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token';

// In-memory token cache (persists across calls within same function invocation)
let memCache = { accessToken: null, accessExpires: 0, refreshToken: null };

let blobStore = null;
let blobsAvailable = null;

async function getStore() {
  if (blobStore) return blobStore;
  if (blobsAvailable === false) return null;
  try {
    const { getStore } = await import('@netlify/blobs');
    blobStore = getStore('sf-tokens');
    blobsAvailable = true;
    return blobStore;
  } catch (e) {
    blobsAvailable = false;
    return null;
  }
}

export async function getSFAccessToken() {
  // 1. Try in-memory cache first (fastest, works without blobs)
  if (memCache.accessToken && memCache.accessExpires > Date.now()) {
    return memCache.accessToken;
  }

  const store = await getStore();

  // 2. Try blob-cached access token
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

  // 3. Get the freshest refresh token: memory > blob > env var
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  let refreshToken = memCache.refreshToken || null;

  // Try blob (survives across invocations)
  if (!refreshToken && store) {
    try {
      const blobRT = await store.get('refresh-token');
      if (blobRT) refreshToken = blobRT;
    } catch (e) {}
  }

  // Fall back to env var
  if (!refreshToken) {
    refreshToken = process.env.SF_REFRESH_TOKEN;
  }

  if (!refreshToken) {
    throw new Error('SF_REFRESH_TOKEN not set. Go to /setup.html and connect Service Fusion.');
  }

  // 3. Refresh
  const res = await fetch(SF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${refreshToken}`,
  });

  if (!res.ok) {
    const err = await res.text();
    // If refresh failed and we used a blob token, try env var as last resort
    if (refreshToken !== process.env.SF_REFRESH_TOKEN && process.env.SF_REFRESH_TOKEN) {
      const res2 = await fetch(SF_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${process.env.SF_REFRESH_TOKEN}`,
      });
      if (!res2.ok) {
        throw new Error(`SF token refresh failed: ${res.status} ${err}`);
      }
      const data2 = await res2.json();
      await cacheTokens(store, data2);
      return data2.access_token;
    }
    throw new Error(`SF token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  await cacheTokens(store, data);
  return data.access_token;
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
    const err = await res.text();
    throw new Error(`SF API error: ${res.status} ${err}`);
  }

  return res.json();
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
