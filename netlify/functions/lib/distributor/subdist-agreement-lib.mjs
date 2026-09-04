// subdist-agreement-lib.mjs — the shared half of the sub-distribution
// agreement flow: template seeding, the signing token, and what "usable" means.
//
// Both the staff endpoint (build / preview / send / revoke) and the PUBLIC
// signing endpoint import from here, so the two cannot drift on whether a link
// is still good. That mattered enough on the NDA to be worth repeating: an
// expiry the sender believes in and the signing page does not is a link that
// keeps working after somebody switched it off.

import { createHash, randomBytes } from 'node:crypto';
import { ops } from '../vendor-onboard-lib.mjs';
import { SHIPPED, DEFAULT_CODE } from './index.mjs';

export { ops, SHIPPED, DEFAULT_CODE };

/** Only the sha256 is ever stored. A database read must not yield a working
 *  signing link — a lost link is RE-ISSUED, never recovered. */
export const hashToken = (raw) => createHash('sha256').update(String(raw)).digest('hex');
export const mintToken = () => randomBytes(32).toString('base64url');

export const SIGN_TTL_DAYS = 30;

/** The active template for a code, seeding the shipped wording on first use. */
export async function activeTemplate(code = DEFAULT_CODE) {
  const want = SHIPPED[code] ? code : DEFAULT_CODE;
  const rows = await ops('GET',
    `subdist_agreement_templates?select=*&active=is.true&code=eq.${encodeURIComponent(want)}`
    + '&order=created_at.desc&limit=1');
  if (rows?.[0]) return rows[0];

  const shipped = SHIPPED[want];
  if (!shipped) throw new Error(`No shipped agreement for code "${want}"`);
  const seeded = await ops('POST', 'subdist_agreement_templates', {
    code: shipped.code,
    version: shipped.version,
    title: shipped.title,
    subtitle: shipped.subtitle,
    body_source: shipped.body_source,
    notes: shipped.notes,
    active: true,
  }, { Prefer: 'return=representation' });
  return Array.isArray(seeded) ? seeded[0] : seeded;
}

/**
 * Is this signing link usable, and if not, why?
 *
 * ⚠ Every unusable case answers with the SAME shape and an equally vague
 * public reason. A probe must not be able to tell an unknown token from a
 * revoked one — that difference tells an attacker which tokens exist.
 */
export function linkUnusable(a) {
  if (!a) return 'This signing link is not valid. Ask us for a new one.';
  if (a.status === 'signed') return null;               // signed is not unusable; the page shows the executed copy
  if (a.revoked_at) return 'This signing link is no longer active. Ask us for a new one.';
  if (a.declined_at) return 'This agreement was declined. Ask us for a new one if that was a mistake.';
  if (a.status !== 'sent') return 'This signing link is not valid. Ask us for a new one.';
  if (a.expires_at && new Date(a.expires_at).getTime() < Date.now()) {
    return 'This signing link has expired. Ask us for a new one.';
  }
  return null;
}

/** Clamp a signing-link lifetime. There is deliberately no "never expires". */
export function clampTtl(days, dflt = SIGN_TTL_DAYS) {
  const n = Number(days);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(365, Math.max(1, Math.round(n)));
}

/** Trim and cap a free-text field before it reaches a document somebody signs. */
export const clean = (v, max = 200) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/** A signature must be an inline image. A remote URL would be a live
 *  dependency inside a legal record, and free text would be an injection. */
export function validSignature(dataUrl, maxBytes = 400_000) {
  const s = String(dataUrl || '');
  if (!/^data:image\/(png|jpeg);base64,/.test(s)) return 'The signature must be a PNG or JPEG image.';
  const b64 = s.slice(s.indexOf(',') + 1);
  if (Math.ceil(b64.length * 3 / 4) > maxBytes) return 'That signature image is too large.';
  return null;
}

/** The company signatory whose signature prints in the Company block. Read
 *  FRESH at send time, so re-drawing a signature takes effect on the next
 *  agreement rather than stranding a stale image on every future one. */
export async function companySignatory(id) {
  const q = id
    ? `nda_signatories?select=*&id=eq.${encodeURIComponent(id)}&limit=1`
    : 'nda_signatories?select=*&active=is.true&order=created_at.desc&limit=1';
  const rows = await ops('GET', q);
  return rows?.[0] || null;
}
