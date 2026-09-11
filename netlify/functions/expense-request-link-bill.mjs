// ============================================================
// expense-request-link-bill.mjs
// The ONE place a human explicitly posts a Brixpense expense/PR to
// QuickBooks. expense-request-notify only auto-approves (draft -> approved)
// and never touches QBO (gate, Sky 2026-08-13) — this function does the
// actual write, for both flavors:
//   - as_bill=true  -> unpaid QBO Bill (requires a matching QBO vendor)
//   - as_bill=false -> paid QBO Purchase (requires payment_account_id)
// Modes: create (default, does the post), preview (dry-run, no writes),
// link (legacy passive — stamp an existing QBO id without posting),
// attach (file a late document onto the posted txn),
// update (2026-09-03: re-post a CHANGED total onto the SAME QBO Bill — a
//   sparse Bill update keeps the BillPayment applied, so a co-packer deposit
//   that was paid against the bill stays paid and the final invoice becomes
//   the balance due; refuses to shrink a bill below what is already paid).
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { qboRequest, qboQuery } from './qbo-helpers.mjs';
import { attachReceiptsToQBO } from './lib/qbo-attach.mjs';
import { findMatchingInvoice, computeMargin, summarizeInvoice } from './qbo-invoice-match.mjs';
import { brixpenseEmail, kvRow, kvTable, esc, money } from './lib/brixpense-email.mjs';
import { sendEmail } from './email-helpers.mjs';
import { findDuplicate } from './lib/expense-dupes.mjs';

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

// Second layer of the duplicate gate: HAND-KEYED QuickBooks bills. findDuplicate
// (expense-dupes.mjs) catches a Brixpense twin — another expense_requests row for
// the same bill already posted. But a bill someone keyed straight into QBO has no
// Brixpense row, so that check can't see it. This one scans the QBO mirror
// (ops.qbo_expense_lines) for bills/purchases in the last 60 days with the same
// amount that NO Brixpense row owns. Amount-only on purpose: hand-keyed vendor
// spellings differ ("ERIC SERRANO" vs "Serrano Refrigeration HTG&AC"), so a
// vendor filter would miss exactly the entries this exists to catch. Excluding
// every txn already linked to an expense_requests.qbo_bill_id keeps real sibling
// expenses (Serrano bills $170 flat, repeatedly) from false-positiving.
// Best-effort like its sibling: a mirror check that can't run never blocks a post.
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
    console.warn('mirror duplicate-check failed (non-fatal, post proceeds):', e?.message);
    return [];
  }
}

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

  const { requestId, mode = 'create', qboBillId, confirmDuplicate = false, attachmentId = null, preview: previewOnly = false } = body;
  if (!requestId) return err('Missing requestId');
  if (!['create', 'preview', 'link', 'attach', 'update'].includes(mode)) return err(`Invalid mode "${mode}"`);

  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !request) return err('Expense request not found', 404);

  // ── mode=attach: file a late-arriving document onto the EXISTING QBO txn ──
  // Receipts are only pushed to QBO at posting time, so a bill posted before
  // its document arrived (the normal case now that SF expenses land data-only)
  // had no way to ever get the file into QuickBooks. This pushes exactly ONE
  // attachment row — the one just uploaded — so re-attaching can't duplicate
  // files QBO already has. No status change, no new transaction.
  if (mode === 'attach') {
    if (!attachmentId) return err('mode=attach requires attachmentId');
    if (request.status !== 'posted' || !request.qbo_bill_id) {
      return err('Attach-to-QuickBooks needs a posted expense with a QBO transaction on record. For an unposted expense, just attach and Submit — posting pushes the file.', 409);
    }
    // Verify the attachment belongs to this request under the CALLER's RLS —
    // the push itself runs service-role, so this read is the authorization.
    const { data: att } = await supabase
      .from('expense_request_attachments')
      .select('id, file_name').eq('id', attachmentId).eq('request_id', requestId).single();
    if (!att) return err('Attachment not found on this expense', 404);
    const kind = request.is_credit === true ? 'VendorCredit'
      : request.request_type === 'expense' && request.as_bill === false ? 'Purchase' : 'Bill';
    const result = await attachReceiptsToQBO(kind, request.qbo_bill_id, requestId, { attachmentId });
    if (!result.attached) {
      return json({
        success: false, error: 'attach_failed',
        message: `The file is saved on the Brixpense record, but pushing it to QuickBooks failed${result.errors.length ? `: ${result.errors.join('; ').slice(0, 300)}` : '.'} Try again, or attach it in QuickBooks by hand.`,
      }, 502);
    }
    await supabase.from('expense_approvals').insert({
      request_id: requestId, action: 'approved',
      decided_by: `attachment by ${user.email || user.id}`,
      notes: `Filed "${att.file_name}" onto QBO ${kind} ${request.qbo_bill_id} after posting.`,
      token_used: null,
    });
    return json({ success: true, mode: 'attach', kind, qbo_txn_id: request.qbo_bill_id, attached: result.attached });
  }

  // ── mode=update: the SAME QuickBooks Bill, new total/lines/number ───────────
  // Bills only (a Purchase is money already gone; a VendorCredit is consumed by
  // application). Read the live Bill for its SyncToken and what has been paid;
  // refuse a total below the paid amount — QBO would leave a negative balance.
  if (mode === 'update') {
    if (request.status !== 'posted' || !request.qbo_bill_id) return err('Only a posted bill can be updated in QuickBooks', 409);
    if (request.as_bill !== true || request.is_credit === true) return err('Only an unpaid Bill can be updated in place — a Purchase or a vendor credit is re-entered, not edited', 409);
    let live;
    try { live = (await qboRequest('GET', `/bill/${encodeURIComponent(request.qbo_bill_id)}`)).Bill; }
    catch (e) { return err('Could not read the QuickBooks bill: ' + qboFaultMessage(e), 502); }
    if (!live || !live.Id) return err(`QuickBooks Bill ${request.qbo_bill_id} was not found — it may have been deleted there`, 409);
    const paid = round(Number(live.TotalAmt || 0) - Number(live.Balance ?? live.TotalAmt ?? 0));
    const newTotal = round(request.total_amount);
    if (newTotal < paid) return err(`The new total (${newTotal.toFixed(2)}) is below what has already been paid on this bill (${paid.toFixed(2)})`, 409);
    const vendor = live.VendorRef ? { Id: live.VendorRef.value, DisplayName: live.VendorRef.name } : await findQBOVendor(request.vendor_name);
    if (!vendor) return err('Could not resolve the bill\'s vendor', 409);
    const departmentRef = request.qbo_department_id
      ? { value: request.qbo_department_id, name: request.qbo_department_name }
      : (request.job_number ? await findQBODepartmentRef(request.job_number) : null);
    const fresh = buildBillPayload(request, vendor, departmentRef, DEFAULT_COGS_ACCOUNT_ID);
    const payload = {
      Id: live.Id, SyncToken: live.SyncToken, sparse: true,
      Line: fresh.Line,
      ...(fresh.DocNumber ? { DocNumber: fresh.DocNumber } : {}),
      ...(fresh.TxnDate ? { TxnDate: fresh.TxnDate } : {}),
      PrivateNote: (fresh.PrivateNote + ` | updated ${new Date().toISOString().slice(0, 10)} from ${round(live.TotalAmt).toFixed(2)} to ${newTotal.toFixed(2)}`).substring(0, 4000),
    };
    if (previewOnly) {
      return json({ success: true, mode: 'update', preview: true, request_id: requestId, qbo_bill_id: live.Id,
        current: { total: round(live.TotalAmt), balance: round(live.Balance ?? live.TotalAmt), paid, sync_token: live.SyncToken },
        proposed: { total: newTotal, balance_after: round(newTotal - paid) }, payload });
    }
    let updated;
    try { updated = (await qboRequest('POST', '/bill', payload)).Bill; }
    catch (e) {
      const reason = qboFaultMessage(e);
      await notifyPostFailure(supabase, request, 'QBO bill update failed: ' + reason);
      return err('QBO bill update failed: ' + reason, 502);
    }
    if (!updated || !updated.Id) return err('QBO did not return the updated Bill', 502);
    let attached = 0;
    if (attachmentId) {
      const { data: att } = await supabase.from('expense_request_attachments').select('id, file_name').eq('id', attachmentId).eq('request_id', requestId).single();
      if (!att) return err('That attachment does not belong to this request', 404);
      try { attached = (await attachReceiptsToQBO('Bill', updated.Id, requestId, { attachmentId })).attached; } catch { /* non-fatal */ }
    }
    const { error: upErr } = await supabase.from('expense_requests').update({
      qbo_posted_amount: round(updated.TotalAmt), posted_at: new Date().toISOString(),
      qbo_balance: null, qbo_checked_at: null, autopost_error: null,
    }).eq('id', requestId);
    await supabase.from('expense_approvals').insert({
      request_id: requestId, action: 'approved', decided_by: `updated in QBO by ${user.email || user.id}`,
      notes: `QBO Bill ${updated.DocNumber || updated.Id} updated in place: ${round(live.TotalAmt).toFixed(2)} → ${round(updated.TotalAmt).toFixed(2)} (paid so far ${paid.toFixed(2)}, balance ${round(updated.Balance ?? updated.TotalAmt - paid).toFixed(2)})${attached ? ` · ${attached} document attached` : ''}`,
      token_used: null,
    });
    return json({ success: true, mode: 'update', request_id: requestId, qbo_bill_id: updated.Id, qbo_doc_number: updated.DocNumber,
      qbo_total: updated.TotalAmt, qbo_balance: updated.Balance, paid, attached, ...(upErr ? { partial: true, update_error: upErr.message } : {}) });
  }

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

  // ── Duplicate gate ────────────────────────────────────────────────────
  // This is the last point before a real QuickBooks transaction exists, so it
  // is where the duplicate check has teeth. Re-checked here rather than
  // trusting the stamp from intake time, because the row may have been sitting
  // for days and the twin may have arrived since.
  //
  // Only an EXACT match (same vendor, same invoice number) blocks, and only
  // when the twin is ALREADY IN QUICKBOOKS — which is the thing we are trying
  // not to do twice. Two unposted drafts of the same bill are a tidiness
  // problem, not a money problem, and refusing to post either of them would be
  // the pipeline arguing with itself. `confirmDuplicate: true` is the caller
  // saying they looked; it is recorded on the row, not just obeyed.
  if (mode === 'create') {
    const dupe = await findDuplicate({
      vendor: request.vendor_name,
      bill_number: request.bill_number,
      amount: request.total_amount,
      date: request.receipt_date,
      job_number: request.job_number,
      exclude: requestId,
    });
    const blocking = dupe && dupe.match_kind === 'exact' && dupe.posted;
    if (blocking && !confirmDuplicate) {
      await supabase.from('expense_requests').update({
        duplicate_of: dupe.id,
        duplicate_reason: dupe.reason,
        duplicate_checked_at: new Date().toISOString(),
      }).eq('id', requestId);
      return json({
        success: false,
        error: 'possible_duplicate',
        message: `This looks like a bill we have already posted — ${dupe.reason}. Post it anyway only if it is genuinely a different invoice.`,
        duplicate_of: dupe.id,
        duplicate_reason: dupe.reason,
        can_override: true,
      }, 409);
    }
    if (dupe) {
      // Not blocking, but record what we saw — including an override, so
      // "why are there two of these in QuickBooks" has an answer on the row.
      await supabase.from('expense_requests').update({
        duplicate_of: dupe.id,
        duplicate_reason: dupe.reason,
        duplicate_checked_at: new Date().toISOString(),
        ...(blocking && confirmDuplicate
          ? { duplicate_cleared_by: `${user.email} (posted anyway)` }
          : {}),
      }).eq('id', requestId);
    }

    // Layer two: bills hand-keyed straight into QuickBooks (no Brixpense row,
    // so findDuplicate above can't see them). Same 409 protocol, so the shared
    // postToQbo confirm flow handles it — and one confirmDuplicate clears both
    // layers, since the human sees the full picture in either prompt.
    if (!confirmDuplicate) {
      const mirror = await findLikelyQboDuplicates(request);
      if (mirror.length) {
        const list = mirror
          .map((d) => `${d.txn_type} #${d.txn_id} — ${d.vendor_name || 'unknown vendor'} $${d.amount.toFixed(2)} on ${d.txn_date}`)
          .join('; ');
        const reason = `QuickBooks already has a transaction with this amount that Brixpense didn't create: ${list}`;
        await supabase.from('expense_requests').update({
          duplicate_reason: reason.slice(0, 500),
          duplicate_checked_at: new Date().toISOString(),
        }).eq('id', requestId);
        return json({
          success: false,
          error: 'possible_duplicate',
          message: `${reason}. If it was keyed into QuickBooks by hand, don't post this copy. Post it anyway only if it's genuinely a different bill.`,
          duplicate_matches: mirror,
          can_override: true,
        }, 409);
      }
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
      status: 'posted', posted_at: now, qbo_bill_id: qboTxn.Id, qbo_posted_amount: round(qboTxn.TotalAmt),
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
  // A credit memo (is_credit) takes the SAME road — same vendor match, same
  // payload shape, same gates — but lands as a QBO VendorCredit: the amount
  // stays positive and the entity carries the sign. It is consumed later by
  // applying it in a pay run, never paid.
  const creditMemo = request.is_credit === true;
  const qboEntity = creditMemo ? 'VendorCredit' : 'Bill';
  const kindLabel = creditMemo ? 'vendor_credit' : 'bill';

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
      success: true, mode: 'preview', kind: kindLabel, request_id: requestId,
      vendor: { id: vendor.Id, name: vendor.DisplayName },
      department: departmentRef,
      payload,
    });
  }

  let billResult;
  try {
    const qboRes = await qboRequest('POST', creditMemo ? '/vendorcredit' : '/bill', payload);
    billResult = creditMemo ? qboRes.VendorCredit : qboRes.Bill;
  } catch (e) {
    const reason = qboFaultMessage(e);
    console.error(`QBO ${qboEntity} creation failed:`, reason);
    await notifyPostFailure(supabase, request, reason);
    return err(`QBO ${creditMemo ? 'vendor credit' : 'bill'} creation failed: ` + reason, 502);
  }

  if (!billResult || !billResult.Id) {
    await notifyPostFailure(supabase, request, `QBO did not return a ${qboEntity} ID`);
    return err(`QBO did not return a ${qboEntity} ID`, 502);
  }

  try { await attachReceiptsToQBO(qboEntity, billResult.Id, requestId); } catch { /* non-fatal */ }

  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({
      qbo_bill_id: billResult.Id,
      qbo_posted_amount: round(billResult.TotalAmt),
      vendor_id: vendor.Id,
      status: 'posted',
      posted_at: new Date().toISOString(),
      autopost_error: null,
    })
    .eq('id', requestId);

  if (updateErr) {
    return json({
      success: true, mode: 'create', kind: kindLabel, partial: true,
      message: `${creditMemo ? 'Vendor credit' : 'Bill'} created in QBO but local status update failed.`,
      request_id: requestId, qbo_bill_id: billResult.Id,
      qbo_doc_number: billResult.DocNumber, qbo_total: billResult.TotalAmt,
      update_error: updateErr.message,
    }, 207);
  }
  await supabase.from('expense_approvals').insert({
    request_id: requestId, action: 'approved',
    decided_by: `posted by ${user.email || user.id}`,
    notes: `Posted to QBO as ${creditMemo ? 'Vendor Credit' : 'Bill'} ${billResult.DocNumber || billResult.Id} (vendor: ${vendor.DisplayName})`,
    token_used: null,
  });

  return json({
    success: true, mode: 'create', kind: kindLabel, request_id: requestId,
    qbo_bill_id: billResult.Id, qbo_doc_number: billResult.DocNumber, qbo_total: billResult.TotalAmt,
    vendor: { id: vendor.Id, name: vendor.DisplayName },
    department: departmentRef,
    new_status: 'posted',
  });
}

export const config = { path: '/api/expense-request-link-bill' };
