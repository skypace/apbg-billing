// Freshpet portal user management — invite + password reset (admin-triggered).
//
// Called from the Freshpet admin console (Billing tab → "Freshpet portal
// access"). Two actions:
//
//   { action:'invite', email, name?, legacyLink? }
//     Ensures the tech_profiles row (role 'freshpet'; an existing 'admin' is
//     never demoted), ensures a real Supabase auth user EXISTS for the email
//     (so email+password can work on its own, without Google), mints a
//     one-time set-password link, and sends the branded walkthrough email —
//     how to sign in, what each tab shows, the pre-6/1/2026 legacy-system
//     note with the archive-folder link, and how to self-serve a password.
//     Re-sending is safe and is ALSO the "resend invite" path.
//
//   { action:'reset', email }
//     Sends a short branded password-reset email (same one-time-link
//     mechanics). The viewer-facing self-serve path is the separate public
//     freshpet-password-reset function.
//
// Auth: same boundary as freshpet-invoice — verifies the caller's Freshpet
// Supabase JWT and requires tech_profiles.role='admin' on that project.
// Writes use FRESHPET_SUPABASE_SERVICE_ROLE_KEY (auth admin API needs it).

import { corsHeaders } from './qbo-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { renderPortalInviteEmail, renderPortalResetEmail } from './lib/freshpet-portal-emails.mjs';
import {
  FRESHPET_SUPABASE_URL, FRESHPET_ANON_KEY, FRESHPET_PORTAL_URL,
  serviceKey, fpSrFetch, ensureAuthUser, mintSetPasswordUrl,
} from './lib/freshpet-auth.mjs';

const EMAIL_FROM = 'Freshpet Service Portal <alerts@alamedapointbg.com>';

function json(statusCode, obj) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) };
}

async function requireFreshpetAdmin(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return { error: json(401, { error: 'Missing Authorization bearer token' }) };
  const jwt = m[1];
  const uRes = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!uRes.ok) return { error: json(401, { error: 'Invalid or expired token' }) };
  const u = await uRes.json();
  if (!u?.email) return { error: json(401, { error: 'Invalid token' }) };
  const pRes = await fetch(
    `${FRESHPET_SUPABASE_URL}/rest/v1/tech_profiles?email=eq.${encodeURIComponent(u.email)}&select=email,role,name`,
    { headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` } });
  const profiles = pRes.ok ? await pRes.json() : [];
  const prof = Array.isArray(profiles) ? profiles[0] : null;
  if (!prof || prof.role !== 'admin') return { error: json(403, { error: 'Freshpet admin role required' }) };
  return { adminEmail: u.email, adminName: prof.name || u.email };
}

// Best-effort invited-at stamp — tolerates the column not existing yet.
async function stampInvited(email, adminEmail) {
  try {
    await fpSrFetch(`tech_profiles?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      body: { invited_at: new Date().toISOString(), invited_by: adminEmail },
    });
  } catch (e) { console.warn('invited_at stamp skipped:', e.message); }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let auth;
  try { auth = await requireFreshpetAdmin(event); }
  catch (e) { return json(502, { error: 'Freshpet auth check failed: ' + e.message }); }
  if (auth.error) return auth.error;

  if (!serviceKey()) {
    return json(500, {
      error: 'FRESHPET_SUPABASE_SERVICE_ROLE_KEY is not configured on this site — invites and password resets need it. Add it in the apbg-billing Netlify env (Supabase dashboard → project mmkncrsaijexezmhfmiw → Settings → API → service_role).',
    });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const action = payload.action === 'reset' ? 'reset' : 'invite';
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return json(400, { error: 'Valid email required' });

  try {
    if (action === 'invite') {
      const name = String(payload.name || '').trim();

      // 1. Profile: upsert role='freshpet' — never demote an existing admin.
      const existing = await fpSrFetch(
        `tech_profiles?email=eq.${encodeURIComponent(email)}&select=email,role,name`);
      const prof = Array.isArray(existing) ? existing[0] : null;
      if (!prof) {
        await fpSrFetch('tech_profiles', {
          method: 'POST',
          body: { email, name: name || email.split('@')[0], role: 'freshpet' },
        });
      } else if (prof.role !== 'admin' && prof.role !== 'freshpet') {
        await fpSrFetch(`tech_profiles?email=eq.${encodeURIComponent(email)}`, {
          method: 'PATCH', body: { role: 'freshpet' },
        });
      }

      // 2. Real login + one-time set-password link.
      await ensureAuthUser(email);
      const setPasswordUrl = await mintSetPasswordUrl(email);

      // 3. Walkthrough email.
      const legacyLink = String(payload.legacyLink || '').trim()
        || process.env.FRESHPET_LEGACY_FOLDER_URL || '';
      const { html, text } = renderPortalInviteEmail({
        name: name || prof?.name || '',
        portalUrl: FRESHPET_PORTAL_URL, setPasswordUrl, legacyLink,
      });
      await sendEmail({
        to: email, from: EMAIL_FROM, replyTo: 'service@brixbev.com',
        subject: 'Your Freshpet service portal — access & walkthrough',
        html, text,
      });
      await stampInvited(email, auth.adminEmail);
      return json(200, { ok: true, action, emailed: true, legacyLinkIncluded: !!legacyLink });
    }

    // action === 'reset'
    const rows = await fpSrFetch(
      `tech_profiles?email=eq.${encodeURIComponent(email)}&select=email,role`);
    if (!Array.isArray(rows) || !rows[0]) {
      return json(404, { error: `${email} has no Freshpet profile — use invite instead` });
    }
    const setPasswordUrl = await mintSetPasswordUrl(email);
    const { html, text } = renderPortalResetEmail({ setPasswordUrl, portalUrl: FRESHPET_PORTAL_URL });
    await sendEmail({
      to: email, from: EMAIL_FROM, replyTo: 'service@brixbev.com',
      subject: 'Reset your Freshpet portal password',
      html, text,
    });
    await stampInvited(email, auth.adminEmail);
    return json(200, { ok: true, action, emailed: true });
  } catch (e) {
    console.error('freshpet-portal-users failed:', e);
    return json(502, { error: e.message });
  }
}
