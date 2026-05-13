// ============================================================
// expense-request-notify.mjs
// POST /api/expense-request-notify   { requestId }
//
// In-app approval model — no magic-link, no email.
//
// 1. Looks up the expense request (must be 'draft').
// 2. If it's an expense and total ≤ auto_approve_threshold, flips
//    straight to 'approved' (auto_approved=true) + logs to
//    expense_approvals.
// 3. Otherwise just flips status → 'pending'. Managers find these
//    items inside the authenticated app at /expense/queue, filtered
//    by manager_email = their session email.
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
function formatUsd(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);

  // Caller is the submitter — pass through their JWT so RLS sees them.
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

  const { requestId } = body;
  if (!requestId) return err('Missing requestId');

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: authHeader } },
  });

  // Load the request
  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (fetchErr || !request) return err('Expense request not found', 404);
  if (request.status !== 'draft') {
    return err(`Request is already "${request.status}", cannot submit`, 409);
  }

  // Read threshold from settings
  const { data: thresholdSetting } = await supabase
    .from('expense_settings')
    .select('value')
    .eq('key', 'auto_approve_threshold')
    .single();
  const threshold = thresholdSetting ? Number(thresholdSetting.value) : 250;

  // ── Auto-approve path ───────────────────────────────────
  if (request.request_type === 'expense' && Number(request.total_amount) <= threshold) {
    const { error: updateErr } = await supabase
      .from('expense_requests')
      .update({
        status: 'approved',
        auto_approved: true,
        approved_at: new Date().toISOString(),
        approved_by: 'auto',
      })
      .eq('id', requestId);

    if (updateErr) {
      console.error('Auto-approve update failed:', updateErr);
      return err('Failed to auto-approve', 500);
    }

    await supabase.from('expense_approvals').insert({
      request_id: requestId,
      action: 'approved',
      decided_by: 'system (auto-approve)',
      notes: `Auto-approved: ${formatUsd(request.total_amount)} ≤ threshold ${formatUsd(threshold)}`,
      token_used: null,
    });

    return json({
      success: true,
      auto_approved: true,
      new_status: 'approved',
      request_id: requestId,
    });
  }

  // ── Manual approval path (in-app) ───────────────────────
  // No token, no email. Just flip to pending; the manager sees the row
  // in their /expense/queue page.
  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({ status: 'pending' })
    .eq('id', requestId);

  if (updateErr) {
    console.error('Failed to set pending status:', updateErr);
    return err('Failed to submit for approval', 500);
  }

  return json({
    success: true,
    auto_approved: false,
    new_status: 'pending',
    request_id: requestId,
    message: request.manager_email
      ? `Routed to ${request.manager_email} — visible in their /expense/queue.`
      : 'Awaiting approval — visible to managers in /expense/queue.',
  });
}

export const config = { path: '/api/expense-request-notify' };
