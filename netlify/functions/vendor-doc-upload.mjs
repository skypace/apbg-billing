// vendor-doc-upload — drop a document on a vendor and have it filed.
//
// The counterpart to the vendor's own onboarding link. Everything the vendor
// could upload through that link, staff can now file directly: a W-9 that was
// emailed to you, a certificate of insurance the broker sent, a bill that tells
// you who the vendor actually is.
//
// It works out WHICH document you dropped rather than making you say. You are
// looking at a PDF, you know what it is; being made to pick from a dropdown
// first is the kind of friction that means the document never gets filed.
// Detection is a cheap Claude pass over the first page, and it always reports
// what it decided so a wrong guess is visible and correctable — never silent.
//
// ⚠ A BILL DOES NOT BECOME A BILL HERE. Dropping an invoice on a vendor record
// harvests what it says about the VENDOR (remit-to address, terms, contact) and
// hands back the read for you to file as an expense with one more click. Money
// rows are not a side effect of a drag gesture — same rule as the 2026-08-14
// QuickBooks gate, one level earlier.
//
// POST { vendor_id, file_name, media_type, file_base64, kind? }
//   kind: 'w9' | 'coi' | 'bill' — omit to auto-detect.
// Gate: staff (superadmin | admin), matching ops.vendors RLS.

import { requireAuth } from './lib/auth.mjs';
import { runCoiOcr, runW9Ocr, coiShortfalls } from './lib/vendor-doc-ocr.mjs';
import { applyW9, applyCoi } from './lib/vendor-doc-apply.mjs';
import { runExpenseOcr } from './lib/expense-ocr-core.mjs';
import { resolveDueDate } from './lib/due-date.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLASSIFY_MODEL = process.env.VENDOR_DOC_CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';
const BUCKET = 'compliance-docs';
const MAX_FILE_BYTES = 4 * 1024 * 1024;   // the platform body cap is ~6MB; base64 adds ~33%
const MEDIA_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

function srHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    ...extra,
  };
}

async function ops(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: srHeaders(method === 'GET' ? {} : { Prefer: 'return=representation' }),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`ops ${path}: ${res.status} ${(await res.text()).slice(0, 240)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

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
}

const safeFilename = (n) =>
  String(n || 'document').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'document';

function contentBlockFor(base64, mediaType) {
  return mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

// What is this? One cheap question, asked of the cheapest model, because the
// three real extractors that follow are the expensive part and running the
// wrong one produces confident nonsense.
async function classify(base64, mediaType) {
  if (!ANTHROPIC_API_KEY) return { kind: null, reason: 'no ANTHROPIC_API_KEY configured' };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      max_tokens: 200,
      system: `Identify a business document. Reply with ONLY JSON, no markdown:
{"kind":"w9"|"coi"|"bill"|"other","confidence":0..1,"why":"a few words"}

- w9   — IRS Form W-9 "Request for Taxpayer Identification Number and Certification".
- coi  — a certificate of liability insurance (ACORD 25 or similar): insurers, policy numbers, limits, a certificate holder box.
- bill — an invoice, bill or receipt asking us to pay: line items and an amount due.
- other — anything else (a W-2, a 1099 we were sent, a contract, a letter, a spec sheet).

A form 1099 is NOT a w9 — it is "other". Say so rather than guessing, because
running the wrong extractor on it produces confident nonsense.`,
      messages: [{
        role: 'user',
        content: [contentBlockFor(base64, mediaType), { type: 'text', text: 'What is this document? JSON only.' }],
      }],
    }),
  });
  if (!res.ok) return { kind: null, reason: `classifier ${res.status}` };
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const parsed = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    return { kind: ['w9', 'coi', 'bill', 'other'].includes(parsed.kind) ? parsed.kind : null,
             confidence: parsed.confidence ?? null, reason: parsed.why || null };
  } catch {
    return { kind: null, reason: 'classifier returned something unparseable' };
  }
}

async function ensureParty(vendor) {
  if (vendor.insured_party_id) return vendor.insured_party_id;
  const rows = await ops('POST', 'insured_parties', {
    name: vendor.display_name,
    party_type: vendor.vendor_type === 'contractor' ? 'contractor' : 'vendor',
    contact_name: vendor.contact_name,
    contact_email: vendor.contact_email,
    contact_phone: vendor.contact_phone,
    notes: 'Created when a document was filed on the vendor record.',
  });
  const partyId = rows?.[0]?.id;
  if (!partyId) throw new Error('could not create the compliance-vault party for this vendor');
  await ops('PATCH', `vendors?id=eq.${vendor.id}`, { insured_party_id: partyId });
  return partyId;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const vendorId = String(body.vendor_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(vendorId)) return json({ error: 'vendor_id must be a uuid' }, 400);

  const mediaType = String(body.media_type || '').toLowerCase();
  if (!MEDIA_TYPES.has(mediaType)) {
    return json({ error: 'Drop a PDF or a photo (JPEG, PNG or WebP).' }, 415);
  }

  let bytes;
  try { bytes = Buffer.from(String(body.file_base64 || ''), 'base64'); } catch { bytes = null; }
  if (!bytes?.length) return json({ error: "That file didn't come through — try again." }, 400);
  if (bytes.length > MAX_FILE_BYTES) {
    return json({ error: 'That file is too large — 4 MB is the limit for a document upload.' }, 413);
  }

  const vendors = await ops('GET', `vendors?id=eq.${vendorId}&select=*&limit=1`);
  const vendor = vendors?.[0];
  if (!vendor) return json({ error: 'Vendor not found' }, 404);

  const base64 = bytes.toString('base64');
  const safeName = safeFilename(body.file_name);

  // Told, or worked out.
  let kind = ['w9', 'coi', 'bill'].includes(body.kind) ? body.kind : null;
  let detected = null;
  if (!kind) {
    detected = await classify(base64, mediaType);
    kind = detected.kind === 'other' ? null : detected.kind;
    if (!kind) {
      return json({
        error: 'not_recognised',
        message: detected.kind === 'other'
          ? `That doesn't look like a W-9, a certificate of insurance or a bill${detected.reason ? ` — it reads as ${detected.reason}` : ''}. Pick what it is and I'll file it.`
          : `Couldn't tell what that document is${detected.reason ? ` (${detected.reason})` : ''}. Pick what it is and I'll file it.`,
        detected,
        can_choose: ['w9', 'coi', 'bill'],
      }, 422);
    }
  }

  // ── A bill: read it for what it says about the VENDOR. No money row. ──
  if (kind === 'bill') {
    let ocr = null, ocrError = null;
    try {
      ocr = await runExpenseOcr({ base64, mediaType, accountLabels: [] });
    } catch (e) {
      ocrError = String(e?.message || e).slice(0, 200);
    }
    if (!ocr) return json({ error: `Couldn't read that bill (${ocrError}).` }, 422);

    // Fill BLANKS on the vendor only. A bill is evidence, not authority: it
    // must never overwrite a term or a name somebody curated by hand.
    const patch = {};
    if (ocr.payment_terms && !vendor.default_terms) patch.default_terms = ocr.payment_terms;
    if (ocr.vendor && !vendor.legal_name && ocr.vendor !== vendor.display_name) patch.legal_name = ocr.vendor;
    if (Object.keys(patch).length) await ops('PATCH', `vendors?id=eq.${vendorId}`, patch);

    const due = resolveDueDate({ printed: ocr.due_date, invoiceDate: ocr.date, terms: ocr.payment_terms });

    return json({
      ok: true,
      kind: 'bill',
      detected,
      filed: false,
      vendor_patch: patch,
      // Everything the expense form needs, so "file this as a bill" is one
      // click and lands on a form already filled in — rather than this
      // endpoint quietly creating a payable nobody asked for.
      bill_draft: {
        vendor_name: ocr.vendor || vendor.display_name,
        bill_number: ocr.bill_number || null,
        total_amount: ocr.total ?? null,
        receipt_date: ocr.date || null,
        payment_terms: ocr.payment_terms || null,
        due_date: due.due_date,
        due_date_source: due.due_date_source,
        line_items: ocr.line_items || [],
        memo: ocr.memo || null,
        job_number: ocr.job_number || null,
        cogs_account_label: ocr.account_guess || null,
      },
      message: Object.keys(patch).length
        ? `Read the bill and filled in ${Object.keys(patch).join(' and ')} on the vendor. Nothing was posted — file it as a bill if you want the payable.`
        : 'Read the bill. The vendor record already had everything it tells us. Nothing was posted.',
    });
  }

  // ── A W-9 or a COI: file it in the vault and populate the record. ──
  const partyId = await ensureParty(vendor);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `vendors/${vendorId}/${kind}-${stamp}-${safeName}`;
  await uploadToBucket(path, bytes, mediaType);

  if (kind === 'w9') {
    let extracted = null, ocrError = null;
    try {
      extracted = await runW9Ocr({ base64, mediaType });
    } catch (e) {
      ocrError = String(e?.message || e).slice(0, 200);
    }
    const applied = applyW9({
      vendor, extracted, storagePath: path, fileName: safeName,
      partyId, source: 'staff', ocrError,
    });
    await ops('POST', 'compliance_documents', applied.doc);
    await ops('PATCH', `vendors?id=eq.${vendorId}`, applied.vendorPatch);
    return json({
      ok: true, kind: 'w9', detected, filed: true,
      summary: applied.summary,
      vendor_patch: applied.vendorPatch,
      warnings: applied.warnings,
      ocr_error: ocrError,
      message: 'W-9 filed. The vendor record now carries their tax identity, so they drop off the 1099 chase list.',
    });
  }

  // COI
  let coi = null, ocrError = null, shortfalls = [];
  try {
    coi = await runCoiOcr({ base64, mediaType });
    shortfalls = coiShortfalls(coi, vendor.requirements);
  } catch (e) {
    ocrError = String(e?.message || e).slice(0, 200);
  }
  const applied = applyCoi({
    extracted: coi, storagePath: path, fileName: safeName,
    partyId, source: 'staff', ocrError, shortfalls,
  });
  await ops('POST', 'compliance_documents', applied.doc);
  return json({
    ok: true, kind: 'coi', detected, filed: true,
    summary: applied.summary,
    shortfalls,
    warnings: applied.warnings,
    ocr_error: ocrError,
    message: applied.expiration
      ? `Certificate filed — it lapses ${applied.expiration}, and the compliance digest will chase it.`
      : 'Certificate filed. No expiry could be read, so it will not be chased automatically — set one by hand.',
  });
};

export const config = { path: '/api/vendor-doc-upload' };
