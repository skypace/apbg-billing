// visitor-signout.mjs — the other half of the front-door kiosk.
//
// Public by design: a visitor taps "Sign out" on the kiosk, types their first
// name, and taps themselves off the on-site list. (Scanning the QR on their
// badge still works and skips straight to the confirmation.) Nothing is
// returned but a confirmation, and only a visit that is currently open can be
// closed, so the worst a stranger can do is sign someone out — which staff can
// undo from the visitor log.
//
// `action:'find'` is the name lookup behind that list. It is deliberately
// minimal-disclosure: only people CURRENTLY ON SITE, only first name + last
// initial, company, and time in — never an email, phone, purpose or photo. A
// person standing in our lobby can read the same thing off the badge of anyone
// walking past, so it discloses nothing the front door doesn't already.
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

  // ── Name lookup: who with this first name is on site right now? ──────────
  if (body.action === 'find') {
    // Strip anything that isn't part of a name before it reaches a PostgREST
    // filter, and require two characters so a single letter can't list the
    // whole building.
    const q = String(body.first_name || '').replace(/[^A-Za-z \-']/g, '').trim().slice(0, 40);
    if (q.length < 2) return json(400, { error: 'Type at least the first two letters of your first name.' });
    let rows;
    try {
      rows = await ops('GET',
        `visitor_visits?select=id,full_name,company,signed_in_at&signed_out_at=is.null` +
        `&full_name=ilike.${encodeURIComponent(q + '*')}&order=signed_in_at.desc&limit=8`);
    } catch (e) {
      return json(500, { error: 'Could not look that up: ' + e.message });
    }
    const matches = (rows || []).map((v) => {
      const parts = String(v.full_name || '').trim().split(/\s+/);
      const first = parts[0] || '';
      const last = parts.length > 1 ? parts[parts.length - 1] : '';
      return {
        id: v.id,
        // Last initial only — enough for two Michaels to tell themselves apart,
        // not enough to be a directory of who visits us.
        name: last ? `${first} ${last[0].toUpperCase()}.` : first,
        company: v.company || '',
        signed_in_at: v.signed_in_at,
      };
    });
    return json(200, { ok: true, matches });
  }

  const badge = String(body.badge_number || '').trim().toUpperCase();
  const id = String(body.id || '').trim();
  if (!badge && !id) return json(400, { error: 'Tell us your first name so we can find you.' });

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
  if (!visit) return json(404, { error: badge
    ? 'No visit found for that badge. Check the number on your pass, or ask at the office.'
    : 'We could not find that visit — please ask at the office.' });
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
