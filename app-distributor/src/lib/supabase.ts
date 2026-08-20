import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // All Brixpense tables live in ops.* — point the client there.
  // Without this, supabase.from('expense_settings') hits public.* and 404s,
  // which is why the COGS / manager / department dropdowns were empty.
  db: { schema: 'ops' },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// ── SSO with apbg-gateway ──
// The gateway (alamedapointbg.com) writes localStorage.apbg_session on login,
// holding a Supabase access_token + refresh_token from THIS same project.
// Adopt it so a user who signed in at the hub flows straight into Brixpense
// without a second login.
//
// ⚠ ONE TOKEN CHAIN (2026-08-17). GoTrue ROTATES the refresh token on every
// refresh and revokes the ENTIRE token family when it sees an already-used
// one re-used ("Possible abuse attempt" in the auth logs). Before this fix,
// this client auto-refreshed the ADOPTED gateway token on its own clock while
// the hub's auth.js rotated the same chain from apbg_session — first
// collision revoked the family and every APBG surface on the machine got
// "invalid jwt" at once. The rules that keep it one chain:
//   1. Whenever THIS client rotates the token (TOKEN_REFRESHED), write the
//      new pair back to apbg_session so hub tabs ride it instead of colliding.
//   2. Whenever ANOTHER tab rotates apbg_session (storage event), re-adopt the
//      new pair here instead of refreshing our stale copy.
//   3. Sign-out is LOCAL-ONLY (see signOutLocal) — a global signOut revokes
//      the shared chain and kills the hub + every other app/device.
const GW_KEY = 'apbg_session';

function readGateway(): { token?: string; refreshToken?: string; expiresAt?: number; user?: Record<string, unknown> } | null {
  try {
    return JSON.parse(localStorage.getItem(GW_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeGatewayFromSupabase(session: { access_token: string; refresh_token: string; expires_at?: number; user?: { id: string; email?: string; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> } }): void {
  try {
    const prev = readGateway() || {};
    const u = session.user;
    localStorage.setItem(GW_KEY, JSON.stringify({
      ...prev,
      token: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ? session.expires_at * 1000 : Date.now() + 3600_000,
      user: prev.user ?? (u ? {
        id: u.id,
        email: u.email,
        name: (u.user_metadata?.name as string) || (u.email || '').split('@')[0],
        role: (u.user_metadata?.role as string) || (u.app_metadata?.role as string) || 'viewer',
      } : undefined),
    }));
  } catch {
    /* best-effort */
  }
}

// Rule 1 — our rotations feed the shared chain.
supabase.auth.onAuthStateChange((event, session) => {
  if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session) {
    writeGatewayFromSupabase(session);
  }
});

// Rule 2 — another tab's rotation supersedes our stale copy. 'storage' only
// fires for OTHER tabs' writes, so our own write-back never loops.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== GW_KEY || !e.newValue) return;
    (async () => {
      try {
        const s = JSON.parse(e.newValue as string);
        if (!s?.token || !s?.refreshToken) return;
        const { data } = await supabase.auth.getSession();
        if (data.session && data.session.refresh_token === s.refreshToken) return;
        await supabase.auth.setSession({ access_token: s.token, refresh_token: s.refreshToken });
      } catch {
        /* ignore */
      }
    })();
  });
}

export async function adoptGatewaySession(): Promise<void> {
  try {
    const gw = readGateway();
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      // Already signed in — but if the hub has rotated the chain since this
      // tab last ran, our stored refresh token is DEAD. Re-adopt the hub's
      // current pair instead of refreshing a stale one (rule 2 for the
      // page-load case, where no storage event fires).
      if (gw?.token && gw?.refreshToken && gw.refreshToken !== data.session.refresh_token) {
        await supabase.auth.setSession({ access_token: gw.token, refresh_token: gw.refreshToken });
      }
      return;
    }
    if (gw?.token && gw?.refreshToken) {
      await supabase.auth.setSession({ access_token: gw.token, refresh_token: gw.refreshToken });
    }
  } catch {
    /* ignore — fall back to the in-app LoginPage */
  }
}

// Rule 3 — sign out THIS browser only. supabase-js signOut() defaults to
// scope 'global', which revokes the user's sessions EVERYWHERE (other
// devices included) and leaves any still-open tab hammering a revoked
// refresh token — the zombie loop seen in the 2026-08-17 auth logs.
export async function signOutLocal(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(GW_KEY);
  } catch {
    /* ignore */
  }
}

/** Get the current bearer token for Netlify function calls */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
