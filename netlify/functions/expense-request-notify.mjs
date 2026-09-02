import { createClient } from '@supabase/supabase-js';
import { sendEmail, EMAIL_FROM } from './email-helpers.mjs';
import { qboQuery } from './qbo-helpers.mjs';
import { routeForApproval } from './lib/expense-approval.mjs';
import { brixpenseEmail, kvRow, kvTable, esc, money } from './lib/brixpense-email.mjs';

// Hardcoded on purpose — the anon key is a PUBLIC client identifier per
// Supabase's architecture (security is via RLS, not key secrecy). Same
// value ships in the Vite frontend bundle. Hardcoding here prevents a
// mis-set Netlify env var from breaking the function.
const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
const SITE_URL = process.env.URL || 'https://alamedapointbg.com';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const DEFAULT_COGS_ACCOUNT_ID = '101';

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400) { return json({ error: m }, s); }
function fmt(n) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0); }

/** Anon key + user's bearer token. RLS applies — caller's auth.uid() drives access. */
function client(authHeader) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
}

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
    for (const w of words.slice(0, 3)) {
      const clean = w.replace(/[^a-zA-Z0-9]/g, '');
      if (!clean) continue;
      const like = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${clean}%'`);
      const v2 = like.QueryResponse?.Vendor || [];
      if (v2.length === 1) return v2[0];
      if (v2.length > 1) {
        const best = v2.find(x => x.DisplayName.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.DisplayName.toLowerCase()));
        if (best) return best;
      }
    }
  } catch {}
  return null;
}

// Bill/Purchase creation (and QBO vendor matching for the paid-vs-bill
// validation below) now lives entirely in expense-request-link-bill.mjs —
// that's the one place a human explicitly triggers a QBO write. Don't
// reintroduce a QBO-posting payload builder here; this file only auto-
// approves and validates that a later post *would* succeed.

function buildNotificationEmailHtml(request, reviewUrl) {
  const lineItemsHtml = (request.line_items || []).map((li, i) => {
    const amt = (li.qty || 1) * (li.unit_price || 0) || (li.amount || 0);
    return `<tr><td style="padding:9px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;"><div style="font-weight:600;color:#111827;">${li.description || `Line ${i + 1}`}</div><div style="font-size:11px;color:#6b7280;">${li.qty || 1} × ${fmt(li.unit_price || 0)}</div></td><td style="padding:9px 10px;text-align:right;font-size:13px;font-weight:600;color:#111827;">${fmt(amt)}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><div style="max-width:640px;margin:0 auto;background:#ffffff;padding:32px 28px;"><div style="border-bottom:3px solid #5BB5F0;padding-bottom:14px;margin-bottom:22px;"><div style="font-size:22px;font-weight:800;color:#06121F;">BRI<span style="color:#2EB872;">X</span>PENSE — Approval Required</div><div style="font-size:13px;color:#6b7280;margin-top:4px;">${request.submitter_name || 'A team member'} · ${fmt(request.total_amount)}</div></div><p style="font-size:15px;color:#111827;line-height:1.6;margin:0 0 14px 0;"><strong>${request.submitter_name || 'A team member'}</strong> submitted a purchase request and routed it to you. Click below to review, sign, and approve or decline.</p>${request.memo ? `<div style="background:#fff7ed;border-left:4px solid #5BB5F0;padding:12px 14px;border-radius:4px;margin:0 0 18px 0;"><div style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Note from submitter</div><div style="font-size:14px;color:#111827;white-space:pre-wrap;">${request.memo}</div></div>` : ''}<table style="width:100%;margin:0 0 18px 0;font-size:13px;border-collapse:collapse;"><tr><td style="padding:6px 0;color:#6b7280;width:140px;">Vendor</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${request.vendor_name || '—'}</td></tr><tr><td style="padding:6px 0;color:#6b7280;">Department</td><td style="padding:6px 0;color:#0f172a;">${request.department || '—'}</td></tr><tr><td style="padding:6px 0;color:#6b7280;">Account</td><td style="padding:6px 0;color:#0f172a;">${request.cogs_account_label || '—'}</td></tr>${request.receipt_date ? `<tr><td style="padding:6px 0;color:#6b7280;">Needed By</td><td style="padding:6px 0;color:#0f172a;">${request.receipt_date}</td></tr>` : ''}<tr style="border-top:2px solid #e5e7eb;"><td style="padding:10px 0;color:#0f172a;font-weight:700;">Total</td><td style="padding:10px 0;color:#5BB5F0;font-weight:800;font-size:18px;">${fmt(request.total_amount)}</td></tr></table>${lineItemsHtml ? `<table style="width:100%;border-collapse:collapse;margin:0 0 18px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;"><thead><tr style="background:#f9fafb;"><th style="padding:9px 10px;text-align:left;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;">Item</th><th style="padding:9px 10px;text-align:right;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;">Amount</th></tr></thead><tbody>${lineItemsHtml}</tbody></table>` : ''}<div style="text-align:center;margin:30px 0 14px 0;"><a href="${reviewUrl}" style="display:inline-block;padding:14px 36px;background:#5BB5F0;color:#06121F;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Review & Sign →</a></div><p style="font-size:12px;color:#6b7280;text-align:center;margin:10px 0 0 0;">You'll be asked to sign in with your @brixbev.com account before approving.</p><hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 14px 0;" /><p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0;">Alameda Point Beverage Group · BRIXPENSE</p></div></body></html>`;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return err('Unauthorized — Bearer token required', 401);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }
  const { requestId } = body;
  if (!requestId) return err('Missing requestId');

  const sb = client(authHeader);

  const { data: request, error: fetchErr } = await sb
    .schema('ops')
    .from('expense_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (fetchErr || !request) {
    console.error('notify: lookup failed', { requestId, fetchErr });
    return err(`Expense request not found (id=${requestId}, err=${fetchErr?.message || 'no row'})`, 404);
  }
  // Expenses can be re-submitted from 'approved' (not just 'draft') — a
  // human editing an approved-but-unposted expense to fix a bad field (wrong
  // date, wrong vendor) needs Submit to re-validate it, not reject it because
  // it was already approved once. PRs keep the stricter 'draft'-only gate —
  // that flow moves through manager decide/fulfill, never back through here.
  const resubmittableStatuses = request.request_type === 'expense' ? ['draft', 'approved'] : ['draft'];
  if (!resubmittableStatuses.includes(request.status)) return err(`Request is already "${request.status}", cannot submit`, 409);
  const wasAlreadyApproved = request.status === 'approved';

  if (request.request_type === 'expense') {
    const now = new Date().toISOString();

    // GATE (Sky, 2026-08-13): expenses no longer post to QuickBooks as a side
    // effect of Submit. This step only auto-approves — no manager workflow,
    // same as always — but the actual QBO Bill/Purchase write is a SEPARATE,
    // explicit action (expense-request-link-bill, mode=create) that a human
    // must trigger after seeing exactly what's about to be created. Every
    // expense sits in Brixpense as 'approved' until someone posts it.
    //
    // Still validate here so the submitter finds out immediately if the post
    // will fail later (missing vendor for a bill, missing payment account for
    // a purchase) rather than discovering it only when they try to post.
    if (request.as_bill) {
      const vendor = await findQBOVendor(request.vendor_name);
      if (!vendor) {
        return err(`"Not paid — create bill" requires a vendor that already exists in QBO. "${request.vendor_name || ''}" didn't match. Create the vendor in QBO first, then resubmit.`, 422);
      }
    } else if (!request.payment_account_id) {
      return err('payment_account_id is required for expense receipts. Pick a "Paid with" account on the form.', 422);
    }

    // APPROVAL LIMITS (Sky, 2026-09-02). Expenses used to auto-approve
    // unconditionally. Now the submitter's own limit decides: within it, this
    // behaves exactly as before; over it, the expense goes to the first person
    // up their chain who can actually sign for that amount. The QBO gate is
    // untouched either way — approval is not posting.
    const { data: people } = await sb.schema('ops').from('expense_people')
      .select('email,full_name,job,approval_limit,approver_email,active').eq('active', true);
    const route = routeForApproval({
      amount: request.total_amount,
      submitterEmail: request.submitter_email,
      people: people || [],
    });

    if (!route.autoApprove) {
      // A gap is reported, never auto-approved and never parked in a queue
      // nobody owns — an unowned approval is the failure that makes a limit
      // worthless.
      if (route.gap || !route.approver?.email) return err(route.reason, 422);

      const { error: pendErr } = await sb.schema('ops').from('expense_requests').update({
        status: 'pending', auto_approved: false,
        approved_by: null, approved_at: null,
        manager_email: route.approver.email, approval_token: null,
      }).eq('id', requestId);
      if (pendErr) return err('Failed to send this for approval', 500);
      await sb.schema('ops').from('expense_approvals').insert({
        request_id: requestId, action: 'submitted',
        decided_by: request.submitter_email || 'submitter',
        notes: route.reason, token_used: null,
      });

      let sentTo = null;
      try {
        const reviewUrl = `${SITE_URL.replace(/\/$/, '')}/expense/review/${requestId}`;
        const html = brixpenseEmail('#F59E0B', 'Approval needed', `
          <p style="margin:0 0 12px;color:#CBD5E1">${esc(route.reason)}</p>
          ${kvTable([
            kvRow('Submitted by', esc(request.submitter_name || request.submitter_email || '—')),
            kvRow('Vendor', esc(request.vendor_name || '—')),
            kvRow('Amount', money(request.total_amount || 0)),
            kvRow('Date', esc(request.receipt_date || '—')),
            ...(request.job_number ? [kvRow('Job', esc(request.job_number))] : []),
          ].join(''))}
          <p style="margin:18px 0 0"><a href="${reviewUrl}"
            style="background:#F59E0B;color:#0F172A;padding:10px 18px;border-radius:6px;
                   text-decoration:none;font-weight:600">Review it →</a></p>`);
        const ok = await sendEmail({
          to: route.approver.email,
          subject: `Approval needed — ${request.vendor_name || 'expense'} ${money(request.total_amount)}`,
          html,
          replyTo: request.submitter_email || EMAIL_FROM,
        });
        if (ok) sentTo = route.approver.email;
      } catch { /* the row is in their queue regardless; the email is a nudge */ }

      return json({
        success: true, auto_approved: false, new_status: 'pending', request_id: requestId,
        needs_approval: true, approver: route.approver.email, notified: sentTo,
        reason: route.reason, mode: request.as_bill ? 'bill' : 'purchase',
      });
    }

    const { error: updateErr } = await sb.schema('ops').from('expense_requests').update({
      status: 'approved', auto_approved: true,
      approved_by: 'auto', approved_at: now,
      manager_email: null, approval_token: null,
    }).eq('id', requestId);
    if (updateErr) return err('Failed to auto-approve', 500);
    await sb.schema('ops').from('expense_approvals').insert({
      request_id: requestId, action: 'approved',
      decided_by: 'system (auto-approve)',
      notes: wasAlreadyApproved
        ? 'Re-validated after edit — still awaiting manual post to QuickBooks.'
        : `Auto-approved (${route.reason}) — awaiting manual post to QuickBooks.`,
      token_used: null,
    });
    return json({
      success: true, auto_approved: true, new_status: 'approved', request_id: requestId,
      ready_to_post: true, mode: request.as_bill ? 'bill' : 'purchase',
    });
  }

  if (request.request_type !== 'purchase_request') return err(`Unknown request_type "${request.request_type}"`, 400);
  if (!request.manager_email) return err('Purchase requests require an approver.', 422);

  const { data: managerSetting } = await sb.schema('ops').from('expense_settings').select('value').eq('key', 'manager_emails').single();
  const managerList = Array.isArray(managerSetting?.value) ? managerSetting.value.map((e) => String(e).toLowerCase()) : [];
  const chosen = String(request.manager_email).toLowerCase();
  if (managerList.length > 0 && !managerList.includes(chosen)) {
    return err(`Approver "${request.manager_email}" is not in the manager_emails allowlist.`, 422);
  }

  const { error: updateErr } = await sb.schema('ops').from('expense_requests').update({ status: 'pending', approval_token: null }).eq('id', requestId);
  if (updateErr) return err('Failed to submit for approval', 500);

  const reviewUrl = `${SITE_URL.replace(/\/$/, '')}/expense/review/${requestId}`;
  const subject = `[BRIXPENSE] PR from ${request.submitter_name || 'a team member'} — ${fmt(request.total_amount)} awaiting your approval`;
  const html = buildNotificationEmailHtml(request, reviewUrl);

  let emailSent = false;
  let emailError = null;
  try {
    emailSent = await sendEmail({ to: request.manager_email, subject, html, replyTo: request.submitter_email || EMAIL_FROM });
  } catch (e) {
    console.error('Resend send failed:', e);
    emailError = e?.message || 'Unknown email error';
  }

  return json({
    success: true, auto_approved: false,
    email_sent: !!emailSent, email_error: emailError,
    new_status: 'pending', request_id: requestId,
    approver: request.manager_email, review_url: reviewUrl,
  });
}

export const config = { path: '/api/expense-request-notify' };
