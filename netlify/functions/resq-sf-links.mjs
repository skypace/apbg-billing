// resq-sf-links — read the Phase 2 sync state tables for the dashboard.
//
//   GET                  -> { links: [...], events: [...recent 50] }
//   GET ?events=1&limit=N -> { events: [...recent N] }
//
// Read-only, anon-key reads (RLS allows SELECT). Superadmin-gated like the rest
// of the sync dashboard endpoints.

import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

function json(body, status = 200) {
  return { statusCode: status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Accept-Profile': 'ops' },
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;

  try {
    const qs = event.queryStringParameters || {};
    const limit = Math.min(parseInt(qs.limit, 10) || 50, 200);

    const events = await sbGet(`sync_events?select=*&order=created_at.desc&limit=${limit}`);
    if (qs.events) return json({ events });

    const links = await sbGet('resq_sf_links?select=resq_code,sf_job_id,sf_job_number,resq_status,sf_status,customer_name,facility,sf_deleted,invoice_submitted,photos_sent,last_sync_at&order=last_sync_at.desc.nullslast&limit=500');
    return json({ links, events });
  } catch (e) {
    console.error('resq-sf-links error:', e);
    return json({ error: e.message }, 500);
  }
}
