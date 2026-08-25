// Daily schedule for the QuickBooks paid-bill check. Thin on purpose — the
// work lives in lib/qbo-bill-status.mjs so this and the manual endpoint cannot
// drift.
//
// A bill's paid state is not urgent: the aging strip's "Check QuickBooks"
// button covers the moment somebody actually wants to know, and the watcher
// (ops.fn_bill_paid_sync_health) goes red if this stops running for 48h.

import { runBillPaidSync } from './lib/qbo-bill-status.mjs';

export default async () => {
  const out = await runBillPaidSync();
  console.log('[bill-paid-sync-cron]', JSON.stringify(out));
  return new Response(JSON.stringify(out), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '40 11 * * *' };
