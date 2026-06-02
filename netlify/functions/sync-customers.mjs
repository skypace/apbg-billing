// sync-customers — manage which customers are linked to the ResQ <-> SF sync.
//
// A "linked customer" is a QBO/SF customer with RESQ in its name. This endpoint
// backs the Settings section in sync.html.
//
//   GET                          -> { customers: [...all rows], candidates: [...QBO RESQ customers not yet linked] }
//   POST { action: 'link', ... } -> upsert a row (linked=true)
//   POST { action: 'update', id, ...fields } -> patch a row
//   POST { action: 'unlink', id }            -> soft-unlink (linked=false)
//   POST { action: 'relink', id }            -> set linked=true
//
// Reads use the anon key (RLS allows SELECT). Writes use the caller's superadmin
// JWT + RLS (apbg-billing has no service-role key). Superadmin required (requireAuth).

import { qboQuery, corsHeaders } from './qbo-helpers.mjs';
import { sfRequest } from './sf-helpers.mjs';
import { requireAuth } from './lib/auth.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const TABLE = `${SUPABASE_URL}/rest/v1/sync_customers`;

function json(body, status = 200) {
  return { statusCode: status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// --- Supabase REST (ops schema) ---
async function sbRead() {
  const res = await fetch(`${TABLE}?select=*&order=qbo_customer_name.asc`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Accept-Profile': 'ops' },
  });
  if (!res.ok) throw new Error(`read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Writes use the caller's superadmin JWT + RLS (apbg-billing has no service
// role key). requireAuth already gated to superadmin; RLS double-checks.
async function sbWrite(authHeader, method, body, query = '') {
  const res = await fetch(`${TABLE}${query}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: authHeader,
      'Content-Type': 'application/json',
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Live Service Fusion customer search — powers the Settings picker so a row
// links to the ACTUAL SF record (by id) instead of a typed name that drifts.
async function sfCustomerSearch(q) {
  const res = await sfRequest('GET', `/customers?filters[customer_name]=${encodeURIComponent(q)}&per-page=25`);
  const items = res.items || res.data || (Array.isArray(res) ? res : []);
  return items
    .map((c) => ({ id: String(c.id ?? c.customer_id ?? ''), name: c.customer_name || c.name || '' }))
    .filter((c) => c.id && c.name);
}

// Normalize an incoming keyword list to lowercase, trimmed, de-duped.
function normKeywords(v) {
  if (Array.isArray(v)) return [...new Set(v.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean))];
  if (typeof v === 'string') return normKeywords(v.split(','));
  return [];
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  const authHeader = event.headers?.authorization || event.headers?.Authorization;

  try {
    if (event.httpMethod === 'GET') {
      const qs = event.queryStringParameters || {};
      // SF customer search for the Settings picker: ?sfSearch=<query>
      if (qs.sfSearch !== undefined) {
        try {
          const results = await sfCustomerSearch(qs.sfSearch);
          return json({ results });
        } catch (e) {
          return json({ results: [], error: e.message.slice(0, 200) });
        }
      }
      const customers = await sbRead();
      const known = new Set(customers.map((c) => String(c.qbo_customer_id)));
      // Discover QBO customers with RESQ in the name that aren't linked yet.
      let candidates = [];
      try {
        const q = await qboQuery("SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '%RESQ%' MAXRESULTS 100");
        candidates = (q.QueryResponse?.Customer || [])
          .map((c) => ({ qbo_customer_id: String(c.Id), qbo_customer_name: c.DisplayName }))
          .filter((c) => !known.has(c.qbo_customer_id));
      } catch (e) {
        // Candidate discovery is best-effort — the linked list still renders.
        return json({ customers, candidates: [], candidatesError: e.message.slice(0, 200) });
      }
      return json({ customers, candidates });
    }

    if (event.httpMethod !== 'POST') return json({ error: 'GET or POST only' }, 405);

    const body = JSON.parse(event.body || '{}');
    const action = body.action;

    if (action === 'link') {
      if (!body.qbo_customer_id || !body.qbo_customer_name) return json({ error: 'qbo_customer_id and qbo_customer_name required' }, 400);
      const row = {
        qbo_customer_id: String(body.qbo_customer_id),
        qbo_customer_name: body.qbo_customer_name,
        sf_customer_name: body.sf_customer_name || body.qbo_customer_name,
        sf_customer_id: body.sf_customer_id ? String(body.sf_customer_id) : null,
        resq_facility_keywords: normKeywords(body.resq_facility_keywords),
        qbo_cogs_account_id: body.qbo_cogs_account_id || null,
        entity: body.entity || null,
        linked: true,
        notes: body.notes || null,
      };
      const result = await sbWrite(authHeader, 'POST', [row], '?on_conflict=qbo_customer_id');
      return json({ ok: true, customer: Array.isArray(result) ? result[0] : result });
    }

    if (action === 'update') {
      if (!body.id) return json({ error: 'id required' }, 400);
      const patch = {};
      if (body.qbo_customer_name !== undefined) patch.qbo_customer_name = body.qbo_customer_name;
      if (body.sf_customer_name !== undefined) patch.sf_customer_name = body.sf_customer_name || null;
      if (body.sf_customer_id !== undefined) patch.sf_customer_id = body.sf_customer_id || null;
      if (body.resq_facility_keywords !== undefined) patch.resq_facility_keywords = normKeywords(body.resq_facility_keywords);
      if (body.qbo_cogs_account_id !== undefined) patch.qbo_cogs_account_id = body.qbo_cogs_account_id || null;
      if (body.entity !== undefined) patch.entity = body.entity || null;
      if (body.notes !== undefined) patch.notes = body.notes || null;
      if (body.linked !== undefined) patch.linked = !!body.linked;
      if (Object.keys(patch).length === 0) return json({ error: 'no fields to update' }, 400);
      const result = await sbWrite(authHeader, 'PATCH', patch, `?id=eq.${encodeURIComponent(body.id)}`);
      return json({ ok: true, customer: Array.isArray(result) ? result[0] : result });
    }

    if (action === 'unlink' || action === 'relink') {
      if (!body.id) return json({ error: 'id required' }, 400);
      const result = await sbWrite(authHeader, 'PATCH', { linked: action === 'relink' }, `?id=eq.${encodeURIComponent(body.id)}`);
      return json({ ok: true, customer: Array.isArray(result) ? result[0] : result });
    }

    return json({ error: `unknown action "${action}"` }, 400);
  } catch (e) {
    console.error('sync-customers error:', e);
    return json({ error: e.message }, 500);
  }
}
