// resq-sync-control — control plane for the ResQ↔SF sync engine that lives in
// skypace/apbg-resq-sync (Supabase edge functions). Backs the Master Control →
// ResQ Sync panel in public/control.html.
//
//   GET                              -> status snapshot (ops.resq_sync_status)
//   POST { action:"set_write",  enabled:bool }  -> observe <-> write
//   POST { action:"set_active", enabled:bool }  -> enable/disable the crons
//   POST { action:"run_tick" }                  -> trigger one full discovery tick
//   POST { action:"drive", codes:["R1046442"] } -> drive specific WO(s) only
//
// Superadmin-gated (requireAuth). Toggles go through SECURITY DEFINER RPCs
// (ops.resq_sync_set_write / _set_active / _status) called with the service-role
// key — those RPCs are granted to service_role only. Tick triggers POST the
// ungated sync-tick edge function.

import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

async function rpc(name, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'ops',
      'Accept-Profile': 'ops',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function sbGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Accept-Profile': 'ops' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sbGet ${pathAndQuery} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

// SF connection health for RESQ's OWN Connected App (ops.resq_sf_token_cache).
// Returns only booleans + non-secret metadata — never the token values.
async function sfStatus() {
  const rows = await sbGet('resq_sf_token_cache?select=access_token,access_expires_at,refresh_token,refresh_count,last_refreshed_by,last_error,updated_at&id=eq.1');
  const r = rows[0] || {};
  const expMs = r.access_expires_at ? Date.parse(r.access_expires_at) : 0;
  return {
    connected: !!r.refresh_token,               // a refresh token means we're authorized
    access_valid: expMs > Date.now(),
    access_expires_at: r.access_expires_at || null,
    has_access: !!r.access_token,
    refresh_count: r.refresh_count ?? 0,
    last_refreshed_by: r.last_refreshed_by || null,
    last_error: r.last_error || null,
    updated_at: r.updated_at || null,
  };
}

// Build the one-click connect/reconnect URL for RESQ's Connected App. The
// inbound_secret gates sf-connect's ?start; only returned to an authed
// superadmin.
async function sfConnectUrl() {
  const rows = await sbGet('resq_sync_config?select=value&key=eq.inbound_secret');
  const secret = rows[0]?.value || '';
  if (!secret) throw new Error('inbound_secret not set');
  return `${SUPABASE_URL}/functions/v1/sf-connect?start=1&secret=${encodeURIComponent(secret)}`;
}

async function callTick(body) {
  // sync-tick is the ungated cron entrypoint; it self-gates the mutating step
  // (sync-wo) with the injected service key. We pass the bearer anyway.
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-tick`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sync-tick ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  // Every action (incl. status read) is superadmin-only.
  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);

  try {
    if (event.httpMethod === 'GET') {
      const [status, sf] = await Promise.all([
        rpc('resq_sync_status'),
        sfStatus().catch((e) => ({ error: e.message })),
      ]);
      return json({ ok: true, status, sf });
    }
    if (event.httpMethod !== 'POST') return json({ error: 'GET or POST only' }, 405);

    const body = JSON.parse(event.body || '{}');
    const action = body.action;

    if (action === 'set_write') {
      const enabled = body.enabled === true;
      await rpc('resq_sync_set_write', { p_enabled: enabled });
      return json({ ok: true, write_enabled: enabled, status: await rpc('resq_sync_status') });
    }
    if (action === 'set_active') {
      const enabled = body.enabled === true;
      await rpc('resq_sync_set_active', { p_enabled: enabled });
      return json({ ok: true, crons_active: enabled, status: await rpc('resq_sync_status') });
    }
    if (action === 'run_tick') {
      const result = await callTick({ source: `control:${auth.user?.email || 'superadmin'}` });
      return json({ ok: true, tick: result, status: await rpc('resq_sync_status') });
    }
    if (action === 'drive') {
      const codes = Array.isArray(body.codes)
        ? body.codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
        : [];
      if (!codes.length) return json({ error: 'codes[] required' }, 400);
      const result = await callTick({ source: `control:${auth.user?.email || 'superadmin'}`, codes });
      return json({ ok: true, tick: result, status: await rpc('resq_sync_status') });
    }
    if (action === 'sf_connect_url') {
      return json({ ok: true, url: await sfConnectUrl() });
    }
    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('resq-sync-control error:', e);
    return json({ error: e.message }, 500);
  }
}
