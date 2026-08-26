// Push a Brixpense vendor into QuickBooks, and file their paperwork against it.
//
// Two halves, both of which people do by hand today:
//   1. The vendor record — name, remit-to address, terms, 1099 flag.
//   2. The DOCUMENTS — the W-9 and the certificate of insurance, attached to
//      the QuickBooks vendor so whoever is looking at a bill can see them.
//
// ⚠ We deliberately do NOT hold a full TIN — ops.vendors keeps `ein_last4`
// only. QuickBooks' TaxIdentifier wants the whole number, so this never sends
// one: a partial would be worse than blank, because it LOOKS filled in. The
// full number is on the W-9 itself, which is exactly why attaching the
// document is the part that matters.

import { qboQuery, qboRequest, getAccessToken, QBO_BASE } from '../qbo-helpers.mjs';

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** QBO rejects a duplicate DisplayName, so a blind create 400s on any vendor
 *  who already exists there. Look first, link if found. Same rule as the W-9
 *  drop: a second record is worse than no record. */
export async function findQboVendorByName(name) {
  const clean = String(name || '').replace(/['\\]/g, ' ').trim();
  if (!clean) return null;
  const res = await qboQuery(
    `SELECT Id, DisplayName, Active FROM Vendor WHERE DisplayName = '${clean}'`);
  return asArray(res?.QueryResponse?.Vendor)[0] || null;
}

export async function getQboVendorById(id) {
  if (!/^\d+$/.test(String(id || ''))) return null;
  try {
    const res = await qboQuery(`SELECT Id, DisplayName, Active FROM Vendor WHERE Id = '${id}'`);
    return asArray(res?.QueryResponse?.Vendor)[0] || null;
  } catch { return null; }
}

/** Map our record onto QBO's Vendor. Only fields we actually hold — an empty
 *  key is left off rather than sent blank, so this never blanks something a
 *  human curated in QuickBooks. */
export function buildVendorPayload(v) {
  const addr = v.tax_address && typeof v.tax_address === 'object' ? v.tax_address : {};
  const payload = { DisplayName: String(v.display_name || '').slice(0, 100) };

  if (v.legal_name && v.legal_name !== v.display_name) payload.CompanyName = v.legal_name;
  if (v.contact_email) payload.PrimaryEmailAddr = { Address: v.contact_email };
  if (v.contact_phone) payload.PrimaryPhone = { FreeFormNumber: v.contact_phone };
  if (v.default_terms) payload.TermRef = undefined; // terms are an id in QBO, not text — left to a human

  const line1 = addr.line1 || addr.street || null;
  if (line1) {
    payload.BillAddr = {
      Line1: String(line1).slice(0, 500),
      ...(addr.line2 ? { Line2: String(addr.line2).slice(0, 500) } : {}),
      ...(addr.city ? { City: String(addr.city).slice(0, 255) } : {}),
      ...(addr.state ? { CountrySubDivisionCode: String(addr.state).slice(0, 255) } : {}),
      ...(addr.zip || addr.postal_code
        ? { PostalCode: String(addr.zip || addr.postal_code).slice(0, 30) } : {}),
    };
  }

  // Only an EXPLICIT override sets this. is_1099 null means "nobody has
  // decided", and guessing it from the W-9 checkbox is the exact mistake the
  // 1099 worklist exists to avoid — an exempt-payee code is about backup
  // withholding, not 1099 reporting.
  if (v.is_1099 === true) payload.Vendor1099 = true;

  delete payload.TermRef;
  return payload;
}

/** Create in QBO, or link to the one already there. Never creates a second. */
export async function ensureQboVendor(v) {
  if (v.qbo_vendor_id) {
    const existing = await getQboVendorById(v.qbo_vendor_id);
    if (existing) return { qboVendorId: String(existing.Id), outcome: 'already_linked', name: existing.DisplayName };
  }
  const byName = await findQboVendorByName(v.display_name);
  if (byName) return { qboVendorId: String(byName.Id), outcome: 'linked_existing', name: byName.DisplayName };

  const res = await qboRequest('POST', '/vendor', buildVendorPayload(v));
  const created = res?.Vendor;
  if (!created?.Id) throw new Error('QuickBooks did not return a vendor id');
  return { qboVendorId: String(created.Id), outcome: 'created', name: created.DisplayName };
}

const CONTENT_TYPE_FOR = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/png', // QBO has no webp — send as png, it sniffs content
};

export function contentTypeFor(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return CONTENT_TYPE_FOR[ext] || 'application/pdf';
}

/** Is this file already on the QBO vendor? Best effort — a query QBO refuses
 *  returns false (upload anyway), because a duplicate attachment is a tidiness
 *  problem while a MISSING W-9 is the thing we are trying to fix. */
export async function alreadyAttached(qboVendorId, fileName) {
  try {
    const clean = String(fileName || '').replace(/['\\]/g, ' ');
    const res = await qboQuery(`SELECT Id, FileName FROM Attachable WHERE FileName = '${clean}'`);
    return asArray(res?.QueryResponse?.Attachable).some((a) =>
      asArray(a.AttachableRef).some((r) =>
        String(r?.EntityRef?.value) === String(qboVendorId) && r?.EntityRef?.type === 'Vendor'));
  } catch { return false; }
}

/** Upload one file and link it to the vendor.
 *
 *  qboRequest() can't do this — it forces application/json — so this builds the
 *  multipart body itself against the same access token. The part names are
 *  fixed by Intuit: file_metadata_01 (JSON) and file_content_01 (the bytes). */
export async function attachToQboVendor({ qboVendorId, bytes, fileName, contentType, note }) {
  const token = await getAccessToken();
  const realm = process.env.QBO_REALM_ID;
  const boundary = `----brixpense${Date.now().toString(16)}`;
  const meta = {
    AttachableRef: [{ EntityRef: { type: 'Vendor', value: String(qboVendorId) } }],
    ContentType: contentType,
    FileName: fileName,
    ...(note ? { Note: String(note).slice(0, 2000) } : {}),
  };

  const parts = [
    Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="file_metadata_01"\r\n'
      + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
      + `${JSON.stringify(meta)}\r\n`, 'utf8'),
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`, 'utf8'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ];
  const body = Buffer.concat(parts);

  const res = await fetch(`${QBO_BASE}/v3/company/${realm}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      // Intuit wants the boundary WITHOUT the leading '--' here.
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`QBO upload ${res.status}: ${text.slice(0, 240)}`);

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* QBO occasionally answers XML */ }
  const first = asArray(parsed?.AttachableResponse)[0];
  if (first?.Fault) {
    throw new Error(`QBO refused the attachment: ${JSON.stringify(first.Fault).slice(0, 240)}`);
  }
  return first?.Attachable?.Id ? String(first.Attachable.Id) : null;
}
