// self-bill-invoice — raise a supplier's invoice on their behalf.
//
// Origins Craft Soda does contract labour for us and does not issue invoices;
// they authorised us to raise them. Their expenses land from Service Fusion
// with an amount, a job and a line item but NO bill number, which is exactly
// what the OCR gate holds a draft on — so the missing document is the thing
// blocking the bill, and producing it fixes both at once.
//
// GET                          → profiles + recent invoices
// GET ?expense_id=             → what would be raised for this expense
// POST {action:'create'}       → allocate a number, render, file, attach, stamp
// POST {action:'send'}         → email it to the supplier
// POST {action:'void'}         → void one (the number is never reused)
// POST {action:'save_profile'} → edit the addresses, numbering, matching, recipients
//
// Accounts-payable only, via requireApAdmin — the same ap_admin row the RLS
// reads. This writes documents that go to an outside party.
// Auth: a staff Bearer, or x-ap-inbox-secret == SUPABASE_SERVICE_ROLE_KEY for
// the daily SF job's automatic raise.

import { opsGet, opsInsert, opsPatch, srHeaders, requireApAdmin, ATTACH_BUCKET } from './lib/ap-inbox.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail, EMAIL_FROM } from './email-helpers.mjs';
import { renderSelfBilledInvoicePdf } from './lib/production-docs.mjs';
import { brixpenseEmail, kvRow, kvTable, esc, money } from './lib/brixpense-email.mjs';
import {
  matchesProfile, buildInvoiceModel, recipientsFor, canRaise,
} from './lib/self-billing.mjs';

const EXPENSE_COLS = 'id,vendor_name,total_amount,receipt_date,job_number,line_items,'
  + 'bill_number,status,tag,as_bill,archived_at,submitter_email,qbo_vendor_id';

async function loadCompany() {
  try {
    const rows = await opsGet('production_settings?limit=1&select=company_name,company_addr1,company_addr2,company_city_state_zip,company_email,doc_accent,doc_from');
    return rows?.[0] || {};
  } catch { return {}; }
}

const loadProfiles = () => opsGet('self_billing_profiles?active=is.true&order=code&select=*');

async function invoiceFor(expenseId) {
  const rows = await opsGet(`self_billed_invoices?expense_request_id=eq.${expenseId}&limit=1&select=*`);
  return rows?.[0] || null;
}

/** The profile that claims this expense, or null. */
export function pickProfile(profiles, expense) {
  return (profiles || []).find((p) => matchesProfile(p, expense)) || null;
}

async function uploadInvoicePdf(bytes, expenseId, invoiceNumber) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const filename = `${invoiceNumber}.pdf`;
  const path = `self-billed/${expenseId}/${filename}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATTACH_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: Buffer.from(bytes),
  });
  if (!res.ok) throw new Error(`invoice upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { path, filename, size: bytes.length };
}

async function renderFor(profile, expense, company, invoiceNumber, invoiceDate) {
  const model = buildInvoiceModel({ profile, expense, company, invoiceNumber, invoiceDate });
  const bytes = await renderSelfBilledInvoicePdf({ ...model, accent: company.doc_accent || '#dc2626' });
  return { model, bytes };
}

async function emailInvoice({ profile, invoice, model, bytes, company, actor }) {
  const { to, cc } = recipientsFor(profile);
  if (!to.length) return { sent: false, error: 'No recipient is set on this profile.' };

  const html = brixpenseEmail('#dc2626', `Invoice ${invoice.invoice_number}`, `
    <p style="margin:0 0 12px;color:#CBD5E1">
      Attached is invoice <strong>${esc(invoice.invoice_number)}</strong> for the work below,
      prepared by ${esc(model.buyer.name || 'us')} on behalf of ${esc(model.seller.name)} by agreement.
    </p>
    ${kvTable([
      kvRow('Invoice', esc(invoice.invoice_number)),
      kvRow('Date', esc(model.invoiceDate)),
      ...(model.jobNumber ? [kvRow('Job', esc(model.jobNumber))] : []),
      kvRow('Amount', money(model.total)),
    ].join(''))}
    <p style="margin:16px 0 0;color:#94A3B8;font-size:12px">
      If anything here is wrong, reply to this email and it will be corrected and reissued —
      please don't raise a separate invoice for the same work, or the charge may be paid twice.
    </p>`);

  const ok = await sendEmail({
    to, cc,
    subject: `Invoice ${invoice.invoice_number} — ${model.seller.name} — ${money(model.total)}`,
    html,
    from: company.doc_from || EMAIL_FROM,
    replyTo: company.company_email || EMAIL_FROM,
    // The PDF we email is the PDF we filed — same bytes, not a re-render.
    attachments: [{ filename: `${invoice.invoice_number}.pdf`, content: Buffer.from(bytes).toString('base64') }],
  });
  if (!ok) return { sent: false, error: 'The email provider refused the send.' };
  await opsPatch('self_billed_invoices', `id=eq.${invoice.id}`, {
    sent_at: new Date().toISOString(), sent_to: to, send_error: null, updated_at: new Date().toISOString(),
  });
  return { sent: true, to, cc, actor };
}

export default async function handler(req) {
  // The daily SF job calls this with the service secret, exactly as
  // bill-email-process-background is called. No escalation: anyone holding that
  // secret already has full database access, so this adds no reach — it just
  // lets the automatic path use the same code as the button instead of a
  // second implementation that could drift on what the document says.
  const secret = req.headers.get('x-ap-inbox-secret') || '';
  const isInternal = !!secret && secret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '');

  let actor = 'system (self-billing)';
  if (!isInternal) {
    const auth = await requireApAdmin(req);
    if (!auth.ok) return auth.response;
    actor = auth.user?.email || 'staff';
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const expenseId = url.searchParams.get('expense_id');
      const profiles = await loadProfiles();

      if (expenseId) {
        const [expense] = await opsGet(`expense_requests?id=eq.${expenseId}&limit=1&select=${EXPENSE_COLS}`);
        const profile = pickProfile(profiles, expense);
        const existing = expense ? await invoiceFor(expenseId) : null;
        const gate = canRaise(expense, existing);
        return Response.json({
          ok: true, profile: profile ? { id: profile.id, code: profile.code, seller_name: profile.seller_name,
            auto_send: profile.auto_send, send_to: profile.send_to } : null,
          existing, can_raise: !!profile && gate.ok, reason: profile ? gate.reason : 'No self-billing profile claims this vendor.',
        });
      }

      const invoices = await opsGet('self_billed_invoices?order=created_at.desc&limit=50&select=*');
      return Response.json({ ok: true, profiles, invoices });
    }

    if (req.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'save_profile') {
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'id required' }, { status: 400 });
      // Whitelisted: everything that identifies either party or addresses the
      // email. next_number is editable too — a supplier who already used
      // BX-0012 elsewhere needs us to skip past it.
      const ALLOWED = ['active', 'vendor_patterns', 'qbo_vendor_id', 'seller_name', 'seller_addr1', 'seller_addr2',
        'seller_city_state_zip', 'seller_email', 'seller_phone', 'buyer_name', 'buyer_addr1', 'buyer_addr2',
        'buyer_city_state_zip', 'buyer_email', 'number_prefix', 'number_separator', 'number_pad', 'next_number',
        'terms', 'footer_note', 'send_to', 'send_cc', 'auto_create', 'auto_send', 'authorized_by', 'authorized_at',
        'authority_note'];
      const patch = {};
      for (const k of ALLOWED) if (k in body) patch[k] = body[k];
      if (!Object.keys(patch).length) return Response.json({ error: 'nothing to save' }, { status: 400 });
      patch.updated_at = new Date().toISOString();
      await opsPatch('self_billing_profiles', `id=eq.${id}`, patch);
      return Response.json({ ok: true, saved: Object.keys(patch).filter((k) => k !== 'updated_at') });
    }

    const expenseId = String(body.expense_request_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(expenseId)) return Response.json({ error: 'expense_request_id required' }, { status: 400 });
    const [expense] = await opsGet(`expense_requests?id=eq.${expenseId}&limit=1&select=${EXPENSE_COLS}`);
    const profiles = await loadProfiles();
    const profile = pickProfile(profiles, expense);
    const company = await loadCompany();
    let invoice = await invoiceFor(expenseId);

    if (action === 'preview') {
      if (!profile) return Response.json({ error: 'No self-billing profile claims this vendor.' }, { status: 409 });
      const gate = canRaise(expense, invoice);
      const model = buildInvoiceModel({ profile, expense, company, invoiceNumber: invoice?.invoice_number || '(next)' });
      return Response.json({ ok: true, can_raise: gate.ok, reason: gate.reason, model, existing: invoice });
    }

    if (action === 'void') {
      if (!invoice) return Response.json({ error: 'No invoice to void.' }, { status: 404 });
      await opsPatch('self_billed_invoices', `id=eq.${invoice.id}`, {
        voided_at: new Date().toISOString(), voided_by: actor,
        void_reason: String(body.reason || '').slice(0, 500) || null, updated_at: new Date().toISOString(),
      });
      // The number is NOT returned to the pool. A voided invoice number that
      // gets reissued to different money is how two documents end up claiming
      // to be BX-0012.
      return Response.json({ ok: true, voided: invoice.invoice_number });
    }

    if (action === 'send') {
      if (!invoice || invoice.voided_at) return Response.json({ error: 'There is no live invoice for this expense.' }, { status: 404 });
      if (!profile) return Response.json({ error: 'No self-billing profile claims this vendor.' }, { status: 409 });
      const { model, bytes } = await renderFor(profile, expense, company, invoice.invoice_number, invoice.invoice_date);
      const out = await emailInvoice({ profile, invoice, model, bytes, company, actor });
      if (!out.sent) {
        await opsPatch('self_billed_invoices', `id=eq.${invoice.id}`, { send_error: out.error, updated_at: new Date().toISOString() });
        return Response.json({ error: out.error }, { status: 502 });
      }
      return Response.json({ ok: true, sent_to: out.to, cc: out.cc, invoice_number: invoice.invoice_number });
    }

    if (action !== 'create') return Response.json({ error: `unknown action ${action}` }, { status: 400 });

    if (!profile) return Response.json({ error: 'No self-billing profile claims this vendor.' }, { status: 409 });
    const gate = canRaise(expense, invoice);
    if (!gate.ok) return Response.json({ error: gate.reason, existing: gate.existing || null }, { status: 409 });

    // Allocate under a row lock in SQL — two clicks a second apart must not
    // both take BX-0012.
    const numRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_self_bill_next_number`, {
      method: 'POST', headers: { ...srHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_profile_id: profile.id }),
    });
    if (!numRes.ok) throw new Error(`could not allocate an invoice number: ${numRes.status} ${(await numRes.text()).slice(0, 200)}`);
    const invoiceNumber = (await numRes.json());

    const { model, bytes } = await renderFor(profile, expense, company, invoiceNumber, body.invoice_date);
    const file = await uploadInvoicePdf(bytes, expenseId, invoiceNumber);

    // ⚠ opsInsert returns the ROW, not an array. Destructuring it would have
    // yielded undefined, so the invoice would have filed with a null
    // attachment_id and looked attached while pointing at nothing.
    const attachment = await opsInsert('expense_request_attachments', {
      request_id: expenseId, file_name: file.filename, file_type: 'application/pdf',
      file_size: file.size, storage_path: file.path,
    });

    const row = await opsInsert('self_billed_invoices', {
      profile_id: profile.id, expense_request_id: expenseId, invoice_number: invoiceNumber,
      invoice_date: model.invoiceDate, subtotal: model.subtotal, total: model.total,
      lines: model.lines, storage_path: file.path, attachment_id: attachment?.id || null, created_by: actor,
    });
    invoice = row;

    // The invoice IS the bill number. That is what clears the OCR gate these
    // drafts are held on, so raising the document is what makes the bill
    // postable — the whole point of the exercise.
    const stamp = { bill_number: invoiceNumber, updated_at: new Date().toISOString() };
    if (!expense.bill_number) {
      stamp.ocr_status = 'processed';
      stamp.ocr_error = null;
    }
    try { await opsPatch('expense_requests', `id=eq.${expenseId}`, stamp); } catch (e) {
      console.error('[self-bill] stamped invoice but could not update the expense:', e?.message || e);
    }

    let sent = null;
    if (profile.auto_send) {
      const out = await emailInvoice({ profile, invoice, model, bytes, company, actor });
      sent = out;
      if (!out.sent) {
        await opsPatch('self_billed_invoices', `id=eq.${invoice.id}`, { send_error: out.error, updated_at: new Date().toISOString() });
      }
    }

    return Response.json({
      ok: true, invoice_number: invoiceNumber, invoice_id: invoice.id,
      attached: !!attachment?.id, bill_number_stamped: invoiceNumber,
      line_mismatch: model.lineMismatch, sent,
      note: profile.auto_send ? undefined : 'Filed and attached. Use Send to email it to the supplier.',
    });
  } catch (e) {
    console.error('[self-bill-invoice]', e?.message || e);
    return Response.json({ error: String(e?.message || e).slice(0, 400) }, { status: 500 });
  }
}

export const config = { path: '/api/self-bill-invoice' };
