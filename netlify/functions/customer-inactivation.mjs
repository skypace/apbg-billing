import { createClient } from '@supabase/supabase-js';
import { qboRequest, corsHeaders } from './qbo-helpers.mjs';
import { sfRequest } from './sf-helpers.mjs';
import { requireAuth } from './lib/auth.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const OPEN_STATUSES = ['requested', 'running', 'blocked', 'sf_failed', 'sf_done', 'qbo_failed'];
const PROCESSABLE_STATUSES = ['requested', 'sf_failed', 'sf_done', 'qbo_failed'];
const MAX_BATCH = 10;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function json(status, body) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getAuthHeader(event) {
  const h = event.headers || {};
  return h.authorization || h.Authorization || '';
}

function getSupabase(authHeader) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
}

function getServiceSupabase() {
  if (!SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'ops' },
    auth: { persistSession: false },
  });
}

function cleanError(err) {
  return String(err?.message || err || 'unknown error').replace(/\s+/g, ' ').slice(0, 900);
}

function compactResult(value) {
  if (!value || typeof value !== 'object') return value ?? {};
  const src = value.Customer || value.customer || value;
  return {
    id: src.id ?? src.Id ?? null,
    name: src.customer_name ?? src.DisplayName ?? src.name ?? null,
    active: src.active ?? src.Active ?? src.is_active ?? null,
    status: src.status ?? src.Status ?? null,
    sync_token: src.SyncToken ?? null,
  };
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function sfItems(result) {
  const raw = result?.items || result?.data || result?.results || (Array.isArray(result) ? result : []);
  return raw
    .map((c) => ({
      id: String(c.id ?? c.customer_id ?? ''),
      name: c.customer_name || c.name || '',
      qbo_id: c.qbo_id == null ? null : String(c.qbo_id),
      raw: c,
    }))
    .filter((c) => c.id && c.name);
}

async function requestAction(sb, qboCustomerId, reason) {
  const { data, error } = await sb.rpc('fn_request_customer_inactivation', {
    p_qbo_customer_id: qboCustomerId,
    p_reason: reason || 'Dormant active customer cleanup',
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] : data;
}

async function readAction(sb, { actionId, qboCustomerId }) {
  let query = sb
    .from('customer_lifecycle_actions')
    .select('*')
    .eq('action', 'inactivate')
    .in('status', OPEN_STATUSES)
    .order('requested_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);

  if (actionId) query = query.eq('id', actionId);
  if (qboCustomerId) query = query.eq('qbo_customer_id', qboCustomerId);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function updateAction(sb, id, patch) {
  const { data, error } = await sb
    .from('customer_lifecycle_actions')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function readAssessment(sb, qboCustomerId) {
  const { data, error } = await sb.rpc('fn_customer_inactivation_assessment', {
    p_qbo_customer_id: qboCustomerId,
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] : data;
}

async function lockForProcessing(sb, action) {
  const { data, error } = await sb
    .from('customer_lifecycle_actions')
    .update({
      status: 'running',
      processing_started_at: new Date().toISOString(),
      processed_at: null,
      last_error: null,
      attempt_count: Number(action.attempt_count || 0) + 1,
    })
    .eq('id', action.id)
    .in('status', PROCESSABLE_STATUSES)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function findServiceFusionCustomer(action, assessment) {
  if (action.sf_customer_id || assessment?.sf_customer_id) {
    return {
      id: String(action.sf_customer_id || assessment.sf_customer_id),
      name: action.sf_customer_name || assessment.sf_customer_name || action.customer_name,
      source: 'linked',
    };
  }

  const searchName = assessment?.sf_customer_name || action.sf_customer_name || action.customer_name;
  const encoded = encodeURIComponent(searchName);
  const result = await sfRequest('GET', `/customers?filters[customer_name]=${encoded}&per-page=25`);
  const candidates = sfItems(result);
  const qboMatch = candidates.find((c) => c.qbo_id && c.qbo_id === String(action.qbo_customer_id));
  if (qboMatch) return { ...qboMatch, source: 'qbo_id' };

  const needle = normalizeName(searchName);
  const exact = candidates.find((c) => normalizeName(c.name) === needle);
  if (exact) return { ...exact, source: 'exact_name' };

  if (candidates.length === 1) return { ...candidates[0], source: 'single_search_result' };
  return null;
}

async function inactivateServiceFusionCustomer(sfCustomer) {
  const endpoint = `/customers/${encodeURIComponent(sfCustomer.id)}`;
  const attempts = [
    { is_active: false },
    { active: false },
    { status: 'Inactive', customer_name: sfCustomer.name },
  ];
  const errors = [];

  for (const body of attempts) {
    try {
      const result = await sfRequest('PUT', endpoint, body);
      return { ok: true, payload: body, result: compactResult(result) };
    } catch (err) {
      errors.push(cleanError(err));
    }
  }

  throw new Error(`Service Fusion inactive update failed after ${attempts.length} attempts: ${errors.join(' | ')}`);
}

async function inactivateQboCustomer(qboCustomerId) {
  const current = await qboRequest('GET', `/customer/${encodeURIComponent(qboCustomerId)}`);
  const customer = current?.Customer;
  if (!customer?.Id) throw new Error(`QBO customer ${qboCustomerId} not found`);

  const before = compactResult(current);
  if (customer.Active === false) {
    return { before, after: before, no_change: true };
  }

  const updated = await qboRequest('POST', '/customer', {
    Id: customer.Id,
    SyncToken: customer.SyncToken,
    sparse: true,
    Active: false,
  });

  return { before, after: compactResult(updated), no_change: false };
}

async function mirrorQboInactive(sb, qboCustomerId, qboResult) {
  const lastUpdated =
    qboResult?.after?.last_updated ||
    qboResult?.Customer?.MetaData?.LastUpdatedTime ||
    null;
  const patch = {
    active: false,
    synced_at: new Date().toISOString(),
  };
  if (lastUpdated) patch.qbo_updated_at = lastUpdated;

  await sb
    .from('qbo_customers')
    .update(patch)
    .eq('qbo_customer_id', qboCustomerId);
}

async function processAction(sb, action) {
  if (!action) return { ok: false, status: 'missing', error: 'No open inactivation action found' };
  if (!PROCESSABLE_STATUSES.includes(action.status)) {
    return { ok: false, status: action.status, action, error: `Action is ${action.status}` };
  }

  const assessment = await readAssessment(sb, action.qbo_customer_id);
  if (!assessment?.can_inactivate) {
    const blocked = await updateAction(sb, action.id, {
      status: 'blocked',
      blockers: assessment?.blockers || ['unknown_blocker'],
      snapshot: assessment || {},
      processed_at: new Date().toISOString(),
      last_error: 'Blocked by current customer activity',
    });
    return { ok: false, status: 'blocked', action: blocked };
  }

  const previousStatus = action.status;
  const locked = await lockForProcessing(sb, action);

  let sfInfo = null;
  let sfUpdate = locked.sf_result;
  if (previousStatus !== 'sf_done') {
    try {
      sfInfo = await findServiceFusionCustomer(locked, assessment);
      if (!sfInfo) {
        const blocked = await updateAction(sb, locked.id, {
          status: 'blocked',
          blockers: ['service_fusion_match_needed'],
          snapshot: assessment || {},
          processed_at: new Date().toISOString(),
          last_error: 'Service Fusion customer not matched. Link or paste the SF customer id, then retry.',
        });
        return { ok: false, status: 'blocked', action: blocked };
      }

      sfUpdate = await inactivateServiceFusionCustomer(sfInfo);
      await updateAction(sb, locked.id, {
        status: 'sf_done',
        sf_customer_id: sfInfo.id,
        sf_customer_name: sfInfo.name,
        sf_result: { ...sfUpdate, source: sfInfo.source },
        processed_at: new Date().toISOString(),
        last_error: null,
      });
    } catch (err) {
      const failed = await updateAction(sb, locked.id, {
        status: 'sf_failed',
        processed_at: new Date().toISOString(),
        last_error: cleanError(err),
      });
      return { ok: false, status: 'sf_failed', action: failed };
    }
  }

  try {
    const qboUpdate = await inactivateQboCustomer(locked.qbo_customer_id);
    await mirrorQboInactive(sb, locked.qbo_customer_id, qboUpdate);
    const completed = await updateAction(sb, locked.id, {
      status: 'completed',
      qbo_result: qboUpdate,
      sf_result: sfUpdate,
      processed_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      last_error: null,
    });
    return { ok: true, status: 'completed', action: completed };
  } catch (err) {
    const failed = await updateAction(sb, locked.id, {
      status: 'qbo_failed',
      processed_at: new Date().toISOString(),
      last_error: cleanError(err),
    });
    return { ok: false, status: 'qbo_failed', action: failed };
  }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;

  const authHeader = getAuthHeader(event);
  const sbUser = getSupabase(authHeader);
  const sbService = getServiceSupabase();

  try {
    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || 'request_and_process');
    const qboCustomerId = body.qbo_customer_id ? String(body.qbo_customer_id) : null;
    const actionId = body.action_id ? Number(body.action_id) : null;
    const reason = body.reason || 'Dormant active customer cleanup';

    if (action === 'request') {
      if (!qboCustomerId) return json(400, { ok: false, error: 'qbo_customer_id required' });
      const requested = await requestAction(sbUser, qboCustomerId, reason);
      return json(200, { ok: requested?.status === 'requested', action: requested });
    }

    if (action === 'process' || action === 'request_and_process') {
      if (!sbService) return json(500, { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' });
      if (!qboCustomerId && !actionId) return json(400, { ok: false, error: 'qbo_customer_id or action_id required' });
      let current = null;
      if (action === 'request_and_process' && qboCustomerId) {
        const requested = await requestAction(sbUser, qboCustomerId, reason);
        if (!requested || requested.status !== 'requested') return json(200, { ok: false, status: requested?.status, action: requested });
        current = await readAction(sbService, { actionId: requested.id });
      } else {
        current = await readAction(sbService, { actionId, qboCustomerId });
      }
      const result = await processAction(sbService, current);
      return json(200, result);
    }

    if (action === 'request_and_process_many') {
      if (!sbService) return json(500, { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' });
      const ids = Array.isArray(body.qbo_customer_ids) ? body.qbo_customer_ids.map(String).filter(Boolean) : [];
      const limit = Math.min(Math.max(Number(body.limit || 5), 1), MAX_BATCH);
      const selected = ids.slice(0, limit);
      if (selected.length === 0) return json(400, { ok: false, error: 'qbo_customer_ids required' });

      const results = [];
      for (const id of selected) {
        try {
          const requested = await requestAction(sbUser, id, reason);
          if (!requested || requested.status !== 'requested') {
            results.push({ qbo_customer_id: id, ok: false, status: requested?.status || 'unknown', action: requested });
            continue;
          }
          const current = await readAction(sbService, { actionId: requested.id });
          results.push({ qbo_customer_id: id, ...(await processAction(sbService, current)) });
        } catch (err) {
          results.push({ qbo_customer_id: id, ok: false, status: 'error', error: cleanError(err) });
        }
      }
      return json(200, {
        ok: results.every((r) => r.ok),
        processed: results.length,
        results,
      });
    }

    return json(400, { ok: false, error: `unknown action ${action}` });
  } catch (err) {
    console.error('customer-inactivation error:', err);
    return json(500, { ok: false, error: cleanError(err) });
  }
}

export const config = { path: '/api/customer-inactivation' };
