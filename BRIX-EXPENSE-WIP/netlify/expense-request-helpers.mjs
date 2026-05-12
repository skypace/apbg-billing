// Shared helpers for the Brix Expense request lifecycle.
//
// - Supabase service-role REST wrapper (writes that bypass user-scoped RLS)
// - HMAC-free random token generator for single-use approval URLs
// - Resend email sender (gracefully no-ops if RESEND_API_KEY missing)

import { randomBytes } from 'node:crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESEND_KEY    = process.env.RESEND_API_KEY;
const RESEND_FROM   = process.env.RESEND_FROM || 'Brix Expense <expense@alamedapointbg.com>';

export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://alamedapointbg.com/billing/sales-next';

function assertServiceKey() {
  if (!SB_SERVICE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY not set in Netlify env');
  }
}

async function sbRequest(method, path, body) {
  assertServiceKey();
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Profile': 'ops',
      'Accept-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
  return data;
}

export async function insertRequest(row) {
  const rows = await sbRequest('POST', 'expense_requests', row);
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function getRequestByToken(token) {
  const rows = await sbRequest('GET', `expense_requests?approve_token=eq.${encodeURIComponent(token)}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getRequestById(id) {
  const rows = await sbRequest('GET', `expense_requests?id=eq.${encodeURIComponent(id)}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function updateRequest(id, patch) {
  const rows = await sbRequest('PATCH', `expense_requests?id=eq.${encodeURIComponent(id)}`, patch);
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function recordApproval(row) {
  return sbRequest('POST', 'expense_request_approvals', row);
}

export function genApprovalToken() {
  return randomBytes(24).toString('base64url');
}

/** Send an email via Resend. No-ops (returns {sent:false}) when the env
 *  isn't configured, so the rest of the flow still works in dev. */
export async function sendResendEmail({ to, subject, html, text, replyTo }) {
  if (!RESEND_KEY) {
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }
  const body = {
    from: RESEND_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: text || undefined,
    reply_to: replyTo || undefined,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { sent: false, reason: data?.message || `Resend ${res.status}` };
  }
  return { sent: true, id: data?.id };
}

export function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function approvalEmailHtml({ request, approveUrl }) {
  const lines = (request.line_items || []).map((li) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #E2E8F0;font-size:13px">${escapeHtml(li.description || '')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;text-align:right">${li.quantity}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;text-align:right">${fmtMoney(li.unitCost)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #E2E8F0;font-size:13px;text-align:right;font-weight:600">${fmtMoney((li.quantity || 1) * (li.unitCost || 0))}</td>
      </tr>`).join('');

  const kindLabel = request.kind === 'purchase_request' ? 'Purchase Request' : 'Expense';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0F172A">
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#1F4E79;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;letter-spacing:2px;font-weight:700;opacity:0.7">BRIX EXPENSE</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">Approval needed — ${escapeHtml(kindLabel)}</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 8px 8px;padding:24px">
        <div style="font-size:14px;color:#475569;margin-bottom:16px">
          <strong>${escapeHtml(request.submitter_email)}</strong> submitted a ${escapeHtml(kindLabel.toLowerCase())} of
          <strong style="color:#1F4E79;font-size:18px">${fmtMoney(request.total_amount)}</strong> and routed it to you for approval.
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
          <tr><td style="color:#64748B;padding:4px 0;width:40%">Vendor</td><td style="font-weight:600">${escapeHtml(request.vendor_name || '—')}</td></tr>
          <tr><td style="color:#64748B;padding:4px 0">Account</td><td>${escapeHtml(request.account_label)}</td></tr>
          <tr><td style="color:#64748B;padding:4px 0">Tag · Dept</td><td>${escapeHtml(request.tag || '—')} · ${escapeHtml(request.department || '—')}</td></tr>
          ${request.job_number ? `<tr><td style="color:#64748B;padding:4px 0">SF/ResQ Job#</td><td>${escapeHtml(request.job_number)}</td></tr>` : ''}
          ${request.customer_name ? `<tr><td style="color:#64748B;padding:4px 0">Customer</td><td>${escapeHtml(request.customer_name)}</td></tr>` : ''}
          ${request.memo ? `<tr><td style="color:#64748B;padding:4px 0;vertical-align:top">Note</td><td>${escapeHtml(request.memo)}</td></tr>` : ''}
        </table>

        ${lines ? `<table style="width:100%;border-collapse:collapse;border-top:1px solid #E2E8F0;margin-bottom:24px">
          <thead><tr style="background:#F1F5F9">
            <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748B">Description</th>
            <th style="text-align:right;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748B">Qty</th>
            <th style="text-align:right;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748B">Unit</th>
            <th style="text-align:right;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748B">Total</th>
          </tr></thead>
          <tbody>${lines}</tbody>
        </table>` : ''}

        <div style="text-align:center;margin:24px 0">
          <a href="${approveUrl}" style="background:#F59E0B;color:#0F172A;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Review and sign</a>
        </div>
        <div style="font-size:11px;color:#94A3B8;text-align:center">
          You can approve or deny this request, and your signature will be captured for the audit log.
        </div>
      </div>
    </div></body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
