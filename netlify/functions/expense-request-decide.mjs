import { createClient } from '@supabase/supabase-js';
import { sendEmail, EMAIL_FROM } from './email-helpers.mjs';

// Hardcoded — anon key is a PUBLIC client identifier per Supabase
// architecture. Hardcoding here prevents a mis-set Netlify env var
// from breaking the function with "Invalid API key".
const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
const SITE_URL = process.env.URL || 'https://alamedapointbg.com';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400) { return json({ error: m }, s); }
function fmt(n) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0); }

function buildDecisionEmailHtml({ approved, request, signerName, signerInitials, declineReason }) {
  const color = approved ? '#2EB872' : '#FF5A5F';
  const headline = approved ? 'Your Purchase Request was Approved' : 'Your Purchase Request was Declined';
  const subhead = approved
    ? `Signed by <strong>${signerName}</strong>${signerInitials ? ` (${signerInitials})` : ''}`
    : `Declined by <strong>${signerName}</strong>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;padding:32px 28px;">
      <div style="border-bottom:3px solid ${color};padding-bottom:14px;margin-bottom:22px;">
        <div style="font-size:22px;font-weight:800;color:#06121F;">
          BRI<span style="color:#2EB872;">X</span>PENSE — ${approved ? '✓ Approved' : '✗ Declined'}
        </div>
      </div>
      <h2 style="color:${color};font-size:18px;margin:0 0 6px 0;">${headline}</h2>
      <p style="font-size:14px;color:#475569;margin:0 0 18px 0;">${subhead}</p>

      <table style="width:100%;margin:0 0 18px 0;font-size:13px;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#6b7280;width:140px;">Vendor</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${request.vendor_name || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Department</td><td style="padding:6px 0;color:#0f172a;">${request.department || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Account</td><td style="padding:6px 0;color:#0f172a;">${request.cogs_account_label || '—'}</td></tr>
        <tr style="border-top:2px solid #e5e7eb;"><td style="padding:10px 0;color:#0f172a;font-weight:700;">Total</td><td style="padding:10px 0;color:${color};font-weight:800;font-size:18px;">${fmt(request.total_amount)}</td></tr>
      </table>

      ${request.memo ? `<div style="background:#f1f5f9;padding:12px 14px;border-radius:6px;margin:0 0 14px 0;font-size:13px;color:#334155;"><strong>Your original note:</strong><br>${request.memo}</div>` : ''}

      ${!approved && declineReason ? `<div style="background:#fef2f2;border-left:4px solid #FF5A5F;padding:12px 14px;border-radius:4px;margin:0 0 18px 0;"><div style="font-size:12px;font-weight:700;color:#7f1d1d;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Reason for decline</div><div style="font-size:14px;color:#0f172a;white-space:pre-wrap;">${declineReason}</div></div>` : ''}

      <div style="text-align:center;margin:28px 0 12px 0;">
        <a href="${SITE_URL.replace(/\/$/, '')}/expense/pending" style="display:inline-block;padding:12px 28px;background:#5BB5F0;color:#06121F;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;">View in BRIXPENSE</a>
      </div>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px 0;" />
      <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0;">Alameda Point Beverage Group · BRIXPENSE</p>
    </div>
  </body></html>`;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return err('Unauthorized — Bearer token required', 401);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }

  const { requestId, action, signer_name, signer_initials, signature_data_url, decline_reason, notes } = body || {};

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
    .schema('ops')
    .from('expense_requests')
    .select('*')
    .eq('id', requestId)
    .single();
  if (fetchErr || !request) return err(`Expense request not found (id=${requestId}, err=${fetchErr?.message || 'no row'})`, 404);

  if (request.status !== 'pending') return err(`Cannot decide on a request with status "${request.status}"`, 409);
  if (request.submitted_by === user.id) return err('You cannot approve your own request.', 403);
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

  const { error: approvalErr } = await supabase.schema('ops').from('expense_approvals').insert({
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

  const { error: updateErr } = await supabase.schema('ops').from('expense_requests').update({
    status: nextStatus,
    approved_by: isApprove ? signer_name.trim() : null,
    approved_at: isApprove ? now : null,
    denial_reason: isApprove ? null : (decline_reason || null),
  }).eq('id', request.id);

  if (updateErr) {
    console.error('Failed to update request status:', updateErr);
    return err('Decision recorded but status update failed', 500);
  }

  let submitterEmailSent = false;
  let submitterEmailError = null;
  if (request.submitter_email) {
    const subject = isApprove
      ? `[BRIXPENSE] ✓ Approved: PR to ${request.vendor_name || 'vendor'} for ${fmt(request.total_amount)}`
      : `[BRIXPENSE] ✗ Declined: PR to ${request.vendor_name || 'vendor'} for ${fmt(request.total_amount)}`;
    const html = buildDecisionEmailHtml({
      approved: isApprove,
      request,
      signerName: signer_name.trim(),
      signerInitials: signer_initials.trim(),
      declineReason: decline_reason ? decline_reason.trim() : null,
    });
    try {
      submitterEmailSent = await sendEmail({
        to: request.submitter_email,
        subject, html,
        replyTo: user.email || EMAIL_FROM,
      });
    } catch (e) {
      console.error('Decision email failed:', e);
      submitterEmailError = e?.message || 'Unknown email error';
    }
  }

  return json({
    success: true,
    action: finalAction,
    new_status: nextStatus,
    request_id: request.id,
    signer_name: signer_name.trim(),
    submitter_email_sent: !!submitterEmailSent,
    submitter_email_error: submitterEmailError,
  });
}

export const config = { path: '/api/expense-request-decide' };
