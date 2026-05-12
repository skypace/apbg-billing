import { createClient } from '@supabase/supabase-js';
import { createToken } from './token-helpers.mjs';
import { sendEmail, EMAIL_FROM, SITE_URL } from './email-helpers.mjs';
import { requireAuth } from './lib/auth.mjs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { db: { schema: 'ops' } }
);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

/** Look up a user's email from Supabase auth by UUID */
async function getUserEmail(userId) {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    return { email: data.user.email, name: data.user.user_metadata?.full_name || data.user.email };
  } catch {
    return null;
  }
}

function notifyEmailHtml(request, submitterLabel, approveUrl) {
  const isExpense = request.type === 'expense';
  const typeLabel = isExpense ? 'Expense' : 'Purchase Request';
  const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(request.total_amount);

  const lineRows = (request.line_items || []).map(li =>
    `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${li.description}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">$${Number(li.amount).toFixed(2)}</td>
    </tr>`
  ).join('');

  return `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1F4E79;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:20px;">${typeLabel} Approval Required</h1>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;">
        <p style="margin:0 0 16px;color:#374151;">
          <strong>${submitterLabel}</strong> submitted a ${typeLabel.toLowerCase()} for your approval.
        </p>

        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#6b7280;">Department</td><td style="padding:4px 0;font-weight:600;">${request.department || '—'}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Vendor</td><td style="padding:4px 0;font-weight:600;">${request.vendor_name || '—'}</td></tr>
          ${request.job_number ? `<tr><td style="padding:4px 0;color:#6b7280;">Job #</td><td style="padding:4px 0;font-weight:600;">${request.job_number}</td></tr>` : ''}
          <tr><td style="padding:4px 0;color:#6b7280;">Total</td><td style="padding:4px 0;font-weight:700;font-size:18px;color:#1F4E79;">${total}</td></tr>
        </table>

        ${request.memo ? `<p style="margin:0 0 16px;padding:12px;background:#f9fafb;border-radius:6px;color:#374151;">${request.memo}</p>` : ''}

        ${lineRows ? `
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="padding:8px 12px;text-align:left;">Description</th>
              <th style="padding:8px 12px;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>${lineRows}</tbody>
        </table>` : ''}

        <div style="text-align:center;margin:24px 0;">
          <a href="${approveUrl}" style="display:inline-block;background:#1F4E79;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">
            Review &amp; Decide
          </a>
        </div>

        <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;text-align:center;">
          This link expires in 7 days. You can approve or deny from the review page.
        </p>
      </div>
      <div style="padding:16px 24px;text-align:center;font-size:12px;color:#9ca3af;">
        Brix Beverage &mdash; Expense Management
      </div>
    </div>
  `;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Require authenticated user
  const auth = await requireAuth(event, ['superadmin', 'admin', 'manager', 'user']);
  if (!auth.ok) return auth.response;

  try {
    const { request_id } = JSON.parse(event.body || '{}');
    if (!request_id) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'request_id required' }) };
    }

    // Load the expense request
    const { data: request, error: fetchErr } = await supabase
      .from('expense_requests')
      .select('*')
      .eq('id', request_id)
      .single();

    if (fetchErr || !request) {
      return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'Request not found' }) };
    }

    if (!request.manager_email) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'No manager email set on request' }) };
    }

    // Look up submitter info
    const submitter = await getUserEmail(request.submitted_by);
    const submitterLabel = submitter?.name || submitter?.email || 'A team member';
    const submitterEmail = submitter?.email || null;

    // Create magic-link token (7 day expiry)
    const token = createToken({
      request_id: request.id,
      type: 'expense_approval',
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    const approveUrl = `${SITE_URL}/expense/approve/${token}`;
    const isExpense = request.type === 'expense';
    const typeLabel = isExpense ? 'Expense' : 'Purchase Request';
    const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(request.total_amount);

    await sendEmail({
      to: request.manager_email,
      subject: `[Action Required] ${typeLabel} — ${total} from ${submitterLabel}`,
      html: notifyEmailHtml(request, submitterLabel, approveUrl),
      replyTo: submitterEmail,
    });

    // Update request status to pending_approval
    await supabase
      .from('expense_requests')
      .update({ status: 'pending' })
      .eq('id', request_id);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, message: 'Notification sent' }),
    };
  } catch (err) {
    console.error('expense-request-notify error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
