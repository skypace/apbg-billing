// bill-paid-sync — ask QuickBooks which posted bills have actually been paid.
//
// Brixpense stamps paid_at when WE pay (vendor-pay, the Stripe webhook). Every
// other way a bill gets paid — a cheque written in QuickBooks, a Bill Pay run,
// the bookkeeper's card — is invisible here, so the bill sits in
// ops.v_ap_aging forever and keeps offering a Pay button for money that has
// already gone out. This closes the loop from the QuickBooks side.
//
// Scope is deliberately narrow: posted, unpaid, un-archived bills only. That
// is 49 rows today, so a run is two batched QBO queries, not a crawl.
//
// This is the MANUAL entry point — the "Check QuickBooks" button on the aging
// strip. The daily schedule lives in bill-paid-sync-cron.mjs; both call the
// same runBillPaidSync(), so a schedule is a schedule and not a second
// implementation. (Netlify may 403 direct HTTP to a scheduled function, which
// is why the two are separate files — same split as health-watchdog.)
//
// Read-only against QuickBooks: it cannot create anything and cannot pay
// anything, so handing the button to the AP desk is safe.

import { requireAuth } from './lib/auth.mjs';
import { runBillPaidSync } from './lib/qbo-bill-status.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return json({ error: auth.error || 'Not authorised' }, auth.status || 401);

  const out = await runBillPaidSync();
  return json({ ok: out.errors.length === 0, ...out });
};

export const config = { path: '/api/bill-paid-sync' };
