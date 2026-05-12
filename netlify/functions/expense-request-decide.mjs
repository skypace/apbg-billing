import { createClient } from '@supabase/supabase-js';
import { verifyToken } from './token-helpers.mjs';
import { sendEmail, EMAIL_FROM, SITE_URL } from './email-helpers.mjs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

/** Look up a user's email from Supabase auth by UUID */
async function getUserEmail(userId) {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    return data.user.email;
  } catch {
    return null;
  }
}

function outcomeEmailHtml(request, decision, reasonNote, submitterLabel) {
  const isApproved = decision === 'approved';
  const typeLabel = request.type === 'expense' ? 'Expense' : 'Purchase Request';
  const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(request.total_amount);
  const statusColor = isApproved ? '#059669' : '#dc2626';
  const statusLabel = isApproved ? 'Approved' : 'Denied';

  return `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1F4E79;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:20px;">${typeLabel} ${statusLabel}</h1>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;background:${statusColor};color:#fff;padding:8px 20px;border-radius:20px;font-weight:700;font-size:16px;">
            ${statusLabel.toUpperCase()}
          </span>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <tr><td style="padding:4px 0;color:#6b7280;">Type</td><td style="padding:4px 0;font-weight:600;">${typeLabel}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Vendor</td><td style="padding:4px 0;font-weight:600;">${request.vendor_name || '—'}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Total</td><td style="padding:4px 0;font-weight:700;color:#1F4E79;">${total}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Manager</td><td style="padding:4px 0;font-weight:600;">${request.manager_email}</td></tr>
        </table>

        ${reasonNote ? `
        <div style="margin:16px 0;padding:12px;background:#f9fafb;border-radius:6px;border-left:4px solid ${statusColor};">
          <p style="margin:0;color:#374151;"><strong>Manager Note:</strong> ${reasonNote}</p>
        </div>` : ''}

        ${isApproved && request.type === 'expense' ? `
        <p style="margin:16px 0 0;padding:12px;background:#ecfdf5;border-radius:6px;color:#065f46;font-size:14px;">
          A QuickBooks bill will be created automatically for this expense.
        </p>` : ''}
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

  // ---------- GET: Load request for approval page ----------
  if (event.httpMethod === 'GET') {
    const token = event.queryStringParameters?.token;
    if (!token) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Token required' }) };
    }

    try {
      const payload = verifyToken(token);
      if (!payload || payload.type !== 'expense_approval') {
        return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid token' }) };
      }

      // Check expiry
      if (payload.exp && Date.now() > payload.exp) {
        return { statusCode: 410, headers: corsHeaders(), body: JSON.stringify({ error: 'Token expired' }) };
      }

      // Load the request
      const { data: request, error: fetchErr } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('id', payload.request_id)
        .single();

      if (fetchErr || !request) {
        return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'Request not found' }) };
      }

      // Check if already decided
      if (request.status === 'approved' || request.status === 'denied') {
        const { data: approval } = await supabase
          .from('expense_request_approvals')
          .select('decision, decided_at')
          .eq('request_id', request.id)
          .order('decided_at', { ascending: false })
          .limit(1)
          .single();

        return {
          statusCode: 200,
          headers: corsHeaders(),
          body: JSON.stringify({
            already_decided: true,
            decision: approval?.decision || request.status,
            decided_at: approval?.decided_at || request.updated_at,
          }),
        };
      }

      // Load attachments
      const { data: attachments } = await supabase
        .from('expense_request_attachments')
        .select('*')
        .eq('request_id', request.id);

      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ request: { ...request, attachments: attachments || [] } }),
      };
    } catch (err) {
      console.error('expense-request-decide GET error:', err);
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  // ---------- POST: Record decision ----------
  if (event.httpMethod === 'POST') {
    try {
      const { token, decision, reason_note, signature_data } = JSON.parse(event.body || '{}');

      if (!token || !decision) {
        return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'token and decision required' }) };
      }

      if (!['approved', 'denied'].includes(decision)) {
        return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'decision must be approved or denied' }) };
      }

      const payload = verifyToken(token);
      if (!payload || payload.type !== 'expense_approval') {
        return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid token' }) };
      }

      if (payload.exp && Date.now() > payload.exp) {
        return { statusCode: 410, headers: corsHeaders(), body: JSON.stringify({ error: 'Token expired' }) };
      }

      // Load request
      const { data: request, error: fetchErr } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('id', payload.request_id)
        .single();

      if (fetchErr || !request) {
        return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'Request not found' }) };
      }

      // Prevent double-decision
      if (request.status === 'approved' || request.status === 'denied') {
        return {
          statusCode: 409,
          headers: corsHeaders(),
          body: JSON.stringify({ error: 'Already decided', status: request.status }),
        };
      }

      // Get client IP
      const clientIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || event.headers['client-ip']
        || 'unknown';

      const userAgent = event.headers['user-agent'] || null;

      // Record approval in ops.expense_request_approvals
      const { error: approvalErr } = await supabase
        .from('expense_request_approvals')
        .insert({
          request_id: request.id,
          decision,
          decided_by: request.manager_email,
          reason_note: reason_note || null,
          signature_url: signature_data || null,  // stores base64 data URL
          ip_address: clientIp,
          user_agent: userAgent,
          decided_at: new Date().toISOString(),
          magic_token: token,
        });

      if (approvalErr) {
        console.error('Failed to insert approval:', approvalErr);
        return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Failed to record decision' }) };
      }

      // Update request status
      await supabase
        .from('expense_requests')
        .update({ status: decision })
        .eq('id', request.id);

      // Notify submitter via email
      const submitterEmail = await getUserEmail(request.submitted_by);
      if (submitterEmail) {
        try {
          await sendEmail({
            to: submitterEmail,
            subject: `Your ${request.type === 'expense' ? 'Expense' : 'Purchase Request'} was ${decision}`,
            html: outcomeEmailHtml(request, decision, reason_note),
          });
        } catch (emailErr) {
          console.error('Failed to send outcome email:', emailErr);
          // Non-fatal — decision was recorded
        }
      }

      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true, decision }),
      };
    } catch (err) {
      console.error('expense-request-decide POST error:', err);
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Internal server error' }) };
    }
  }

  return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
};
