// Shared QBO token management
// Refreshes access token using stored refresh token, makes API calls

const QBO_BASE = 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export async function getAccessToken() {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const refreshToken = process.env.QBO_REFRESH_TOKEN;

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
    const err = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();

  // Update refresh token in Netlify env vars if it changed
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    try {
      await updateNetlifyEnvVar('QBO_REFRESH_TOKEN', data.refresh_token);
    } catch (e) {
      console.error('Failed to update refresh token:', e.message);
    }
  }

  return data.access_token;
}

async function updateNetlifyEnvVar(key, value) {
  const token = process.env.NETLIFY_ACCESS_TOKEN || process.env.MCP_API_KEY;
  if (!token) return;

  // Update on BOTH sites so the MCP and billing app stay in sync
  const sites = [
    process.env.NETLIFY_SITE_ID,                // apbg-billing
    'f0fa961e-94bb-4f68-88e5-84ec4751b399',     // pacerfinance (MCP server)
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
