// /api/vendor-qbo-push — put a Brixpense vendor into QuickBooks, with their
// paperwork attached to the QuickBooks vendor record.
//
// Two jobs people do by hand today:
//   1. Re-key the vendor into QuickBooks.
//   2. Find the W-9 / certificate of insurance and attach it there, so whoever
//      is looking at a bill can see the vendor is actually documented.
//
// It never creates a SECOND QuickBooks vendor: an existing link is verified
// first, then an exact DisplayName match is linked to, and only then is one
// created. QBO rejects duplicate display names anyway, so a blind create would
// just 400 — but linking is also the right answer, for the same reason the W-9
// drop matches before it creates.
//
// Documents are best effort and reported individually: the vendor push having
// worked is worth keeping even if one attachment fails, and the response says
// exactly which did what.
//
// Gate: staff (superadmin | admin), matching ops.vendors RLS.

import { requireAuth } from './lib/auth.mjs';
import { ops } from './lib/vendor-onboard-lib.mjs';
import {
  ensureQboVendor, attachToQboVendor, alreadyAttached, contentTypeFor, pickEmail,
} from './lib/qbo-vendor-push.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'compliance-docs';
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // QBO's own attachment ceiling

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

async function downloadFromBucket(path) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`storage ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const vendorId = String(body.vendor_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(vendorId)) return json({ error: 'vendor_id must be a uuid' }, 400);

  const rows = await ops('GET', `vendors?id=eq.${vendorId}&select=*&limit=1`);
  const vendor = rows?.[0];
  if (!vendor) return json({ error: 'Vendor not found' }, 404);

  // ── 1. The vendor record ──
  const pushed = await ensureQboVendor(vendor);
  if (String(vendor.qbo_vendor_id || '') !== pushed.qboVendorId) {
    await ops('PATCH', `vendors?id=eq.${vendorId}`, { qbo_vendor_id: pushed.qboVendorId });
  }

  // ── 2. Their paperwork ──
  const docs = vendor.insured_party_id
    ? (await ops('GET',
        `compliance_documents?party_id=eq.${vendor.insured_party_id}`
        + '&storage_path=not.is.null&archived_at=is.null'
        + '&select=id,doc_type,file_name,storage_path,expiration_date&order=created_at.desc')) || []
    : [];

  const attachments = [];
  for (const d of docs) {
    const name = d.file_name || `${d.doc_type || 'document'}.pdf`;
    try {
      if (await alreadyAttached(pushed.qboVendorId, name)) {
        attachments.push({ document: name, status: 'already_there' });
        continue;
      }
      const bytes = await downloadFromBucket(d.storage_path);
      if (bytes.length > MAX_ATTACH_BYTES) {
        attachments.push({ document: name, status: 'too_large' });
        continue;
      }
      const id = await attachToQboVendor({
        qboVendorId: pushed.qboVendorId,
        bytes,
        fileName: name,
        contentType: contentTypeFor(name),
        note: [d.doc_type, d.expiration_date ? `expires ${d.expiration_date}` : null]
          .filter(Boolean).join(' · ') || null,
      });
      attachments.push({ document: name, status: 'attached', qbo_attachment_id: id });
    } catch (e) {
      // One bad file must not lose the rest, or the vendor push itself.
      attachments.push({ document: name, status: 'failed', error: String(e?.message || e).slice(0, 160) });
    }
  }

  // A vendor record often holds several contacts in one field; QuickBooks takes
  // one. Say which one went, so nobody has to guess.
  const emailPick = pickEmail(vendor.contact_email);
  const emailNote = emailPick.valid > 1
    ? ` QuickBooks takes one email — sent ${emailPick.email} of ${emailPick.valid} on file.`
    : '';

  const attached = attachments.filter((a) => a.status === 'attached').length;
  const failed = attachments.filter((a) => a.status === 'failed').length;
  const verb = pushed.outcome === 'created' ? 'Created'
    : pushed.outcome === 'linked_existing' ? 'Linked to the existing' : 'Already linked to the';

  return json({
    ok: true,
    qbo_vendor_id: pushed.qboVendorId,
    outcome: pushed.outcome,
    qbo_display_name: pushed.name,
    attachments,
    message: `${verb} QuickBooks vendor "${pushed.name}".`
      + (docs.length === 0
        ? ' No documents on file to attach yet.'
        : ` ${attached} document${attached === 1 ? '' : 's'} attached`
          + (failed ? `, ${failed} failed` : '')
          + (attachments.some((a) => a.status === 'already_there')
            ? `, ${attachments.filter((a) => a.status === 'already_there').length} already there` : '')
          + '.')
      + emailNote,
    email_used: emailPick.email,
    emails_on_file: emailPick.valid,
  });
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    const detail = String(e?.message || e).slice(0, 300);
    console.error('[vendor-qbo-push]', detail);
    return json({ error: 'push_failed', message: `QuickBooks refused that: ${detail}` }, 500);
  }
};

export const config = { path: '/api/vendor-qbo-push' };
