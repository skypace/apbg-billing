// ============================================================
// expense-request-link-bill.mjs
// The ONE place a human explicitly posts a Brixpense expense/PR to
// QuickBooks. expense-request-notify only auto-approves (draft -> approved)
// and never touches QBO (gate, Sky 2026-08-13) — this function does the
// actual write, for both flavors:
//   - as_bill=true  -> unpaid QBO Bill (requires a matching QBO vendor)
//   - as_bill=false -> paid QBO Purchase (requires payment_account_id)
// Modes: create (default, does the post), preview (dry-run, no writes),
// link (legacy passive — stamp an existing QBO id without posting).
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { qboRequest, qboQuery } from './qbo-helpers.mjs';
import { attachReceiptsToQBO } from './lib/qbo-attach.mjs';
import { findMatchingInvoice, computeMargin, summarizeInvoice } from './qbo-invoice-match.mjs';
import { brixpenseEmail, kvRow, kvTable, esc, money } from './lib/brixpense-email.mjs';
import { sendEmail } from './email-helpers.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
const REPORT_TO = process.env.SF_EXPENSE_REPORT_TO || 'whitney@alamedasoda.com';
const SITE_URL = process.env.URL || 'https://alamedapointbg.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const LINKABLE_STATUSES = ['approved', 'awaiting_invoice', 'fulfilled'];
const DEFAULT_COGS_ACCOUNT_ID = '101';

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400) { return json({ error: m }, s); }
function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

// qboRequest throws `Error("QBO API error: <status> " + rawResponseText)` —
// rawResponseText is QBO's Fault JSON. Pull out the actual human message
// ("Account Period Closed…") instead of surfacing the raw blob to a person
// trying to figure out why their bill won't post.
function qboFaultMessage(e) {
  const msg = e?.message || String(e);
  const jsonStart = msg.indexOf('{');
  if (jsonStart === -1) return msg;
  try {
    const parsed = JSON.parse(msg.slice(jsonStart));
    const fault = parsed?.Fault?.Error?.[0];
    if (fault) return [fault.Message, fault.Detail].filter(Boolean).join(' — ');
  } catch { /* not JSON, or not the shape we expect — fall through */ }
  return msg;
}

// A failed/blocked post is easy to miss if the person who clicked the button
// just closes the tab. This mails REPORT_TO (same convention as the SF
// autopost/OCR alerts) so it doesn't depend on anyone staring at the screen,
// and stamps the reason onto the row (autopost_error) so it's also visible
// in the Brixpense list without opening the email.
async function notifyPostFailure(supabase, request, reason) {
  try {
    await supabase.from('expense_requests').update({ autopost_error: reason.slice(0, 500) }).eq('id', request.id);
  } catch { /* best-effort */ }
  try {
    const editUrl = `${SITE_URL.replace(/\/$/, '')}/expense/edit/${request.id}`;
    const inner = `<p style="margin:0 0 6px;color:#fff;font-size:16px;font-weight:700">Couldn't post to QuickBooks</p>
      <p style="margin:0 0 14px;color:#CBD5E1">${esc(reason)}</p>
      ${kvTable([
        kvRow('Vendor', esc(request.vendor_name || '(blank)')),
        kvRow('Amount', money(request.total_amount)),
        kvRow('Job / customer', [request.job_number, request.customer_name].filter(Boolean).map(esc).join(' — ') || '—'),
        kvRow('Brixpense ID', esc(request.id)),
      ].join(''))}
      <p style="margin-top:14px"><a href="${editUrl}" style="color:#60A5FA">Open in Brixpense →</a></p>
      <p style="color:#64748B;font-size:12px;margin-top:14px">The expense stays "Approved" and untouched in QuickBooks — fix the issue (date, vendor, etc.) and post it again.</p>`;
    await sendEmail({
      to: REPORT_TO,
      subject: `⚠ Brixpense — QuickBooks post failed: ${request.vendor_name || request.id} (${money(request.total_amount)})`,
      html: brixpenseEmail('#F59E0B', 'Post failed', inner),
    });
  } catch (e) {
    console.warn('notifyPostFailure email failed (non-fatal):', e?.message);
  }
}

// Pre-post duplicate guard. The "Post to QuickBooks" button only knows whether
// BRIXPENSE posted a row (qbo_bill_id on the row) — it can't see a bill someone
// hand-keyed straight into QBO for the same expense. So before creating anything,
// scan the QBO mirror (ops.qbo_expense_lines) for an existing bill/purchase with
// the same amount in the last 60 days that no Brixpense row owns. Amount-only on
// purpose: hand-keyed vendor spellings differ ("ERIC SERRANO" vs "Serrano
// Refrigeration HTG&AC"), so a vendor filter would miss exactly the entries this
// exists to catch. Matches come back as a 409 the UI turns into a confirm dialog
// ("post anyway?") — a warn, not a block, since same-amount coincidences happen.
// Best-effort by design: the mirror check failing must never stop a legit post.
async function findLikelyQboDuplicates(request) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const amt = Number(request.total_amount) || 0;
  if (!serviceKey || !amt) return [];
  try {
    const svc = createClient(SUPABASE_URL, serviceKey, { db: { schema: 'ops' } });
    const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const { data: lines } = await svc.from('qbo_expense_lines')
      .select('qbo_txn_id, qbo_txn_type, txn_date, vendor_name, amount')
      .gte('txn_date', since)
      .gte('amount', amt - 0.005).lte('amount', amt + 0.005)
      .order('txn_date', { ascending: false })
      .limit(40);
    if (!lines?.length) return [];
    // Transactions some Brixpense row already posted are accounted for — a real
    // sibling expense (Serrano bills $170 flat, repeatedly) is not a duplicate.
    const txnIds = [...new Set(lines.map((l) => l.qbo_txn_id))];
    const { data: linked } = await svc.from('expense_requests')
      .select('qbo_bill_id').in('qbo_bill_id', txnIds);
    const linkedSet = new Set((linked || []).map((r) => r.qbo_bill_id));
    const seen = new Set();
    const out = [];
    for (const l of lines) {
      if (linkedSet.has(l.qbo_txn_id) || seen.has(l.qbo_txn_id)) continue;
      seen.add(l.qbo_txn_id);
      out.push({ txn_type: l.qbo_txn_type, txn_id: l.qbo_txn_id, txn_date: l.txn_date, vendor_name: l.vendor_name || null, amount: Number(l.amount) });
      if (out.length >= 5) break;
    }
    return out;
  } catch (e) {
    console.warn('duplicate-check failed (non-fatal, post proceeds):', e?.message);
    return [];
  }
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

async function findQBODepartmentRef(name) {
  if (!name) return null;
  try {
    const safe = name.replace(/'/g, "\\'");
    const res = await qboQuery(`SELECT * FROM Department WHERE Name = '${safe}'`);
    const depts = res.QueryResponse?.Department || [];
    if (depts.length > 0) return { value: depts[0].Id, name: depts[0].Name };
  } catch {}
  return null;
}

function lineItemLines(request, departmentRef, fallbackAccountId) {
  const lineItems = Array.isArray(request.line_items) ? request.line_items : [];
  const accountId = request.cogs_account_id || fallbackAccountId;
  return lineItems.length > 0
    ? lineItems.map((li, idx) => {
        const amount = round((li.qty || li.quantity || 1) * (li.unit_price || li.unitCost || 0)) || round(li.amount || 0);
        return {
          DetailType: 'AccountBasedExpenseLineDetail',
          Amount: amount,
          Description: li.description || `Line ${idx + 1}`,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: accountId },
            BillableStatus: 'NotBillable',
            ...(departmentRef ? { DepartmentRef: { value: departmentRef.value } } : {}),
          },
        };
      })
    : [{
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round(request.total_amount),
        Description: request.memo || request.vendor_name || 'Brixpense expense',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: accountId },
          BillableStatus: 'NotBillable',
          ...(departmentRef ? { DepartmentRef: { value: departmentRef.value } } : {}),
        },
      }];
}

function buildBillPayload(request, vendor, departmentRef, fallbackAccountId) {
  const lines = lineItemLines(request, departmentRef, fallbackAccountId);
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
  if (departmentRef) payload.DepartmentRef = { value: departmentRef.value };
  // Vendor invoice/bill number (OCR-extracted or hand-entered) → QBO's "Bill no.".
  // QBO's DocNumber caps at 21 chars.
  if (request.bill_number) payload.DocNumber = String(request.bill_number).trim().slice(0, 21);
  return payload;
}

// Paid expenses ("Paid with" account picked on the form) post as a QBO
// Purchase instead of a Bill — same line-item shape, but AccountRef +
// PaymentType replace VendorRef, and the vendor (if it matches one in QBO)
// rides along as an optional EntityRef for reporting only.
function paymentTypeFromAccountType(accountType) {
  const t = String(accountType || '').toLowerCase();
  if (t === 'credit card') return 'CreditCard';
  if (t === 'bank') return 'Check';
  if (!t) return null;
  return 'Cash';
}

function buildPurchasePayload(request, paymentAccount, optionalVendor, departmentRef, fallbackAccountId) {
  const lines = lineItemLines(request, departmentRef, fallbackAccountId);
  const memoParts = [
    `BRIXpense expense ${request.id}`,
    request.vendor_name ? `vendor:${request.vendor_name}` : null,
    request.entity ? `entity:${request.entity}` : null,
    request.department ? `dept:${request.department}` : null,
    request.tag ? `tag:${request.tag}` : null,
    request.customer_name ? `cust:${request.customer_name}` : null,
    request.job_number ? `job:${request.job_number}` : null,
    request.memo || null,
  ].filter(Boolean);
  // PaymentType chain: fresh QBO Account lookup -> cached payment_account_type
  // on the row -> hardcoded CreditCard fallback for pre-column legacy rows.
  const paymentType = paymentAccount?.payment_type
    || paymentTypeFromAccountType(request.payment_account_type)
    || 'CreditCard';
  const payload = {
    AccountRef: { value: request.payment_account_id },
    PaymentType: paymentType,
    Line: lines,
    PrivateNote: memoParts.join(' | ').substring(0, 4000),
  };
  if (optionalVendor?.Id) payload.EntityRef = { value: optionalVendor.Id, type: 'Vendor' };
  if (departmentRef) payload.DepartmentRef = { value: departmentRef.value };
  if (request.receipt_date) payload.TxnDate = request.receipt_date;
  if (request.bill_number) payload.DocNumber = String(request.bill_number).trim().slice(0, 21);
  return payload;
}

async function maybeMarginMatch(request, txnTotal) {
  if (!request?.job_number) return null;
  try {
    const inv = await findMatchingInvoice(request.job_number, null);
    if (!inv) return { matched: false, job_number: request.job_number };
    const invSummary = summarizeInvoice(inv);
    const { margin, marginPct } = computeMargin(invSummary.total, txnTotal);
    return { matched: true, job_number: request.job_number, invoice: invSummary, margin, marginPct };
  } catch (e) {
    console.warn('maybeMarginMatch failed (non-fatal):', e?.message);
    return null;
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return err('Unauthorized — Bearer token required', 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return err('Invalid or expired session', 401);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }

  const { requestId, mode = 'create', qboBillId, force = false } = body;
  if (!requestId) return err('Missing requestId');
  if (!['create', 'preview', 'link'].includes(mode)) return err(`Invalid mode "${mode}"`);

  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !request) return err('Expense request not found', 404);

  if (mode === 'link') {
    if (!qboBillId) return err('mode=link requires qboBillId');
    if (!LINKABLE_STATUSES.includes(request.status)) {
      return err(`Cannot link from status "${request.status}". Must be: ${LINKABLE_STATUSES.join(', ')}`, 409);
    }
    const { error: updateErr } = await supabase
      .from('expense_requests')
      .update({ qbo_bill_id: qboBillId, status: 'posted', posted_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updateErr) return err('Failed to link bill: ' + updateErr.message, 500);
    return json({ success: true, mode: 'link', request_id: requestId, qbo_bill_id: qboBillId, new_status: 'posted' });
  }

  if (!LINKABLE_STATUSES.includes(request.status)) {
    return err(`Cannot post from status "${request.status}". Must be: ${LINKABLE_STATUSES.join(', ')}`, 409);
  }

  // Duplicate guard — only on the real write, and only until the human says
  // "post anyway" (force). preview/link skip it.
  if (mode === 'create' && !force) {
    const dupes = await findLikelyQboDuplicates(request);
    if (dupes.length) {
      const list = dupes
        .map((d) => `${d.txn_type} #${d.txn_id} — ${d.vendor_name || 'unknown vendor'} $${d.amount.toFixed(2)} on ${d.txn_date}`)
        .join('; ');
      return json({
        success: false, duplicate_check: true, matches: dupes, request_id: requestId,
        message: `QuickBooks may already have this expense: ${list}. Nothing was posted.`,
      }, 409);
    }
  }

  const departmentRef = await findQBODepartmentRef(request.department);
  const isPaidExpense = request.request_type === 'expense' && !request.as_bill;

  // ── Paid expense -> QBO Purchase ──────────────────────────────────────
  if (isPaidExpense) {
    if (!request.payment_account_id) {
      const reason = 'This expense has no "Paid with" account on record.';
      await notifyPostFailure(supabase, request, reason);
      return err(`${reason} Edit it in Brixpense and pick one before posting.`, 422);
    }
    let optionalVendor = null;
    try { optionalVendor = await findQBOVendor(request.vendor_name); } catch {}
    let paymentAccount = null;
    try {
      const acctRes = await qboQuery(
        `SELECT Id, Name, AccountType FROM Account WHERE Id = '${String(request.payment_account_id).replace(/'/g, "\\'")}'`
      );
      const a = acctRes?.QueryResponse?.Account?.[0];
      if (a) {
        const t = String(a.AccountType || '').toLowerCase();
        paymentAccount = { id: a.Id, name: a.Name, payment_type: t === 'credit card' ? 'CreditCard' : t === 'bank' ? 'Check' : 'Cash' };
      }
    } catch {}
    const payload = buildPurchasePayload(request, paymentAccount, optionalVendor, departmentRef, DEFAULT_COGS_ACCOUNT_ID);

    if (mode === 'preview') {
      return json({ success: true, mode: 'preview', kind: 'purchase', request_id: requestId, vendor: optionalVendor ? { id: optionalVendor.Id, name: optionalVendor.DisplayName } : null, department: departmentRef, payload });
    }

    let qboTxn;
    try {
      const qboRes = await qboRequest('POST', '/purchase', payload);
      qboTxn = qboRes?.Purchase;
    } catch (e) {
      const reason = qboFaultMessage(e);
      console.error('QBO Purchase post failed:', reason);
      await notifyPostFailure(supabase, request, reason);
      return err('QBO Purchase post failed: ' + reason, 502);
    }
    if (!qboTxn?.Id) {
      await notifyPostFailure(supabase, request, 'QBO did not return a Purchase ID');
      return err('QBO did not return a Purchase ID', 502);
    }

    try { await attachReceiptsToQBO('Purchase', qboTxn.Id, requestId); } catch { /* non-fatal */ }

    const now = new Date().toISOString();
    // The qbo_bill_id column predates the Bill/Purchase split — reused for the
    // Purchase Id so existing reporting keeps working without a schema rename.
    const { error: updateErr } = await supabase.from('expense_requests').update({
      status: 'posted', posted_at: now, qbo_bill_id: qboTxn.Id,
      vendor_id: optionalVendor?.Id || request.vendor_id || null,
      autopost_error: null,
    }).eq('id', requestId);
    if (updateErr) {
      return json({ success: true, partial: true, message: 'Purchase created in QBO but local status update failed.', request_id: requestId, qbo_purchase_id: qboTxn.Id, update_error: updateErr.message }, 207);
    }
    await supabase.from('expense_approvals').insert({
      request_id: requestId, action: 'approved',
      decided_by: `posted by ${user.email || user.id}`,
      notes: `Posted to QBO as Purchase ${qboTxn.DocNumber || qboTxn.Id}${optionalVendor ? ` (vendor: ${optionalVendor.DisplayName})` : ''}`,
      token_used: null,
    });

    // Close the loop on the source PR (PendingList's "Log Receipt" CTA):
    // 'awaiting_invoice' -> 'fulfilled'. Best-effort bookkeeping hygiene only.
    let fulfilledPRId = null;
    if (request.linked_pr_id) {
      const { error: prErr } = await supabase.from('expense_requests').update({ status: 'fulfilled', updated_at: now }).eq('id', request.linked_pr_id);
      if (!prErr) fulfilledPRId = request.linked_pr_id;
    }

    const marginMatch = await maybeMarginMatch(request, Number(request.total_amount) || 0);

    return json({
      success: true, mode: 'create', kind: 'purchase', request_id: requestId,
      qbo_purchase_id: qboTxn.Id, qbo_doc_number: qboTxn.DocNumber, qbo_total: qboTxn.TotalAmt,
      vendor: optionalVendor ? { id: optionalVendor.Id, name: optionalVendor.DisplayName } : null,
      department: departmentRef, fulfilled_pr_id: fulfilledPRId, margin_match: marginMatch,
      new_status: 'posted',
    });
  }

  // ── Unpaid bill (expense as_bill=true, or a purchase_request fulfillment) -> QBO Bill ──
  const vendor = await findQBOVendor(request.vendor_name);
  if (!vendor) {
    const reason = `Could not match vendor "${request.vendor_name || '(blank)'}" in QuickBooks.`;
    await notifyPostFailure(supabase, request, reason);
    return json({
      success: false, needs_vendor: true,
      message: reason,
      request_id: requestId,
    });
  }

  const payload = buildBillPayload(request, vendor, departmentRef, DEFAULT_COGS_ACCOUNT_ID);

  if (mode === 'preview') {
    return json({
      success: true, mode: 'preview', kind: 'bill', request_id: requestId,
      vendor: { id: vendor.Id, name: vendor.DisplayName },
      department: departmentRef,
      payload,
    });
  }

  let billResult;
  try {
    const qboRes = await qboRequest('POST', '/bill', payload);
    billResult = qboRes.Bill;
  } catch (e) {
    const reason = qboFaultMessage(e);
    console.error('QBO bill creation failed:', reason);
    await notifyPostFailure(supabase, request, reason);
    return err('QBO bill creation failed: ' + reason, 502);
  }

  if (!billResult || !billResult.Id) {
    await notifyPostFailure(supabase, request, 'QBO did not return a bill ID');
    return err('QBO did not return a bill ID', 502);
  }

  try { await attachReceiptsToQBO('Bill', billResult.Id, requestId); } catch { /* non-fatal */ }

  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({
      qbo_bill_id: billResult.Id,
      vendor_id: vendor.Id,
      status: 'posted',
      posted_at: new Date().toISOString(),
      autopost_error: null,
    })
    .eq('id', requestId);

  if (updateErr) {
    return json({
      success: true, mode: 'create', kind: 'bill', partial: true,
      message: 'Bill created in QBO but local status update failed.',
      request_id: requestId, qbo_bill_id: billResult.Id,
      qbo_doc_number: billResult.DocNumber, qbo_total: billResult.TotalAmt,
      update_error: updateErr.message,
    }, 207);
  }
  await supabase.from('expense_approvals').insert({
    request_id: requestId, action: 'approved',
    decided_by: `posted by ${user.email || user.id}`,
    notes: `Posted to QBO as Bill ${billResult.DocNumber || billResult.Id} (vendor: ${vendor.DisplayName})`,
    token_used: null,
  });

  return json({
    success: true, mode: 'create', kind: 'bill', request_id: requestId,
    qbo_bill_id: billResult.Id, qbo_doc_number: billResult.DocNumber, qbo_total: billResult.TotalAmt,
    vendor: { id: vendor.Id, name: vendor.DisplayName },
    department: departmentRef,
    new_status: 'posted',
  });
}

export const config = { path: '/api/expense-request-link-bill' };
