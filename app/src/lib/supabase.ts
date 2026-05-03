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

// Returns the user's bearer token if signed in, otherwise the anon key.
export async function _sbToken(): Promise<string> {
  try {
    const s = await sbAuth.auth.getSession();
    return s?.data?.session?.access_token || SB_KEY;
  } catch {
    return SB_KEY;
  }
}
