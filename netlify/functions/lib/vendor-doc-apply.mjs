// vendor-doc-apply.mjs — turn an OCR'd W-9 or COI into vendor-record changes.
//
// Shared by the two paths that file these documents, which must not drift:
//
//   vendor-onboard.mjs     the VENDOR uploads through their emailed one-time link
//   vendor-doc-upload.mjs  STAFF drop a document they already have on the vendor page
//
// Before this existed, the W-9 extractor read the tax classification, the TIN
// type and the address off the form and then wrote them into a free-text notes
// sentence — so ops.vendors kept its structured 1099 columns empty and the
// vendor stayed on the chase list with their W-9 sitting in the vault. The
// extraction was never the missing piece; landing it in columns was.
//
// Everything here is conservative in the same direction: a field we cannot read
// with confidence is left NULL rather than guessed, because on this record a
// wrong answer is worse than a blank one — a vendor wrongly marked exempt drops
// off the 1099 worklist silently, which is the failure that costs money.

/** W-9 line 3 as the form prints it → our tax_classification enum.
 *  Unrecognised text returns null: "Other" on a W-9 usually has a write-in
 *  beside it that a human needs to read. */
export function mapEntityType(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (!t) return null;

  // LLCs first — "LLC taxed as an S corporation" contains "s corp", and the
  // order of these tests is the only thing stopping it landing on s_corp.
  if (/\bllc\b|limited liability/.test(t)) {
    if (/\b(c[\s-]?corp|llc[\s-]?c)\b|taxed as an? +c/.test(t)) return 'llc_c';
    if (/\b(s[\s-]?corp|llc[\s-]?s)\b|taxed as an? +s/.test(t)) return 'llc_s';
    if (/partnership|llc[\s-]?p/.test(t)) return 'llc_p';
    // A single-member LLC checks the INDIVIDUAL box on a W-9, so a bare "LLC"
    // is genuinely ambiguous — say nothing rather than pick.
    return null;
  }

  if (/trust|estate/.test(t)) return 'trust';
  if (/partnership/.test(t)) return 'partnership';
  if (/\bc[\s-]?corp/.test(t)) return 'c_corp';
  if (/\bs[\s-]?corp/.test(t)) return 's_corp';
  if (/corporation|\bcorp\b|\binc\b/.test(t)) return null;  // which kind? unknown
  if (/sole[\s-]?prop/.test(t)) return 'sole_prop';
  if (/individual/.test(t)) return 'individual';
  if (/^other\b/.test(t)) return 'other';
  return null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cleanDate = (v) => (ISO.test(String(v || '')) ? String(v) : null);

/**
 * @returns {{ vendorPatch: object, doc: object, summary: object, warnings: string[] }}
 */
export function applyW9({ vendor, extracted, storagePath, fileName, partyId, source, ocrError }) {
  const warnings = [];
  const e = extracted || {};

  const classification = mapEntityType(e.entity_type);
  if (e.entity_type && !classification) {
    warnings.push(`Couldn't map the tax classification "${e.entity_type}" — set it by hand on the vendor.`);
  }
  if (e.signed === false) warnings.push('No signature found in Part II — verify the form is actually signed.');
  if (ocrError) warnings.push(`Couldn't read the form (${ocrError}) — the file is filed, but the fields need entering by hand.`);

  // w9_received_at is when WE got it, which is today for a staff upload and the
  // upload moment for a vendor one. The signature date is when they signed it —
  // related, often months earlier, and not the same question.
  const receivedAt = new Date().toISOString().slice(0, 10);

  const vendorPatch = { w9_status: 'on_file', w9_received_at: receivedAt };
  if (e.tin_last4) vendorPatch.ein_last4 = e.tin_last4;
  if (e.tin_type === 'ein' || e.tin_type === 'ssn') vendorPatch.tin_type = e.tin_type;
  if (classification) vendorPatch.tax_classification = classification;
  // Never overwrite a legal name somebody has already curated.
  if (e.legal_name && !vendor?.legal_name) vendorPatch.legal_name = e.legal_name;
  if (e.address) {
    vendorPatch.tax_address = {
      line: e.address,
      source: 'w9',
      captured_at: new Date().toISOString(),
    };
  }
  // is_1099 is deliberately NOT set here. It stays NULL so it derives from the
  // classification. An exempt payee code on a W-9 is about backup withholding,
  // not about 1099 reporting, and reading it as an exemption would quietly drop
  // a real obligation.

  const doc = {
    category: 'tax',
    doc_type: 'W-9',
    party_id: partyId,
    issuer: null,
    reference_number: e.tin_last4 ? `TIN •••${e.tin_last4}` : null,
    issue_date: cleanDate(e.signature_date),
    expiration_date: null,          // a W-9 does not expire
    storage_path: storagePath,
    file_name: fileName,
    notes: [
      source === 'staff' ? 'Filed by staff on the vendor record.' : 'Uploaded by the vendor via the onboarding link.',
      e.entity_type ? `Entity type: ${e.entity_type}.` : null,
      e.exempt_payee_code ? `Exempt payee code: ${e.exempt_payee_code}.` : null,
      ...warnings.map((w) => `⚠ ${w}`),
    ].filter(Boolean).join(' '),
  };

  return {
    vendorPatch,
    doc,
    warnings,
    summary: {
      legal_name: e.legal_name ?? null,
      entity_type: e.entity_type ?? null,
      tax_classification: classification,
      tin_type: e.tin_type ?? null,
      tin_last4: e.tin_last4 ?? null,
      signed: e.signed ?? null,
    },
  };
}

/** The date the whole certificate lapses — the EARLIEST line expiry, because a
 *  certificate is only as current as its soonest-expiring coverage. */
export function coiExpiration(e) {
  const dates = [e?.gl_expiration, e?.auto_expiration, e?.wc_expiration]
    .map(cleanDate).filter(Boolean).sort();
  return dates[0] ?? null;
}

export function applyCoi({ extracted, storagePath, fileName, partyId, source, ocrError, shortfalls = [] }) {
  const e = extracted || {};
  const warnings = [];
  if (ocrError) warnings.push(`Couldn't read the certificate (${ocrError}) — it is filed, but the limits and dates need entering by hand.`);
  for (const s of shortfalls) warnings.push(s);

  const expiration = coiExpiration(e);
  if (expiration && expiration < new Date().toISOString().slice(0, 10)) {
    warnings.push('This certificate has already expired — ask for a current one.');
  }

  const doc = {
    category: 'insurance',
    doc_type: 'Certificate of Insurance (ACORD 25)',
    party_id: partyId,
    issuer: e.producer || (Array.isArray(e.carriers) ? e.carriers[0] : null) || null,
    reference_number: e.gl_policy_number || e.auto_policy_number || e.wc_policy_number || null,
    issue_date: cleanDate(e.certificate_date),
    expiration_date: expiration,
    storage_path: storagePath,
    file_name: fileName,
    notes: [
      source === 'staff' ? 'Filed by staff on the vendor record.' : 'Uploaded by the vendor via the onboarding link.',
      e.gl_each_occurrence ? `GL ${money(e.gl_each_occurrence)} occ / ${money(e.gl_aggregate)} agg.` : null,
      e.auto_csl ? `Auto CSL ${money(e.auto_csl)}.` : null,
      e.wc_each_accident ? `WC E.L. ${money(e.wc_each_accident)}.` : null,
      e.umbrella_each_occurrence ? `Umbrella ${money(e.umbrella_each_occurrence)}.` : null,
      // Worth stating explicitly: a certificate naming us is not the same as an
      // endorsement granting us additional-insured status (SOP-11).
      e.additional_insured === true ? 'Marked additional insured — confirm the endorsement, not just the box.'
        : e.additional_insured === false ? '⚠ NOT marked additional insured.' : null,
      ...warnings.map((w) => `⚠ ${w}`),
    ].filter(Boolean).join(' '),
  };

  return { doc, warnings, expiration, summary: { ...e, expiration } };
}

function money(n) {
  const v = Number(n || 0);
  return v ? `$${v.toLocaleString('en-US')}` : '—';
}
