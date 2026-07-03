import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = `${SUPABASE_URL}/rest/v1/proposal_builder_proposals`;

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function ops(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    ...extra,
  };
}

function shareUrl(event, slug) {
  if (!slug) return null;
  const configured = process.env.PROPOSAL_SHARE_BASE_URL;
  if (configured) return `${configured.replace(/\/+$/, '')}/${encodeURIComponent(slug)}`;
  const host = event.headers?.host || event.headers?.Host || '';
  const proto = event.headers?.['x-forwarded-proto'] || event.headers?.['X-Forwarded-Proto'] || 'https';
  return `${proto}://${host}/margin/.netlify/functions/proposal-share?slug=${encodeURIComponent(slug)}`;
}

function toSaved(row, event) {
  return {
    id: row.id,
    title: row.title,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    businessType: row.business_type,
    status: row.status,
    shareEnabled: !!row.share_enabled,
    shareSlug: row.share_slug,
    shareUrl: row.share_enabled ? shareUrl(event, row.share_slug) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    proposal: row.proposal,
    generatedEmail: row.generated_email || '',
    gammaUrl: row.gamma_url,
    pdfUrl: row.pdf_url,
  };
}

async function sb(path, init = {}) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  const res = await fetch(`${TABLE}${path}`, { ...init, headers: ops(init.headers || {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(parsed?.message || parsed?.error || text || `Supabase returned ${res.status}`);
  return parsed;
}

function rowFromBody(body, auth) {
  const proposal = body.proposal || {};
  const customer = proposal.customer || {};
  const title = String(body.title || customer.name || 'Untitled proposal').trim();
  return {
    title,
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    business_type: customer.businessType || null,
    status: body.shareEnabled ? 'shared' : 'draft',
    share_enabled: !!body.shareEnabled,
    proposal,
    generated_email: body.generatedEmail || '',
    gamma_url: body.gammaUrl || proposal.gammaUrl || null,
    pdf_url: body.pdfUrl || proposal.pdfUrl || null,
    updated_by: auth.user?.email || auth.user?.id || auth.role || 'unknown',
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  try {
    if (event.httpMethod === 'GET') {
      const id = event.queryStringParameters?.id;
      if (id) {
        const rows = await sb(`?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        if (!rows?.length) return json({ error: 'Proposal not found' }, 404);
        return json({ proposal: toSaved(rows[0], event) });
      }
      const rows = await sb('?select=id,title,customer_name,customer_email,business_type,status,share_enabled,share_slug,created_at,updated_at&order=updated_at.desc&limit=50');
      return json({ proposals: rows.map((row) => toSaved(row, event)) });
    }

    if (event.httpMethod !== 'POST') return json({ error: 'GET or POST only' }, 405);

    const body = JSON.parse(event.body || '{}');
    const row = rowFromBody(body, auth);
    let saved;
    if (body.id) {
      const rows = await sb(`?id=eq.${encodeURIComponent(body.id)}&select=*`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      saved = rows?.[0];
    } else {
      const rows = await sb('?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          ...row,
          created_by: auth.user?.email || auth.user?.id || auth.role || 'unknown',
        }),
      });
      saved = rows?.[0];
    }
    if (!saved) return json({ error: 'Proposal was not saved' }, 500);
    return json({ proposal: toSaved(saved, event) });
  } catch (e) {
    console.error('proposal-store error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
