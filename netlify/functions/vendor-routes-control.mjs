// vendor-routes-control — control plane for the vendor email → SF ticket
// automation (Red Bull / Freshpet). Backs the Master Control → Vendor Job
// Intake panel in public/control.html.
//
//   GET                                   -> route list + 7-day ticket counts
//   POST { id, active:bool }              -> switch a route on/off
//
// Superadmin-gated (requireAuth). While a route is OFF the intake still
// RECORDS inbound emails (status 'ignored') but creates nothing and emails
// nobody, and the status poller skips its tickets.

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

function sbHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    ...extra,
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' }, 500);

  if (event.httpMethod === 'GET') {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vendor_email_routes?select=id,inbox,display_name,vendor_key,active,sf_customer_name,sf_job_category,require_confirmation,send_list,vendor_notify_list,updated_at&order=display_name.asc`,
      { headers: sbHeaders() },
    );
    if (!res.ok) return json({ error: `routes read failed: ${res.status}` }, 502);
    const routes = await res.json();

    // Light activity snapshot per route (last 7 days)
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const tRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vendor_email_tickets?select=route_id,status&created_at=gte.${since}`,
      { headers: sbHeaders() },
    );
    const tickets = tRes.ok ? await tRes.json() : [];
    const counts = {};
    for (const t of tickets) {
      if (!t.route_id) continue;
      counts[t.route_id] = counts[t.route_id] || { total: 0, sf_created: 0, awaiting: 0, ignored: 0 };
      counts[t.route_id].total++;
      if (t.status === 'sf_created') counts[t.route_id].sf_created++;
      if (t.status === 'awaiting_confirmation') counts[t.route_id].awaiting++;
      if (t.status === 'ignored') counts[t.route_id].ignored++;
    }
    return json({ routes, counts });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    const { id, active } = body;
    if (!id || typeof active !== 'boolean') return json({ error: 'need { id, active:boolean }' }, 400);

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vendor_email_routes?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: sbHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({ active, updated_at: new Date().toISOString() }),
      },
    );
    if (!res.ok) return json({ error: `route update failed: ${res.status}` }, 502);
    const rows = await res.json();
    if (!rows.length) return json({ error: 'route not found' }, 404);
    console.log(`[vendor-routes-control] ${auth.user?.email || 'superadmin'} set ${rows[0].inbox} active=${active}`);
    return json({ ok: true, route: rows[0] });
  }

  return json({ error: 'method not allowed' }, 405);
}
