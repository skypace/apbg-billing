// vendor-funding-cron — daily watch on the Stripe vendor-funding float.
//
// Two jobs, in this order:
//   1. Reconcile. Pull Stripe's funding events into ops.vendor_funding_events
//      and write the QBO Transfer for anything settled that QuickBooks hasn't
//      been told about — including top-ups Sky made by hand in the Stripe
//      Dashboard. This is what keeps the "Stripe Vendor Funding" account's QBO
//      balance equal to the live Stripe balance.
//   2. Watch the floor. Below it, either EMAIL (default) or, when
//      `auto_top_up` is switched on, pull up to the target — capped by
//      max_per_day and Stripe's own $50k/transaction limit.
//
// auto_top_up ships FALSE. A pull takes 2–6 business days to settle, so this is
// a float you keep topped up, not just-in-time funding: the alert is usually
// the right answer and the automation is opt-in.
//
// Every run logs ops.sync_log (source 'vendors', sync_type 'vendor_funding')
// carrying the observed balance and a below_floor flag — that row is what
// ops.fn_vendor_funding_health() reads, since Postgres can't see Stripe.
//
// Auth: a superadmin JWT, or ?secret= matching VENDOR_FUNDING_CRON_SECRET.
// Netlify may 403 direct HTTP to a scheduled function, so don't rely on this
// for a manual run — /api/vendor-funding with { action: 'sync' } does the same
// reconcile behind the superadmin gate, and the funding card shows the floor
// state live. This gate exists so a hand-invoke isn't open if it does work.

import { requireAuth } from './lib/auth.mjs';
import { sendEmail, SITE_URL } from './email-helpers.mjs';
import {
  ops, readConfig, getFinancialAccount, syncFunding, createInboundTransfer,
  insertEvent, patchEvent, pulledToday, STRIPE_PULL_MAX_PER_TXN, SETTLEMENT_DAYS,
} from './lib/vendor-funding-lib.mjs';
import { stripeConfigured } from './lib/stripe-payouts.mjs';

const ALERT_TO = process.env.VENDOR_FUNDING_ALERT_TO || process.env.REPORT_TO
  || process.env.COMPLIANCE_ALERT_TO || 'service@brixbev.com';
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function alertHtml({ balance, config, action, detail, sync }) {
  return `<div style="font-family:'DM Sans',-apple-system,sans-serif;max-width:620px;margin:0 auto">
    <div style="background:#B45309;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#FDE68A;font-weight:700">Brixpense · Vendor payments</div>
      <div style="font-size:20px;font-weight:800;margin-top:4px">Stripe vendor funding is low</div>
    </div>
    <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px;font-size:14px;color:#0F172A;line-height:1.6">
      <p style="margin:0 0 12px">Payout balance is <b>${money(balance)}</b>, below the ${money(config.floor)} floor. Vendor payments larger than the balance will refuse until it's topped up.</p>
      <p style="margin:0 0 12px"><b>${action}</b>${detail ? ` — ${detail}` : ''}</p>
      <p style="margin:0 0 14px;color:#475569">A bank pull settles in ${SETTLEMENT_DAYS}, so top up ahead of the bills you know are coming.</p>
      <p style="margin:0 0 14px"><a href="${SITE_URL}/expense/vendors" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Open vendor funding →</a></p>
      <p style="margin:0;color:#64748B;font-size:12px">Reconcile: ${sync.inserted} new funding event(s), ${sync.booked} booked to QuickBooks${sync.errors.length ? `, ${sync.errors.length} error(s)` : ''}.</p>
    </div></div>`;
}

async function run(actor) {
  const out = { synced: null, balance: null, below_floor: false, action: 'none', errors: [] };
  const config = await readConfig();
  out.config = config;

  out.synced = await syncFunding({ actor });
  out.errors.push(...out.synced.errors);

  let balance = null;
  try {
    const fa = await getFinancialAccount();
    balance = Math.round(fa.availableCents) / 100;
  } catch (e) {
    out.errors.push(`balance read failed: ${String(e.message || e).slice(0, 160)}`);
  }
  out.balance = balance;

  if (balance !== null && balance < config.floor) {
    out.below_floor = true;
    let action = 'Top up in Stripe (Treasury → Add funds) or from the Brixpense funding card.';
    let detail = '';

    if (config.auto_top_up) {
      const want = Math.max(0, config.target - balance);
      const already = await pulledToday();
      const room = Math.min(config.max_per_day - already, STRIPE_PULL_MAX_PER_TXN);
      const amount = Math.min(want, room);
      if (amount <= 0) {
        action = 'Auto top-up is ON but blocked by the daily cap.';
        detail = `wanted ${money(want)}, ${money(already)} already pulled today against a ${money(config.max_per_day)} cap`;
      } else {
        const pending = await insertEvent({
          stripe_object_id: `pending:${Date.now()}:${Math.round(amount * 100)}`,
          kind: 'inbound_transfer', source: 'app', amount, status: 'pending',
          initiated_by: 'cron (auto top-up)',
        });
        try {
          const transfer = await createInboundTransfer({ amount, description: 'Brix Beverage vendor payouts auto top-up' });
          await patchEvent(pending.id, {
            stripe_object_id: transfer.id, status: transfer.status,
            stripe_created_at: new Date().toISOString(),
          });
          out.action = 'auto_top_up';
          action = `Auto top-up sent: pulling ${money(amount)} from the linked bank account.`;
          detail = `settles in ${SETTLEMENT_DAYS}${amount < want ? ` — capped from ${money(want)}` : ''}`;
        } catch (e) {
          const msg = String(e.message || e).slice(0, 400);
          await patchEvent(pending.id, { status: 'failed', failure_reason: msg });
          out.errors.push(`auto top-up failed: ${msg.slice(0, 160)}`);
          action = 'Auto top-up FAILED — top up by hand.';
          detail = msg.slice(0, 180);
        }
      }
    }

    if (out.action !== 'auto_top_up') out.action = 'alerted';
    try {
      await sendEmail({
        to: ALERT_TO,
        subject: `Stripe vendor funding at ${money(balance)} (floor ${money(config.floor)})`,
        html: alertHtml({ balance, config, action, detail, sync: out.synced }),
        text: `Stripe vendor payout balance ${money(balance)} is below the ${money(config.floor)} floor. ${action} ${detail}\nA bank pull settles in ${SETTLEMENT_DAYS}.\n${SITE_URL}/expense/vendors`,
      });
    } catch (e) {
      out.errors.push(`alert email failed: ${String(e.message || e).slice(0, 160)}`);
    }
  }

  // The health check reads this row — balance and below_floor included, since
  // Postgres has no way to ask Stripe.
  try {
    await ops('POST', 'sync_log', {
      source: 'vendors',
      sync_type: 'vendor_funding',
      status: out.errors.length > 0 ? 'error' : 'success',
      error_message: out.errors.length ? out.errors.join(' | ').slice(0, 400) : null,
      metadata: {
        balance: balance === null ? null : balance.toFixed(2),
        below_floor: out.below_floor,
        floor: config.floor,
        target: config.target,
        auto_top_up: config.auto_top_up,
        action: out.action,
        ...out.synced,
      },
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[vendor-funding-cron] could not log the run:', e.message);
  }
  return out;
}

export default async function handler(req) {
  const secret = new URL(req.url).searchParams.get('secret');
  const viaSecret = Boolean(process.env.VENDOR_FUNDING_CRON_SECRET)
    && secret === process.env.VENDOR_FUNDING_CRON_SECRET;
  if (!viaSecret) {
    const auth = await requireAuth(req, ['superadmin']);
    if (!auth.ok) return auth.response;
  }

  if (!stripeConfigured()) {
    // Ships dark: no key, nothing to reconcile, and no red light for it.
    return new Response(JSON.stringify({ skipped: 'Stripe payouts are not configured (STRIPE_PAYOUTS_KEY)' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const out = await run(viaSecret ? 'cron' : 'superadmin');
    return new Response(JSON.stringify({ ok: out.errors.length === 0, ...out }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[vendor-funding-cron] failed:', e.message);
    try {
      await ops('POST', 'sync_log', {
        source: 'vendors', sync_type: 'vendor_funding', status: 'error',
        error_message: String(e.message || e).slice(0, 400),
        completed_at: new Date().toISOString(),
      });
    } catch { /* the >48h yellow rule catches a run that could not even log */ }
    return new Response(JSON.stringify({ error: String(e.message || e).slice(0, 300) }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const config = {
  schedule: '20 16 * * *',
};
