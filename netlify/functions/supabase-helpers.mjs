// Single source of truth for BRIXPENSE Supabase config.
// The anon key is public-by-design per Supabase architecture
// (security is enforced by RLS, not key secrecy), so hardcoding it
// is intentional. Env var override is allowed but only if the value
// passes validation — a typo, stale rotation, or wrong-project key
// would otherwise lock the whole system out with "Invalid API key".

const PROJECT_REF = 'gfsdpwiqzshhexkofiif';

const HARDCODED_URL = `https://${PROJECT_REF}.supabase.co`;
const HARDCODED_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

/**
 * Returns true iff the value looks like a valid Supabase anon JWT for
 * THIS project. We can't verify the signature without the JWT secret,
 * but we can check structure + the iss/ref/role claims to catch the
 * common failure modes: wrong project, wrong role, truncation, garbage.
 */
function looksLikeValidAnonKey(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('eyJ')) return false;
  const parts = trimmed.split('.');
  if (parts.length !== 3) return false;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const payload = JSON.parse(
      Buffer.from(padded + pad, 'base64').toString('utf8'),
    );
    if (payload.iss !== 'supabase') return false;
    if (payload.ref !== PROJECT_REF) return false;
    if (payload.role !== 'anon') return false;
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export const SUPABASE_URL = (() => {
  const env = process.env.SUPABASE_URL;
  if (typeof env === 'string' && /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(env.trim())) {
    return env.trim().replace(/\/$/, '');
  }
  return HARDCODED_URL;
})();

export const SUPABASE_ANON_KEY = (() => {
  const env = process.env.SUPABASE_ANON_KEY;
  if (looksLikeValidAnonKey(env)) return env.trim();
  if (env && env !== HARDCODED_ANON_KEY) {
    console.warn(
      '[supabase-helpers] Ignoring SUPABASE_ANON_KEY env var — fails validation for project',
      PROJECT_REF,
    );
  }
  return HARDCODED_ANON_KEY;
})();

export const SUPABASE_PROJECT_REF = PROJECT_REF;
