import { createClient } from '@supabase/supabase-js';
import { sendEmail, EMAIL_FROM } from './email-helpers.mjs';
import { qboRequest, qboQuery } from './qbo-helpers.mjs';
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_URL = process.env.URL || 'https://alamedapointbg.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const DEFAULT_COGS_ACCOUNT_ID = '101';

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: CORS }); }
function err(message, status = 400) { return json({ error: message }, status); }
function formatUsd(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
}
function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

async function findQBOVendor(name) {
  if (!name) return null;
  try {
    const safe = name.replace(/'/g, "\\'");
    const exact = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName = '${safe}'`);
    const v = exact.QueryResponse?.Vendor || [];
    if (v.length > 0) return v[0];
  } catch {}
  try {
    const words = name.split(/\s+/).filter(w => w.length > 2);
    for (const word of words.slice(0, 3)) {
      const clean = word.replace(/[^a-zA-Z0-9]/g, '');
      if (!clean) continue;
      const like = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${clean}%'`);
      const v = like.QueryResponse?.Vendor || [];
      if (v.length === 1) return v[0];
      if (v.length > 1) {
        const best = v.find(x =>
          x.DisplayName.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(x.DisplayName.toLowerCase())
        );
        if (best) return best;
      }
    }
  } catch {}
  return null;
}

function buildBillPayload(request, vendor, fallbackAccountId) {
  const items = Array.isArray(request.line_items) ? request.line_items : [];
  const accountId = request.cogs_account_id || fallbackAccountId;
  const lines = items.length > 0
    ? items.map((li, idx) => ({
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round((li.qty || li.quantity || 1) * (li.unit_price || li.unitCost || 0)) || round(li.amount || 0),
        Description: li.description || `Line ${idx + 1}`,
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, BillableStatus: 'NotBillable' },
      }))
    : [{
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round(request.total_amount),
        Description: request.memo || request.vendor_name || 'Brixpense expense',
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, BillableStatus: 'NotBillable' },
      }];

  const memoParts = [
    `BRIXpense ${request.request_type === 'purchase_request' ? 'PR' : 'expense'} ${request.id}`,
    request.entity ? `entity:${request.entity}` : null,
    request.department ? `dept:${request.department}` : null,
    request.tag ? `tag:${request.tag}` : null,
    request.customer_name ? `cust:${request.customer_name}` : null,
    request.job_number ? `job:${request.job_number}` : null,
    request.memo || null,
  ].filter(Boolean);

  const payload = {
    VendorRef: { value: vendor.Id },
    Line: lines,
    PrivateNote: memoParts.join(' | ').substring(0, 4000),
  };
  if (request.receipt_date) payload.TxnDate = request.receipt_date;
  return payload;
}

function buildApprovalEmailHtml(request, approveUrl) {
  const lineItemsHtml = (request.line_items || []).map((li, i) => {
    const amount = (li.qty || li.quantity || 1) * (li.unit_price || li.unitCost || 0) || (li.amount || 0);
    return `
      <tr>
        <td style="padding:9px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;">
          <div style="font-weight:600;color:#111827;">${li.description || `Line ${i + 1}`}</div>
          <div style="font-size:11px;color:#6b7280;">${li.qty || 1} × ${formatUsd(li.unit_price || li.unitCost || 0)}</div>
        </td>
        <td style="padding:9px 10px;text-align:right;font-size:13px;font-weight:600;color:#111827;">${formatUsd(amount)}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;padding:32px 28px;">
    <div style="border-bottom:3px solid #5BB5F0;padding-bottom:14px;margin-bottom:22px;">
      <div style="font-size:22px;font-weight:800;color:#06121F;">
        BRI<span style="color:#2EB872;">X</span>PENSE — Purchase Request Approval
      </div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">
        ${request.submitter_name || 'A team member'} · ${formatUsd(request.total_amount)}
      </div>
    </div>

    <p style="font-size:15px;color:#111827;line-height:1.6;margin:0 0 14px 0;">
      <strong>${request.submitter_name || 'A team member'}</strong> submitted a purchase request and routed it to you for approval. Please review and click <strong>Approve</strong> or <strong>Decline</strong> below.
    </p>

    ${request.memo ? `
      <div style="background:#fff7ed;border-left:4px solid #5BB5F0;padding:12px 14px;border-radius:4px;margin:0 0 18px 0;">
        <div style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Note from submitter</div>
        <div style="font-size:14px;color:#111827;white-space:pre-wrap;">${request.memo}</div>
      </div>
    ` : ''}

    <table style="width:100%;margin:0 0 18px 0;font-size:13px;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6b7280;width:140px;">Vendor</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${request.vendor_name || '—'}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Department</td><td style="padding:6px 0;color:#0f172a;">${request.department || '—'}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Account</td><td style="padding:6px 0;color:#0f172a;">${request.cogs_account_label || '—'}</td></tr>
      ${request.receipt_date ? `<tr><td style="padding:6px 0;color:#6b7280;">Needed By</td><td style="padding:6px 0;color:#0f172a;">${request.receipt_date}</td></tr>` : ''}
      <tr style="border-top:2px solid #e5e7eb;"><td style="padding:10px 0;color:#0f172a;font-weight:700;">Total</td><td style="padding:10px 0;color:#5BB5F0;font-weight:800;font-size:18px;">${formatUsd(request.total_amount)}</td></tr>
    </table>

    ${lineItemsHtml ? `
      <table style="width:100%;border-collapse:collapse;margin:0 0 18px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
        <thead><tr style="background:#f9fafb;">
          <th style="padding:9px 10px;text-align:left;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;">Item</th>
          <th style="padding:9px 10px;text-align:right;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;">Amount</th>
        </tr></thead>
        <tbody>${lineItemsHtml}</tbody>
      </table>
    ` : ''}

    <div style="text-align:center;margin:30px 0 14px 0;">
      <a href="${approveUrl}" style="display:inline-block;padding:14px 36px;background:#5BB5F0;color:#06121F;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">
        Review &amp; Sign →
      </a>
    </div>

    <p style="font-size:12px;color:#6b7280;text-align:center;margin:10px 0 0 0;">
      You'll be able to sign with your mouse, finger, or typed initials on the approval page.
    </p>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 14px 0;" />
    <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0;">
      This request was sent by Alameda Point Beverage Group · BRIXPENSE. If you were not expecting this email, please reply to let us know.
    </p>
  </div>
</body></html>`;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured: missing SUPABASE_ANON_KEY', 500);

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return err('Unauthorized — Bearer token required', 401);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }
  const { requestId } = body;
  if (!requestId) return err('Missing requestId');

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !request) return err('Expense request not found', 404);
  if (request.status !== 'draft') return err(`Request is already "${request.status}", cannot submit`, 409);

  // ── EXPENSE: try QBO post → posted; fall back to approved-only ──
  if (request.request_type === 'expense') {
    const now = new Date().toISOString();
    let vendor = null, qboBill = null, qboError = null;

    try {
      vendor = await findQBOVendor(request.vendor_name);
      if (!vendor) {
        qboError = `Vendor "${request.vendor_name || '(blank)'}" not in QBO`;
      } else {
        const payload = buildBillPayload(request, vendor, DEFAULT_COGS_ACCOUNT_ID);
        const qboRes = await qboRequest('POST', '/bill', payload);
        qboBill = qboRes?.Bill;
        if (!qboBill?.Id) qboError = 'QBO did not return a bill ID';
      }
    } catch (e) {
      console.error('QBO post failed:', e);
      qboError = e?.message || 'QBO post failed';
    }

    if (qboBill?.Id) {
      const { error: updateErr } = await supabase
        .from('expense_requests')
        .update({
          status: 'posted', auto_approved: true,
          approved_by: 'auto', approved_at: now, posted_at: now,
          manager_email: null, approval_token: null,
          qbo_bill_id: qboBill.Id,
        })
        .eq('id', requestId);

      if (updateErr) {
        console.error('Status update failed after QBO post:', updateErr);
        return json({
          success: true, auto_approved: true, partial: true,
          new_status: 'draft', request_id: requestId,
          qbo_bill_id: qboBill.Id,
          message: 'Bill created in QBO but local status update failed.',
        }, 207);
      }

      await supabase.from('expense_approvals').insert({
        request_id: requestId, action: 'approved',
        decided_by: 'system (auto-approve + auto-post)',
        notes: `Auto-approved + posted to QBO as Bill ${qboBill.DocNumber || qboBill.Id} for ${formatUsd(qboBill.TotalAmt || request.total_amount)}.`,
        token_used: null,
      });

      return json({
        success: true, auto_approved: true,
        new_status: 'posted', request_id: requestId,
        qbo_bill_id: qboBill.Id, qbo_doc_number: qboBill.DocNumber,
      });
    }

    // Fallback
    const { error: updateErr } = await supabase
      .from('expense_requests')
      .update({
        status: 'approved', auto_approved: true,
        approved_by: 'auto', approved_at: now,
        manager_email: null, approval_token: null,
      })
      .eq('id', requestId);

    if (updateErr) return err('Failed to auto-approve', 500);

    await supabase.from('expense_approvals').insert({
      request_id: requestId, action: 'approved',
      decided_by: 'system (auto-approve)',
      notes: `Auto-approved. QBO post deferred: ${qboError}.`,
      token_used: null,
    });

    return json({
      success: true, auto_approved: true,
      new_status: 'approved', request_id: requestId,
      qbo_post_deferred: true, qbo_error: qboError,
    });
  }

  // ── PURCHASE REQUEST: magic-link email ──
  if (request.request_type !== 'purchase_request') return err(`Unknown request_type "${request.request_type}"`, 400);
  if (!request.manager_email) return err('Purchase requests require an approver.', 422);

  const { data: managerSetting } = await supabase
    .from('expense_settings').select('value').eq('key', 'manager_emails').single();
  const managerList = Array.isArray(managerSetting?.value)
    ? managerSetting.value.map((e) => String(e).toLowerCase()) : [];
  const chosen = String(request.manager_email).toLowerCase();
  if (managerList.length > 0 && !managerList.includes(chosen)) {
    return err(`Approver "${request.manager_email}" is not in the manager_emails allowlist.`, 422);
  }

  // Generate magic-link token + store on the row + flip to pending in one update
  const token = crypto.randomBytes(32).toString('hex');
  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({ status: 'pending', approval_token: token })
    .eq('id', requestId);

  if (updateErr) {
    console.error('Failed to set pending + token:', updateErr);
    return err('Failed to submit for approval', 500);
  }

  // Build approval URL + send email
  const approveUrl = `${SITE_URL.replace(/\/$/, '')}/expense/approve?token=${encodeURIComponent(token)}`;
  const subject = `[BRIXPENSE] PR from ${request.submitter_name || 'a team member'} — ${formatUsd(request.total_amount)} awaiting your approval`;
  const html = buildApprovalEmailHtml(request, approveUrl);

  let emailSent = false;
  let emailError = null;
  try {
    emailSent = await sendEmail({
      to: request.manager_email,
      subject, html,
      replyTo: request.submitter_email || EMAIL_FROM,
    });
  } catch (e) {
    console.error('Resend send failed:', e);
    emailError = e?.message || 'Unknown email error';
  }

  return json({
    success: true,
    auto_approved: false,
    email_sent: !!emailSent,
    email_error: emailError,
    new_status: 'pending',
    request_id: requestId,
    approver: request.manager_email,
    approve_url: approveUrl,
  });
}

export const config = { path: '/api/expense-request-notify' };
