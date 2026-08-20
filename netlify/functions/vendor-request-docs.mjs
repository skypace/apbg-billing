// /api/vendor-request-docs — staff mints a one-time onboarding link for a
// vendor and emails it (Vendor Portal Phase 2). Called from Brixpense →
// Vendors → vendor detail → "Request documents".
//
// POST { vendor_id, email?, purpose? }
//   email    — overrides (and is saved back to) the vendor's contact_email
//   purpose  — 'onboard' (default) | 'docs_refresh'
// → { ok, sent_to, expires_at }
//
// The vendor's compliance-vault party is created here if missing, so the
// intake's first upload always has somewhere to file. Gate: superadmin/admin
// (same audience as the Vendors module).

import { requireAuth } from './lib/auth.mjs';
import { sendEmail } from './email-helpers.mjs';
import { ops, mintToken, ensureParty, requestDocsEmailHtml } from './lib/vendor-onboard-lib.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const vendorId = String(body.vendor_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(vendorId)) return json({ error: 'vendor_id is required' }, 400);

  let vendor;
  try {
    const rows = await ops('GET', `vendors?select=*&id=eq.${vendorId}&limit=1`);
    vendor = rows && rows[0];
  } catch (e) {
    return json({ error: `Could not load the vendor: ${e.message}` }, 502);
  }
  if (!vendor) return json({ error: 'Vendor not found' }, 404);
  if (vendor.archived_at) return json({ error: 'This vendor is archived — restore it first.' }, 409);

  const emailOverride = String(body.email || '').trim();
  if (emailOverride && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailOverride)) {
    return json({ error: 'That email address does not look right.' }, 400);
  }
  const sendTo = emailOverride || vendor.contact_email;
  if (!sendTo) return json({ error: 'No contact email on file for this vendor — add one (or pass it here) first.' }, 400);

  try {
    await ensureParty(vendor);

    const { link, expiresAt } = await mintToken({
      vendorId: vendor.id,
      purpose: body.purpose === 'docs_refresh' ? 'docs_refresh' : 'onboard',
      sentTo: sendTo,
      createdBy: auth.user?.email || 'staff',
    });

    await sendEmail({
      to: sendTo,
      subject: `${vendor.display_name} — vendor documents for Brix Beverage`,
      html: requestDocsEmailHtml({ vendorName: vendor.display_name, link, mode: 'invite' }),
      text: `Please send us your vendor documents (COI, W-9, payment preference): ${link}\nThis link expires in 14 days.`,
    });

    const patch = {};
    if (vendor.onboard_status === 'new' || vendor.onboard_status === 'invited') patch.onboard_status = 'invited';
    if (emailOverride && emailOverride !== vendor.contact_email) patch.contact_email = emailOverride;
    if (Object.keys(patch).length) await ops('PATCH', `vendors?id=eq.${vendor.id}`, patch);

    return json({ ok: true, sent_to: sendTo, expires_at: expiresAt });
  } catch (e) {
    return json({ error: `Could not send the request: ${e.message?.slice(0, 300) || e}` }, 502);
  }
}

export const config = { path: '/api/vendor-request-docs' };
