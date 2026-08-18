// visitor-signin.mjs — the front-door kiosk's only write path.
//
// Visitors cannot log in, so ops.visitor_visits is closed to the anon key and
// everything goes through here on the service-role key: validate, store the
// photo in the private visitor-photos bucket, allocate a badge number, insert
// the visit, then email the host and the ops list. Staff read the log from
// /compliance → Visitors.
//
// Deliberately public (no auth). It is write-only and returns nothing but the
// caller's own badge, so a stranger with the URL can create a visit record and
// nothing else. Rate-limited per IP to keep that from being interesting.
//
// Env: SUPABASE_SERVICE_ROLE_KEY (required — RLS is closed to anon),
//      RESEND_API_KEY / SENDGRID_API_KEY, VISITOR_ALERT_TO (optional override).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';
import { sendEmail, SITE_URL } from './email-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'visitor-photos';
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const RATE_LIMIT = 12;          // sign-ins per IP per window
const RATE_WINDOW_MIN = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function ops(method, path, body, extra = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const VISITOR_TYPES = new Set(['visitor', 'contractor', 'vendor', 'inspector', 'driver', 'interview', 'other']);
const TYPE_LABEL = {
  visitor: 'Visitor', contractor: 'Contractor', vendor: 'Vendor / delivery',
  inspector: 'Regulator / inspector', driver: 'Driver', interview: 'Interview', other: 'Other',
};

// Badge numbers are human-readable and unique per day: V-20260818-004. The
// UNIQUE constraint on badge_number is the real guard — on a collision (two
// tablets signing in at once) we retry with the next number.
function badgeFor(dayKey, seq) {
  return `V-${dayKey}-${String(seq).padStart(3, '0')}`;
}

async function decodePhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) return null;
  return { bytes, type: m[1], ext: m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg' };
}

async function uploadPhoto(id, photo) {
  const path = `${new Date().toISOString().slice(0, 10)}/${id}.${photo.ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': photo.type,
      'x-upsert': 'true',
    },
    body: photo.bytes,
  });
  if (!res.ok) throw new Error(`photo upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return path;
}

function notifyHtml(v, settings) {
  const row = (k, val) => `<tr><td style="padding:5px 14px 5px 0;color:#64748B;white-space:nowrap">${esc(k)}</td><td style="padding:5px 0;color:#0F172A;font-weight:600">${esc(val || '—')}</td></tr>`;
  return `<div style="font-family:'DM Sans',-apple-system,Segoe UI,Arial,sans-serif;background:#F5F7FA;padding:24px 12px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #E4E9F0;border-radius:14px;overflow:hidden">
    <div style="background:#1F4E79;padding:18px 22px;color:#fff">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9FD0E8;font-weight:700">Visitor signed in</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${esc(v.full_name)}</div>
      <div style="font-size:13px;color:#C9E2F0;margin-top:2px">${esc(v.company || 'No company given')} · ${esc(TYPE_LABEL[v.visitor_type] || v.visitor_type)}</div>
    </div>
    <div style="height:4px;background:#F4B400"></div>
    <div style="padding:20px 22px;font-size:14px;color:#0F172A">
      <p style="margin:0 0 12px">They are at <b>${esc(settings.facility_label)}</b> now and have signed the visitor agreement (version ${esc(v.agreement_version)}).</p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        ${row('Badge', v.badge_number)}
        ${row('Here to see', v.host_name)}
        ${row('Purpose', v.visit_purpose)}
        ${row('Email', v.email)}
        ${row('Phone', v.phone)}
        ${row('Vehicle', v.vehicle)}
        ${row('Areas', v.areas)}
        ${row('Signed in', new Date(v.signed_in_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT')}
      </table>
      <p style="margin:18px 0 0">
        <a href="${SITE_URL}/compliance#visitors" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Open the visitor log →</a>
      </p>
      <p style="margin:16px 0 0;color:#64748B;font-size:12px">Their photo and signature are on the visit record. Sign them out when they leave — the on-site list is what an evacuation head-count runs on.</p>
    </div>
  </div></div>`;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!SERVICE_KEY) return json(500, { error: 'Kiosk is not configured — SUPABASE_SERVICE_ROLE_KEY is missing on this site.' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Expected JSON.' }); }

  const full_name = clean(body.full_name, 120);
  if (full_name.length < 3 || !full_name.includes(' ')) return json(400, { error: 'Please enter your first and last name.' });
  if (!String(body.signature_data || '').startsWith('data:image/')) return json(400, { error: 'Please sign the agreement.' });
  if (body.agree !== true) return json(400, { error: 'Please accept the visitor agreement.' });

  const visitor_type = VISITOR_TYPES.has(body.visitor_type) ? body.visitor_type : 'visitor';
  const email = clean(body.email, 160);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'That email address does not look right.' });

  let settings;
  try {
    const rows = await ops('GET', 'visitor_settings?select=*&id=eq.1');
    settings = (rows && rows[0]) || {};
  } catch (e) {
    return json(500, { error: 'Could not read the kiosk settings: ' + e.message });
  }
  const hosts = Array.isArray(settings.hosts) ? settings.hosts : [];
  const chosen = hosts.find(h => h && String(h.email).toLowerCase() === clean(body.host_email, 160).toLowerCase());

  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '';
  try {
    const since = new Date(Date.now() - RATE_WINDOW_MIN * 60000).toISOString();
    const recent = await ops('GET', `visitor_visits?select=id&signed_in_at=gte.${since}`, undefined, { Prefer: 'count=exact' });
    if (Array.isArray(recent) && recent.length >= RATE_LIMIT * 4) {
      console.warn(`[visitor-signin] unusual volume: ${recent.length} sign-ins in ${RATE_WINDOW_MIN}m (ip ${ip})`);
    }
  } catch { /* never block a real visitor on the rate probe */ }

  const dayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).replace(/-/g, '');
  const row = {
    full_name,
    email: email || null,
    phone: clean(body.phone, 40) || null,
    company: clean(body.company, 160) || null,
    visitor_type,
    visit_purpose: clean(body.visit_purpose, 400) || null,
    host_name: chosen ? chosen.name : (clean(body.host_name, 120) || null),
    host_email: chosen ? chosen.email : null,
    vehicle: clean(body.vehicle, 120) || null,
    areas: clean(body.areas, 200) || null,
    agreement_version: clean(body.agreement_version, 60) || settings.agreement_version || '1.0',
    signature_data: String(body.signature_data).slice(0, 200000),
    user_agent: clean(req.headers.get('user-agent'), 300) || null,
  };

  // Allocate the badge number and insert, retrying on the unique collision two
  // simultaneous tablets would produce.
  let visit = null, lastErr = null;
  for (let attempt = 0; attempt < 6 && !visit; attempt++) {
    let seq = 1;
    try {
      const today = await ops('GET', `visitor_visits?select=badge_number&badge_number=like.V-${dayKey}-*&order=badge_number.desc&limit=1`);
      if (today && today[0]) seq = Number(String(today[0].badge_number).split('-').pop()) + 1;
    } catch { /* fall back to 1 and let the unique index sort it out */ }
    try {
      const created = await ops('POST', 'visitor_visits', { ...row, badge_number: badgeFor(dayKey, seq + attempt) }, { Prefer: 'return=representation' });
      visit = created && created[0];
    } catch (e) {
      lastErr = e;
      if (!/duplicate|unique/i.test(e.message)) break;
    }
  }
  if (!visit) return json(500, { error: 'Could not record the sign-in: ' + (lastErr ? lastErr.message : 'unknown error') });

  // Photo is best effort — a broken camera must never strand a visitor at the door.
  let photoWarning = null;
  const photo = await decodePhoto(body.photo_data);
  if (photo) {
    try {
      const path = await uploadPhoto(visit.id, photo);
      await ops('PATCH', `visitor_visits?id=eq.${visit.id}`, { photo_path: path });
      visit.photo_path = path;
    } catch (e) {
      photoWarning = e.message;
      console.error('[visitor-signin] photo failed:', e.message);
    }
  } else if (body.photo_data) {
    photoWarning = 'photo was not a usable image';
  }

  // Notification is best effort for the same reason, but a failure is recorded
  // so the visitor log can show that nobody was actually told.
  const to = [];
  if (visit.host_email) to.push(visit.host_email);
  const list = Array.isArray(settings.notify_emails) ? settings.notify_emails : [];
  for (const e of list) if (e && !to.includes(e)) to.push(e);
  const override = process.env.VISITOR_ALERT_TO;
  if (override && !to.includes(override)) to.push(override);
  if (!to.length) to.push('service@brixbev.com');

  try {
    await sendEmail({
      to,
      subject: `Visitor on site — ${visit.full_name}${visit.company ? ' (' + visit.company + ')' : ''}`,
      html: notifyHtml(visit, { facility_label: settings.facility_label || 'Hangar 200, Alameda' }),
      text: `${visit.full_name} signed in at ${new Date(visit.signed_in_at).toLocaleString()} — badge ${visit.badge_number}.`
        + `\nHere to see: ${visit.host_name || '—'}\nPurpose: ${visit.visit_purpose || '—'}\n${SITE_URL}/compliance#visitors`,
      replyTo: visit.email || undefined,
    });
    await ops('PATCH', `visitor_visits?id=eq.${visit.id}`, { notified_at: new Date().toISOString(), notify_error: null });
    visit.notified_at = new Date().toISOString();
  } catch (e) {
    console.error('[visitor-signin] notify failed:', e.message);
    try { await ops('PATCH', `visitor_visits?id=eq.${visit.id}`, { notify_error: e.message.slice(0, 400) }); } catch { /* logged already */ }
    visit.notify_error = e.message;
  }

  return json(200, {
    ok: true,
    badge_number: visit.badge_number,
    id: visit.id,
    full_name: visit.full_name,
    company: visit.company,
    visitor_type: visit.visitor_type,
    host_name: visit.host_name,
    signed_in_at: visit.signed_in_at,
    notified: !!visit.notified_at,
    notified_to: visit.notified_at ? to : [],
    photo_warning: photoWarning,
    notify_error: visit.notify_error || null,
  });
};

export const config = { path: '/api/visitor-signin' };
