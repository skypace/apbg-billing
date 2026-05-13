// ============================================================
// expense-request-notify.mjs
// POST /api/expense-request-notify   { requestId }
//
// In-app approval model. Email is notification only — not a magic-link.
//
// Two paths, by request_type:
//
//   expense          → auto-approve immediately. No email, no approval flow.
//                      Status='approved', auto_approved=true, audit row.
//
//   purchase_request → status='pending'. Notification email to the approver
//                      chosen by the submitter (validated against
//                      expense_settings.manager_emails). Email body links
//                      to {SITE_URL}/expense/queue — approver must log in
//                      with their Supabase account to approve in-app.
//
// Submitter's Supabase Bearer JWT is required (RLS gates the UPDATE to
// status='pending' under their own row).
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { sendEmail, EMAIL_FROM } from './email-helpers.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_URL = process.env.URL || 'https://alamedapointbg.com';

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
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
}

// Notification email — links to the authed portal, NOT a magic-link URL.
function buildNotificationEmailHtml(request, portalUrl) {
  const lineItemsHtml = (request.line_items || []).map((li, i) => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${i + 1}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${li.description || '—'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">${formatUsd(li.amount || 0)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:20px;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#06121F;padding:24px 32px;">
      <h1 style="color:#ffffff;margin:0;font-size:20px;">Brixpense — Purchase Request Waiting for You</h1>
    </div>

    <div style="padding:24px 32px;">
      <p style="color:#334155;font-size:15px;line-height:1.6;">
        <strong>${request.submitter_name || 'A team member'}</strong> submitted a purchase request and routed it to you for approval.
      </p>

      <table style="width:100%;margin:16px 0;font-size:14px;">
        <tr><td style="color:#64748b;padding:4px 0;width:120px;">Entity</td><td style="color:#0f172a;">${request.entity || '—'}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Department</td><td style="color:#0f172a;">${request.department || '—'}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Vendor</td><td style="color:#0f172a;">${request.vendor_name || '—'}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Total</td><td style="color:#0f172a;font-weight:600;font-size:16px;">${formatUsd(request.total_amount)}</td></tr>
      </table>

      ${request.description ? `<p style="color:#475569;font-size:14px;background:#f1f5f9;padding:12px;border-radius:6px;">${request.description}</p>` : ''}

      ${lineItemsHtml ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:8px 12px;text-align:left;">#</th>
            <th style="padding:8px 12px;text-align:left;">Description</th>
            <th style="padding:8px 12px;text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>${lineItemsHtml}</tbody>
      </table>
      ` : ''}

      <div style="text-align:center;margin:32px 0 16px;">
        <a href="${portalUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
          Open Approval Queue
        </a>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;">
        You'll be asked to log into Brixpense before you can approve.
      </p>
    </div>

    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:11px;margin:0;">
        Brix Beverage · Alameda Point Beverage Group · Expense Management
      </p>
    </div>
  </div>
</body>
</html>`;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);

  // Submitter's JWT — RLS allows them to UPDATE their own draft.
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

  // ── EXPENSE: auto-approve always, no email, no approval workflow ───────
  if (request.request_type === 'expense') {
    const { error: updateErr } = await supabase
      .from('expense_requests')
      .update({
        status: 'approved',
        auto_approved: true,
        approved_at: new Date().toISOString(),
        approved_by: 'auto',
        manager_email: null,    // expenses don't route to an approver
        approval_token: null,
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
      notes: 'Expenses are auto-approved on submit (no approval workflow for expenses).',
      token_used: null,
    });

    return json({
      success: true,
      auto_approved: true,
      new_status: 'approved',
      request_id: requestId,
    });
  }

  // ── PURCHASE REQUEST: notification email to chosen approver ────────────
  if (request.request_type !== 'purchase_request') {
    return err(`Unknown request_type "${request.request_type}"`, 400);
  }

  if (!request.manager_email) {
    return err('Purchase requests require an approver. Pick one from the list before submitting.', 422);
  }

  // Validate the chosen approver is in the manager_emails allowlist.
  const { data: managerSetting } = await supabase
    .from('expense_settings')
    .select('value')
    .eq('key', 'manager_emails')
    .single();

  const managerList = Array.isArray(managerSetting?.value)
    ? managerSetting.value.map((e) => String(e).toLowerCase())
    : [];
  const chosen = String(request.manager_email).toLowerCase();

  if (managerList.length > 0 && !managerList.includes(chosen)) {
    return err(
      `Approver "${request.manager_email}" is not in the manager_emails allowlist.`,
      422
    );
  }

  // Flip status to pending. No token — approver authenticates in-app.
  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({
      status: 'pending',
      approval_token: null,
    })
    .eq('id', requestId);

  if (updateErr) {
    console.error('Failed to set pending status:', updateErr);
    return err('Failed to submit for approval', 500);
  }

  // Build the notification (link to the authed portal queue, not a magic URL).
  const portalUrl = `${SITE_URL.replace(/\/$/, '')}/expense/queue`;
  const subject = `[Brixpense] PR from ${request.submitter_name || 'a team member'} — ${formatUsd(request.total_amount)} awaiting your approval`;
  const html = buildNotificationEmailHtml(request, portalUrl);

  const emailSent = await sendEmail({
    to: request.manager_email,
    subject,
    html,
    replyTo: request.submitter_email || EMAIL_FROM,
  });

  return json({
    success: true,
    auto_approved: false,
    email_sent: emailSent,
    new_status: 'pending',
    request_id: requestId,
    approver: request.manager_email,
    portal_url: portalUrl,
  });
}

export const config = { path: '/api/expense-request-notify' };
