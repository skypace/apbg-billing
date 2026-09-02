// Freshpet — email the incident log's owner when an incident is opened, its
// status changes, or it is closed.
//
// The incident log is the durable record of anything that went wrong with the
// service or the data. A record nobody is told about is a record nobody reads,
// so every event on it reaches a person. The console calls this best-effort:
// a mail outage must never stop an incident being written down, which is the
// thing that actually matters.
//
// Auth: the caller's Freshpet Supabase JWT (project mmkncrsaijexezmhfmiw) must
// belong to a tech_profiles.role='admin' — the same boundary as every other
// Freshpet function here.
//
// Deliberately NOT a general-purpose mailer. The recipient is validated against
// an allow-list of our own domains, so a compromised admin session cannot turn
// this into a way to send Brix-branded mail to an arbitrary address.

import { corsHeaders } from './qbo-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';

const FRESHPET_SUPABASE_URL =
  process.env.FRESHPET_SUPABASE_URL || 'https://mmkncrsaijexezmhfmiw.supabase.co';
const FRESHPET_ANON_KEY =
  process.env.FRESHPET_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ta25jcnNhaWpleGV6bWhmbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkyMjUsImV4cCI6MjA5NjM3NTIyNX0.lx4J-YhlFFrQVJMqjeBXXHNmgZfRe23xYGKZMEL8dPM';

const DEFAULT_TO = process.env.FRESHPET_INCIDENT_ALERT_TO || 'skypace@brixbev.com';
// An incident alert goes to us, never outward. Anything else is refused rather
// than silently redirected, so a wrong address is visible instead of lost.
const ALLOWED_DOMAINS = ['brixbev.com', 'alamedapointbg.com', 'alamedasoda.com'];
const ADMIN_CONSOLE = 'https://freshpet.brixbev.com/admin';

function json(statusCode, obj) { return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) }; }
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '')); }
function allowedRecipient(s) {
  if (!isEmail(s)) return false;
  const dom = String(s).split('@')[1].toLowerCase();
  return ALLOWED_DOMAINS.includes(dom);
}
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SEV_COLOR = { critical: '#B3261E', high: '#B3261E', medium: '#8A5A1A', low: '#5F6B7A' };
const EVENT_LABEL = { opened: 'OPENED', closed: 'CLOSED', reopened: 'REOPENED', status: 'UPDATED' };

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return json(401, { error: 'Missing Authorization bearer token' });
  const jwt = m[1];

  let adminEmail;
  try {
    const uRes = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!uRes.ok) return json(401, { error: 'Invalid or expired token' });
    adminEmail = (await uRes.json())?.email;
    if (!adminEmail) return json(401, { error: 'Invalid token' });
    const pRes = await fetch(
      `${FRESHPET_SUPABASE_URL}/rest/v1/tech_profiles?email=eq.${encodeURIComponent(adminEmail)}&select=role,name`,
      { headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` } });
    if (!pRes.ok) throw new Error(`profile read ${pRes.status}`);
    const prof = (await pRes.json())[0];
    if (!prof || prof.role !== 'admin') return json(403, { error: 'Freshpet admin role required' });
  } catch (e) {
    return json(502, { error: 'Freshpet auth check failed: ' + e.message });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const inc = payload.incident || {};
  if (!inc.ref && !inc.title) return json(400, { error: 'incident.ref or incident.title is required' });

  const to = payload.to && allowedRecipient(payload.to) ? payload.to : DEFAULT_TO;
  if (payload.to && !allowedRecipient(payload.to)) {
    return json(400, { error: `Refusing to send an incident alert to ${payload.to} — incident mail goes to our own domains only` });
  }

  const label = EVENT_LABEL[payload.event] || 'UPDATED';
  const sev = String(inc.severity || 'medium').toLowerCase();
  const color = SEV_COLOR[sev] || '#5F6B7A';
  const subject = `[Freshpet incident ${label}] ${inc.ref || ''} ${inc.title || ''}`.replace(/\s+/g, ' ').trim();

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1d1a17">
  <div style="background:#0F2942;color:#fff;padding:18px 20px;border-radius:12px 12px 0 0">
    <div style="font-size:.72rem;letter-spacing:.14em;opacity:.75">FRESHPET INCIDENT LOG</div>
    <div style="font-size:1.15rem;font-weight:800;margin-top:4px">Incident ${escHtml(label)}</div>
  </div>
  <div style="border:1px solid #e4dccf;border-top:none;border-radius:0 0 12px 12px;padding:20px">
    <div style="font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:#6b6157">${escHtml(inc.ref || '')}</div>
    <div style="font-size:1.05rem;font-weight:700;margin:3px 0 12px">${escHtml(inc.title || '')}</div>
    <div style="margin-bottom:14px">
      <span style="display:inline-block;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${color};border:1px solid ${color};border-radius:999px;padding:3px 10px">${escHtml(sev)}</span>
      <span style="display:inline-block;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#0F2942;border:1px solid #0F2942;border-radius:999px;padding:3px 10px;margin-left:6px">${escHtml(inc.status || '')}</span>
      ${inc.customer_facing ? '<span style="display:inline-block;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#8A5A1A;border:1px solid #E8B368;border-radius:999px;padding:3px 10px;margin-left:6px">customer-facing</span>' : ''}
    </div>
    ${payload.note ? `<div style="background:#faf6f0;border:1px solid #e4dccf;border-radius:10px;padding:12px 14px;font-size:.9rem;line-height:1.6;white-space:pre-wrap">${escHtml(payload.note)}</div>` : ''}
    <div style="margin-top:18px;font-size:.82rem;color:#6b6157">By ${escHtml(adminEmail)}${inc.customer_facing ? ' &middot; this incident is visible to Freshpet on their portal' : ''}</div>
    <div style="margin-top:18px"><a href="${ADMIN_CONSOLE}" style="display:inline-block;background:#E56A15;color:#fff;text-decoration:none;font-weight:700;font-size:.88rem;padding:10px 18px;border-radius:9px">Open the incident log</a></div>
  </div>
</div>`;

  const text = [
    `Freshpet incident ${label}`,
    `${inc.ref || ''} — ${inc.title || ''}`,
    `Severity: ${sev} · Status: ${inc.status || ''}${inc.customer_facing ? ' · customer-facing' : ''}`,
    payload.note ? `\n${payload.note}` : '',
    `\nBy ${adminEmail}`,
    ADMIN_CONSOLE,
  ].filter(Boolean).join('\n');

  try {
    await sendEmail({ to, subject, html, text });
  } catch (e) {
    return json(502, { error: 'Send failed: ' + e.message });
  }
  return json(200, { ok: true, to, subject });
}
