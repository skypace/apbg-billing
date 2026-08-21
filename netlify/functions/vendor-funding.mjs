// /api/vendor-funding — the Stripe vendor-funding float (SUPERADMIN ONLY).
//
// The float sits in Stripe; QuickBooks mirrors it as the "Stripe Vendor
// Funding" bank account. This endpoint is the only place in the app that pulls
// money INTO Stripe, and the place that writes the QBO Transfer for funding
// that arrives any other way (Sky clicking Top up in the Stripe Dashboard, or
// a pushed ACH/wire). See lib/vendor-funding-lib.mjs for the model.
//
// POST { action, ... }:
//   status      → live balance, config, recent funding events, today's pulls,
//                 unbooked count. What the Brixpense funding card renders.
//   top_up      { amount } → cap checks → ledger row FIRST → InboundTransfer →
//                 stamp the Stripe id. Settles in 2–6 business days; `sync`
//                 books the QBO Transfer once it lands.
//   sync        → reconcile Stripe → ledger → QuickBooks. Idempotent on
//                 stripe_object_id, so replays and overlapping runs are safe.
//   save_config { floor, target, auto_top_up, max_per_day }
//
// Money movement is never automatic here: `top_up` is a human click and
// auto_top_up ships false (the cron reads it, this endpoint sets it).

import { requireAuth } from './lib/auth.mjs';
import {
  readConfig, writeConfig, getFinancialAccount, syncFunding,
  createInboundTransfer, insertEvent, patchEvent,
  recentEvents, pulledToday,
  fundingBankAccountId, STRIPE_PULL_MAX_PER_TXN, SETTLEMENT_DAYS,
} from './lib/vendor-funding-lib.mjs';
import { stripeConfigured } from './lib/stripe-payouts.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

async function handleStatus() {
  const config = await readConfig();
  const configured = stripeConfigured();
  const out = {
    configured,
    bank_configured: Boolean(fundingBankAccountId()),
    qbo_account_configured: Boolean(process.env.QBO_VENDOR_PAY_BANK_ACCOUNT_ID),
    config,
    settlement_days: SETTLEMENT_DAYS,
    max_per_txn: STRIPE_PULL_MAX_PER_TXN,
    pulled_today: await pulledToday(),
    events: (await recentEvents(20)) || [],
  };
  out.unbooked = out.events.filter((e) => e.status === 'settled' && !e.qbo_transfer_id).length;
  if (configured) {
    try {
      const fa = await getFinancialAccount();
      out.balance = Math.round(fa.availableCents) / 100;
      out.below_floor = out.balance < config.floor;
      out.financial_account = fa.id;
    } catch (e) {
      out.balance_error = e.message;
    }
  }
  return json(out);
}

async function handleTopUp(amountRaw, actorEmail) {
  const amount = Number(amountRaw);
  if (!(amount > 0)) return json({ error: 'A positive amount is required.' }, 400);
  if (amount > STRIPE_PULL_MAX_PER_TXN) {
    return json({ error: `Stripe caps a single pull at $${STRIPE_PULL_MAX_PER_TXN.toLocaleString()}.` }, 400);
  }
  const config = await readConfig();
  const already = await pulledToday();
  if (already + amount > config.max_per_day) {
    return json({
      error: `That would pull $${(already + amount).toLocaleString()} today, over the $${config.max_per_day.toLocaleString()} daily cap`
        + (already > 0 ? ` ($${already.toLocaleString()} already pulled).` : '.')
        + ' Raise the cap in the funding settings if that is deliberate.',
    }, 409);
  }

  // Ledger row first: the unique index on stripe_object_id can't guard a
  // transfer that doesn't exist yet, so the row is what proves we tried.
  const pending = await insertEvent({
    stripe_object_id: `pending:${Date.now()}:${Math.round(amount * 100)}`,
    kind: 'inbound_transfer',
    source: 'app',
    amount,
    status: 'pending',
    initiated_by: actorEmail,
  });

  try {
    const transfer = await createInboundTransfer({
      amount,
      description: 'Brix Beverage vendor payouts funding',
    });
    await patchEvent(pending.id, {
      stripe_object_id: transfer.id,
      status: transfer.status,
      stripe_created_at: new Date().toISOString(),
    });
    return json({
      ok: true, event_id: pending.id, stripe_object_id: transfer.id, status: transfer.status,
      note: `Pulling $${amount.toLocaleString()} from the linked bank account. Stripe settles it in ${SETTLEMENT_DAYS}; the QuickBooks transfer books itself once it lands.`,
    });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 400);
    await patchEvent(pending.id, { status: 'failed', failure_reason: msg });
    return json({ error: `Stripe refused the transfer: ${msg}` }, 502);
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Superadmin only — same gate as vendor-pay. This endpoint moves company money.
  const auth = await requireAuth(req, ['superadmin']);
  if (!auth.ok) return auth.response;
  const actorEmail = auth.user?.email || 'superadmin';

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  try {
    if (body.action === 'status') return await handleStatus();
    if (body.action === 'top_up') {
      if (!stripeConfigured()) return json({ error: 'Stripe payouts are not configured on this site yet (STRIPE_PAYOUTS_KEY).' }, 501);
      return await handleTopUp(body.amount, actorEmail);
    }
    if (body.action === 'sync') {
      if (!stripeConfigured()) return json({ error: 'Stripe payouts are not configured on this site yet (STRIPE_PAYOUTS_KEY).' }, 501);
      const result = await syncFunding({ actor: actorEmail });
      return json({ ok: result.errors.length === 0, ...result });
    }
    if (body.action === 'save_config') {
      const next = await writeConfig(body);
      console.log(`[vendor-funding] config saved by ${actorEmail}: ${JSON.stringify(next)}`);
      return json({ ok: true, config: next });
    }
  } catch (e) {
    console.error('[vendor-funding]', body.action, 'failed:', e.message);
    return json({ error: String(e.message || e).slice(0, 400) }, 502);
  }
  return json({ error: 'Unknown action — expected status, top_up, sync, or save_config' }, 400);
}

export const config = { path: '/api/vendor-funding' };
