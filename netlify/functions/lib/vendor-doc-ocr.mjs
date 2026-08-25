// vendor-doc-ocr.mjs — Claude extraction for vendor onboarding documents
// (Vendor Portal Phase 2): ACORD 25 certificates of insurance and IRS W-9s.
//
// Built on the expense-ocr-core recipe (same Claude client + primary/fallback
// ladder, reuses its contentBlockFor). Two schemas, one module — the intake
// page and any future staff re-run must never drift on what "gl_each_occurrence"
// means.
//
// Privacy rule enforced HERE, not left to callers: the W-9 extraction returns
// ein_last4 ONLY. The model is instructed to output the last four digits and
// the normalizer re-truncates whatever comes back, so a full EIN/SSN can never
// ride the pipeline into a column. The full number stays inside the PDF in the
// private compliance-docs bucket.

import { contentBlockFor } from './expense-ocr-core.mjs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_OCR_MODEL || 'claude-sonnet-4-5-20250929';
const CLAUDE_FALLBACK = 'claude-haiku-4-5-20251001';

const COI_PROMPT = `You extract structured data from ACORD 25 Certificates of Liability Insurance (or equivalent COI documents) for a vendor-compliance system.
Return ONLY valid JSON — no markdown, no backticks, no preamble. Schema:

{
  "insured_name": "string or null (the named insured — the vendor)",
  "producer": "string or null (the broker/agency issuing the certificate)",
  "carriers": ["string" (insurer names from the INSURER A/B/C... block)],
  "gl_policy_number": "string or null",
  "gl_each_occurrence": number or null (USD, the GL EACH OCCURRENCE limit),
  "gl_aggregate": number or null (the GENERAL AGGREGATE limit),
  "gl_effective": "YYYY-MM-DD or null",
  "gl_expiration": "YYYY-MM-DD or null",
  "auto_policy_number": "string or null",
  "auto_csl": number or null (automobile COMBINED SINGLE LIMIT),
  "auto_expiration": "YYYY-MM-DD or null",
  "wc_policy_number": "string or null (workers' compensation)",
  "wc_each_accident": number or null (E.L. EACH ACCIDENT limit),
  "wc_expiration": "YYYY-MM-DD or null",
  "umbrella_each_occurrence": number or null,
  "additional_insured": boolean (true ONLY if the certificate marks the certificate holder as additional insured — the ADDL INSD column checked for GL, or wording in the description box),
  "certificate_holder": "string or null (the name in the CERTIFICATE HOLDER box)",
  "description_of_operations": "string or null (verbatim-ish summary of the description box, max ~300 chars)",
  "certificate_date": "YYYY-MM-DD or null (the DATE at the top right)"
}

Rules:
- Limits are plain numbers: "$1,000,000" → 1000000. Never strings.
- The EXPIRATION that matters most is GL — read the policy rows carefully; effective and expiration are two separate columns (POLICY EFF / POLICY EXP).
- additional_insured must be evidence-based: a checked ADDL INSD box or explicit wording. When unclear, false.
- If a coverage line is blank/absent on the certificate, use null for its fields.
- Return ONLY the JSON object, nothing else.`;

const W9_PROMPT = `You extract structured data from IRS Form W-9 (Request for Taxpayer Identification Number) for a vendor-compliance system.
Return ONLY valid JSON — no markdown, no backticks, no preamble. Schema:

{
  "legal_name": "string or null (line 1 — name as shown on the tax return)",
  "business_name": "string or null (line 2 — business/disregarded-entity name, if different)",
  "entity_type": "string or null (the checked federal tax classification: individual/sole proprietor, C corporation, S corporation, partnership, trust/estate, LLC-C, LLC-S, LLC-P, other)",
  "tin_type": "ssn" | "ein" | null (which TIN box is filled),
  "tin_last4": "string or null (ONLY the LAST FOUR digits of the SSN or EIN — never output more)",
  "address": "string or null (street, city, state, zip as one line)",
  "signed": boolean (a signature is present in Part II),
  "signature_date": "YYYY-MM-DD or null",
  "exempt_payee_code": "string or null"
}

Rules:
- PRIVACY: tin_last4 must contain AT MOST four digits — the last four of whichever TIN is written. NEVER output the full SSN or EIN anywhere in the JSON, including free-text fields.
- entity_type: report the checked box; if an LLC, include the tax-classification letter when written.
- signed is true only when an actual signature (not just a printed name) appears.
- Return ONLY the JSON object, nothing else.`;

async function callClaude(model, contentBlock, systemPrompt, instruction) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [contentBlock, { type: 'text', text: instruction }],
      }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude ${model} ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

async function runWithFallback(contentBlock, systemPrompt, instruction) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured on Netlify');
  let extracted, modelUsed = CLAUDE_MODEL, primaryError = null;
  try {
    extracted = await callClaude(CLAUDE_MODEL, contentBlock, systemPrompt, instruction);
  } catch (e) {
    primaryError = e?.message || 'Primary model failed';
    extracted = await callClaude(CLAUDE_FALLBACK, contentBlock, systemPrompt, instruction);
    modelUsed = CLAUDE_FALLBACK;
  }
  return { extracted, modelUsed, primaryError };
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? v : null);
const str = (v, max = 300) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/** Extract an ACORD 25 / COI. Returns normalized limits + dates. */
export async function runCoiOcr({ base64, mediaType }) {
  const contentBlock = contentBlockFor(base64, mediaType);
  const { extracted, modelUsed, primaryError } = await runWithFallback(
    contentBlock, COI_PROMPT, 'Extract the certificate of insurance. Return only JSON matching the schema. No prose.',
  );
  return {
    ok: true,
    model: modelUsed,
    primary_error: primaryError,
    insured_name: str(extracted.insured_name, 160),
    producer: str(extracted.producer, 160),
    carriers: Array.isArray(extracted.carriers) ? extracted.carriers.map((c) => str(c, 120)).filter(Boolean).slice(0, 8) : [],
    gl_policy_number: str(extracted.gl_policy_number, 60),
    gl_each_occurrence: num(extracted.gl_each_occurrence),
    gl_aggregate: num(extracted.gl_aggregate),
    gl_effective: dateOrNull(extracted.gl_effective),
    gl_expiration: dateOrNull(extracted.gl_expiration),
    auto_policy_number: str(extracted.auto_policy_number, 60),
    auto_csl: num(extracted.auto_csl),
    auto_expiration: dateOrNull(extracted.auto_expiration),
    wc_policy_number: str(extracted.wc_policy_number, 60),
    wc_each_accident: num(extracted.wc_each_accident),
    wc_expiration: dateOrNull(extracted.wc_expiration),
    umbrella_each_occurrence: num(extracted.umbrella_each_occurrence),
    additional_insured: extracted.additional_insured === true,
    certificate_holder: str(extracted.certificate_holder, 200),
    description_of_operations: str(extracted.description_of_operations, 300),
    certificate_date: dateOrNull(extracted.certificate_date),
    raw: extracted,
  };
}

/** Extract a W-9. tin_last4 is hard-truncated to 4 digits here — belt AND
 *  suspenders on top of the prompt rule. */
export async function runW9Ocr({ base64, mediaType }) {
  const contentBlock = contentBlockFor(base64, mediaType);
  const { extracted, modelUsed, primaryError } = await runWithFallback(
    contentBlock, W9_PROMPT, 'Extract the W-9. Return only JSON matching the schema. Last four TIN digits ONLY. No prose.',
  );
  const digits = String(extracted.tin_last4 ?? '').replace(/\D/g, '');
  return {
    ok: true,
    model: modelUsed,
    primary_error: primaryError,
    legal_name: str(extracted.legal_name, 160),
    business_name: str(extracted.business_name, 160),
    entity_type: str(extracted.entity_type, 60),
    tin_type: extracted.tin_type === 'ssn' || extracted.tin_type === 'ein' ? extracted.tin_type : null,
    tin_last4: digits ? digits.slice(-4) : null,
    address: str(extracted.address, 240),
    signed: extracted.signed === true,
    signature_date: dateOrNull(extracted.signature_date),
    exempt_payee_code: str(extracted.exempt_payee_code, 20),
    // Deliberately NO raw echo for W-9s — the model was told not to output the
    // full TIN, but a raw pass-through would defeat the truncation if it did.
  };
}

/** Compare an extracted COI against a vendor's requirements jsonb. Returns
 *  human-readable shortfall strings — the SOFT gate: everything still files,
 *  these just flag for staff review. */
export function coiShortfalls(coi, requirements) {
  const req = requirements || {};
  const out = [];
  if (req.gl_each_occurrence) {
    if (!coi.gl_each_occurrence) {
      out.push(`GL each-occurrence limit not found on the certificate (required: $${Number(req.gl_each_occurrence).toLocaleString()})`);
    } else if (coi.gl_each_occurrence < Number(req.gl_each_occurrence)) {
      out.push(`GL each-occurrence $${coi.gl_each_occurrence.toLocaleString()} is below the required $${Number(req.gl_each_occurrence).toLocaleString()}`);
    }
  }
  if (req.wc_required && !coi.wc_policy_number && !coi.wc_each_accident) {
    out.push("Workers' comp required but no WC coverage appears on the certificate");
  }
  if (req.auto_required && !coi.auto_policy_number && !coi.auto_csl) {
    out.push('Auto liability required but no auto coverage appears on the certificate');
  }
  if (req.additional_insured_required && !coi.additional_insured) {
    out.push('Additional-insured endorsement required but the certificate does not show it (remember: certificate ≠ coverage — the endorsement itself is what counts)');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (coi.gl_expiration && coi.gl_expiration < today) {
    out.push(`GL policy already expired ${coi.gl_expiration}`);
  }
  return out;
}
