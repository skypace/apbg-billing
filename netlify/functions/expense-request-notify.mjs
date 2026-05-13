import { createClient } from '@supabase/supabase-js';
import { sendEmail, EMAIL_FROM } from './email-helpers.mjs';
import { qboRequest, qboQuery } from './qbo-helpers.mjs';

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

function buildNotificationEmailHtml(request, portalUrl) {
  const lineItemsHtml = (request.line_items || []).map((li, i) => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${i + 1}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${li.description || '—'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">${formatUsd(li.amount || 0)}</td>
    </tr>`).join('');

  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:20px;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#06121F;padding:24px 32px;">
      <h1 style="color:#fff;margin:0;font-size:20px;">BRI<span style="color:#2EB872;">X</span>PENSE — PR Awaiting Your Approval</h1>
    </div>
    <div style="padding:24px 32px;">
      <p style="color:#334155;font-size:15px;line-height:1.6;">
        <strong>${request.submitter_name || 'A team member'}</strong> submitted a purchase request and routed it to you for approval.
      </p>
      <table style="width:100%;margin:16px 0;font-size:14px;">
        <tr><td style="color:#64748b;padding:4px 0;width:120px;">Department</td><td style="color:#0f172a;">${request.department || '—'}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Vendor</td><td style="color:#0f172a;">${request.vendor_name || '—'}</td></tr>
        <tr><td style="color:#64748b;padding:4px 0;">Total</td><td style="color:#0f172a;font-weight:600;font-size:16px;">${formatUsd(request.total_amount)}</td></tr>
      </table>
      ${request.memo ? `<p style="color:#475569;font-size:14px;background:#f1f5f9;padding:12px;border-radius:6px;">${request.memo}</p>` : ''}
      ${lineItemsHtml ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
        <thead><tr style="background:#f1f5f9;">
          <th style="padding:8px 12px;text-align:left;">#</th>
          <th style="padding:8px 12px;text-align:left;">Description</th>
          <th style="padding:8px 12px;text-align:right;">Amount</th>
        </tr></thead><tbody>${lineItemsHtml}</tbody>
      </table>` : ''}
      <div style="text-align:center;margin:32px 0 16px;">
        <a href="${portalUrl}" style="display:inline-block;background:#5BB5F0;color:#06121F;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">Open Approval Queue</a>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;">You'll be asked to log into BRIXPENSE before you can approve.</p>
    </div>
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

  // EXPENSE — try QBO post; fall back to approved-only
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
          status: 'posted',
          auto_approved: true,
          approved_by: 'auto',
          approved_at: now,
          posted_at: now,
          manager_email: null,
          approval_token: null,
          qbo_bill_id: qboBill.Id,
        })
        .eq('id', requestId);

      if (updateErr) {
        console.error('Status update failed after QBO post:', updateErr);
        return json({
          success: true, auto_approved: true, partial: true,
          new_status: 'draft', request_id: requestId,
          qbo_bill_id: qboBill.Id,
          message: 'Bill created in QBO but the local status update failed. Fix manually.',
        }, 207);
      }

      await supabase.from('expense_approvals').insert({
        request_id: requestId,
        action: 'approved',
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

    // Fallback — auto-approve without QBO
    const { error: updateErr } = await supabase
      .from('expense_requests')
      .update({
        status: 'approved',
        auto_approved: true,
        approved_by: 'auto',
        approved_at: now,
        manager_email: null,
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
      notes: `Auto-approved. QBO post deferred: ${qboError}. AP can post manually.`,
      token_used: null,
    });

    return json({
      success: true, auto_approved: true,
      new_status: 'approved', request_id: requestId,
      qbo_post_deferred: true, qbo_error: qboError,
    });
  }

  // PURCHASE REQUEST — notification email
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

  const { error: updateErr } = await supabase
    .from('expense_requests').update({ status: 'pending', approval_token: null }).eq('id', requestId);
  if (updateErr) return err('Failed to submit for approval', 500);

  const portalUrl = `${SITE_URL.replace(/\/$/, '')}/expense/queue`;
  const subject = `[BRIXPENSE] PR from ${request.submitter_name || 'a team member'} — ${formatUsd(request.total_amount)} awaiting your approval`;
  const html = buildNotificationEmailHtml(request, portalUrl);

  const emailSent = await sendEmail({
    to: request.manager_email,
    subject, html,
    replyTo: request.submitter_email || EMAIL_FROM,
  });

  return json({
    success: true, auto_approved: false,
    email_sent: emailSent, new_status: 'pending',
    request_id: requestId, approver: request.manager_email,
    portal_url: portalUrl,
  });
}

export const config = { path: '/api/expense-request-notify' };
