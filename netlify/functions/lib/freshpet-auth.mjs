// Freshpet Supabase auth helpers (project mmkncrsaijexezmhfmiw).
//
// The Freshpet portal/admin/field apps live on a DIFFERENT Supabase project
// than the APBG gateway. These helpers wrap that project's GoTrue admin API
// for the portal user-management functions (freshpet-portal-users,
// freshpet-password-reset).
//
// Env vars (apbg-billing Netlify site):
//   FRESHPET_SUPABASE_URL               — optional, defaults to the live project
//   FRESHPET_SUPABASE_ANON_KEY          — optional (public anyway, hardcoded fallback)
//   FRESHPET_SUPABASE_SERVICE_ROLE_KEY  — REQUIRED for these features.
//                                         Supabase dashboard → mmkncrsaijexezmhfmiw
//                                         → Settings → API → service_role.
//   FRESHPET_PORTAL_URL                 — optional, defaults to the gateway path.

export const FRESHPET_SUPABASE_URL =
  process.env.FRESHPET_SUPABASE_URL || 'https://mmkncrsaijexezmhfmiw.supabase.co';
export const FRESHPET_ANON_KEY =
  process.env.FRESHPET_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ta25jcnNhaWpleGV6bWhmbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkyMjUsImV4cCI6MjA5NjM3NTIyNX0.lx4J-YhlFFrQVJMqjeBXXHNmgZfRe23xYGKZMEL8dPM';
export const FRESHPET_PORTAL_URL =
  process.env.FRESHPET_PORTAL_URL || 'https://alamedapointbg.com/freshpet/portal';

export function serviceKey() {
  return process.env.FRESHPET_SUPABASE_SERVICE_ROLE_KEY || '';
}

// PostgREST with the SERVICE ROLE key (bypasses RLS — server-side only).
export async function fpSrFetch(path, { method = 'GET', body } = {}) {
  const key = serviceKey();
  const res = await fetch(`${FRESHPET_SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'GET' ? 'count=none' : 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const textBody = await res.text();
  if (!res.ok) throw new Error(`Freshpet ${method} ${path.split('?')[0]} ${res.status}: ${textBody.slice(0, 200)}`);
  return textBody ? JSON.parse(textBody) : null;
}

async function goTrueAdmin(path, method, body) {
  const key = serviceKey();
  const res = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json: j };
}

function randomPassword() {
  // Throwaway — never shared; the user sets their own via the recovery link.
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'Fp1!' + Buffer.from(bytes).toString('base64url');
}

// Create the auth user if it doesn't exist yet. Idempotent: an
// "already registered" rejection is success. (A viewer who has only ever
// signed in with Google already has an auth user — also fine.)
export async function ensureAuthUser(email) {
  const r = await goTrueAdmin('/admin/users', 'POST', {
    email, password: randomPassword(), email_confirm: true,
  });
  if (r.ok) return { created: true };
  const msg = JSON.stringify(r.json || {});
  if (r.status === 422 || /already|exists|registered/i.test(msg)) return { created: false };
  throw new Error(`Could not create login for ${email}: ${msg.slice(0, 200)}`);
}

// Mint a one-time set-password link that lands on OUR portal page carrying
// the hashed_token — the page redeems it via verifyOtp, so an email-scanner
// GET can never consume it and no GoTrue redirect allowlist is involved.
export async function mintSetPasswordUrl(email) {
  let r = await goTrueAdmin('/admin/generate_link', 'POST', { type: 'recovery', email });
  if (!r.ok && (r.status === 404 || /not\s*found/i.test(JSON.stringify(r.json || {})))) {
    // Profile was granted before any login existed — create it, then retry.
    await ensureAuthUser(email);
    r = await goTrueAdmin('/admin/generate_link', 'POST', { type: 'recovery', email });
  }
  if (!r.ok) throw new Error(`Could not mint reset link: ${JSON.stringify(r.json || {}).slice(0, 200)}`);
  const hashed = r.json.hashed_token || r.json?.properties?.hashed_token;
  if (!hashed) throw new Error('Reset link response carried no hashed_token');
  return `${FRESHPET_PORTAL_URL}?type=recovery&token_hash=${encodeURIComponent(hashed)}`;
}
