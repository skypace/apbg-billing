import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';

const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];

const RESOURCES = {
  catalog: { method: 'GET', path: '/api/catalog?limit=500' },
  'pricing/calculate': { method: 'POST', path: '/api/pricing/calculate' },
  quotes: { method: 'POST', path: '/api/quotes' },
  'quotes/service-plans': { method: 'GET', path: '/api/quotes/service-plans' },
  'quotes/end-of-lease-options': { method: 'GET', path: '/api/quotes/end-of-lease-options' },
};

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  const baseUrl = cleanBaseUrl(process.env.BRIX_LEASING_API_URL);
  if (!baseUrl) return json({ error: 'BRIX_LEASING_API_URL is not configured' }, 503);

  const resource = String(event.queryStringParameters?.resource || '').replace(/^\/?api\//, '');
  const route = RESOURCES[resource];
  if (!route) return json({ error: `Unknown leasing resource: ${resource}` }, 400);
  if (event.httpMethod !== route.method) return json({ error: `${route.method} only for ${resource}` }, 405);

  const token = process.env.BRIX_LEASING_API_TOKEN || '';
  const inboundAuth = event.headers?.authorization || event.headers?.Authorization || '';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (inboundAuth) {
    headers.Authorization = inboundAuth;
  } else if (token && token.split('.').length === 3) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (token) {
    headers['X-API-Key'] = token;
  }

  try {
    const res = await fetch(`${baseUrl}${route.path}`, {
      method: route.method,
      headers,
      body: route.method === 'POST' ? event.body || '{}' : undefined,
    });
    const body = await res.text();
    return {
      statusCode: res.status,
      headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
      body,
    };
  } catch (e) {
    console.error('proposal-leasing error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}
