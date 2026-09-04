// /api/qbo-purchasing-sync — pull QuickBooks purchasing into Refractor.
//
// Every 15 minutes (pg_cron 'qbo-purchasing-sync' at :10/:25/:40/:55, knocking
// with the shared cron secret) and on demand from the Sync now button in
// Refractor (staff bearer). Same body either way — see lib/qbo-purchasing-sync.
//
//   POST {}                 → CDC since the last successful run: PurchaseOrders
//                             → ops.purchase_orders (origin 'qbo' or refreshed
//                             native rows), Bills/VendorCredits →
//                             ops.qbo_expense_lines, then every Inventory item's
//                             QtyOnHand → ops.qbo_items, then the purchase feed.
//   POST { po: <qbo id> }   → re-read ONE PurchaseOrder (the Reload button).
//
// First run ever = a full pull (open POs + bills since the feed's apply_from),
// because CDC needs a "since". A run that exceeds its budget stops cleanly and
// logs what it managed; the next tick picks up from the last SUCCESS, so
// nothing is skipped — only deferred.
//
// Auth: cron secret header (x-sf-autopost-secret, the same one every other
// Netlify-hosted cron on this site accepts) OR superadmin/admin bearer.

import { requireAuth } from './lib/auth.mjs';
import { runPurchasingSync } from './lib/qbo-purchasing-sync.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-sf-autopost-secret',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

function cronSecretOk(req) {
  const given = req.headers.get('x-sf-autopost-secret') || '';
  if (!given) return false;
  const want = process.env.SF_AUTOPOST_CRON_SECRET || '';
  const fallback = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32);
  return (!!want && given === want) || (!!fallback && given === fallback);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'POST' }, 405);

  let trigger = 'cron';
  if (!cronSecretOk(req)) {
    const auth = await requireAuth(req, ['superadmin', 'admin']);
    if (!auth.ok) return auth.response;
    trigger = auth.user?.email || 'staff';
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on this site' }, 500);

  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
  const url = new URL(req.url);
  const singlePo = String(body.po || url.searchParams.get('po') || '').trim() || null;

  const result = await runPurchasingSync({ trigger, budgetMs: 20_000, singlePo });
  return json(result, result.ok ? 200 : 502);
}
