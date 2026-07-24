// connections.mjs — the Master Control "Connections & Reconnect" panel data:
// every Service Fusion + QuickBooks connection with its NAME, CLIENT ID, its
// OWN health light, and the exact reconnect link for that app. Exists because
// reconnecting the wrong app (or not knowing which app a token belongs to)
// caused multi-hour scavenger hunts — see CLAUDE.md → Service Fusion OAuth.
//
// Health comes live from ops.sync_health() (same source the 15-min alerter
// reads). Rows without a DB-visible token store are marked unmonitored.
// Superadmin only.

import { requireAuth } from './lib/auth.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const SUPA_FN = 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1';

function srHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ops', 'Content-Profile': 'ops', ...extra };
}

function sfAuthorizeUrl(clientId, redirect) {
  return `https://api.servicefusion.com/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}`;
}
function qboAuthorizeUrl(clientId, redirect) {
  return `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=com.intuit.quickbooks.accounting&state=qbo-${Date.now()}`;
}

export default async (req) => {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  try {
    // live health map from the same function the alerter reads
    const healthRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_health`, {
      method: 'POST', headers: srHeaders({ 'Content-Type': 'application/json' }), body: '{}',
    });
    const health = {};
    if (healthRes.ok) for (const r of await healthRes.json()) health[r.check_name] = { status: r.status, detail: r.detail };

    // ResQ SF client id lives in ops.resq_sync_config (may rotate — read live)
    let resqClientId = '';
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/resq_sync_config?key=eq.sf_app_client_id&select=value`, { headers: srHeaders() });
      if (r.ok) resqClientId = ((await r.json())[0] || {}).value || '';
    } catch { /* row shows without a link */ }

    const qboBillingClient = process.env.QBO_CLIENT_ID || '';
    const qboBillingRedirect = process.env.QBO_REDIRECT_URI || 'https://apbg-billing.netlify.app/.netlify/functions/oauth-callback';

    const groups = [
      {
        label: 'Service Fusion',
        rows: [
          {
            key: 'sf_billing', name: 'Billing / Brixpense (expense landing, SF reads)',
            client_id: 'TNpu3bVz9XAIgey_7e', token_store: 'ops.sf_token_cache',
            health: health.sf_token || null,
            reconnect_url: sfAuthorizeUrl('TNpu3bVz9XAIgey_7e', `${SUPA_FN}/sf-oauth-callback`),
            note: 'Sign into Service Fusion in this browser first, then click Reconnect.',
          },
          {
            key: 'sf_resq', name: 'ResQ Sync (dedicated app — its own rotating token)',
            client_id: resqClientId || '(ops.resq_sync_config)', token_store: 'ops.resq_sf_token_cache',
            health: health.resq_sf_token || null,
            reconnect_url: resqClientId ? sfAuthorizeUrl(resqClientId, `${SUPA_FN}/sf-connect`) : null,
            note: 'Separate Connected App so its token can never race the billing one.',
          },
          {
            key: 'sf_pacer', name: 'PACER MCP (voice agent / HQ tools)',
            client_id: '(managed in pacerfinance)', token_store: 'pacerfinance site',
            health: null, // not visible from this DB
            reconnect_url: null, manage_url: '/pacer/connect.html',
            note: 'Unmonitored from here — token lives in the pacerfinance site. Reconnect via Manage MCP Connections.',
          },
        ],
      },
      {
        label: 'QuickBooks',
        rows: [
          {
            key: 'qbo_billing', name: 'Billing AP tool + Brixpense posting (Netlify)',
            client_id: qboBillingClient, token_store: 'Netlify Blobs (own chain) → shared fallback',
            health: health.qbo_netlify_chain || null,
            reconnect_url: qboAuthorizeUrl(qboBillingClient, qboBillingRedirect),
            note: '⚠ pacerfinance QBO was pointed at this SAME Intuit app on 7/15 — re-authorizing either one invalidates the other\'s refresh token. Give pacerfinance its own Intuit app to stop the whack-a-mole.',
          },
          {
            key: 'qbo_shared', name: 'Shared edge token (QBO mirror, order payments, writebacks)',
            client_id: '(Supabase edge env)', token_store: 'ops.qbo_token_cache (lease-guarded)',
            health: health.qbo_token || null,
            reconnect_url: null,
            note: 'Auto-refreshes hourly via the lease; no self-serve reconnect (grant seeded outside this repo). If it ever goes red, this is a re-seed job, not a button.',
          },
          {
            key: 'qbo_melt', name: 'Melt Dashboard',
            client_id: 'ABcbkH2VkVLsWzXS2UuOdAg9DmXG6UecHk938uNEqe3ir5v6N1', token_store: 'melt-dashboard site',
            health: null,
            reconnect_url: qboAuthorizeUrl('ABcbkH2VkVLsWzXS2UuOdAg9DmXG6UecHk938uNEqe3ir5v6N1', 'https://melt-dashboard.netlify.app/.netlify/functions/oauth-callback'),
            note: 'Unmonitored from here — token lives in the melt-dashboard site.',
          },
        ],
      },
    ];

    return new Response(JSON.stringify({ ok: true, groups }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
