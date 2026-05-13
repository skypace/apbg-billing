// ============================================================
// expense-request-decide.mjs
// POST /api/expense-request-decide
//   Body: { requestId, action: 'approved' | 'denied', notes?, signatureUrl? }
//
// In-app approval only. Approver must be logged into Supabase (same
// auth as alamedapointbg). No magic-link, no anonymous token path.
//
// Guards:
//   - Bearer JWT required
//   - Caller != submitter (no self-approval)
//   - lower(caller.email) == lower(request.manager_email)
//   - Request.status == 'pending'
// ============================================================
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);

  // Approver's JWT — RLS allows them to UPDATE the row whose manager_email matches.
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return err('Unauthorized — Bearer token required', 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { requestId, action, notes, signatureUrl } = body;
  if (!requestId) return err('Missing requestId');
  if (!action || !['approved', 'denied'].includes(action)) {
    return err('action must be "approved" or "denied"');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: authHeader } },
  });

  // Identify the caller
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return err('Invalid or expired session', 401);
  const callerEmail = String(user.email || '').toLowerCase();

  // Load the request
  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests')
    .select('id, status, request_type, submitted_by, manager_email')
    .eq('id', requestId)
    .single();

  if (fetchErr || !request) return err('Expense request not found', 404);

  // Status guard
  if (request.status !== 'pending') {
    return err(`Cannot decide on a request with status "${request.status}"`, 409);
  }

  // No self-approval
  if (request.submitted_by === user.id) {
    return err('You cannot approve your own request.', 403);
  }

  // App-layer email match (RLS will also enforce this on UPDATE)
  const routedTo = String(request.manager_email || '').toLowerCase();
  if (!routedTo || routedTo !== callerEmail) {
    return err(
      `This request is routed to ${request.manager_email || 'no one'}, not to you (${user.email}).`,
      403
    );
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

  // Insert approval audit row
  const { error: approvalErr } = await supabase
    .from('expense_approvals')
    .insert({
      request_id: request.id,
      action,
      decided_by: user.user_metadata?.full_name || user.email || user.id,
      decided_by_email: user.email,
      signature_url: signatureUrl || null,
      ip_address: ip,
      user_agent: ua,
      notes: notes || null,
      token_used: null,
    });

  if (approvalErr) {
    console.error('Failed to insert approval record:', approvalErr);
    return err('Failed to record decision', 500);
  }

  // Update request status (RLS allows because manager_email = caller's email)
  const updateFields = {
    status: nextStatus,
    approved_by: action === 'approved' ? (user.email || user.id) : null,
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
    decided_by: user.email,
  });
}

export const config = { path: '/api/expense-request-decide' };
