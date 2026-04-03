// Service Fusion API helper
// OAuth2 Authorization Code Grant
// Token URL: https://api.servicefusion.com/oauth/access_token
// API Base: https://api.servicefusion.com/v1

const SF_API = 'https://api.servicefusion.com/v1';
const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token';

export async function getSFAccessToken() {
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  const refreshToken = process.env.SF_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error('SF_REFRESH_TOKEN not set. Go to /setup.html and connect Service Fusion.');
  }

  const res = await fetch(SF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${refreshToken}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SF token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();

  // Save new refresh token if rotated
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await updateSFToken(data.refresh_token);
  }

  return data.access_token;
}

async function updateSFToken(newToken) {
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
    console.warn('SF token save failed:', e.message);
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
