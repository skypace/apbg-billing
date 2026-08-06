// Proxy health check for the PACER Finance MCP server (pacerfinance).
//
// Rewritten 2026-08-06 for the OAuth 2.1 conversion: the /qbo and /zoho MCP
// endpoints no longer accept the old x-api-key — every call requires an
// OAuth bearer token issued by Supabase Auth. "Healthy" now means:
//   1. the RFC 9728 discovery metadata is served and points at OUR
//      authorization server, and
//   2. the endpoint is up and REJECTING unauthenticated calls with the
//      OAuth challenge (a 401 with oauth/bearer language is the correct,
//      healthy behavior — a 200 for an anonymous caller would be the bug).
//
// Response vocabulary is unchanged ({qbo, zoho, overall: healthy|degraded|
// down}) — the gateway hub's status dots and the Master Control health grid
// both parse this shape. Called server-side because none of these endpoints
// send CORS headers.

import { requireAuth } from './lib/auth.mjs';

const PACER_BASE = 'https://pacerfinance.netlify.app';
const EXPECTED_ISSUER = 'https://gfsdpwiqzshhexkofiif.supabase.co/auth/v1';

async function timedFetch(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function checkDiscovery() {
  try {
    const res = await timedFetch(`${PACER_BASE}/.well-known/oauth-protected-resource`);
    if (!res.ok) return { ok: false, message: `discovery HTTP ${res.status}` };
    const meta = await res.json().catch(() => null);
    const ok = (meta?.authorization_servers || []).includes(EXPECTED_ISSUER);
    return ok
      ? { ok: true, message: 'OAuth discovery served (Supabase AS)' }
      : { ok: false, message: 'discovery served but wrong authorization server' };
  } catch (e) {
    return { ok: false, message: `discovery unreachable (${e.name === 'AbortError' ? 'timeout' : e.message})` };
  }
}

async function checkEndpoint(path) {
  try {
    const res = await timedFetch(`${PACER_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    const body = await res.text().catch(() => '');
    if (res.status === 401 && /oauth|bearer/i.test(body)) {
      return { ok: true, message: 'up — OAuth enforced (401 challenge)' };
    }
    if (res.ok) {
      // A 200 to an anonymous caller means auth is NOT being enforced.
      return { ok: false, message: 'responding WITHOUT auth — OAuth enforcement missing' };
    }
    if (res.status === 404 || res.status >= 502) {
      return { ok: false, message: `endpoint down (HTTP ${res.status})` };
    }
    return { ok: false, message: `unexpected HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;

  const [discovery, qbo, zoho] = await Promise.all([
    checkDiscovery(),
    checkEndpoint('/qbo'),
    checkEndpoint('/zoho'),
  ]);

  // Fold discovery into each check's health: an endpoint is only fully
  // healthy when the OAuth front door is also intact.
  const results = {
    discovery,
    qbo: { ok: qbo.ok && discovery.ok, message: discovery.ok ? qbo.message : `${qbo.message}; ${discovery.message}` },
    zoho: { ok: zoho.ok && discovery.ok, message: discovery.ok ? zoho.message : `${zoho.message}; ${discovery.message}` },
    checkedAt: new Date().toISOString(),
  };

  const allOk = results.qbo.ok && results.zoho.ok;
  const anyOk = results.qbo.ok || results.zoho.ok;
  results.overall = allOk ? 'healthy' : anyOk ? 'degraded' : 'down';

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(results),
  };
}
