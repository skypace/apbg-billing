// site-settings — read/write generic site flags (ops.site_settings).
//
//   GET  ?key=maintenance   -> { key, value }            (PUBLIC: the banner must
//                                                          load for everyone, incl.
//                                                          logged-out visitors)
//   POST { key, value }      -> upsert                    (superadmin only)
//
// First use: the maintenance flag/banner.

import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = `${SUPABASE_URL}/rest/v1/site_settings`;

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  // ── GET: public read (no auth) so the banner shows for any visitor ──
  if (event.httpMethod === 'GET') {
    const key = (event.queryStringParameters || {}).key || 'maintenance';
    try {
      const res = await fetch(`${TABLE}?key=eq.${encodeURIComponent(key)}&select=key,value,updated_at`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Accept-Profile': 'ops' },
      });
      if (!res.ok) throw new Error(`read ${res.status}`);
      const rows = await res.json();
      return json(rows[0] || { key, value: {} });
    } catch (e) {
      // Fail safe: never let a settings read error take a page down. Treat as "off".
      return json({ key, value: {}, error: e.message.slice(0, 150) });
    }
  }

  // ── POST: superadmin write ──
  if (event.httpMethod !== 'POST') return json({ error: 'GET or POST only' }, 405);

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);

  try {
    const body = JSON.parse(event.body || '{}');
    if (!body.key) return json({ error: 'key required' }, 400);
    const row = {
      key: body.key,
      value: body.value || {},
      updated_by: auth.user?.email || auth.role || 'superadmin',
    };
    const res = await fetch(`${TABLE}?on_conflict=key`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Accept-Profile': 'ops',
        'Content-Profile': 'ops',
        Prefer: 'return=representation,resolution=merge-duplicates',
      },
      body: JSON.stringify([row]),
    });
    if (!res.ok) throw new Error(`write ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = await res.json();
    return json({ ok: true, setting: Array.isArray(out) ? out[0] : out });
  } catch (e) {
    console.error('site-settings error:', e);
    return json({ error: e.message }, 500);
  }
}
