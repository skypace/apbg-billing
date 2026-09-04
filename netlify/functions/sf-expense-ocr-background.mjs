// sf-expense-ocr-background.mjs — the OCR gate in front of the SF-expense →
// QBO-bill autopost.
//
// Ask (Sky, 2026-08-13): SF-sourced expense drafts should go through OCR like
// any other bill — pull vendor/date/line-items/bill-number out of the actual
// receipt — and a bill number should flow through to QBO. But if no PDF/receipt
// is attached at all, DON'T let it auto-post: hold it as a draft so a human can
// review and adjust before it becomes a QBO Bill.
//
// This function is the gate: for every SF-tag draft that hasn't been through
// OCR yet (ocr_status IS NULL), it either
//   - finds no attachment → ocr_status='no_attachment' (never auto-posts; a
//     human opens it in Brixpense, attaches a receipt or fills it in by hand,
//     and submits manually — expense-request-notify posts it same as any
//     other expense, gate-free, because a human explicitly reviewed it), or
//   - finds an attachment → runs it through the same Claude OCR used for
//     human-uploaded receipts (lib/expense-ocr-core.mjs) and stores the
//     extraction on the attachment row (ops.expense_request_attachments
//     .ocr_result) + promotes bill_number onto the request row.
//
// sf-expense-autopost-background.mjs only auto-posts rows where
// ocr_status='processed' AND bill_number IS NOT NULL — this function is what
// produces both.
//
// Auth: same pattern as sf-expense-autopost-background.mjs — cron secret
// (x-sf-autopost-secret) OR superadmin Bearer. No enable flag: unlike autopost,
// this function only reads receipts and writes Brixpense-local columns — it
// never touches QBO, so there's no live-financial-system blast radius to gate.

import { requireAuth } from './lib/auth.mjs';
import { runExpenseOcr } from './lib/expense-ocr-core.mjs';
import { brixpenseEmail, kvRow, kvTable, esc, money } from './lib/brixpense-email.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';

const REPORT_TO = process.env.SF_EXPENSE_REPORT_TO || 'whitney@alamedasoda.com';
const MAX_PER_RUN = 30;
const ATTACH_BUCKET = 'expense-attachments';

function srHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ops', 'Content-Profile': 'ops', ...extra };
}
async function opsGet(q) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: srHeaders() });
  if (!res.ok) throw new Error(`ops read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function opsPatch(table, id, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: srHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
async function logRun(started, status, records, metadata, errorMessage = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST', headers: srHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ source: 'sf', sync_type: 'sf-expense-ocr', status, records_synced: records, started_at: started, completed_at: new Date().toISOString(), error_message: errorMessage, metadata }),
    });
  } catch { /* best-effort */ }
}

async function loadAccountLabels() {
  try {
    const rows = await opsGet(`expense_settings?key=eq.cogs_accounts&select=value`);
    const value = rows?.[0]?.value;
    if (Array.isArray(value)) return value.map((a) => a.label || a.name || '').filter(Boolean);
  } catch { /* fall through to free-form */ }
  return [];
}

async function downloadAttachment(storagePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATTACH_BUCKET}/${storagePath}`, { headers: srHeaders() });
  if (!res.ok) throw new Error(`storage fetch failed (${res.status})`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

function guessMediaType(fileType, fileName) {
  if (fileType) return fileType;
  const ext = (fileName || '').split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function emailHeld(r, headline, reason) {
  const inner = `<p style="margin:0 0 6px;color:#fff;font-size:16px;font-weight:700">${esc(headline)}</p>
    <p style="margin:0 0 14px;color:#CBD5E1">${esc(reason)}</p>
    ${kvTable([
      kvRow('Service Fusion job', `<b style="color:#fff">${esc(r.job_number || '')}</b>${r.customer_name ? ' — ' + esc(r.customer_name) : ''}`),
      kvRow('Vendor on record (SF)', r.vendor_name ? esc(r.vendor_name) : '<i style="color:#FBBF24">blank</i>'),
      kvRow('Amount', money(r.total_amount)),
      kvRow('Brixpense ID', esc(r.id)),
    ].join(''))}
    <p style="color:#64748B;font-size:12px;margin-top:14px">This draft will NOT auto-post to QuickBooks. Open it in Brixpense → SF Expenses, attach/replace the receipt or fill in the bill number, and submit — that posts it immediately, no waiting on the automated sweep.</p>`;
  await sendEmail({
    to: REPORT_TO,
    subject: `⚠ Brixpense — SF expense held for review: ${r.job_number || r.id} (${headline})`,
    html: brixpenseEmail('#F59E0B', 'Needs review', inner),
  });
}

/**
 * Raise the supplier's invoice ourselves, where they authorised it.
 *
 * Calls the one endpoint that does this, so the automatic path and the button
 * in Brixpense cannot drift on what the document says or how it is numbered.
 *
 * ⚠ self-bill-invoice declares config.path = '/api/self-bill-invoice', so it is
 * served THERE and the legacy /.netlify/functions/<name> route 404s — the trap
 * that left every emailed bill stuck at "Scanning".
 */
async function tryRaiseSelfBilledInvoice(expense) {
  const base = process.env.URL || 'https://apbg-billing.netlify.app';
  try {
    const res = await fetch(`${base}/api/self-bill-invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ap-inbox-secret': process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      },
      body: JSON.stringify({ action: 'create', expense_request_id: expense.id }),
    });
    if (!res.ok) {
      // 409 is the normal case: no profile claims this vendor, because most
      // suppliers do send their own invoices. Not worth logging as noise.
      if (res.status !== 409) {
        console.error('[sf-expense-ocr] self-bill raise failed:', res.status, (await res.text()).slice(0, 200));
      }
      return false;
    }
    const out = await res.json();
    return !!out?.invoice_number;
  } catch (e) {
    console.error('[sf-expense-ocr] self-bill raise threw:', e?.message || e);
    return false;
  }
}

/**
 * Rescue drafts ALREADY held at 'no_attachment' that a self-billing profile can
 * now cover.
 *
 * ⚠ Without this the feature only works going forward. The main pool takes
 * ocr_status IS NULL, so a row held before the supplier's profile existed — or
 * before this feature shipped — is stranded permanently, and a supplier who
 * NEVER issues invoices lands at 'no_attachment' every single time by
 * definition. Origins had two sitting in exactly that state.
 *
 * Deliberately silent on a miss: a row no profile claims is left completely
 * untouched — no patch, no email — so this cannot re-notify anybody about a
 * hold they were already told about. The cost is a few cheap 409s a day,
 * bounded by the limit.
 */
async function rescueHeldSelfBillables(sel) {
  let rescued = 0;
  let rows = [];
  try {
    rows = await opsGet(
      `expense_requests?tag=eq.Service%20Fusion&request_type=eq.expense&status=eq.draft`
      + `&qbo_bill_id=is.null&archived_at=is.null&ocr_status=eq.no_attachment`
      + `&bill_number=is.null&order=created_at.asc&limit=25&select=${sel}`,
    );
  } catch { return 0; }
  for (const r of rows) {
    if (await tryRaiseSelfBilledInvoice(r)) rescued++;
  }
  return rescued;
}

export default async (req) => {
  const url = new URL(req.url);

  const cronSecret = req.headers.get('x-sf-autopost-secret') || '';
  const isCron = !!cronSecret && (
    cronSecret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32) ||
    (!!process.env.SF_AUTOPOST_CRON_SECRET && cronSecret === process.env.SF_AUTOPOST_CRON_SECRET)
  );
  if (!isCron) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }

  const started = new Date().toISOString();
  try {
    const sel = 'id,vendor_name,total_amount,job_number,customer_name,memo,receipt_date,line_items';
    const rows = await opsGet(
      `expense_requests?tag=eq.Service%20Fusion&request_type=eq.expense&status=eq.draft&qbo_bill_id=is.null&archived_at=is.null&ocr_status=is.null&order=created_at.asc&limit=${MAX_PER_RUN}&select=${sel}`
    );

    let processed = 0, noAttachment = 0, failed = 0, noBillNumber = 0, selfBilled = 0;
    const accountLabels = rows.length ? await loadAccountLabels() : [];

    for (const r of rows) {
      let attachments = [];
      try {
        attachments = await opsGet(`expense_request_attachments?request_id=eq.${r.id}&select=id,file_name,file_type,storage_path&order=created_at.asc&limit=1`);
      } catch (e) {
        // Can't even check — leave ocr_status null so the next run retries.
        continue;
      }

      if (!attachments.length) {
        // SELF-BILLING. Some suppliers do not issue invoices at all — Origins
        // Craft Soda authorised us to raise theirs. For those, "no attachment"
        // is not something to hold and chase: the document does not exist
        // because it is OURS to produce. Raising it files the PDF, attaches it
        // and stamps the bill number — precisely what this gate waits for — so
        // the draft leaves held and becomes postable.
        //
        // Best-effort by design: a failure must leave the row exactly where it
        // would have been anyway (held, then chased), never lose it.
        if (await tryRaiseSelfBilledInvoice(r)) { selfBilled++; continue; }
        noAttachment++;
        await opsPatch('expense_requests', r.id, { ocr_status: 'no_attachment', ocr_processed_at: new Date().toISOString() });
        if (url.searchParams.get('mode') !== 'quiet') {
          try { await emailHeld(r, 'no receipt attached', 'Service Fusion has no receipt/document on this expense, and nothing was found to attach — there is nothing to OCR.'); } catch { /* non-fatal */ }
        }
        await opsPatch('expense_requests', r.id, { ocr_notified_at: new Date().toISOString() });
        continue;
      }

      const att = attachments[0];
      try {
        const base64 = await downloadAttachment(att.storage_path);
        const mediaType = guessMediaType(att.file_type, att.file_name);
        const result = await runExpenseOcr({ base64, mediaType, accountLabels });

        try { await opsPatch('expense_request_attachments', att.id, { ocr_result: result }); } catch { /* non-fatal — the request row is the source of truth for the gate */ }

        await opsPatch('expense_requests', r.id, {
          bill_number: result.bill_number || null,
          ocr_status: 'processed',
          ocr_processed_at: new Date().toISOString(),
          ocr_error: null,
        });
        processed++;

        if (!result.bill_number) {
          noBillNumber++;
          if (url.searchParams.get('mode') !== 'quiet') {
            try { await emailHeld(r, 'no bill number found', 'The receipt was read successfully, but no vendor invoice/bill number was found on it — review before posting.'); } catch { /* non-fatal */ }
          }
          await opsPatch('expense_requests', r.id, { ocr_notified_at: new Date().toISOString() });
        }
      } catch (e) {
        failed++;
        const msg = String(e?.message || e).slice(0, 500);
        await opsPatch('expense_requests', r.id, { ocr_status: 'failed', ocr_error: msg, ocr_processed_at: new Date().toISOString() });
        if (url.searchParams.get('mode') !== 'quiet') {
          try { await emailHeld(r, 'OCR failed', `The attached receipt couldn't be read: ${msg}`); } catch { /* non-fatal */ }
        }
        await opsPatch('expense_requests', r.id, { ocr_notified_at: new Date().toISOString() });
      }
    }

    // Also pick up anything already held that a self-billing profile now covers.
    const rescued = await rescueHeldSelfBillables(sel);
    const summary = { scanned: rows.length, processed, no_attachment: noAttachment, failed, no_bill_number: noBillNumber, self_billed: selfBilled + rescued, self_billed_rescued: rescued };
    await logRun(started, 'success', processed, summary);
    return new Response(JSON.stringify({ ok: true, ...summary }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[sf-expense-ocr]', e);
    await logRun(started, 'error', 0, {}, String(e?.message || e).slice(0, 500));
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/sf-expense-ocr-background' };
