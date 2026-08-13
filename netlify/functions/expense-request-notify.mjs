import { createClient } from '@supabase/supabase-js';
import { sendEmail, EMAIL_FROM } from './email-helpers.mjs';
import { qboRequest, qboQuery } from './qbo-helpers.mjs';
import { attachReceiptsToQBO } from './lib/qbo-attach.mjs';
import { findMatchingInvoice, computeMargin, summarizeInvoice } from './qbo-invoice-match.mjs';

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
function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

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

// Receipt-style expenses post as QBO Purchase (not Bill). Differences:
//   - VendorRef → EntityRef (optional). If a QBO Vendor matches the typed
//     name we still attach it for reporting, but we don't gate the post on
//     finding one. The submitted vendor_name is preserved in line
//     descriptions and the memo so it shows on the transaction.
//   - AccountRef on the Purchase itself = the payment account (credit card
//     / bank), captured per-expense via the "Paid with" picker on the form.
//   - PaymentType = derived from the picked account's AccountType.
//
// The PR-flow Bill posting (purchase_request) has its own buildBillPayload
// in expense-request-link-bill.mjs — this file no longer posts Bills at all
// since the expense branch now goes through Purchase. Don't reintroduce a
// Bill helper here without a matching call site.
function paymentTypeFromAccountType(accountType) {
  const t = String(accountType || '').toLowerCase();
  if (t === 'credit card') return 'CreditCard';
  if (t === 'bank') return 'Check';
  // Return null for empty / unknown so the caller's fallback chain falls
  // through to the next option instead of being short-circuited by a
  // truthy 'Cash' default. The 'Cash' classification only makes sense
  // when an operator-picked AccountType is genuinely "Other" or similar.
  if (!t) return null;
  return 'Cash';
}

// "Not paid — create bill" path: build a /bill payload (unpaid AP) instead
// of a /purchase payload. Vendor is required here because QBO Bills don't
// accept a free-floating expense without a VendorRef. Lines are the same
// AccountBasedExpenseLineDetail shape — the difference vs Purchase is the
// top-level VendorRef + no AccountRef/PaymentType.
function buildBillPayload(r, vendor, fallback, prApproval) {
  const items = Array.isArray(r.line_items) ? r.line_items : [];
  const accountId = r.cogs_account_id || fallback;
  const lines = items.length > 0
    ? items.map((li, idx) => ({
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round((li.qty || li.quantity || 1) * (li.unit_price || li.unitCost || 0)) || round(li.amount || 0),
        Description: li.description || `Line ${idx + 1}`,
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, BillableStatus: 'NotBillable' },
      }))
    : [{
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round(r.total_amount),
        Description: r.memo || r.vendor_name || 'Brixpense expense',
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, BillableStatus: 'NotBillable' },
      }];
  const approvalPrefix = prApproval
    ? [
        `PR approved by ${prApproval.decided_by || 'manager'}` +
          (prApproval.decided_at ? ` on ${String(prApproval.decided_at).slice(0, 10)}` : ''),
        r.linked_pr_id ? `linked PR: ${String(r.linked_pr_id).slice(0, 8)}` : null,
      ].filter(Boolean).join(' | ')
    : null;
  const memo = [
    approvalPrefix,
    `BRIXpense expense ${r.id} (unpaid bill)`,
    r.entity ? `entity:${r.entity}` : null,
    r.department ? `dept:${r.department}` : null,
    r.tag ? `tag:${r.tag}` : null,
    r.customer_name ? `cust:${r.customer_name}` : null,
    r.job_number ? `job:${r.job_number}` : null,
    r.memo || null,
  ].filter(Boolean).join(' | ');
  const payload = {
    VendorRef: { value: vendor.Id },
    Line: lines,
    PrivateNote: memo.substring(0, 4000),
  };
  // QBO Location tracking — "Department" line on the bill.
  if (r.qbo_department_id) payload.DepartmentRef = { value: String(r.qbo_department_id) };
  if (r.receipt_date) payload.TxnDate = r.receipt_date;
  // Vendor invoice/bill number — OCR-extracted (sf-expense-ocr-background) or
  // typed in by hand on the form → QBO's "Bill no." QBO's DocNumber caps at 21 chars.
  if (r.bill_number) payload.DocNumber = String(r.bill_number).trim().slice(0, 21);
  return payload;
}

function buildPurchasePayload(r, paymentAccount, optionalVendor, fallback, prApproval) {
  const items = Array.isArray(r.line_items) ? r.line_items : [];
  const accountId = r.cogs_account_id || fallback;
  const lines = items.length > 0
    ? items.map((li, idx) => ({
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round((li.qty || li.quantity || 1) * (li.unit_price || li.unitCost || 0)) || round(li.amount || 0),
        Description: li.description || `Line ${idx + 1}`,
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, BillableStatus: 'NotBillable' },
      }))
    : [{
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round(r.total_amount),
        Description: r.memo || r.vendor_name || 'Brixpense expense',
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId }, BillableStatus: 'NotBillable' },
      }];
  // When this expense fulfills an approved PR, lead the PrivateNote with the
  // manager-approval audit so QBO carries the chain-of-custody in plain text
  // (operator opens the Purchase in QBO → sees who approved + when + which PR
  // without leaving QBO). Falls through silently if there's no linked PR.
  const approvalPrefix = prApproval
    ? [
        `PR approved by ${prApproval.decided_by || 'manager'}` +
          (prApproval.decided_at ? ` on ${String(prApproval.decided_at).slice(0, 10)}` : ''),
        r.linked_pr_id ? `linked PR: ${String(r.linked_pr_id).slice(0, 8)}` : null,
      ].filter(Boolean).join(' | ')
    : null;
  const memo = [
    approvalPrefix,
    `BRIXpense expense ${r.id}`,
    r.vendor_name ? `vendor:${r.vendor_name}` : null,
    r.entity ? `entity:${r.entity}` : null,
    r.department ? `dept:${r.department}` : null,
    r.tag ? `tag:${r.tag}` : null,
    r.customer_name ? `cust:${r.customer_name}` : null,
    r.job_number ? `job:${r.job_number}` : null,
    r.memo || null,
  ].filter(Boolean).join(' | ');
  // PaymentType source-of-truth chain (per the migration comment):
  //   1. fresh QBO Account lookup (paymentAccount.payment_type)
  //   2. cached payment_account_type on the row (the column exists for
  //      exactly this case — a transient QBO 5xx during the SELECT
  //      shouldn't downgrade a Bank-account expense to CreditCard)
  //   3. hardcoded 'CreditCard' (covers the legacy corp-card case for rows
  //      that pre-date the column)
  const paymentType = paymentAccount?.payment_type
    || paymentTypeFromAccountType(r.payment_account_type)
    || 'CreditCard';
  const payload = {
    AccountRef: { value: r.payment_account_id },
    PaymentType: paymentType,
    Line: lines,
    PrivateNote: memo.substring(0, 4000),
  };
  if (optionalVendor?.Id) {
    payload.EntityRef = { value: optionalVendor.Id, type: 'Vendor' };
  }
  // QBO Location tracking — "Department" line on the purchase.
  if (r.qbo_department_id) payload.DepartmentRef = { value: String(r.qbo_department_id) };
  if (r.receipt_date) payload.TxnDate = r.receipt_date;
  return payload;
}

async function maybeMarginMatch(request, billTotal) {
  if (!request?.job_number) return null;
  try {
    const inv = await findMatchingInvoice(request.job_number, null);
    if (!inv) return { matched: false, job_number: request.job_number };
    const invSummary = summarizeInvoice(inv);
    const { margin, marginPct } = computeMargin(invSummary.total, billTotal);
    return { matched: true, job_number: request.job_number, invoice: invSummary, margin, marginPct };
  } catch (e) {
    console.warn('maybeMarginMatch failed (non-fatal):', e?.message);
    return null;
  }
}

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
  if (request.status !== 'draft') return err(`Request is already "${request.status}", cannot submit`, 409);

  if (request.request_type === 'expense') {
    const now = new Date().toISOString();

    // Bill flow — the user picked "Not paid — create bill" on the form, so we
    // post the expense as an unpaid QBO Bill (AP) instead of a paid Purchase.
    // Bills *require* a vendor in QBO, so the vendor name has to resolve.
    if (request.as_bill) {
      const vendor = await findQBOVendor(request.vendor_name);
      if (!vendor) {
        return err(`"Not paid — create bill" requires a vendor that already exists in QBO. "${request.vendor_name || ''}" didn't match. Create the vendor in QBO first, then resubmit.`, 422);
      }
      let prApproval = null;
      if (request.linked_pr_id) {
        const { data: app } = await sb
          .schema('ops')
          .from('expense_approvals')
          .select('decided_by, decided_at, action')
          .eq('request_id', request.linked_pr_id)
          .eq('action', 'approved')
          .order('decided_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (app) prApproval = app;
      }
      let qboBill = null, qboError = null;
      try {
        const payload = buildBillPayload(request, vendor, DEFAULT_COGS_ACCOUNT_ID, prApproval);
        const qboRes = await qboRequest('POST', '/bill', payload);
        qboBill = qboRes?.Bill;
        if (!qboBill?.Id) qboError = 'QBO did not return a Bill ID';
      } catch (e) {
        console.error('QBO Bill post failed:', e);
        qboError = e?.message || 'QBO Bill post failed';
      }
      if (!qboBill?.Id) {
        return err(`QBO Bill post failed: ${qboError || 'unknown'}`, 502);
      }
      // Receipt photos ride onto the QBO bill (best-effort, never blocks).
      try { await attachReceiptsToQBO('Bill', qboBill.Id, requestId); } catch { /* non-fatal */ }
      const { error: updateErr } = await sb.schema('ops').from('expense_requests').update({
        status: 'posted', auto_approved: true,
        approved_by: 'auto', approved_at: now, posted_at: now,
        manager_email: null, approval_token: null,
        qbo_bill_id: qboBill.Id,
      }).eq('id', requestId);
      if (updateErr) return json({ success: true, partial: true, qbo_bill_id: qboBill.Id }, 207);
      await sb.schema('ops').from('expense_approvals').insert({
        request_id: requestId, action: 'approved',
        decided_by: 'system (auto-approve + bill mode)',
        notes: `Auto-approved + posted to QBO as Bill ${qboBill.DocNumber || qboBill.Id} (vendor: ${vendor.DisplayName}) — unpaid, awaiting QBO payment.`,
        token_used: null,
      });
      return json({
        success: true, mode: 'bill',
        request_id: requestId,
        qbo_bill_id: qboBill.Id,
        qbo_doc_number: qboBill.DocNumber,
        vendor: vendor.DisplayName,
      });
    }

    if (!request.payment_account_id) {
      return err('payment_account_id is required for expense receipts. Pick a "Paid with" account on the form.', 422);
    }
    let optionalVendor = null, qboTxn = null, qboError = null;
    try {
      // Vendor is best-effort — if we recognize the typed name we attach the
      // EntityRef for QBO reporting, but a missing vendor no longer blocks
      // the post. The vendor name still lives in the line description + memo.
      try { optionalVendor = await findQBOVendor(request.vendor_name); } catch {}
      // Resolve the payment account so we can pick the right PaymentType.
      // If the lookup fails we fall back to CreditCard, since that covers
      // the corp-card receipt case that drove this design.
      let paymentAccount = null;
      try {
        const acctRes = await qboQuery(
          `SELECT Id, Name, AccountType FROM Account WHERE Id = '${String(request.payment_account_id).replace(/'/g, "\\'")}'`
        );
        const a = acctRes?.QueryResponse?.Account?.[0];
        if (a) {
          const t = String(a.AccountType || '').toLowerCase();
          paymentAccount = {
            id: a.Id,
            name: a.Name,
            payment_type: t === 'credit card' ? 'CreditCard' : t === 'bank' ? 'Check' : 'Cash',
          };
        }
      } catch {}
      // If this expense fulfills an approved PR, fetch the PR's most-recent
      // approval row so we can stamp "approved by X on Y" into the Purchase's
      // PrivateNote. Server-side lookup — never trust a client to assert who
      // approved what.
      let prApproval = null;
      if (request.linked_pr_id) {
        const { data: app } = await sb
          .schema('ops')
          .from('expense_approvals')
          .select('decided_by, decided_at, action')
          .eq('request_id', request.linked_pr_id)
          .eq('action', 'approved')
          .order('decided_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (app) prApproval = app;
      }
      const payload = buildPurchasePayload(request, paymentAccount, optionalVendor, DEFAULT_COGS_ACCOUNT_ID, prApproval);
      const qboRes = await qboRequest('POST', '/purchase', payload);
      qboTxn = qboRes?.Purchase;
      if (!qboTxn?.Id) qboError = 'QBO did not return a Purchase ID';
    } catch (e) {
      console.error('QBO Purchase post failed:', e);
      qboError = e?.message || 'QBO Purchase post failed';
    }

    if (qboTxn?.Id) {
      // Receipt photos ride onto the QBO Purchase (best-effort, never blocks).
      try { await attachReceiptsToQBO('Purchase', qboTxn.Id, requestId); } catch { /* non-fatal */ }
      const { error: updateErr } = await sb.schema('ops').from('expense_requests').update({
        status: 'posted', auto_approved: true,
        approved_by: 'auto', approved_at: now, posted_at: now,
        manager_email: null, approval_token: null,
        // The qbo_bill_id column predates the Bill→Purchase split. We reuse it
        // to store the Purchase Id so existing reporting / margin-match code
        // keeps working without a schema-wide rename.
        qbo_bill_id: qboTxn.Id,
      }).eq('id', requestId);
      if (updateErr) return json({ success: true, partial: true, qbo_purchase_id: qboTxn.Id }, 207);
      await sb.schema('ops').from('expense_approvals').insert({
        request_id: requestId, action: 'approved',
        decided_by: 'system (auto-approve + auto-post)',
        notes: `Auto-approved + posted to QBO as Purchase ${qboTxn.DocNumber || qboTxn.Id}${optionalVendor ? ` (vendor: ${optionalVendor.DisplayName})` : ''}`,
        token_used: null,
      });

      // Close the loop on the source PR if this expense was filed via
      // PendingList's "Log Receipt" CTA. The PR's status flips from
      // 'awaiting_invoice' → 'fulfilled' so it stops showing the CTA and
      // disappears from open-PR rollups. Best-effort: if the update errors
      // we surface it but don't fail the whole post (the Purchase is real,
      // the audit log already captured the approval chain, this is only a
      // bookkeeping hygiene step).
      let fulfilledPRId = null;
      if (request.linked_pr_id) {
        const { error: prErr } = await sb.schema('ops').from('expense_requests').update({
          status: 'fulfilled',
          updated_at: now,
        }).eq('id', request.linked_pr_id);
        if (prErr) {
          console.warn('Failed to flip linked PR to fulfilled:', prErr.message);
        } else {
          fulfilledPRId = request.linked_pr_id;
        }
      }

      const marginMatch = await maybeMarginMatch(request, Number(request.total_amount) || 0);

      return json({
        success: true, auto_approved: true, new_status: 'posted',
        request_id: requestId, qbo_purchase_id: qboTxn.Id,
        fulfilled_pr_id: fulfilledPRId,
        margin_match: marginMatch,
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
      notes: `Auto-approved. QBO Purchase post deferred: ${qboError}.`,
      token_used: null,
    });
    return json({ success: true, auto_approved: true, new_status: 'approved', request_id: requestId, qbo_post_deferred: true, qbo_error: qboError });
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
