// ============================================================
// expense-request-link-bill.mjs
// POST /api/expense-request-link-bill
// Body: { requestId, qboBillId }
//
// Links an approved/awaiting_invoice/fulfilled expense request
// to a QuickBooks Online bill and marks it as posted.
// Requires Authorization header with Supabase JWT.
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

  if (req.method !== 'POST') {
    return err('Method not allowed', 405);
  }

  if (!SUPABASE_ANON_KEY) {
    return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);
  }

  // Require auth — this is an internal operation
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return err('Unauthorized — Bearer token required', 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: authHeader } },
  });

  // Verify the user session
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return err('Invalid or expired session', 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { requestId, qboBillId } = body;
  if (!requestId) return err('Missing requestId');
  if (!qboBillId) return err('Missing qboBillId');

  // Fetch the request
  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests')
    .select('id, status')
    .eq('id', requestId)
    .single();

  if (fetchErr || !request) {
    return err('Expense request not found', 404);
  }

  // Only link if in an approved-family status
  const linkableStatuses = ['approved', 'awaiting_invoice', 'fulfilled'];
  if (!linkableStatuses.includes(request.status)) {
    return err(
      `Cannot link a bill to a request with status "${request.status}". ` +
      `Must be one of: ${linkableStatuses.join(', ')}`,
      409
    );
  }

  // Update with QBO bill link
  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({
      qbo_bill_id: qboBillId,
      status: 'posted',
      posted_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  if (updateErr) {
    console.error('Failed to link bill:', updateErr);
    return err('Failed to link QBO bill', 500);
  }

  return json({
    success: true,
    request_id: requestId,
    qbo_bill_id: qboBillId,
    new_status: 'posted',
  });
}

export const config = { path: '/api/expense-request-link-bill' };
