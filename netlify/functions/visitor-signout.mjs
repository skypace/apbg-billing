// visitor-signout.mjs — the other half of the front-door kiosk.
//
// Public by design: a visitor taps "Sign out" on the kiosk or scans the QR on
// their badge, gives their badge number, and the visit closes. Nothing is
// returned but a confirmation, and only a badge that is currently signed in can
// be closed, so the worst a stranger can do with the endpoint is guess badge
// numbers to sign someone out — which staff can undo from the visitor log.
//
// The on-site list this maintains is what an evacuation head-count runs on, so
// closing a visit matters more than it looks.
//
// Env: SUPABASE_SERVICE_ROLE_KEY.

import { SUPABASE_URL } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});

async function ops(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!SERVICE_KEY) return json(500, { error: 'Kiosk is not configured — SUPABASE_SERVICE_ROLE_KEY is missing on this site.' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Expected JSON.' }); }

  const badge = String(body.badge_number || '').trim().toUpperCase();
  const id = String(body.id || '').trim();
  if (!badge && !id) return json(400, { error: 'Enter the badge number from your pass.' });

  const filter = id
    ? `id=eq.${encodeURIComponent(id)}`
    : `badge_number=eq.${encodeURIComponent(badge)}`;

  let open;
  try {
    open = await ops('GET', `visitor_visits?select=id,badge_number,full_name,signed_in_at,signed_out_at&${filter}&limit=1`);
  } catch (e) {
    return json(500, { error: 'Could not look that badge up: ' + e.message });
  }
  const visit = open && open[0];
  if (!visit) return json(404, { error: 'No visit found for that badge. Check the number on your pass, or ask at the office.' });
  if (visit.signed_out_at) {
    return json(200, { ok: true, already: true, full_name: visit.full_name, badge_number: visit.badge_number,
      signed_out_at: visit.signed_out_at });
  }

  try {
    const done = await ops('PATCH', `visitor_visits?id=eq.${visit.id}&signed_out_at=is.null`, {
      signed_out_at: new Date().toISOString(),
      signed_out_by: 'kiosk',
    });
    const out = (done && done[0]) || visit;
    return json(200, { ok: true, full_name: out.full_name, badge_number: out.badge_number, signed_out_at: out.signed_out_at });
  } catch (e) {
    return json(500, { error: 'Could not sign you out: ' + e.message });
  }
};

export const config = { path: '/api/visitor-signout' };
