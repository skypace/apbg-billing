// bill-email-process-background — turns an AP-inbox email into a Brixpense
// bill draft.
//
// Read the attachment → OCR it with the SAME extractor human uploads use
// (lib/expense-ocr-core.mjs) → land an ops.expense_requests row as an
// UNPAID BILL DRAFT tagged "AP Inbox", with the original PDF attached.
//
// ⚠ NOTHING HERE POSTS TO QUICKBOOKS. That is the 2026-08-14 rule and this
// pipeline does not get an exception: an email from outside the company must
// not be able to create a QBO Bill. Every draft waits for a human to open it
// in Brixpense and click "Post to QuickBooks" (expense-request-link-bill),
// which is also where vendor matching and GL coding actually happen. The
// worst a stranger emailing bills@ can do is put a row in a review queue.
//
// Every failure is a VISIBLE, re-runnable status on ops.bill_email_intake —
// never a silent drop. The distinction between "this email had no attachment"
// and "we were not allowed to read the attachment" is recorded explicitly,
// because collapsing those two is precisely how brix-order lost a purchase
// order to a send-only Resend key for a day.
//
// Invocation:
//   POST { intake_id }            — one email (the intake webhook's hand-off)
//   POST { retry: true }          — re-run everything currently stuck
//   POST { intake_id, force: true } — re-run one row whatever its status
// Auth: x-ap-inbox-secret == SUPABASE_SERVICE_ROLE_KEY, or a superadmin Bearer.

import { requireAuth } from './lib/auth.mjs';
import { runExpenseOcr } from './lib/expense-ocr-core.mjs';
import { brixpenseEmail, kvRow, kvTable, esc, money } from './lib/brixpense-email.mjs';
import { sendEmail } from './email-helpers.mjs';
import {
  AP_TAG, opsGet, opsInsert, opsPatch, loadApInboxSettings, resolveSubmitter,
  findInternalUser, resolveBillRouting, uploadAttachment, dedupeEmails,
} from './lib/ap-inbox.mjs';
import {
  fetchResendAttachments, fetchResendBody, rankAttachments, makeDiag,
  inboundKeyIsFallback, safeFilename, OCRABLE,
} from './lib/resend-inbound.mjs';

const MAX_PER_RUN = 15;
const RETRYABLE = ['received', 'processing', 'failed', 'attachment_fetch_failed', 'ocr_failed'];
const SITE = process.env.URL || 'https://alamedapointbg.com';
const QUEUE_URL = `${SITE.replace(/\/$/, '')}/expense/bills`;
const APPROVALS_URL = `${SITE.replace(/\/$/, '')}/expense/queue`;
const MINE_URL = `${SITE.replace(/\/$/, '')}/expense/pending`;

async function loadAccountLabels() {
  try {
    const rows = await opsGet('expense_settings?key=eq.cogs_accounts&select=value&limit=1');
    const v = rows?.[0]?.value;
    return Array.isArray(v) ? v.map((a) => a?.label).filter(Boolean) : [];
  } catch { return []; }
}

// ─── Notifications ───

async function notifyDrafted(intake, request, settings, submitter, routing, needsApproval) {
  const owned = !!routing.owner_email;
  const inner = kvTable([
    kvRow('Vendor', esc(request.vendor_name || '—')),
    kvRow('Amount', money(request.total_amount || 0)),
    kvRow('Bill #', esc(request.bill_number || '—')),
    kvRow('Bill date', esc(request.receipt_date || '—')),
    kvRow('From', esc(intake.from_email || '—')),
    kvRow('Subject', esc(intake.subject || '—')),
    kvRow('Filed as', esc(submitter?.matched_sender ? `${submitter.name} (the sender)` : 'AP Inbox')),
    kvRow(needsApproval ? 'Waiting on' : 'Filed to', esc(routing.owner_email || 'nobody yet — needs assigning')),
    kvRow('Why', esc(routing.reason)),
  ]) + `<p style="margin:16px 0 0">
      <a href="${needsApproval ? APPROVALS_URL : (owned ? MINE_URL : QUEUE_URL)}" style="background:#38BDF8;color:#0B1220;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${needsApproval ? 'Review and approve →' : (owned ? 'Review and post →' : 'Open the AP inbox →')}</a>
    </p>
    <p style="margin:14px 0 0;color:#94A3B8;font-size:13px">
      Nothing has been posted to QuickBooks${needsApproval ? ' and nothing can be until this is approved' : ' yet'}.
      Check the vendor, amount and GL account against the attached bill${needsApproval ? ', approve it, then post it' : ', then post it'}.
    </p>`;

  // The owner is the person who has to act; the AP list is the audience that
  // wants to see the queue moving. Deduped so a one-person AP desk gets one
  // email, not two.
  const to = dedupeEmails([routing.owner_email, ...settings.notify].filter(Boolean));
  if (!to.length) return;

  await sendEmail({
    to,
    subject: needsApproval
      ? `📄 Bill to approve — ${request.vendor_name || 'vendor'}${request.total_amount ? ` · ${money(request.total_amount)}` : ''}`
      : owned
        ? `📄 Bill ready to post — ${request.vendor_name || 'vendor'}${request.total_amount ? ` · ${money(request.total_amount)}` : ''}`
        : `📄 AP inbox — ${request.vendor_name || 'bill'}${request.total_amount ? ` · ${money(request.total_amount)}` : ''} needs assigning`,
    html: brixpenseEmail('#38BDF8', needsApproval ? 'Waiting on you' : (owned ? 'Ready to post' : 'Needs assigning'), inner),
    replyTo: intake.from_email || undefined,
  });
}

async function notifyHeld(intake, settings, headline, detail) {
  const inner = kvTable([
    kvRow('From', esc(intake.from_email || '—')),
    kvRow('Subject', esc(intake.subject || '—')),
    kvRow('Problem', esc(headline)),
  ]) + `<p style="margin:12px 0 0;color:#CBD5E1">${esc(detail || '')}</p>
    <p style="margin:16px 0 0">
      <a href="${QUEUE_URL}" style="background:#F59E0B;color:#0B1220;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open the AP inbox →</a>
    </p>`;
  await sendEmail({
    to: dedupeEmails(settings.notify),
    subject: `⚠ AP inbox — couldn't read a bill from ${intake.from_email || 'a sender'}`,
    html: brixpenseEmail('#F59E0B', 'Needs attention', inner),
    replyTo: intake.from_email || undefined,
  });
}

async function ackSender(intake, settings, request) {
  if (!settings.ack_sender || !intake.from_email) return;
  const inner = `<p style="margin:0 0 10px">Thanks — we received your invoice and it's in our accounts-payable queue.</p>`
    + kvTable([
      kvRow('Vendor', esc(request?.vendor_name || '—')),
      kvRow('Amount', request?.total_amount ? money(request.total_amount) : '—'),
      kvRow('Bill #', esc(request?.bill_number || '—')),
    ])
    + `<p style="margin:14px 0 0;color:#94A3B8;font-size:13px">This is an automated receipt confirmation, not an approval or a payment. Reply to this email if anything above looks wrong.</p>`;
  try {
    await sendEmail({
      to: intake.from_email,
      subject: `We received your invoice${request?.bill_number ? ` (${request.bill_number})` : ''}`,
      html: brixpenseEmail('#38BDF8', 'Alameda Point Beverage Group · Accounts Payable', inner),
    });
  } catch (e) {
    console.warn('[ap-inbox] sender ack failed (non-fatal):', e?.message || e);
  }
}

// ─── One email ───

async function processIntake(intake, settings, accountLabels) {
  const diag = makeDiag();
  if (inboundKeyIsFallback()) {
    diag.push('note: reading inbound mail with the send-only RESEND_API_KEY fallback (set RESEND_INBOUND_API_KEY)');
  }

  await opsPatch('bill_email_intake', `id=eq.${intake.id}`, { status: 'processing' });

  const attachments = rankAttachments(
    await fetchResendAttachments(intake.resend_email_id, { diag, maxAttachments: 6 }),
  );
  const readable = attachments.find((a) => OCRABLE.has(a.mediaType));

  if (!readable) {
    // Two very different failures wearing the same face — separate them.
    const fetchFailed = diag.text() !== null && attachments.length === 0;
    const status = fetchFailed ? 'attachment_fetch_failed' : 'no_attachment';
    const headline = fetchFailed
      ? "Couldn't read the attachment from Resend"
      : 'No readable invoice attached';
    const detail = fetchFailed
      ? 'Resend refused the attachment read — see the diagnostics on the queue row.'
      : 'The email had no PDF or image we could read. Ask the sender to attach the invoice, or add it by hand in Brixpense.';

    // Body text is still worth keeping — some vendors paste the invoice inline.
    let body = intake.raw_text;
    if (!body) { try { body = await fetchResendBody(intake.resend_email_id, diag); } catch { /* keep null */ } }

    await opsPatch('bill_email_intake', `id=eq.${intake.id}`, {
      status, status_detail: headline, diagnostics: diag.text(),
      raw_text: body ? String(body).slice(0, 20000) : intake.raw_text,
      processed_at: new Date().toISOString(),
    });
    if (!intake.notified_at) {
      try {
        await notifyHeld(intake, settings, headline, detail);
        await opsPatch('bill_email_intake', `id=eq.${intake.id}`, { notified_at: new Date().toISOString() });
      } catch (e) { console.warn('[ap-inbox] held notify failed:', e?.message || e); }
    }
    return { status };
  }

  // ── OCR ──
  let ocr;
  try {
    ocr = await runExpenseOcr({ base64: readable.base64, mediaType: readable.mediaType, accountLabels });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    await opsPatch('bill_email_intake', `id=eq.${intake.id}`, {
      status: 'ocr_failed', status_detail: msg, diagnostics: diag.text(),
      processed_at: new Date().toISOString(),
    });
    if (!intake.notified_at) {
      try {
        await notifyHeld(intake, settings, 'OCR failed', msg);
        await opsPatch('bill_email_intake', `id=eq.${intake.id}`, { notified_at: new Date().toISOString() });
      } catch { /* non-fatal */ }
    }
    return { status: 'ocr_failed' };
  }

  // ── Store the original document ──
  let stored = null;
  try {
    stored = await uploadAttachment({
      base64: readable.base64,
      mediaType: readable.mediaType,
      filename: safeFilename(readable.filename),
      intakeId: intake.id,
    });
  } catch (e) {
    diag.push(`attachment upload failed: ${e?.message || e}`);
  }

  // ── Who owns it ──
  const internalUser = await findInternalUser(intake.from_email);
  const routing = resolveBillRouting({
    fromEmail: intake.from_email,
    internalUser,
    ocrVendor: ocr.vendor,
    ocrAccountLabel: ocr.account_guess,
    settings,
  });

  // ── The bill draft ──
  const submitter = await resolveSubmitter(intake.from_email);
  if (!submitter?.id) {
    const msg = 'No submitter could be resolved — set AP_INBOX_SUBMITTER_ID on Netlify.';
    await opsPatch('bill_email_intake', `id=eq.${intake.id}`, {
      status: 'failed', status_detail: msg, diagnostics: diag.text(), ocr_result: ocr,
      processed_at: new Date().toISOString(),
    });
    return { status: 'failed' };
  }

  const lineItems = (ocr.line_items || []).map((li) => ({
    description: li.description,
    quantity: li.qty,
    unit_cost: li.unit_price,
    amount: li.amount,
  }));

  // Where it lands depends on whether approval is required.
  //
  //  approval ON  → `pending` + manager_email. ManagerQueue selects on
  //                 (manager_email, status='pending') regardless of
  //                 request_type, so it appears there next to the purchase
  //                 requests with no change to that page, and cannot post
  //                 until someone approves.
  //  approval OFF → `approved` (the default). This is the SAME auto-approve
  //                 every other Brixpense expense gets on submit, not a
  //                 rubber stamp of a human decision — so the bill is
  //                 immediately postable and shows up in the owner's
  //                 "Previous Expenses" with a Post to QuickBooks button.
  //                 manager_email is still set: ownership and RLS visibility
  //                 are what routing buys, and they don't depend on the gate.
  //  unassigned   → `draft`, held in the AP Inbox for a human to assign.
  const needsApproval = routing.assigned && settings.require_approval;
  const status = needsApproval ? 'pending' : (routing.assigned ? 'approved' : 'draft');
  const autoApproved = status === 'approved';

  const request = await opsInsert('expense_requests', {
    request_type: 'expense',
    status,
    manager_email: routing.owner_email,   // who owns it, gate or no gate
    ...(autoApproved ? {
      auto_approved: true,
      approved_by: 'system (AP inbox — no approval required)',
      approved_at: new Date().toISOString(),
    } : {}),
    as_bill: true,              // an unpaid vendor bill, not an out-of-pocket receipt
    tag: AP_TAG,
    submitted_by: submitter.id,
    submitter_name: submitter.matched_sender ? submitter.name : 'AP Inbox (email)',
    submitter_email: intake.from_email || submitter.email || null,
    vendor_name: ocr.vendor || null,
    bill_number: ocr.bill_number || null,
    total_amount: ocr.total ?? null,
    receipt_date: ocr.date || null,
    line_items: lineItems,
    memo: ocr.memo || intake.subject || null,
    description: intake.subject || null,
    job_number: ocr.job_number || null,
    customer_name: ocr.customer_name || null,
    cogs_account_label: ocr.account_guess || null,
    ocr_status: 'processed',
    ocr_processed_at: new Date().toISOString(),
  });

  if (stored && request?.id) {
    try {
      await opsInsert('expense_request_attachments', {
        request_id: request.id,
        file_name: stored.file_name,
        file_type: stored.file_type,
        file_size: stored.file_size,
        storage_path: stored.storage_path,
        ocr_result: ocr,
      });
    } catch (e) {
      diag.push(`attachment row insert failed: ${e?.message || e}`);
    }
  }

  await opsPatch('bill_email_intake', `id=eq.${intake.id}`, {
    status: 'drafted',
    status_detail: null,
    diagnostics: diag.text(),
    ocr_result: ocr,
    expense_request_id: request?.id || null,
    storage_path: stored?.storage_path || null,
    file_name: stored?.file_name || readable.filename,
    file_type: stored?.file_type || readable.mediaType,
    processed_at: new Date().toISOString(),
  });

  if (!intake.notified_at) {
    try {
      await notifyDrafted(intake, { ...request, ...ocr, vendor_name: ocr.vendor, total_amount: ocr.total, bill_number: ocr.bill_number, receipt_date: ocr.date }, settings, submitter, routing, needsApproval);
      await ackSender(intake, settings, { vendor_name: ocr.vendor, total_amount: ocr.total, bill_number: ocr.bill_number });
      await opsPatch('bill_email_intake', `id=eq.${intake.id}`, { notified_at: new Date().toISOString() });
    } catch (e) {
      console.warn('[ap-inbox] drafted notify failed:', e?.message || e);
    }
  }

  return { status: 'drafted', request_id: request?.id, owner: routing.owner_email, bill_status: status };
}

// ─── Handler ───

export default async (req) => {
  const secret = req.headers.get('x-ap-inbox-secret') || '';
  const isInternal = !!secret && secret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!isInternal) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }

  let body = {};
  try { body = await req.json(); } catch { /* sweep mode */ }

  const settings = await loadApInboxSettings();
  const accountLabels = await loadAccountLabels();

  let rows;
  try {
    if (body.intake_id) {
      rows = await opsGet(`bill_email_intake?id=eq.${body.intake_id}&select=*&limit=1`);
      if (rows?.[0] && !body.force && !RETRYABLE.includes(rows[0].status)) {
        return Response.json({ ok: true, skipped: `status ${rows[0].status}` });
      }
    } else {
      const filter = RETRYABLE.map(encodeURIComponent).join(',');
      rows = await opsGet(
        `bill_email_intake?status=in.(${filter})&order=received_at.asc&limit=${MAX_PER_RUN}&select=*`,
      );
    }
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }

  const results = [];
  for (const intake of rows || []) {
    try {
      results.push({ id: intake.id, ...(await processIntake(intake, settings, accountLabels)) });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 500);
      console.error('[ap-inbox] processing failed:', intake.id, msg);
      try {
        await opsPatch('bill_email_intake', `id=eq.${intake.id}`, {
          status: 'failed', status_detail: msg, processed_at: new Date().toISOString(),
        });
      } catch { /* the row keeps its previous status and stays retryable */ }
      results.push({ id: intake.id, status: 'failed', error: msg });
    }
  }

  return Response.json({ ok: true, processed: results.length, results });
};

export const config = { path: '/api/bill-email-process-background' };
