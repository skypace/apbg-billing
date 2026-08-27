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

// ── The real 400 ──────────────────────────────────────────────────────────
// QuickBooks refused a live push with fault 2210 "does not conform to the
// syntax rules of RFC 822", quoting the whole contact_email field:
//   "tina@trutekaz.com, nancy@truetekaz.com, gene,cota@truetekaz.com"
// Three contacts in one column, one of them itself malformed (a comma where a
// dot belongs). PrimaryEmailAddr takes exactly ONE address.
import { pickEmail, pickPhone, splitContacts } from '../netlify/functions/lib/qbo-vendor-push.mjs';

const REAL = 'tina@trutekaz.com, nancy@truetekaz.com, gene,cota@truetekaz.com';

test('the string that actually broke it now yields one valid address', () => {
  const p = pickEmail(REAL);
  assert.equal(p.email, 'tina@trutekaz.com');
  assert.ok(p.valid > 1, 'should notice there were several');
});

test('the whole multi-address string never reaches QuickBooks', () => {
  const payload = buildVendorPayload({ display_name: 'TruTek', contact_email: REAL });
  assert.equal(payload.PrimaryEmailAddr.Address, 'tina@trutekaz.com');
  assert.ok(!payload.PrimaryEmailAddr.Address.includes(','));
});

test('a malformed address is skipped, not repaired', () => {
  // "gene,cota@x.com" must never be silently turned into "gene.cota@x.com" —
  // that is inventing a contact. Splitting drops the unusable fragment.
  const p = pickEmail('gene,cota@truetekaz.com');
  assert.equal(p.email, 'cota@truetekaz.com');
  assert.ok(!splitContacts('gene,cota@truetekaz.com').includes('gene.cota@truetekaz.com'));
});

test('no valid address means the key is omitted entirely, not sent blank', () => {
  for (const junk of ['not an email', '@@@', '', null, 'a@b']) {
    assert.equal(pickEmail(junk).email, null);
    assert.equal(buildVendorPayload({ display_name: 'X', contact_email: junk }).PrimaryEmailAddr, undefined);
  }
});

test('semicolons and newlines separate contacts too', () => {
  assert.equal(pickEmail('ap@vendor.com; owner@vendor.com').email, 'ap@vendor.com');
  assert.equal(pickEmail('\nap@vendor.com\nowner@vendor.com\n').email, 'ap@vendor.com');
});

test('a phone list sends one number, and junk sends none', () => {
  assert.equal(pickPhone('928-555-0134, 928-555-0199'), '928-555-0134');
  assert.equal(pickPhone('ask for Gene'), null);
});
