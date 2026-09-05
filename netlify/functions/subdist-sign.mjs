// /api/subdist-sign — the public, token-gated sub-distribution signing endpoint.
//
// Visitor-kiosk posture, same as the NDA: deliberately unauthenticated (a
// distribution partner's owner has no login here and may never want one),
// every write through the service role, and the TOKEN is the entire gate —
// nothing is readable or writable without one, and a token resolves to exactly
// one agreement.
//
// POST { action: 'view',    token }            → the agreement + what to prefill
// POST { action: 'sign',    token, … }         → executes it, files the PDF, emails both sides
// POST { action: 'pdf',     token }            → the executed PDF, base64
// POST { action: 'decline', token, reason }
//
// Three things the signer can never do, by construction:
//   · change the terms — `body_source` and `deal_terms` come from the row and
//     `sign` accepts no text of either kind, so what they sign is what we sent;
//   · sign twice — the row is frozen at the database by a trigger, and this
//     returns the executed copy rather than an error, because coming back to
//     re-read what you signed is legitimate;
//   · see anything else — publicView() is an allow-list, so a widened row can
//     never start leaking the token hash or another partner's agreement.
//
// ⚠ FILING NEVER UN-SIGNS ANYTHING. The signature is recorded FIRST; the PDF,
// the bucket and the two emails are each best-effort afterwards and record
// their own failure in `notes`. The page says so and pushes the signer to
// download the PDF then and there, rather than implying everything landed.

import { sendEmail, SITE_URL } from './email-helpers.mjs';
import {
  ops, validateToken, uploadPdf, clean, clientIp, todayPacific, companySignatory,
} from './lib/distributor/subdist-agreement-lib.mjs';
import { renderSubdistHtml, dealTerms } from './lib/distributor/subdist-doc.mjs';
import { renderSubdistPdf } from './lib/distributor/subdist-pdf.mjs';
import { describeImageProblem } from './lib/nda-image.mjs';

const ALERT_TO = process.env.DISTRIBUTOR_ALERT_TO || 'service@brixbev.com';
const FROM = process.env.NDA_EMAIL_FROM
  || 'Alameda Point Beverage Group <legal@alamedapointbg.com>';

const ENTITY_TYPES = [
  'corporation', 'limited liability company', 'limited partnership',
  'general partnership', 'sole proprietorship', 'other',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** What the signing page is allowed to know. Never the token hash, never the
 *  internal ids, never another agreement. */
function publicView(a, html) {
  return {
    agreement_number: a.agreement_number,
    status: a.status,
    title: a.title,
    subtitle: a.subtitle,
    html,
    counterparty_legal_name: a.counterparty_legal_name,
    counterparty_entity_type: a.counterparty_entity_type,
    counterparty_state: a.counterparty_state,
    counterparty_address: a.counterparty_address,
    signer_name: a.signer_name,
    signer_title: a.signer_title,
    signer_email: a.signer_email,
    company_signer_name: a.company_signer_name,
    company_signer_title: a.company_signer_title,
    effective_date: a.effective_date,
    signed_at: a.signed_at,
    expires_at: a.expires_at,
    entity_types: ENTITY_TYPES,
  };
}

async function loadDistributor(id) {
  const rows = await ops('GET', `sub_distributors?select=*&id=eq.${id}&limit=1`);
  return rows?.[0] || null;
}

function executedEmail({ a, them, forUs }) {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#16191d">
    <div style="padding:20px 0;border-bottom:2px solid #1f4e79">
      <img src="https://alamedapointbg.com/logos/brix-round.png" alt="Brix Beverage" height="44" style="vertical-align:middle">
      <img src="https://alamedapointbg.com/logos/alameda-seal.png" alt="Alameda Soda Co." height="44" style="vertical-align:middle;margin-left:10px">
    </div>
    <h1 style="font-size:20px;margin:24px 0 8px">Sub-distribution agreement executed</h1>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px">
      ${forUs ? `<b>${esc(them)}</b> has signed` : 'Thank you — this is signed'}
      ${esc(a.agreement_number || '')}. The executed copy is attached, and it carries the
      Fee and Territory Schedule and the record of signature.</p>
    <p style="font-size:13px;color:#5a636c;line-height:1.5;margin:0">
      Signed by ${esc(a.signer_name || '')}${a.signer_title ? `, ${esc(a.signer_title)}` : ''}
      on ${esc(new Date(a.signed_at).toLocaleDateString('en-US',
        { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' }))}.
      ${forUs ? '' : 'Keep this email — it is your copy.'}</p>
  </div>`;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Signing is not configured — SUPABASE_SERVICE_ROLE_KEY is missing on this site.' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Expected JSON.' }); }

  const check = await validateToken(body.token);
  if (check.error) return json(check.status, { error: check.error });
  let a = check.agreement;
  const action = body.action || 'view';
  const dist = await loadDistributor(a.sub_distributor_id);
  const render = (row) => renderSubdistHtml(row, { distributor: dist || {} });

  // ── view ────────────────────────────────────────────────────────────────
  if (action === 'view') {
    if (!a.viewed_at && a.status === 'sent') {
      // First open. Best-effort: a stamp that fails must not block the read.
      try {
        const at = new Date().toISOString();
        await ops('PATCH', `sub_distributor_agreements?id=eq.${a.id}`, { viewed_at: at });
        a = { ...a, viewed_at: at };
      } catch { /* ignore */ }
    }
    return json(200, { ok: true, ...publicView(a, render(a)) });
  }

  // ── pdf ─────────────────────────────────────────────────────────────────
  if (action === 'pdf') {
    if (a.status !== 'signed') return json(409, { error: 'This agreement has not been signed yet.' });
    const bytes = await renderSubdistPdf(a, { distributor: dist || {} });
    return json(200, {
      ok: true,
      file_name: `${a.agreement_number}.pdf`,
      pdf_base64: Buffer.from(bytes).toString('base64'),
    });
  }

  // ── decline ─────────────────────────────────────────────────────────────
  if (action === 'decline') {
    if (a.status === 'signed') return json(409, { error: 'This agreement has already been signed.' });
    const reason = clean(body.reason, 1000);
    await ops('PATCH', `sub_distributor_agreements?id=eq.${a.id}`, {
      status: 'declined', declined_at: new Date().toISOString(), decline_reason: reason || null,
    });
    try {
      await sendEmail({
        from: FROM, to: ALERT_TO,
        subject: `Sub-distribution agreement declined — ${dist?.name || ''} (${a.agreement_number})`,
        html: `<p><b>${esc(dist?.name || '')}</b> declined ${esc(a.agreement_number || '')}.</p>`
            + `<p>Reason given: ${reason ? esc(reason) : '<i>none</i>'}</p>`,
      });
    } catch { /* a declined agreement is recorded whether or not the email lands */ }
    return json(200, { ok: true, status: 'declined' });
  }

  if (action !== 'sign') return json(400, { error: 'Unknown action.' });

  // ── sign ────────────────────────────────────────────────────────────────
  if (a.status === 'signed') {
    // Not an error — they came back. Hand them what they signed.
    return json(200, { ok: true, already: true, ...publicView(a, render(a)) });
  }
  if (a.status === 'declined') {
    return json(409, { error: 'This agreement was declined. Contact us for a fresh copy.' });
  }

  const f = {
    counterparty_legal_name:  clean(body.counterparty_legal_name, 200),
    counterparty_entity_type: clean(body.counterparty_entity_type, 60),
    counterparty_state:       clean(body.counterparty_state, 60),
    counterparty_address:     clean(body.counterparty_address, 300),
    signer_name:              clean(body.signer_name, 120),
    signer_title:             clean(body.signer_title, 120),
    signer_email:             clean(body.signer_email, 200),
    typed_name:               clean(body.typed_name, 120),
  };

  const missing = [];
  if (!f.counterparty_legal_name) missing.push('your company’s full legal name');
  if (!f.counterparty_entity_type) missing.push('the kind of entity it is');
  if (!f.counterparty_address) missing.push('your business address');
  if (!f.signer_name) missing.push('the name of the person signing');
  if (!f.signer_title) missing.push('their title');
  if (!f.signer_email) missing.push('an email address');
  if (!f.typed_name) missing.push('your typed name');
  if (missing.length) {
    return json(400, { error: `Please add ${missing.slice(0, 3).join(', ')}`
      + `${missing.length > 3 ? ', and the rest of the highlighted fields' : ''}.` });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.signer_email)) {
    return json(400, { error: 'That email address does not look right — we send your signed copy there.' });
  }
  if (!ENTITY_TYPES.includes(f.counterparty_entity_type)) {
    return json(400, { error: 'Choose an entity type from the list.' });
  }
  if (body.consent !== true) {
    return json(400, { error: 'Please tick the box agreeing to sign electronically.' });
  }
  const sig = typeof body.signature_data === 'string' ? body.signature_data.trim() : '';
  if (!/^data:image\/png;base64,/.test(sig) || sig.length > 400_000) {
    return json(400, { error: 'Please sign in the box above.' });
  }
  // Refuse an unreadable signature HERE, while the signer is still on the page
  // and can draw it again. Past this point the signature is recorded and the
  // PDF, the bucket and the emails are all best-effort — so a bad image would
  // leave a signed agreement with no document and nobody told. (It also cannot
  // reach pdf-lib, whose PNG decoder spins forever on some malformed files.)
  const sigProblem = describeImageProblem(sig);
  if (sigProblem) return json(400, { error: sigProblem });

  const signedAt = new Date().toISOString();
  const patch = {
    ...f,
    status: 'signed',
    signed_at: signedAt,
    signature_data: sig,
    consent_esign: true,
    signer_ip: clientIp(req) || null,
    signer_user_agent: (typeof req.headers?.get === 'function' ? req.headers.get('user-agent') : '') || null,
  };
  // An agreement sent without an effective date takes today's, in Pacific.
  if (!a.effective_date) patch.effective_date = todayPacific();

  const updated = await ops('PATCH',
    `sub_distributor_agreements?id=eq.${a.id}&status=neq.signed`, patch,
    { Prefer: 'return=representation' });
  if (!updated || !updated[0]) {
    // Lost a race with another tab. The agreement is signed either way.
    const rows = await ops('GET', `sub_distributor_agreements?select=*&id=eq.${a.id}&limit=1`);
    const now = rows?.[0];
    if (now?.status === 'signed') return json(200, { ok: true, already: true, ...publicView(now, render(now)) });
    return json(500, { error: 'We could not record the signature. Please try again.' });
  }
  const signed = updated[0];
  const them = signed.counterparty_legal_name || dist?.name || '';

  // ── Everything below is best effort. The agreement is already executed. ──
  const notes = [];
  let pdfBase64 = null;

  try {
    const co = signed.company_signature_data ? null : await companySignatory(signed.company_signatory_id);
    const bytes = await renderSubdistPdf(signed, {
      distributor: dist || {}, companySignature: co?.signature_data || null,
    });
    pdfBase64 = Buffer.from(bytes).toString('base64');
    const path = `agreements/${signed.sub_distributor_id}/${signed.agreement_number}.pdf`;
    await uploadPdf(path, bytes);
    await ops('PATCH', `sub_distributor_agreements?id=eq.${signed.id}`, {
      executed_pdf_path: path, executed_pdf_at: new Date().toISOString(),
      file_path: path, file_name: `${signed.agreement_number}.pdf`,
    });
  } catch (e) {
    notes.push(`PDF/filing failed: ${e?.message || e}`);
  }

  const attachments = pdfBase64
    ? [{ filename: `${signed.agreement_number}.pdf`, content: pdfBase64 }]
    : undefined;
  for (const [to, forUs] of [[signed.signer_email, false], [ALERT_TO, true]]) {
    try {
      await sendEmail({
        from: FROM, to,
        subject: `${them} — sub-distribution agreement executed (${signed.agreement_number})`,
        html: executedEmail({ a: signed, them, forUs }),
        attachments,
      });
    } catch (e) { notes.push(`email to ${to} failed: ${e?.message || e}`); }
  }

  if (notes.length) {
    // Recorded ON THE ROW, because "signed but we never sent it" is a fact
    // somebody has to be able to find later.
    try {
      await ops('PATCH', `sub_distributor_agreements?id=eq.${signed.id}`, {
        notes: [signed.notes, ...notes].filter(Boolean).join(' · ').slice(0, 2000),
      });
    } catch { /* ignore */ }
  }

  return json(200, {
    ok: true,
    ...publicView(signed, render(signed)),
    pdf_ready: !!pdfBase64,
    delivery_notes: notes,
  });
};
