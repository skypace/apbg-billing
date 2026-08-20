// vendor-onboard-lib.mjs — shared plumbing for the Vendor Portal Phase 2
// token flow. Used by vendor-request-docs.mjs (staff mint + invite email),
// vendor-onboard.mjs (the public intake), and compliance-expiry-cron.mjs
// (the Monday auto-chase). One definition of a token, one email look.
//
// Token model: 32 random bytes, base64url — the RAW token exists only inside
// the emailed link; ops.vendor_onboard_tokens stores its sha256 hex. 14-day
// expiry; used_at stamps on completion (uploads before completion ride the
// same token).

import { createHash, randomBytes } from 'node:crypto';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase-helpers.mjs';
import { SITE_URL } from '../email-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

export const TOKEN_TTL_DAYS = 14;
export const ONBOARD_PAGE = `${SITE_URL}/vendor-onboarding`;

/** Service-role PostgREST call against the ops schema. */
export async function ops(method, path, body, extra = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const hashToken = (raw) => createHash('sha256').update(String(raw)).digest('hex');

/** Mint a token row for a vendor and return the raw token + link. */
export async function mintToken({ vendorId, purpose, sentTo, createdBy }) {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();
  await ops('POST', 'vendor_onboard_tokens', {
    vendor_id: vendorId,
    token_hash: hashToken(raw),
    purpose: purpose === 'docs_refresh' ? 'docs_refresh' : 'onboard',
    expires_at: expiresAt,
    sent_to: sentTo || null,
    created_by: createdBy || null,
  });
  return { raw, link: `${ONBOARD_PAGE}?t=${raw}`, expiresAt };
}

/** Validate a raw token: exists, not expired, not already completed.
 *  Returns { token, vendor } or { error, status }. Constant-shape errors —
 *  the public page shows the same friendly message for every failure mode. */
export async function validateToken(raw) {
  if (!raw || typeof raw !== 'string' || raw.length < 20 || raw.length > 100) {
    return { error: 'This link is not valid.', status: 400 };
  }
  const rows = await ops('GET', `vendor_onboard_tokens?select=*&token_hash=eq.${hashToken(raw)}&limit=1`);
  const token = rows && rows[0];
  if (!token) return { error: 'This link is not valid.', status: 404 };
  if (token.used_at) return { error: 'This link has already been used. If you have more documents to send, ask us for a fresh link.', status: 410 };
  if (new Date(token.expires_at).getTime() < Date.now()) {
    return { error: 'This link has expired. Ask us for a fresh one — links are good for 14 days.', status: 410 };
  }
  const vendors = await ops('GET', `vendors?select=*&id=eq.${token.vendor_id}&limit=1`);
  const vendor = vendors && vendors[0];
  if (!vendor || vendor.archived_at) return { error: 'This link is not valid.', status: 404 };
  return { token, vendor };
}

/** Create the vendor's compliance-vault party when missing; returns party id.
 *  (Server-side twin of the Brixpense ensureInsuredParty — the intake files
 *  documents under the party, so it must exist before the first upload.) */
export async function ensureParty(vendor) {
  if (vendor.insured_party_id) return vendor.insured_party_id;
  const created = await ops('POST', 'insured_parties', {
    name: vendor.display_name,
    party_type: vendor.vendor_type === 'contractor' ? 'contractor' : 'vendor',
    contact_name: vendor.contact_name,
    contact_email: vendor.contact_email,
    contact_phone: vendor.contact_phone,
    notes: 'Created by vendor onboarding intake',
  }, { Prefer: 'return=representation' });
  const partyId = created[0].id;
  await ops('PATCH', `vendors?id=eq.${vendor.id}`, { insured_party_id: partyId });
  return partyId;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Branded invite / chase email. `mode` = 'invite' | 'chase'. */
export function requestDocsEmailHtml({ vendorName, link, mode, reason }) {
  const heading = mode === 'chase' ? 'Your insurance certificate needs a refresh' : 'Please send us your vendor documents';
  const intro = mode === 'chase'
    ? `Our records show ${esc(reason || 'your certificate of insurance is due for renewal')}. Please use the secure link below to send us the updated certificate — it takes about two minutes.`
    : 'To set you up (or keep you current) as a vendor of Brix Beverage / Alameda Point Beverage Group, we need a few documents on file. The secure link below walks you through it — it takes about five minutes.';
  return `<div style="font-family:'DM Sans',-apple-system,Segoe UI,Arial,sans-serif;background:#F5F7FA;padding:24px 12px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #E4E9F0;border-radius:14px;overflow:hidden">
    <div style="background:#1F4E79;padding:18px 22px;color:#fff">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9FD0E8;font-weight:700">Brix Beverage · Vendor documents</div>
      <div style="font-size:21px;font-weight:800;margin-top:4px">${esc(heading)}</div>
      <div style="font-size:13px;color:#C9E2F0;margin-top:2px">${esc(vendorName)}</div>
    </div>
    <div style="height:4px;background:#F4B400"></div>
    <div style="padding:20px 22px;font-size:14px;color:#0F172A;line-height:1.55">
      <p style="margin:0 0 12px">${intro}</p>
      <ul style="margin:0 0 14px;padding-left:20px;color:#374151;font-size:13px">
        <li>A current <b>Certificate of Insurance</b> (ACORD 25)</li>
        <li>A completed, signed <b>W-9</b></li>
        <li>How you'd like to be <b>paid</b></li>
      </ul>
      <p style="margin:0 0 16px">
        <a href="${esc(link)}" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Send your documents →</a>
      </p>
      <p style="margin:0;color:#64748B;font-size:12px">
        This link is personal to your business and expires in ${TOKEN_TTL_DAYS} days.
        We never ask for bank account numbers on this page — payment setup for bank transfers happens
        separately through our payment provider.
      </p>
    </div>
  </div></div>`;
}
