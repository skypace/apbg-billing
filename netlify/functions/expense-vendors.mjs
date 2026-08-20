// /api/expense-vendors — QBO Vendor actions for the Brixpense Vendors module.
//
// The Vendors pages CRUD ops.vendors directly via PostgREST under staff-only
// RLS; this function exists ONLY for the parts that must touch QuickBooks:
//
//   POST { action: 'qbo_search', term }
//     → { vendors: [{ id, name, company, email }] }   live QBO Vendor search
//   POST { action: 'qbo_create', display_name, company_name?, email?, phone? }
//     → { vendor: { id, name, company }, existed?: true }
//       Creates the QBO Vendor (payload shape shared with create-vendor.mjs).
//       A duplicate-name rejection (QBO fault 6240) resolves to the EXISTING
//       vendor instead of erroring — same lesson as melt's qbo-item-loader.
//       On success the ops.qbo_vendors mirror row is upserted (same conflict
//       key as push-qbo-item:vendors, which stays the mirror's primary writer)
//       so the new vendor is pickable immediately instead of after the nightly
//       sync. Registered in architecture/sync-manifest.json as
//       brixpense-vendors:app-and-fn.
//
// Gate: superadmin OR admin (the Vendors module's audience).

import { requireAuth } from './lib/auth.mjs';
import { qboQuery, qboRequest } from './qbo-helpers.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: CORS });
}

const esc = (s) => String(s).replace(/'/g, "\\'");

function vendorShape(v) {
  return {
    id: String(v.Id),
    name: v.DisplayName,
    company: v.CompanyName || null,
    email: v.PrimaryEmailAddr?.Address || null,
    phone: v.PrimaryPhone?.FreeFormNumber || null,
  };
}

// Best-effort mirror heal — a failed upsert must never sink the QBO create
// (the nightly push-qbo-item syncVendors run re-lands the row anyway).
async function healMirror(v) {
  try {
    const sbUrl = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) return;
    await fetch(`${sbUrl}/rest/v1/qbo_vendors?on_conflict=qbo_vendor_id`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'ops',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        qbo_vendor_id: String(v.Id),
        display_name: v.DisplayName,
        company_name: v.CompanyName || null,
        active: v.Active !== false,
        email: v.PrimaryEmailAddr?.Address || null,
        phone: v.PrimaryPhone?.FreeFormNumber || null,
        synced_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn('[expense-vendors] mirror heal failed:', e.message);
  }
}

async function findByExactName(name) {
  const r = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName = '${esc(name)}'`);
  const v = r?.QueryResponse?.Vendor || [];
  return v[0] || null;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body?.action === 'qbo_search') {
    const term = (body.term || '').trim();
    if (term.length < 2) return json({ error: 'term must be at least 2 characters' }, 400);
    try {
      const r = await qboQuery(
        `SELECT Id, DisplayName, CompanyName, PrimaryEmailAddr, PrimaryPhone FROM Vendor ` +
        `WHERE Active = true AND DisplayName LIKE '%${esc(term)}%' ORDERBY DisplayName MAXRESULTS 25`,
      );
      const vendors = (r?.QueryResponse?.Vendor || []).map(vendorShape);
      return json({ vendors });
    } catch (e) {
      return json({ error: `QBO vendor search failed: ${e.message?.slice(0, 300) || e}` }, 502);
    }
  }

  if (body?.action === 'qbo_create') {
    const displayName = (body.display_name || '').trim();
    if (!displayName) return json({ error: 'display_name is required' }, 400);

    const payload = { DisplayName: displayName };
    if (body.company_name?.trim()) payload.CompanyName = body.company_name.trim();
    if (body.email?.trim()) payload.PrimaryEmailAddr = { Address: body.email.trim() };
    if (body.phone?.trim()) payload.PrimaryPhone = { FreeFormNumber: body.phone.trim() };

    try {
      const res = await qboRequest('POST', '/vendor', payload);
      const v = res?.Vendor;
      if (!v?.Id) return json({ error: 'QBO did not return a Vendor id' }, 502);
      await healMirror(v);
      return json({ vendor: vendorShape(v) });
    } catch (e) {
      const msg = e.message || String(e);
      // 6240 = Duplicate Name Exists — the vendor is already in QBO; link to it.
      if (msg.includes('6240') || /Duplicate Name Exists/i.test(msg)) {
        try {
          const existing = await findByExactName(displayName);
          if (existing?.Id) {
            await healMirror(existing);
            return json({ vendor: vendorShape(existing), existed: true });
          }
        } catch { /* fall through to the error below */ }
      }
      return json({ error: `QBO create vendor failed: ${msg.slice(0, 300)}` }, 502);
    }
  }

  return json({ error: 'Unknown action — expected qbo_search or qbo_create' }, 400);
}

// Reachable only at this path (see netlify.toml /expense/api/* rewrite).
export const config = { path: '/api/expense-vendors' };
