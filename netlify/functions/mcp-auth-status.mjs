// mcp-auth-status.mjs — live status of the MCP resource servers for the
// Master Control panel.
//
// The MCP servers were converted to OAuth 2.1 with Supabase Auth as the
// authorization server (the 2026-08 connector-auth repair): each server
// publishes RFC 9728 protected-resource metadata at
// /.well-known/oauth-protected-resource pointing at the shared project's
// /auth/v1 issuer, and enforces a per-server MCP_ALLOWED_EMAILS allowlist.
//
// GET (superadmin) → one row per server: is the discovery metadata being
// served, does it point at OUR authorization server, and does the endpoint
// itself respond. Probed server-side because the well-known endpoints don't
// send CORS headers — the browser can't check them directly.

import { requireAuth } from './lib/auth.mjs';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ⚠ The CORS preflight MUST be answered BEFORE requireAuth, and with a 2xx.
// This page is served from alamedapointbg.com and calls apbg-billing.netlify.app
// with an Authorization header — cross-origin + a non-simple header means the
// browser sends an OPTIONS preflight first, and browsers do NOT put the
// Authorization header on a preflight. So requireAuth saw no bearer, returned
// 401, the preflight failed, and the real GET was never sent: the page could
// only ever report the browser's generic "Failed to fetch", which names neither
// CORS nor auth. CORS headers on the 401 do not help — a preflight has to
// SUCCEED, not merely be labelled.
const PREFLIGHT = { statusCode: 204, headers: { ...HEADERS, 'Access-Control-Max-Age': '86400' }, body: '' };

const EXPECTED_ISSUER = 'https://gfsdpwiqzshhexkofiif.supabase.co/auth/v1';

const SERVERS = [
  {
    key: 'pacerfinance',
    name: 'PACER Finance MCP — QuickBooks · Zoho · Service Fusion',
    base: 'https://pacerfinance.netlify.app',
    endpoint: 'https://pacerfinance.netlify.app/qbo (+ /zoho, /servicefusion)',
    probe: 'https://pacerfinance.netlify.app/qbo',
  },
  {
    key: 'outlook',
    name: 'Pacer Outlook MCP — email search & attachments',
    base: 'https://pacer-outlook.netlify.app',
    endpoint: 'https://pacer-outlook.netlify.app/outlook/mcp',
    probe: 'https://pacer-outlook.netlify.app/outlook/mcp',
  },
  {
    key: 'asm',
    name: 'ASM MCP Tools — GitHub · ASM Specialist · HyperLEDA',
    base: 'https://asm-mcp-tools.netlify.app',
    endpoint: 'https://asm-mcp-tools.netlify.app/github (+ /asm-specialist, /hyperleda)',
    probe: 'https://asm-mcp-tools.netlify.app/github',
  },
  {
    key: 'retell',
    name: 'Retell MCP — voice-agent bridge (brix-order)',
    base: 'https://orders.brixbev.com',
    endpoint: 'https://orders.brixbev.com/.netlify/functions/mcp-retell',
    probe: null, // POST-only MCP endpoint; the well-known is the health signal
  },
];

async function timedFetch(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'apbg-master-control' } });
  } finally {
    clearTimeout(t);
  }
}

async function checkServer(s) {
  const row = { ...s, well_known: 'error', auth_server_ok: false, probe_note: null, status: 'red' };

  try {
    const res = await timedFetch(`${s.base}/.well-known/oauth-protected-resource`);
    if (res.ok) {
      const meta = await res.json().catch(() => null);
      const servers = meta?.authorization_servers || [];
      row.well_known = 'ok';
      row.auth_server_ok = servers.includes(EXPECTED_ISSUER);
      if (!row.auth_server_ok) row.probe_note = `unexpected authorization server: ${servers.join(', ') || 'none'}`;
    } else {
      row.well_known = `HTTP ${res.status}`;
    }
  } catch (e) {
    row.well_known = `unreachable (${e.name === 'AbortError' ? 'timeout' : e.message})`;
  }

  if (s.probe) {
    try {
      const res = await timedFetch(s.probe);
      const body = await res.text().catch(() => '');
      if (res.status === 401 && /oauth|bearer/i.test(body)) {
        row.probe_note = 'endpoint up — rejecting unauthenticated calls (OAuth enforced)';
      } else if (res.ok && /"status"\s*:\s*"ok"/.test(body)) {
        row.probe_note = 'endpoint up (health OK)';
      } else {
        row.probe_note = `endpoint responded HTTP ${res.status}`;
      }
    } catch (e) {
      row.probe_note = `endpoint unreachable (${e.name === 'AbortError' ? 'timeout' : e.message})`;
    }
  }

  row.status =
    row.well_known === 'ok' && row.auth_server_ok ? 'green'
    : /^unreachable/.test(row.well_known) && !row.probe_note?.includes('endpoint up') ? 'red'
    : 'amber';
  return row;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return PREFLIGHT;
  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'GET only' }) };
  }

  const servers = await Promise.all(SERVERS.map(checkServer));
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      ok: true,
      checked_at: new Date().toISOString(),
      authorization_server: EXPECTED_ISSUER,
      consent_page: 'https://alamedapointbg.com/oauth/consent',
      servers,
    }),
  };
}
