// /api/vendor-onboard — the public vendor-onboarding intake (Vendor Portal
// Phase 2). The page at /vendor-onboarding calls this with the one-time token
// from the emailed link; every action re-validates it (visitor-kiosk posture:
// deliberately unauthenticated, service-role writes, the TOKEN is the gate —
// nothing here is readable or writable without one).
//
// POST { action: 'info', token }
//   → vendor prefill + what's still needed (never more than the vendor's own
//     name/contact — no other vendor's data is reachable from a token).
// POST { action: 'upload', token, kind: 'w9'|'coi', file_name, media_type, file_base64 }
//   → files the document: bucket compliance-docs (vendors/<party>/…), OCR
//     (ACORD-25 / W-9 schemas), ops.compliance_documents row, vendor fields
//     (w9_status, ein_last4, legal_name). COI shortfalls vs the vendor's
//     requirements come back as flags — SOFT gate: a short certificate still
//     files, staff argue about it later.
// POST { action: 'complete', token, contact_*, payment_method_pref, payment_handle }
//   → saves contact + payment preference (handle ONLY — never bank details;
//     ACH setup happens with the payment provider), stamps the token used,
//     flips onboard_status, emails staff a summary.
//
// Env: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (OCR),
//      RESEND_API_KEY/SENDGRID_API_KEY, COMPLIANCE_ALERT_TO (optional).

import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail, SITE_URL } from './email-helpers.mjs';
import { ops, validateToken, ensureParty, hashToken } from './lib/vendor-onboard-lib.mjs';
import { runCoiOcr, runW9Ocr, coiShortfalls } from './lib/vendor-doc-ocr.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ALERT_TO = process.env.COMPLIANCE_ALERT_TO || 'service@brixbev.com';
const BUCKET = 'compliance-docs';
const MAX_FILE_BYTES = 4 * 1024 * 1024; // platform body cap is ~6MB; base64 adds ~33%
const MEDIA_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const PAY_PREFS = new Set(['ach', 'paypal', 'venmo', 'zelle_manual', 'check_manual']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});
const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function uploadToBucket(path, bytes, mediaType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': mediaType,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`file upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return path;
}

async function docsStatus(partyId) {
  if (!partyId) return { has_w9: false, coi_expiration: null };
  const docs = await ops('GET',
    `compliance_documents?select=category,doc_type,expiration_date&party_id=eq.${partyId}&archived_at=is.null`);
  const hasW9 = (docs || []).some((d) => /w[\s-]?9/i.test(d.doc_type));
  const coi = (docs || []).filter((d) => d.category === 'insurance');
  const coiExp = coi.reduce((best, d) => {
    if (!d.expiration_date) return best;
    return !best || d.expiration_date > best ? d.expiration_date : best;
  }, null);
  return { has_w9: hasW9, coi_expiration: coiExp, has_coi: coi.length > 0 };
}

function requirementsSummary(req) {
  const r = req || {};
  const out = [];
  if (r.gl_each_occurrence) out.push(`General liability with at least $${Number(r.gl_each_occurrence).toLocaleString()} each occurrence`);
  if (r.wc_required) out.push("Workers' compensation");
  if (r.auto_required) out.push('Auto liability');
  if (r.additional_insured_required) out.push('Brix Beverage named as additional insured');
  return out;
}

async function handleInfo(vendor, token) {
  const status = await docsStatus(vendor.insured_party_id);
  return json(200, {
    ok: true,
    purpose: token.purpose,
    vendor: {
      display_name: vendor.display_name,
      legal_name: vendor.legal_name,
      contact_name: vendor.contact_name,
      contact_email: vendor.contact_email,
      contact_phone: vendor.contact_phone,
      payment_method_pref: vendor.payment_method_pref,
      payment_handle: vendor.payment_handle,
      w9_status: vendor.w9_status,
    },
    requirements: requirementsSummary(vendor.requirements),
    docs: status,
    expires_at: token.expires_at,
  });
}

async function handleUpload(vendor, body) {
  const kind = body.kind === 'w9' ? 'w9' : body.kind === 'coi' ? 'coi' : null;
  if (!kind) return json(400, { error: "kind must be 'w9' or 'coi'" });
  const mediaType = MEDIA_TYPES.has(body.media_type) ? body.media_type : null;
  if (!mediaType) return json(400, { error: 'Please upload a PDF or a photo (JPEG/PNG/WebP).' });

  let bytes;
  try {
    bytes = Buffer.from(String(body.file_base64 || ''), 'base64');
  } catch {
    return json(400, { error: 'The file did not upload correctly — please try again.' });
  }
  if (!bytes.length) return json(400, { error: 'The file is empty — please try again.' });
  if (bytes.length > MAX_FILE_BYTES) return json(400, { error: 'That file is over 4 MB. A phone photo or a smaller PDF works best.' });

  const partyId = await ensureParty(vendor);

  const safeName = clean(body.file_name, 100).replace(/[^\w.\- ]+/g, '_') || (kind + (mediaType === 'application/pdf' ? '.pdf' : '.jpg'));
  const path = `vendors/${partyId}/${Date.now()}-${kind}-${safeName}`;
  await uploadToBucket(path, bytes, mediaType);

  const base64 = bytes.toString('base64');

  if (kind === 'w9') {
    let extracted = null, ocrError = null;
    try {
      extracted = await runW9Ocr({ base64, mediaType });
    } catch (e) {
      ocrError = e.message?.slice(0, 200) || 'OCR failed';
    }
    await ops('POST', 'compliance_documents', {
      category: 'tax',
      doc_type: 'W-9',
      party_id: partyId,
      issuer: null,
      reference_number: extracted?.tin_last4 ? `TIN •••${extracted.tin_last4}` : null,
      issue_date: extracted?.signature_date || null,
      expiration_date: null,
      storage_path: path,
      file_name: safeName,
      notes: [
        'Uploaded by the vendor via the onboarding link.',
        extracted?.entity_type ? `Entity type: ${extracted.entity_type}.` : null,
        extracted && !extracted.signed ? '⚠ OCR did not find a signature — verify.' : null,
        ocrError ? `⚠ OCR failed (${ocrError}) — review the file by hand.` : null,
      ].filter(Boolean).join(' '),
    });
    const patch = { w9_status: 'on_file' };
    if (extracted?.tin_last4) patch.ein_last4 = extracted.tin_last4;
    if (extracted?.legal_name && !vendor.legal_name) patch.legal_name = extracted.legal_name;
    await ops('PATCH', `vendors?id=eq.${vendor.id}`, patch);
    return json(200, {
      ok: true,
      kind: 'w9',
      summary: extracted ? {
        legal_name: extracted.legal_name,
        entity_type: extracted.entity_type,
        tin_last4: extracted.tin_last4,
        signed: extracted.signed,
      } : null,
      ocr_error: ocrError,
    });
  }

  // COI
  let coi = null, ocrError = null, shortfalls = [];
  try {
    coi = await runCoiOcr({ base64, mediaType });
    shortfalls = coiShortfalls(coi, vendor.requirements);
  } catch (e) {
    ocrError = e.message?.slice(0, 200) || 'OCR failed';
  }
  await ops('POST', 'compliance_documents', {
    category: 'insurance',
    doc_type: 'Certificate of Insurance (ACORD 25)',
    party_id: partyId,
    issuer: coi?.carriers?.[0] || coi?.producer || null,
    reference_number: coi?.gl_policy_number || null,
    issue_date: coi?.certificate_date || coi?.gl_effective || null,
    expiration_date: coi?.gl_expiration || coi?.auto_expiration || coi?.wc_expiration || null,
    storage_path: path,
    file_name: safeName,
    notes: [
      'Uploaded by the vendor via the onboarding link.',
      coi?.gl_each_occurrence ? `GL each occurrence $${coi.gl_each_occurrence.toLocaleString()}.` : null,
      coi?.additional_insured ? 'Additional insured shown.' : null,
      shortfalls.length ? `⚠ SHORTFALLS: ${shortfalls.join(' · ')}` : null,
      ocrError ? `⚠ OCR failed (${ocrError}) — review the file by hand.` : null,
    ].filter(Boolean).join(' '),
  });
  return json(200, {
    ok: true,
    kind: 'coi',
    summary: coi ? {
      carriers: coi.carriers,
      gl_each_occurrence: coi.gl_each_occurrence,
      gl_expiration: coi.gl_expiration,
      wc: Boolean(coi.wc_policy_number || coi.wc_each_accident),
      auto: Boolean(coi.auto_policy_number || coi.auto_csl),
      additional_insured: coi.additional_insured,
    } : null,
    shortfalls,
    ocr_error: ocrError,
  });
}

async function handleComplete(vendor, token, body) {
  const patch = {};
  const contactName = clean(body.contact_name, 120);
  const contactEmail = clean(body.contact_email, 160);
  const contactPhone = clean(body.contact_phone, 40);
  if (contactName) patch.contact_name = contactName;
  if (contactEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) patch.contact_email = contactEmail;
  if (contactPhone) patch.contact_phone = contactPhone;

  const pref = clean(body.payment_method_pref, 20);
  if (pref) {
    if (!PAY_PREFS.has(pref)) return json(400, { error: 'Unknown payment preference.' });
    patch.payment_method_pref = pref;
    const handle = clean(body.payment_handle, 160);
    if (pref === 'venmo' || pref === 'paypal') {
      if (!handle) return json(400, { error: pref === 'venmo' ? 'Please enter your Venmo @handle.' : 'Please enter your PayPal email.' });
      patch.payment_handle = handle;
    } else {
      patch.payment_handle = null; // never store anything payment-shaped for bank/check rails
    }
  }

  const status = await docsStatus(vendor.insured_party_id);
  patch.onboard_status = status.has_w9 && status.has_coi ? 'complete' : 'docs_pending';
  await ops('PATCH', `vendors?id=eq.${vendor.id}`, patch);
  await ops('PATCH', `vendor_onboard_tokens?token_hash=eq.${hashToken(body.token)}`, { used_at: new Date().toISOString() });

  // Staff summary — best effort, the vendor's submission is already filed.
  try {
    const row = (k, v) => `<tr><td style="padding:4px 14px 4px 0;color:#64748B;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;color:#0F172A;font-weight:600">${esc(v || '—')}</td></tr>`;
    await sendEmail({
      to: ALERT_TO,
      subject: `Vendor documents received — ${vendor.display_name}`,
      html: `<div style="font-family:'DM Sans',-apple-system,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1F4E79;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:700">
          📥 ${esc(vendor.display_name)} finished the onboarding link
        </div>
        <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:16px 20px;font-size:14px">
          <table style="border-collapse:collapse;font-size:13px">
            ${row('W-9', status.has_w9 ? 'On file' : 'STILL MISSING')}
            ${row('COI', status.has_coi ? `On file${status.coi_expiration ? ' → expires ' + status.coi_expiration : ''}` : 'STILL MISSING')}
            ${row('Pays via', patch.payment_method_pref || vendor.payment_method_pref)}
            ${row('Status', patch.onboard_status)}
          </table>
          <p style="margin:14px 0 0">
            <a href="${SITE_URL}/expense/vendors" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px">Open Brixpense → Vendors →</a>
          </p>
          <p style="margin:12px 0 0;color:#64748B;font-size:12px">Any COI shortfalls are flagged in the document notes — soft gate, nothing was bounced.</p>
        </div></div>`,
      text: `${vendor.display_name} finished the vendor onboarding link. W-9: ${status.has_w9 ? 'on file' : 'MISSING'} · COI: ${status.has_coi ? 'on file' : 'MISSING'} · status ${patch.onboard_status}.`,
    });
  } catch (e) {
    console.error('[vendor-onboard] staff summary email failed:', e.message);
  }

  return json(200, { ok: true, onboard_status: patch.onboard_status });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!SERVICE_KEY) return json(500, { error: 'Onboarding is not configured — SUPABASE_SERVICE_ROLE_KEY is missing on this site.' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Expected JSON.' }); }

  let validated;
  try {
    validated = await validateToken(body.token);
  } catch (e) {
    return json(502, { error: `Could not check the link: ${e.message?.slice(0, 200)}` });
  }
  if (validated.error) return json(validated.status, { error: validated.error });
  const { vendor, token } = validated;

  try {
    if (body.action === 'info') return await handleInfo(vendor, token);
    if (body.action === 'upload') return await handleUpload(vendor, body);
    if (body.action === 'complete') return await handleComplete(vendor, token, body);
  } catch (e) {
    console.error('[vendor-onboard] action failed:', body.action, e.message);
    return json(502, { error: `Something went wrong on our side — please try again. (${e.message?.slice(0, 160)})` });
  }
  return json(400, { error: 'Unknown action — expected info, upload, or complete' });
}

export const config = { path: '/api/vendor-onboard' };
