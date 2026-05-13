import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400) { return json({ error: m }, s); }

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return err('Unauthorized — Bearer token required', 401);
  }

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }

  const {
    requestId, action,
    signer_name, signer_initials,
    signature_data_url, decline_reason,
    notes,
  } = body || {};

  if (!requestId) return err('Missing requestId');
  if (!action || !['approve', 'approved', 'decline', 'declined', 'deny', 'denied'].includes(action)) {
    return err('action must be approve or decline');
  }
  const isApprove = ['approve', 'approved'].includes(action);
  const finalAction = isApprove ? 'approved' : 'denied';

  if (!signer_name || signer_name.trim().length < 2) return err('Please type your full name to sign.', 422);
  if (!signer_initials || signer_initials.trim().length === 0) return err('Please type your initials.', 422);
  if (!isApprove && (!decline_reason || decline_reason.trim().length === 0)) {
    return err('Please explain why you are declining.', 422);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return err('Invalid or expired session', 401);
  const callerEmail = String(user.email || '').toLowerCase();

  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests')
    .select('id, status, request_type, submitted_by, manager_email, submitter_email')
    .eq('id', requestId)
    .single();
  if (fetchErr || !request) return err('Expense request not found', 404);

  if (request.status !== 'pending') {
    return err(`Cannot decide on a request with status "${request.status}"`, 409);
  }
  if (request.submitted_by === user.id) {
    return err('You cannot approve your own request.', 403);
  }
  const routedTo = String(request.manager_email || '').toLowerCase();
  if (!routedTo || routedTo !== callerEmail) {
    return err(`This request is routed to ${request.manager_email || 'no one'}, not to you (${user.email}).`, 403);
  }

  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const ua = req.headers.get('user-agent') || 'unknown';
  const now = new Date().toISOString();

  const auditNotes = JSON.stringify({
    signer_name: signer_name.trim(),
    signer_initials: signer_initials.trim(),
    signature_data_url: signature_data_url || null,
    decline_reason: decline_reason ? decline_reason.trim() : null,
    free_text_note: notes || null,
    decided_at: now,
  });

  const { error: approvalErr } = await supabase
    .from('expense_approvals')
    .insert({
      request_id: request.id,
      action: finalAction,
      decided_by: signer_name.trim(),
      decided_by_email: user.email,
      signature_url: signature_data_url || null,
      ip_address: ip,
      user_agent: ua,
      notes: auditNotes,
      token_used: null,
    });
  if (approvalErr) {
    console.error('Failed to insert approval record:', approvalErr);
    return err('Failed to record decision', 500);
  }

  const nextStatus = isApprove
    ? (request.request_type === 'purchase_request' ? 'awaiting_invoice' : 'approved')
    : 'denied';

  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({
      status: nextStatus,
      approved_by: isApprove ? signer_name.trim() : null,
      approved_at: isApprove ? now : null,
      denial_reason: isApprove ? null : (decline_reason || null),
    })
    .eq('id', request.id);
  if (updateErr) {
    console.error('Failed to update request status:', updateErr);
    return err('Decision recorded but status update failed', 500);
  }

  return json({
    success: true,
    action: finalAction,
    new_status: nextStatus,
    request_id: request.id,
    signer_name: signer_name.trim(),
  });
}

export const config = { path: '/api/expense-request-decide' };
