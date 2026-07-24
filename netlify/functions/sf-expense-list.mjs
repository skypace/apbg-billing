// sf-expense-list.mjs — SYNCHRONOUS read-only backlog view for the SF-expense →
// QBO auto-post pipeline. Returns JSON (a background function can't — it 202s
// with no body). Lists every unposted Service Fusion expense draft with its job
// number, what it was for, SF "purchased_from" vendor, amount, and whether that
// vendor already resolves in QuickBooks (READY_TO_POST / VENDOR_NOT_IN_QBO /
// NO_VENDOR_IN_SF). No writes, no emails. Superadmin Bearer or the one-off
// x-list-secret (SF_AUTOPOST_LIST_SECRET).

import { requireAuth } from './lib/auth.mjs';
import { findQBOVendor } from './lib/qbo-vendor-match.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const LOOKBACK_DAYS = Number(process.env.SF_AUTOPOST_LOOKBACK_DAYS || 90);

function srHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ops' };
}

export default async function handler(req) {
  const listSecret = req.headers.get('x-list-secret') || '';
  const listSecretOk = listSecret && process.env.SF_AUTOPOST_LIST_SECRET && listSecret === process.env.SF_AUTOPOST_LIST_SECRET;
  if (!listSecretOk) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const sel = 'id,vendor_name,total_amount,line_items,customer_name,job_number,memo,created_at';
    const res = await fetch(`${SUPABASE_URL}/rest/v1/expense_requests?tag=eq.Service%20Fusion&request_type=eq.expense&status=eq.draft&qbo_bill_id=is.null&archived_at=is.null&created_at=gte.${since}&order=created_at.asc&limit=200&select=${sel}`, { headers: srHeaders() });
    if (!res.ok) throw new Error(`ops read failed (${res.status})`);
    const rows = await res.json();
    const items = [];
    for (const r of rows) {
      const what = (Array.isArray(r.line_items) && r.line_items[0] && r.line_items[0].description) || r.memo || null;
      const v = r.vendor_name && String(r.vendor_name).trim() ? await findQBOVendor(r.vendor_name) : null;
      items.push({
        brixpense_id: r.id,
        created: (r.created_at || '').slice(0, 10),
        job_number: r.job_number,
        customer: r.customer_name,
        what_for: what,
        sf_vendor: r.vendor_name || null,
        amount: Number(r.total_amount) || 0,
        qbo_vendor: v ? `${v.DisplayName} (id ${v.Id})` : null,
        status: !r.vendor_name ? 'NO_VENDOR_IN_SF' : (v ? 'READY_TO_POST' : 'VENDOR_NOT_IN_QBO'),
      });
    }
    const sum = (s) => items.filter((i) => i.status === s).length;
    return new Response(JSON.stringify({
      ok: true, count: items.length,
      summary: { ready_to_post: sum('READY_TO_POST'), vendor_not_in_qbo: sum('VENDOR_NOT_IN_QBO'), no_vendor_in_sf: sum('NO_VENDOR_IN_SF') },
      items,
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export const config = { path: '/api/sf-expense-list' };
