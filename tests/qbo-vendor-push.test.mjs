import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVendorPayload, contentTypeFor } from '../netlify/functions/lib/qbo-vendor-push.mjs';

const base = { display_name: 'ARTURO SANTIAGO' };

test('the display name always goes', () => {
  assert.equal(buildVendorPayload(base).DisplayName, 'ARTURO SANTIAGO');
});

test('a full tax id is NEVER sent — we only hold the last four', () => {
  // Sending a partial would be worse than blank: it LOOKS filled in. The whole
  // number lives on the W-9 PDF, which is why attaching the document matters.
  const p = buildVendorPayload({ ...base, ein_last4: '4821', tin_type: 'ein' });
  assert.equal(p.TaxIdentifier, undefined);
  assert.ok(!JSON.stringify(p).includes('4821'));
});

test('legal name rides as CompanyName, but not when it duplicates the display name', () => {
  assert.equal(buildVendorPayload({ ...base, legal_name: 'Santiago Refrigeration LLC' }).CompanyName,
    'Santiago Refrigeration LLC');
  assert.equal(buildVendorPayload({ ...base, legal_name: 'ARTURO SANTIAGO' }).CompanyName, undefined);
});

test('1099 is only set on an EXPLICIT override, never inferred', () => {
  assert.equal(buildVendorPayload({ ...base, is_1099: null }).Vendor1099, undefined);
  assert.equal(buildVendorPayload({ ...base, is_1099: false }).Vendor1099, undefined);
  assert.equal(buildVendorPayload({ ...base, is_1099: true }).Vendor1099, true);
});

test('an address only rides when there is a street to put on it', () => {
  assert.equal(buildVendorPayload({ ...base, tax_address: { city: 'Alameda' } }).BillAddr, undefined);
  const p = buildVendorPayload({
    ...base, tax_address: { line1: '1951 Monarch St', city: 'Alameda', state: 'CA', zip: '94501' },
  });
  assert.equal(p.BillAddr.Line1, '1951 Monarch St');
  assert.equal(p.BillAddr.CountrySubDivisionCode, 'CA');
  assert.equal(p.BillAddr.PostalCode, '94501');
});

test('a junk tax_address never throws', () => {
  for (const bad of [null, 'not an object', 42, []]) {
    assert.doesNotThrow(() => buildVendorPayload({ ...base, tax_address: bad }));
  }
});

test('no empty keys are sent — they would blank curated QuickBooks values', () => {
  const p = buildVendorPayload({ ...base, legal_name: null, contact_email: null, contact_phone: null });
  assert.deepEqual(Object.keys(p), ['DisplayName']);
});

test('terms are never pushed as text — QBO wants a TermRef id', () => {
  assert.equal(buildVendorPayload({ ...base, default_terms: 'Net 30' }).TermRef, undefined);
});

test('content type follows the file extension', () => {
  assert.equal(contentTypeFor('w9.pdf'), 'application/pdf');
  assert.equal(contentTypeFor('scan.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('cert.png'), 'image/png');
  assert.equal(contentTypeFor('mystery'), 'application/pdf');
});
