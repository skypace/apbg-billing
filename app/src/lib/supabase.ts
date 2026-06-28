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
// without a second login. No-op if already signed in or no gateway session.
export async function adoptGatewaySession(): Promise<void> {
  try {
    const { data } = await sbAuth.auth.getSession();
    if (data.session) return;
    const raw = localStorage.getItem('apbg_session');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s?.token && s?.refreshToken) {
      await sbAuth.auth.setSession({ access_token: s.token, refresh_token: s.refreshToken });
    }
  } catch {
    /* ignore — fall back to the in-app LoginPage */
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
