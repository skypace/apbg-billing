// /api/nda-sign — the public, token-gated NDA signing endpoint.
//
// Visitor-kiosk posture: deliberately unauthenticated (a co-packer or a lab has
// no login here and never will), every write through the service role, and the
// TOKEN is the entire gate — nothing is readable or writable without one, and
// a token resolves to exactly one agreement.
//
// POST { action: 'view',    token }  → the agreement text + what to prefill
// POST { action: 'sign',    token, … } → executes it, renders the PDF, files it
// POST { action: 'pdf',     token }  → the executed PDF, base64, for download
// POST { action: 'decline', token, reason }
//
// Two things the recipient can never do, by construction:
//   · change the terms — `body_source` comes from the row and `sign` does not
//     accept text of any kind, so what they sign is what we sent;
//   · sign twice — the row is frozen at the database by a trigger, and this
//     endpoint returns the executed copy instead of an error, because coming
//     back to re-read what you signed is legitimate, not a failure.
//
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY/SENDGRID_API_KEY,
//      COMPLIANCE_ALERT_TO (optional, defaults service@brixbev.com).

import { sendEmail } from './email-helpers.mjs';
import {
  NDA_FROM, ops, validateToken, loadLog, uploadPdf, ensureParty, fileInVault,
  clean, clientIp, todayPacific, ENTITY_TYPES, SERVICE_OPTIONS,
  executedEmailRecipient, executedEmailStaff, declinedEmailStaff,
} from './lib/nda-lib.mjs';
import { renderNdaHtml } from './lib/nda-doc.mjs';
import { renderNdaPdf } from './lib/nda-pdf.mjs';
import { describeImageProblem } from './lib/nda-image.mjs';

const ALERT_TO = process.env.COMPLIANCE_ALERT_TO || 'service@brixbev.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});

/** What the signing page is allowed to know. Never the token hash, never the
 *  internal ids, never another agreement. */
function publicView(a, html) {
  return {
    agreement_number: a.agreement_number,
    status: a.status,
    title: a.title,
    subtitle: a.subtitle,
    html,
    recipient_company: a.recipient_company,
    recipient_contact: a.recipient_contact,
    recipient_email: a.recipient_email,
    recipient_legal_name: a.recipient_legal_name,
    recipient_entity_type: a.recipient_entity_type,
    recipient_state: a.recipient_state,
    recipient_address: a.recipient_address,
    signer_name: a.signer_name,
    signer_title: a.signer_title,
    signer_email: a.signer_email,
    signer_phone: a.signer_phone,
    purpose_scope: a.purpose_scope,
    services: a.services || [],
    company_signer_name: a.company_signer_name,
    company_signer_title: a.company_signer_title,
    effective_date: a.effective_date,
    signed_at: a.signed_at,
    expires_at: a.expires_at,
    entity_types: ENTITY_TYPES,
    service_options: SERVICE_OPTIONS,
  };
}

/** Render + file the executed PDF. Returns { path, bytes }. */
async function buildAndFile(a) {
  const log = await loadLog(a.id);
  const bytes = await renderNdaPdf(a, { log });
  const path = `nda/${a.agreement_number}.pdf`;
  await uploadPdf(path, bytes);
  return { path, bytes };
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

  // ── view ──────────────────────────────────────────────────────────────────
  if (action === 'view') {
    if (!a.viewed_at && a.status === 'sent') {
      // First open. Best-effort: a stamp that fails must not block the read.
      try {
        await ops('PATCH', `nda_agreements?id=eq.${a.id}`, { viewed_at: new Date().toISOString(), status: 'viewed' });
        a = { ...a, viewed_at: new Date().toISOString(), status: 'viewed' };
      } catch { /* ignore */ }
    }
    const log = a.status === 'signed' ? await loadLog(a.id) : [];
    return json(200, { ok: true, ...publicView(a, renderNdaHtml(a, { log })) });
  }

  // ── pdf ───────────────────────────────────────────────────────────────────
  if (action === 'pdf') {
    if (a.status !== 'signed') return json(409, { error: 'This agreement has not been signed yet.' });
    const log = await loadLog(a.id);
    const bytes = await renderNdaPdf(a, { log });
    return json(200, {
      ok: true,
      file_name: `${a.agreement_number}.pdf`,
      pdf_base64: Buffer.from(bytes).toString('base64'),
    });
  }

  // ── decline ───────────────────────────────────────────────────────────────
  if (action === 'decline') {
    if (a.status === 'signed') return json(409, { error: 'This agreement has already been signed.' });
    const reason = clean(body.reason, 1000);
    await ops('PATCH', `nda_agreements?id=eq.${a.id}`, {
      status: 'declined', declined_at: new Date().toISOString(), decline_reason: reason || null,
    });
    try {
      await sendEmail({
        from: NDA_FROM,
        to: ALERT_TO,
        subject: `NDA declined — ${a.recipient_company} (${a.agreement_number})`,
        html: declinedEmailStaff({ a, reason }),
      });
    } catch { /* a declined NDA is recorded whether or not the email lands */ }
    return json(200, { ok: true, status: 'declined' });
  }

  // ── sign ──────────────────────────────────────────────────────────────────
  if (action !== 'sign') return json(400, { error: 'Unknown action.' });

  if (a.status === 'signed') {
    // Not an error — they came back. Hand them what they signed.
    const log = await loadLog(a.id);
    return json(200, { ok: true, already: true, ...publicView(a, renderNdaHtml(a, { log })) });
  }
  if (a.status === 'declined') return json(409, { error: 'This agreement was declined. Contact us for a fresh copy.' });

  const f = {
    recipient_legal_name:  clean(body.recipient_legal_name, 200),
    recipient_entity_type: clean(body.recipient_entity_type, 60),
    recipient_state:       clean(body.recipient_state, 60),
    recipient_address:     clean(body.recipient_address, 300),
    signer_name:           clean(body.signer_name, 120),
    signer_title:          clean(body.signer_title, 120),
    signer_email:          clean(body.signer_email, 200),
    signer_phone:          clean(body.signer_phone, 40),
    typed_name:            clean(body.typed_name, 120),
  };

  const missing = [];
  if (!f.recipient_legal_name) missing.push('your company’s full legal name');
  if (!f.recipient_entity_type) missing.push('the kind of entity it is');
  if (!f.recipient_address) missing.push('your business address');
  if (!f.signer_name) missing.push('the name of the person signing');
  if (!f.signer_title) missing.push('their title');
  if (!f.signer_email) missing.push('an email address');
  if (!f.typed_name) missing.push('your typed name');
  if (missing.length) {
    return json(400, { error: `Please add ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', and the rest of the highlighted fields' : ''}.` });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.signer_email)) {
    return json(400, { error: 'That email address does not look right — we send your signed copy there.' });
  }
  if (!ENTITY_TYPES.includes(f.recipient_entity_type)) {
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
  // PDF, the vault and the emails are all best-effort — so a bad image would
  // leave a signed agreement with no document and nobody told. (It also cannot
  // reach pdf-lib, whose PNG decoder spins forever on some malformed files.)
  const sigProblem = describeImageProblem(sig);
  if (sigProblem) return json(400, { error: sigProblem });

  const signedAt = new Date().toISOString();
  const patch = {
    ...f,
    status: 'signed',
    signed_at: signedAt,
    effective_date: todayPacific(),
    signature_data: sig,
    consent_esign: true,
    signer_ip: clientIp(req) || null,
    signer_user_agent: (typeof req.headers?.get === 'function' ? req.headers.get('user-agent') : '') || null,
  };
  // The recipient may sharpen the purpose we drafted, but may not blank it —
  // an NDA with no stated purpose is the one clause a court actually reads.
  const purpose = clean(body.purpose_scope, 1000);
  if (purpose) patch.purpose_scope = purpose;

  const updated = await ops('PATCH', `nda_agreements?id=eq.${a.id}&status=neq.signed`, patch,
    { Prefer: 'return=representation' });
  if (!updated || !updated[0]) {
    // Lost a race with another tab. The agreement is signed either way.
    const rows = await ops('GET', `nda_agreements?select=*&id=eq.${a.id}&limit=1`);
    const now = rows && rows[0];
    if (now && now.status === 'signed') {
      const log = await loadLog(now.id);
      return json(200, { ok: true, already: true, ...publicView(now, renderNdaHtml(now, { log })) });
    }
    return json(500, { error: 'Could not record the signature. Please try once more.' });
  }
  a = updated[0];

  // ── Everything past this point is FILING, and filing must never un-sign the
  // agreement. The signature is recorded; a storage hiccup or a Resend outage
  // is an operations problem to fix later, not a reason to tell someone their
  // signature did not take. Each step records its own failure instead.
  let pdfBase64 = null;
  const warnings = [];
  try {
    const { path, bytes } = await buildAndFile(a);
    pdfBase64 = Buffer.from(bytes).toString('base64');
    const partyId = await ensureParty(a).catch((e) => { warnings.push('party: ' + e.message); return null; });
    if (partyId) a.insured_party_id = partyId;
    let documentId = null;
    try { documentId = await fileInVault(a, path); } catch (e) { warnings.push('vault: ' + e.message); }
    await ops('PATCH', `nda_agreements?id=eq.${a.id}`, {
      pdf_path: path,
      insured_party_id: a.insured_party_id || null,
      document_id: documentId,
      notes: warnings.length ? `Filing warnings: ${warnings.join(' | ')}` : a.notes,
    });
  } catch (e) {
    warnings.push('pdf: ' + e.message);
    try {
      await ops('PATCH', `nda_agreements?id=eq.${a.id}`, { notes: `Filing warnings: ${warnings.join(' | ')}` });
    } catch { /* ignore */ }
  }

  const attachments = pdfBase64
    ? [{ filename: `${a.agreement_number}.pdf`, content: pdfBase64, contentType: 'application/pdf' }]
    : undefined;
  try {
    await sendEmail({
      from: NDA_FROM,
      to: f.signer_email,
      subject: `Your signed NDA — ${a.agreement_number}`,
      html: executedEmailRecipient({ a }),
      attachments,
    });
  } catch (e) { warnings.push('recipient email: ' + e.message); }
  try {
    await sendEmail({
      from: NDA_FROM,
      to: ALERT_TO,
      subject: `NDA signed — ${a.recipient_legal_name || a.recipient_company} (${a.agreement_number})`,
      html: executedEmailStaff({ a }),
      attachments,
    });
  } catch (e) { warnings.push('staff email: ' + e.message); }

  const log = await loadLog(a.id).catch(() => []);
  return json(200, {
    ok: true,
    ...publicView(a, renderNdaHtml(a, { log })),
    pdf_base64: pdfBase64,
    file_name: `${a.agreement_number}.pdf`,
    // Surfaced so the page can say "we could not email your copy, download it
    // now" rather than implying everything went perfectly.
    warnings,
  });
};

export const config = { path: '/api/nda-sign' };
