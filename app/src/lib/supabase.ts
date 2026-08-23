import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

export const SB_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
export const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

// Auth client (public schema): used for sign-in, session, JWT.
export const sbAuth: SupabaseClient<Database> = createClient<Database>(
  SB_URL,
  SB_KEY,
  { auth: { persistSession: true, autoRefreshToken: true } },
);

// ── SSO with apbg-gateway ──
// The gateway (alamedapointbg.com) writes localStorage.apbg_session on login,
// holding a Supabase access_token + refresh_token from THIS same project.
// Adopt it so a user who signed in at the hub flows straight into Refractor
// without a second login.
//
// ⚠ ONE TOKEN CHAIN (2026-08-17). GoTrue rotates the refresh token on every
// refresh and revokes the ENTIRE token family on reuse of an already-used one
// ("Possible abuse attempt"). Before this fix, this client auto-refreshed the
// adopted gateway token on its own clock while the hub's auth.js (and
// Brixpense) rotated the same chain — first collision revoked the family and
// every APBG surface on the machine got "invalid jwt" at once. Rules:
//   1. Our rotations write back to apbg_session (hub tabs ride them).
//   2. Another tab's rotation (storage event / page load) is re-adopted here.
//   3. Sign-out is LOCAL-ONLY (signOutLocal) — global signOut revokes the
//      shared chain across every app and device.
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

sbAuth.auth.onAuthStateChange((event, session) => {
  if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session) {
    writeGatewayFromSupabase(session);
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== GW_KEY || !e.newValue) return;
    (async () => {
      try {
        const s = JSON.parse(e.newValue as string);
        if (!s?.token || !s?.refreshToken) return;
        const { data } = await sbAuth.auth.getSession();
        if (data.session && data.session.refresh_token === s.refreshToken) return;
        await sbAuth.auth.setSession({ access_token: s.token, refresh_token: s.refreshToken });
      } catch {
        /* ignore */
      }
    })();
  });
}

export async function adoptGatewaySession(): Promise<void> {
  try {
    const gw = readGateway();
    const { data } = await sbAuth.auth.getSession();
    if (data.session) {
      // If the hub rotated the chain since this tab last ran, our stored
      // refresh token is dead — re-adopt the hub's current pair.
      if (gw?.token && gw?.refreshToken && gw.refreshToken !== data.session.refresh_token) {
        await sbAuth.auth.setSession({ access_token: gw.token, refresh_token: gw.refreshToken });
      }
      return;
    }
    if (gw?.token && gw?.refreshToken) {
      await sbAuth.auth.setSession({ access_token: gw.token, refresh_token: gw.refreshToken });
    }
  } catch {
    /* ignore — fall back to the in-app LoginPage */
  }
}

// Sign out THIS browser only — never revoke the shared chain globally.
export async function signOutLocal(): Promise<void> {
  try {
    await sbAuth.auth.signOut({ scope: 'local' });
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(GW_KEY);
  } catch {
    /* ignore */
  }
}

// Returns the user's bearer token if signed in, otherwise the anon key.
export async function _sbToken(): Promise<string> {
  try {
    const s = await sbAuth.auth.getSession();
    return s?.data?.session?.access_token || SB_KEY;
  } catch {
    return SB_KEY;
  }
}
