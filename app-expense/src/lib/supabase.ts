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
// without a second login. No-op if already signed in or no gateway session.
export async function adoptGatewaySession(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session) return;
    const raw = localStorage.getItem('apbg_session');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s?.token && s?.refreshToken) {
      await supabase.auth.setSession({ access_token: s.token, refresh_token: s.refreshToken });
    }
  } catch {
    /* ignore — fall back to the in-app LoginPage */
  }
}

/** Get the current bearer token for Netlify function calls */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
