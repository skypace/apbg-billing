// ============================================================
// expense-request-decide.mjs
// Mirror of Melt's order-approval-response pattern.
//
// GET  /api/expense-request-decide?token=XXX
//   → returns { request, attachments } if token valid + status='pending'
//   → returns { already_decided: true } if status changed
//   → 404 if token doesn't match any row
//
// POST /api/expense-request-decide
//   body: { token, decision, signer_name, signer_initials,
//           signature_data_url, decline_reason }
//   → records the decision + signature in expense_approvals
//   → flips status to approved / awaiting_invoice / denied
//   → clears approval_token so the link can't be reused
//
// No Bearer auth — the token itself is the authorization. Uses anon
// RLS policies gated on approval_token IS NOT NULL.
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

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: CORS }); }
function err(message, status = 400) { return json({ error: message }, status); }

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
  });

  // ── GET: validate token + return request ──
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

    // Approval already decided?
    if (request.status !== 'pending') {
      // Fetch the last approval record so the page can show what was decided
      const { data: lastApproval } = await supabase
        .from('expense_approvals')
        .select('*')
        .eq('request_id', request.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      return json({
        already_decided: true,
        request,
        approval: lastApproval || null,
      });
    }

    // Pending — fetch attachments for context
    const { data: attachments } = await supabase
      .from('expense_request_attachments')
      .select('id, file_name, storage_path, file_type')
      .eq('request_id', request.id);

    return json({
      already_decided: false,
      request,
      attachments: attachments || [],
    });
  }

  // ── POST: record decision ──
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }

  const {
    token,
    decision,
    signer_name,
    signer_initials,
    signature_data_url,
    decline_reason,
  } = body || {};

  if (!token) return err('Missing token');
  if (!decision || !['approve', 'approved', 'decline', 'declined', 'deny', 'denied'].includes(decision)) {
    return err('decision must be approve or decline');
  }
  const isApprove = ['approve', 'approved'].includes(decision);
  const action = isApprove ? 'approved' : 'denied';

  if (!signer_name || signer_name.trim().length < 2) {
    return err('Please type your full name to sign.', 422);
  }
  if (!signer_initials || signer_initials.trim().length === 0) {
    return err('Please type your initials.', 422);
  }
  if (!isApprove && (!decline_reason || decline_reason.trim().length === 0)) {
    return err('Please explain why you are declining.', 422);
  }

  // Load the request by token
  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests')
    .select('id, status, request_type, submitter_email')
    .eq('approval_token', token)
    .single();

  if (fetchErr || !request) return err('Invalid or expired approval link', 404);
  if (request.status !== 'pending') return err(`This request has already been ${request.status}.`, 409);

  // Determine next status
  let nextStatus;
  if (isApprove) {
    nextStatus = request.request_type === 'purchase_request' ? 'awaiting_invoice' : 'approved';
  } else {
    nextStatus = 'denied';
  }

  // Capture audit metadata
  const ip = req.headers.get('x-forwarded-for')
    || req.headers.get('x-real-ip')
    || 'unknown';
  const ua = req.headers.get('user-agent') || 'unknown';
  const now = new Date().toISOString();

  // Build a single audit-notes blob that holds the signature data URL + name + initials.
  // (The migrations don't have separate signature/name columns; encoding everything in notes
  // keeps things simple while still preserving the full audit trail.)
  const auditNotes = JSON.stringify({
    signer_name: signer_name.trim(),
    signer_initials: signer_initials.trim(),
    signature_data_url: signature_data_url || null,
    decline_reason: decline_reason ? decline_reason.trim() : null,
    decided_at: now,
  });

  // Insert audit row
  const { error: approvalErr } = await supabase
    .from('expense_approvals')
    .insert({
      request_id: request.id,
      action,
      decided_by: signer_name.trim(),
      decided_by_email: request.submitter_email,  // we don't know approver email, log submitter for context
      signature_url: signature_data_url || null,
      ip_address: ip,
      user_agent: ua,
      notes: auditNotes,
      token_used: token,
    });

  if (approvalErr) {
    console.error('Failed to insert approval record:', approvalErr);
    return err('Failed to record decision', 500);
  }

  // Update the request — clear approval_token so the link can't be reused
  const updateFields = {
    status: nextStatus,
    approval_token: null,
    approved_by: isApprove ? signer_name.trim() : null,
    approved_at: isApprove ? now : null,
    denial_reason: isApprove ? null : (decline_reason || null),
  };

  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update(updateFields)
    .eq('id', request.id);
    // No .eq('approval_token', token) filter because anon RLS already
    // gates UPDATE on approval_token IS NOT NULL, and we just set it null
    // in our update. The id filter is enough.

  if (updateErr) {
    console.error('Failed to update request status:', updateErr);
    return err('Decision recorded but status update failed', 500);
  }

  return json({
    success: true,
    action,
    new_status: nextStatus,
    request_id: request.id,
    signer_name: signer_name.trim(),
  });
}

export const config = { path: '/api/expense-request-decide' };
