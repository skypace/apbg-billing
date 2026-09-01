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
// A W-9 with NO vendor_id CREATES the vendor. That is the case that actually
// happens: somebody sends you a W-9 for a firm you have never paid, and the
// form itself carries everything the record needs — legal name, business name,
// entity type, TIN, address. Making you key that in by hand first and then
// upload the document is busywork the document can do.
//
// POST { vendor_id?, file_name, media_type, file_base64, kind? }
//   vendor_id — omit ONLY with a W-9, to create the vendor from the form.
//   kind      — 'w9' | 'coi' | 'bill'; omit to auto-detect.
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
const KIND_LABEL = { w9: 'W-9', coi: 'certificate of insurance', bill: 'bill' };

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

// Does this W-9 belong to a vendor we already have? Checked before creating
// anything, because the failure mode is a second ARTURO SANTIAGO sitting beside
// the first with half the history each — and ops.vendors has a unique index on
// display_name, so the naive insert would just error out anyway.
//
// Matched on the normalised name (the same comparison the duplicate-bill guard
// uses, so "Parts Town, LLC" and "PARTS TOWN LLC" are one vendor) or on a TIN
// last-4 we already hold. A TIN match is the stronger of the two: names get
// typed differently, tax numbers do not.
async function findExistingVendor(extracted) {
  const names = [extracted?.business_name, extracted?.legal_name].filter(Boolean);
  const rows = await ops('GET', 'vendors?archived_at=is.null&select=id,display_name,legal_name,ein_last4&limit=1000');
  const all = rows || [];

  if (extracted?.tin_last4) {
    const byTin = all.find((v) => v.ein_last4 && v.ein_last4 === extracted.tin_last4);
    if (byTin) return { vendor: byTin, why: `their TIN ends ${extracted.tin_last4}` };
  }
  for (const n of names) {
    const key = normName(n);
    if (!key) continue;
    const hit = all.find((v) => normName(v.display_name) === key || normName(v.legal_name) === key);
    if (hit) return { vendor: hit, why: `the name matches "${hit.display_name}"` };
  }
  return null;
}

// Mirrors ops.fn_norm_vendor so the client and the database agree on what
// counts as the same vendor.
function normName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c|ltd|co|corp|corporation|company|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || null;
}

async function ensureParty(vendor) {
  if (vendor.insured_party_id) return vendor.insured_party_id;
  // return=representation for the same reason as the vendor insert below: a
  // bare POST comes back with no body, so partyId would always be undefined
  // and this would throw on every vendor that has no party yet.
  const rows = await ops('POST', 'insured_parties', {
    name: vendor.display_name,
    party_type: vendor.vendor_type === 'contractor' ? 'contractor' : 'vendor',
    contact_name: vendor.contact_name,
    contact_email: vendor.contact_email,
    contact_phone: vendor.contact_phone,
    notes: 'Created when a document was filed on the vendor record.',
  }, { Prefer: 'return=representation' });
  const partyId = rows?.[0]?.id;
  if (!partyId) throw new Error('could not create the compliance-vault party for this vendor');
  await ops('PATCH', `vendors?id=eq.${vendor.id}`, { insured_party_id: partyId });
  return partyId;
}

// Everything below runs behind handle(); the export wraps it so a throw comes
// back as a readable message instead of a bare 500. That distinction is not
// cosmetic — a vendors_vendor_type_check violation surfaced as an unexplained
// failure, which is a much harder thing to report than "the database refused
// this value".
async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const givenVendorId = String(body.vendor_id || '');
  if (givenVendorId && !/^[0-9a-f-]{36}$/i.test(givenVendorId)) {
    return json({ error: 'vendor_id must be a uuid' }, 400);
  }

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

  let vendor = null;
  if (givenVendorId) {
    const rows = await ops('GET', `vendors?id=eq.${givenVendorId}&select=*&limit=1`);
    vendor = rows?.[0] || null;
    if (!vendor) return json({ error: 'Vendor not found' }, 404);
  }

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
    if (!vendor) {
      return json({
        error: 'vendor_required',
        message: 'Pick a vendor first — a bill tells us plenty about a vendor we already have, but not enough to create one from scratch.',
      }, 400);
    }
    const vendorId = vendor.id;
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

  // ── A W-9 with no vendor: the form is the vendor record. ──
  let createdVendor = false;
  let matchedExisting = null;
  if (!vendor) {
    if (kind !== 'w9') {
      return json({
        error: 'vendor_required',
        message: `Pick a vendor first — only a W-9 carries enough to create one, and this is a ${KIND_LABEL[kind]}.`,
      }, 400);
    }
    let extracted = null, ocrError = null;
    try {
      extracted = await runW9Ocr({ base64, mediaType });
    } catch (e) {
      ocrError = String(e?.message || e).slice(0, 200);
    }
    const name = (extracted?.business_name || extracted?.legal_name || '').trim();
    if (!name) {
      // Without a name there is nothing to file under, and inventing a
      // placeholder vendor is worse than saying so.
      return json({
        error: 'no_name',
        message: ocrError
          ? `Couldn't read that W-9 (${ocrError}), so there's no name to create a vendor from. Create the vendor and drop it on their record instead.`
          : "Couldn't find a name on that W-9. Create the vendor first and drop this on their record.",
      }, 422);
    }

    matchedExisting = await findExistingVendor(extracted);
    if (matchedExisting) {
      // File it against the vendor we already have rather than creating a
      // second one. Reported, so the person who dropped it knows where it went.
      const rows = await ops('GET', `vendors?id=eq.${matchedExisting.vendor.id}&select=*&limit=1`);
      vendor = rows?.[0];
    } else {
      // vendor_type MUST be one of ops.vendors_vendor_type_check:
      // contractor | supplier | service | other. 'vendor' is not on that list
      // (it was the first shape of this code and every create died on the
      // constraint), and 'supplier' is both the column default and what the
      // Vendors page itself offers. Prefer: return=representation is required
      // — without it PostgREST answers 201 with an EMPTY body, so `created[0]`
      // is undefined and this reads as a failure while the row lands anyway.
      const created = await ops('POST', 'vendors', {
        display_name: name,
        legal_name: extracted?.legal_name || null,
        vendor_type: 'supplier',
        created_by: auth.user?.id || null,
        notes: 'Created from a W-9 filed on the Vendors page.',
      }, { Prefer: 'return=representation' });
      vendor = created?.[0];
      if (!vendor) return json({ error: 'Could not create the vendor.' }, 500);
      createdVendor = true;
    }

    // The document is in hand and already read — file it without a second OCR pass.
    const partyIdNew = await ensureParty(vendor);
    const stampNew = new Date().toISOString().replace(/[:.]/g, '-');
    const pathNew = `vendors/${vendor.id}/w9-${stampNew}-${safeName}`;
    await uploadToBucket(pathNew, bytes, mediaType);
    const appliedNew = applyW9({
      vendor, extracted, storagePath: pathNew, fileName: safeName,
      partyId: partyIdNew, source: 'staff', ocrError,
    });
    await ops('POST', 'compliance_documents', appliedNew.doc);
    await ops('PATCH', `vendors?id=eq.${vendor.id}`, appliedNew.vendorPatch);
    return json({
      ok: true, kind: 'w9', detected, filed: true,
      created_vendor: createdVendor,
      vendor: { id: vendor.id, display_name: vendor.display_name },
      matched_existing: matchedExisting ? matchedExisting.why : null,
      summary: appliedNew.summary,
      vendor_patch: appliedNew.vendorPatch,
      warnings: appliedNew.warnings,
      ocr_error: ocrError,
      message: createdVendor
        ? `Created ${vendor.display_name} from the W-9 and filed it. Their tax identity is on the record, so they never show up on the 1099 chase list.`
        : `${vendor.display_name} already existed (${matchedExisting.why}) — filed the W-9 against them rather than creating a second record.`,
    });
  }

  // ── A W-9 or a COI on a vendor we already have. ──
  const vendorId = vendor.id;
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

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    const detail = String(e?.message || e).slice(0, 300);
    console.error('[vendor-doc-upload]', detail);
    return json({ error: 'upload_failed', message: `That didn't file: ${detail}` }, 500);
  }
};

export const config = { path: '/api/vendor-doc-upload' };
