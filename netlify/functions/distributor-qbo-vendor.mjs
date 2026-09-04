// /api/distributor-qbo-vendor — put a sub-distributor into QuickBooks as a
// vendor, and link the two.
//
// Why this exists: the settlement bill for a partner's delivery fees lands on
// a QuickBooks VENDOR (they invoice us — the money runs the other way from
// the customer side). Three of the four partners already had one and were
// linked by hand; the fourth had never been paid, so no vendor existed and
// there was nowhere for a settlement to go. Keying it into QuickBooks and
// then hunting for the id is work this can do.
//
// It never creates a SECOND vendor. ensureQboVendor() verifies an existing
// link, then matches an exact DisplayName, and only creates when neither
// finds one — QBO rejects a duplicate DisplayName anyway, so a blind create
// would 400, and linking is the right answer regardless: a second vendor
// splits the bill history in two and that cannot be undone by editing.
//
// ⚠ We send name, email and phone and nothing else. ops.sub_distributors
// holds no remit-to address, and a made-up address on a payee record is worse
// than a blank one somebody fills in — a cheque goes to it. The response says
// so, and the panel repeats it.
//
// Gate: staff (superadmin | admin), matching ops.sub_distributors RLS.

import { requireAuth } from './lib/auth.mjs';
import { ops } from './lib/vendor-onboard-lib.mjs';
import { ensureQboVendor, pickEmail } from './lib/qbo-vendor-push.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' }, 500);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const id = String(body.distributor_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'distributor_id must be a uuid' }, 400);

  const rows = await ops('GET', `sub_distributors?id=eq.${id}&select=*&limit=1`);
  const dist = rows?.[0];
  if (!dist) return json({ error: 'Sub-distributor not found' }, 404);

  // The name on the vendor record is theirs, not our internal code — a
  // bookkeeper reading a bill sees the QuickBooks DisplayName.
  const displayName = String(body.display_name || dist.name || '').trim();
  if (!displayName) return json({ error: 'This partner has no name to create a vendor under.' }, 400);

  let pushed;
  try {
    pushed = await ensureQboVendor({
      qbo_vendor_id: dist.qbo_vendor_id,
      display_name: displayName,
      legal_name: null,          // no legal-name column on this table
      contact_email: dist.contact_email,
      contact_phone: dist.contact_phone,
      tax_address: null,         // no remit-to on file — see the header note
      is_1099: null,             // an explicit decision, never inferred
    });
  } catch (e) {
    return json({ error: `QuickBooks refused the vendor: ${e?.message || e}` }, 502);
  }

  if (String(dist.qbo_vendor_id || '') !== pushed.qboVendorId) {
    await ops('PATCH', `sub_distributors?id=eq.${id}`, { qbo_vendor_id: pushed.qboVendorId });
  }

  const picked = pickEmail(dist.contact_email);
  const notes = [];
  if (pushed.outcome === 'linked_existing') {
    notes.push(`A QuickBooks vendor named "${pushed.name}" already existed — linked to it rather than creating a second.`);
  }
  if (pushed.outcome === 'created') {
    notes.push('No remit-to address was sent — add one in QuickBooks before paying them.');
  }
  if (picked.candidates > 1) {
    notes.push(`${picked.candidates} email addresses were on file; QuickBooks took ${picked.email || 'none — none of them parsed'}.`);
  }

  return json({
    ok: true,
    outcome: pushed.outcome,          // created | linked_existing | already_linked
    qbo_vendor_id: pushed.qboVendorId,
    display_name: pushed.name,
    notes,
  });
}

export default handle;
