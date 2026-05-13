// ============================================================
// expense-request-notify.mjs
// POST /api/expense-request-notify
// Body: { requestId }
//
// 1. Looks up the expense request
// 2. If expense type + under auto-approve threshold → auto-approve
// 3. Otherwise generates approval token, sends magic-link email
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { sendEmail, EMAIL_FROM, APPROVAL_EMAIL } from './email-helpers.mjs';
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_URL = process.env.URL || 'https://apbg-billing.netlify.app';

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

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function buildApprovalEmailHtml(request, approveUrl) {
  const typeLabel = request.request_type === 'purchase_request'
    ? 'Purchase Request' : 'Expense Report';
  const lineItemsHtml = (request.line_items || []).map((li, i) => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${i + 1}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${li.description || '—'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${li.account || '—'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">${formatCurrency(li.amount || 0)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:20px;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background:#06121F;padding:24px 32px;">
      <h1 style="color:#ffffff;margin:0;font-size:20px;">Brixpense — ${typeLabel} Approval</h1>
    </div>

    <!-- Body -->
    <div style="padding:24px 32px;">
      <p style="color:#334155;font-size:15px;line-height:1.6;">
        <strong>${request.submitter_name}</strong> submitted a ${typeLabel.toLowerCase()} for your review.
      </p>

      <table style="width:100%;margin:16px 0;font-size:14px;">
        <tr><td style="color:#64748b;padding:4px 0;width:120px;">Entity</td><td style="color:#0f172a;">${request.entity}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Department</td><td style="color:#0f172a;">${request.department}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Vendor</td><td style="color:#0f172a;">${request.vendor_name || '—'}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Total</td><td style="color:#0f172a;font-weight:600;font-size:16px;">${formatCurrency(request.total_amount)}</td></tr>
      </table>

      ${request.description ? `<p style="color:#475569;font-size:14px;background:#f1f5f9;padding:12px;border-radius:6px;">${request.description}</p>` : ''}

      ${lineItemsHtml ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:8px 12px;text-align:left;">#</th>
            <th style="padding:8px 12px;text-align:left;">Description</th>
            <th style="padding:8px 12px;text-align:left;">Account</th>
            <th style="padding:8px 12px;text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>${lineItemsHtml}</tbody>
      </table>
      ` : ''}

      <div style="text-align:center;margin:32px 0 16px;">
        <a href="${approveUrl}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
          Review &amp; Approve
        </a>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;">
        This link is unique to this request. Do not forward.
      </p>
    </div>

    <!-- Footer -->
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

  if (req.method !== 'POST') {
    return err('Method not allowed', 405);
  }

  if (!SUPABASE_ANON_KEY) {
    return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);
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
  });

  // Fetch the request
  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (fetchErr || !request) {
    return err('Expense request not found', 404);
  }

  if (request.status !== 'draft') {
    return err(`Request is already "${request.status}", cannot submit`, 409);
  }

  // Fetch auto-approve threshold
  const { data: thresholdSetting } = await supabase
    .from('expense_settings')
    .select('value')
    .eq('key', 'auto_approve_threshold')
    .single();

  const threshold = thresholdSetting ? Number(thresholdSetting.value) : 250;

  // Fetch configured approval email
  const { data: emailSetting } = await supabase
    .from('expense_settings')
    .select('value')
    .eq('key', 'approval_email')
    .single();

  const approvalEmail = emailSetting
    ? String(emailSetting.value).replace(/"/g, '')
    : APPROVAL_EMAIL;

  // ── Auto-approve path ───────────────────────────────────
  if (request.request_type === 'expense' && request.total_amount <= threshold) {
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

    // Insert audit record for auto-approval
    await supabase.from('expense_approvals').insert({
      request_id: requestId,
      action: 'approved',
      decided_by: 'system (auto-approve)',
      notes: `Auto-approved: ${formatCurrency(request.total_amount)} ≤ threshold ${formatCurrency(threshold)}`,
      token_used: null,
    });

    return json({
      success: true,
      auto_approved: true,
      new_status: 'approved',
      request_id: requestId,
    });
  }

  // ── Manual approval path ────────────────────────────────
  // Generate a unique approval token
  const token = crypto.randomBytes(32).toString('hex');

  // Update request: set to pending, store token
  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({
      status: 'pending',
      approval_token: token,
    })
    .eq('id', requestId);

  if (updateErr) {
    console.error('Failed to set pending status:', updateErr);
    return err('Failed to submit for approval', 500);
  }

  // Build approval URL
  const approveUrl = `${SITE_URL}/expense/approve/${token}`;

  // Build and send email
  const typeLabel = request.request_type === 'purchase_request'
    ? 'Purchase Request' : 'Expense';
  const subject = `[Brixpense] ${typeLabel} from ${request.submitter_name} — ${formatCurrency(request.total_amount)}`;
  const html = buildApprovalEmailHtml(request, approveUrl);

  const emailSent = await sendEmail({
    to: approvalEmail,
    subject,
    html,
    replyTo: request.submitter_email,
  });

  return json({
    success: true,
    auto_approved: false,
    email_sent: emailSent,
    new_status: 'pending',
    request_id: requestId,
    approval_email: approvalEmail,
  });
}

export const config = { path: '/api/expense-request-notify' };
