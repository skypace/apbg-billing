// Freshpet portal — self-serve "Forgot password" (PUBLIC endpoint).
//
// POST { email } from the portal's sign-in screen. Anti-enumeration: the
// response is ALWAYS { ok:true } regardless of whether the email is known —
// a reset email only actually goes out when the address has a tech_profiles
// row (portal viewer, tech, or admin). The link lands on the portal page
// carrying the GoTrue hashed_token (?type=recovery&token_hash=…), redeemed
// only by the page's JS via verifyOtp — scanner-proof, no redirect
// allowlist involved.
//
// A viewer who was granted access but never had a login yet (or has only
// ever signed in with Google) gets an auth user created on the fly — an
// authorized profile is the authorization; the login is just plumbing.

import { corsHeaders } from './qbo-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { renderPortalResetEmail } from './lib/freshpet-portal-emails.mjs';
import { FRESHPET_PORTAL_URL, serviceKey, fpSrFetch, mintSetPasswordUrl } from './lib/freshpet-auth.mjs';

const EMAIL_FROM = 'Freshpet Service Portal <alerts@alamedapointbg.com>';

function json(statusCode, obj) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 200) {
    return json(400, { error: 'Valid email required' });
  }

  // Everything below is best-effort behind the anti-enumeration response.
  try {
    if (!serviceKey()) {
      console.error('freshpet-password-reset: FRESHPET_SUPABASE_SERVICE_ROLE_KEY not configured — cannot send resets');
      return json(200, { ok: true });
    }
    const rows = await fpSrFetch(
      `tech_profiles?email=eq.${encodeURIComponent(email)}&select=email`);
    if (Array.isArray(rows) && rows[0]) {
      const setPasswordUrl = await mintSetPasswordUrl(email);
      const { html, text } = renderPortalResetEmail({ setPasswordUrl, portalUrl: FRESHPET_PORTAL_URL });
      await sendEmail({
        to: email, from: EMAIL_FROM, replyTo: 'service@brixbev.com',
        subject: 'Reset your Freshpet portal password',
        html, text,
      });
    }
  } catch (e) {
    console.error('freshpet-password-reset failed for', email, '-', e.message);
  }
  return json(200, { ok: true });
}
