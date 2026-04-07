// Master Health API — serves GET /api/master-health for control.html dashboard
// Returns cached results or runs live cross-site health checks

import { runMasterHealthChecks } from './lib/master-health-core.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Blob helpers ──
let _store = null;
async function getBlobStore() {
  if (_store) return _store;
  try {
    const { getStore } = await import('@netlify/blobs');
    _store = getStore({
      name: 'master-health',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    return _store;
  } catch (e) {
    console.error('[master-health] Blob store error:', e.message);
    return null;
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Try cached result first (unless ?refresh=1)
  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get('refresh') === '1';

  if (!forceRefresh) {
    try {
      const store = await getBlobStore();
      if (store) {
        const cached = await store.get('last-result');
        if (cached) {
          return new Response(cached, { headers: CORS });
        }
      }
    } catch (e) { /* fall through to live */ }
  }

  // No cache or forced refresh — run live checks
  const payload = await runMasterHealthChecks();
  return new Response(JSON.stringify(payload, null, 2), { headers: CORS });
}

export const config = {
  path: '/api/master-health',
};
