// tests/vendor-docs.test.mjs — filing a W-9 or a COI onto a vendor.
//
// The mapping is the part worth pinning. runW9Ocr had been reading the tax
// classification and TIN type off the form since it shipped and writing them
// into a free-text notes sentence, so ops.vendors kept its structured columns
// empty and the vendor stayed on the 1099 chase list with their W-9 already in
// the vault. These tests exist so that cannot quietly happen again.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mapEntityType, applyW9, applyCoi, coiExpiration } from '../netlify/functions/lib/vendor-doc-apply.mjs';

test('W-9 line 3 maps to the classification the 1099 report reads', () => {
  const cases = {
    'Individual/sole proprietor': 'sole_prop',
    Individual: 'individual',
    'C Corporation': 'c_corp',
    'S corporation': 's_corp',
    Partnership: 'partnership',
    'Trust/estate': 'trust',
    'LLC-C': 'llc_c',
    'LLC-S': 'llc_s',
    'LLC-P': 'llc_p',
    // An LLC that elected S-corp treatment must not land on plain s_corp:
    // the exemption is the same, but the classification is what a human reads
    // back when checking why a vendor is or isn't reportable.
    'Limited liability company taxed as an S corporation': 'llc_s',
    'Limited liability company taxed as a C corporation': 'llc_c',
    Other: 'other',
  };
  for (const [text, want] of Object.entries(cases)) {
    assert.equal(mapEntityType(text), want, text);
  }
});

test('an ambiguous classification is left blank and reported, never guessed', () => {
  // A single-member LLC checks the INDIVIDUAL box on a W-9, so a bare "LLC"
  // genuinely does not say whether it is reportable. Guessing "exempt" would
  // silently drop a real 1099 obligation, which is the expensive direction.
  for (const vague of ['LLC', 'Limited Liability Company', 'Corporation', 'Inc', '']) {
    assert.equal(mapEntityType(vague), null, vague);
  }
  const out = applyW9({
    vendor: { display_name: 'X' },
    extracted: { entity_type: 'LLC', tin_last4: '1234', tin_type: 'ein', signed: true },
    storagePath: 'p', fileName: 'f', partyId: 'party', source: 'staff',
  });
  assert.equal(out.vendorPatch.tax_classification, undefined);
  assert.match(out.warnings.join(' '), /Couldn't map the tax classification "LLC"/);
});

test('a filed W-9 fills every column the 1099 worklist reads', () => {
  const out = applyW9({
    vendor: { display_name: 'ARTURO SANTIAGO', legal_name: null },
    extracted: {
      legal_name: 'Arturo Santiago', entity_type: 'Individual/sole proprietor',
      tin_type: 'ssn', tin_last4: '4821', address: '1420 Buena Vista Ave, Alameda, CA 94501',
      signed: true, signature_date: '2026-03-04',
    },
    storagePath: 'p', fileName: 'w9.pdf', partyId: 'party', source: 'staff',
  });
  const p = out.vendorPatch;
  assert.equal(p.w9_status, 'on_file');
  assert.equal(p.tax_classification, 'sole_prop');
  assert.equal(p.tin_type, 'ssn');
  assert.equal(p.ein_last4, '4821');
  assert.equal(p.legal_name, 'Arturo Santiago');
  assert.ok(p.w9_received_at, 'w9_received_at is what takes them off the chase list');
  assert.equal(p.tax_address.source, 'w9');
  // Left to derive from the classification. An exempt payee code on a W-9 is
  // about backup withholding, not 1099 reporting — reading it as an exemption
  // would drop a real obligation.
  assert.equal(p.is_1099, undefined);
});

test('a curated legal name is never overwritten by OCR', () => {
  const out = applyW9({
    vendor: { display_name: 'X', legal_name: 'Parts Town, LLC' },
    extracted: { legal_name: 'PARTSTOWN LLC  ', entity_type: 'C Corporation' },
    storagePath: 'p', fileName: 'f', partyId: 'party', source: 'staff',
  });
  assert.equal(out.vendorPatch.legal_name, undefined);
});

test('an unreadable W-9 still gets filed, and says so', () => {
  // Losing the document because the model choked is strictly worse than
  // filing it with the fields blank — the PDF is the thing of record.
  const out = applyW9({
    vendor: { display_name: 'X' },
    extracted: null, ocrError: 'Anthropic 529',
    storagePath: 'p', fileName: 'f', partyId: 'party', source: 'staff',
  });
  assert.equal(out.vendorPatch.w9_status, 'on_file');
  assert.match(out.doc.notes, /Couldn't read the form/);
  assert.equal(out.doc.doc_type, 'W-9');
});

test('a W-9 has no expiry, a certificate expires on its EARLIEST line', () => {
  const w9 = applyW9({
    vendor: {}, extracted: { signature_date: '2026-03-04' },
    storagePath: 'p', fileName: 'f', partyId: 'party', source: 'staff',
  });
  assert.equal(w9.doc.expiration_date, null);

  // The general-liability date is the one people quote, but the certificate is
  // only as current as whichever coverage lapses first.
  assert.equal(coiExpiration({
    gl_expiration: '2027-01-01', auto_expiration: '2026-09-30', wc_expiration: '2027-01-01',
  }), '2026-09-30');
  assert.equal(coiExpiration({}), null);
});

test('a certificate carries its shortfalls and the additional-insured caveat', () => {
  const out = applyCoi({
    extracted: {
      producer: 'Marsh', gl_each_occurrence: 1_000_000, gl_aggregate: 2_000_000,
      gl_expiration: '2027-01-01', additional_insured: false, certificate_date: '2026-01-02',
    },
    storagePath: 'p', fileName: 'coi.pdf', partyId: 'party', source: 'staff',
    shortfalls: ['GL aggregate below the $3M required'],
  });
  assert.equal(out.doc.category, 'insurance');
  assert.equal(out.doc.expiration_date, '2027-01-01');
  assert.match(out.doc.notes, /NOT marked additional insured/);
  assert.match(out.doc.notes, /GL aggregate below/);
});

test('an already-expired certificate is flagged on the way in', () => {
  const out = applyCoi({
    extracted: { gl_expiration: '2020-01-01' },
    storagePath: 'p', fileName: 'f', partyId: 'party', source: 'staff',
  });
  assert.match(out.warnings.join(' '), /already expired/);
});
