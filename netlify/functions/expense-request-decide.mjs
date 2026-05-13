// ============================================================
// expense-request-decide.mjs
// GET  ?token=xxx  → validate token, return request for approval UI
// POST { token, action, decidedBy, decidedByEmail, notes, signatureUrl }
//      → record decision, update request status
// ============================================================
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!SUPABASE_ANON_KEY) {
    return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
  });

  // ── GET: validate token, return request details ──────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token) return err('Missing token parameter');

    const { data: request, error: fetchErr } = await supabase
      .from('expense_requests')
      .select('*')
      .eq('approval_token', token)
      .single();

    if (fetchErr || !request) {
      return err('Invalid or expired approval link', 404);
    }

    // Already decided?
    if (['approved', 'denied', 'awaiting_invoice', 'fulfilled', 'posted'].includes(request.status)) {
      return json({
        request,
        already_decided: true,
        message: `This request has already been ${request.status}.`,
      });
    }

    // Fetch attachments for context
    const { data: attachments } = await supabase
      .from('expense_request_attachments')
      .select('id, file_name, file_url, file_type')
      .eq('request_id', request.id);

    return json({ request, attachments: attachments || [], already_decided: false });
  }

  // ── POST: record approval or denial ─────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch {
      return err('Invalid JSON body');
    }

    const { token, action, decidedBy, decidedByEmail, notes, signatureUrl } = body;

    if (!token) return err('Missing token');
    if (!action || !['approved', 'denied'].includes(action)) {
      return err('action must be "approved" or "denied"');
    }
    if (!decidedBy) return err('Missing decidedBy (approver name)');

    // Look up the request
    const { data: request, error: fetchErr } = await supabase
      .from('expense_requests')
      .select('id, status, request_type')
      .eq('approval_token', token)
      .single();

    if (fetchErr || !request) {
      return err('Invalid or expired approval link', 404);
    }

    // Guard: only pending requests can be decided
    if (request.status !== 'pending') {
      return err(`Cannot decide on a request with status "${request.status}"`, 409);
    }

    // Determine next status
    const nextStatus = action === 'approved'
      ? (request.request_type === 'purchase_request' ? 'awaiting_invoice' : 'approved')
      : 'denied';

    // Extract IP + UA for audit
    const ip = req.headers.get('x-forwarded-for')
      || req.headers.get('x-real-ip')
      || 'unknown';
    const ua = req.headers.get('user-agent') || 'unknown';

    // Insert approval audit record
    const { error: approvalErr } = await supabase
      .from('expense_approvals')
      .insert({
        request_id: request.id,
        action,
        decided_by: decidedBy,
        decided_by_email: decidedByEmail || null,
        signature_url: signatureUrl || null,
        ip_address: ip,
        user_agent: ua,
        notes: notes || null,
        token_used: token,
      });

    if (approvalErr) {
      console.error('Failed to insert approval record:', approvalErr);
      return err('Failed to record decision', 500);
    }

    // Update request status
    const updateFields = {
      status: nextStatus,
      approved_by: decidedBy,
      approved_at: action === 'approved' ? new Date().toISOString() : null,
      denial_reason: action === 'denied' ? (notes || null) : null,
    };

    const { error: updateErr } = await supabase
      .from('expense_requests')
      .update(updateFields)
      .eq('id', request.id);

    if (updateErr) {
      console.error('Failed to update request status:', updateErr);
      return err('Decision recorded but status update failed', 500);
    }

    return json({
      success: true,
      action,
      new_status: nextStatus,
      request_id: request.id,
    });
  }

  return err('Method not allowed', 405);
}

export const config = { path: '/api/expense-request-decide' };
