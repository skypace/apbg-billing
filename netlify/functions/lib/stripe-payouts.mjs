// stripe-payouts.mjs — thin client for Stripe Global Payouts (Vendor Portal
// Phase 3). Rail decided by Sky 2026-08-20: pay vendors from the existing
// Alameda Point Beverage Group Stripe account (financial account activated
// 2026-07-11, verified live this session).
//
// Global Payouts is Stripe's API v2 (public preview): JSON bodies, bearer
// auth, and a pinned `Stripe-Version` preview header. Live requests require a
// RESTRICTED key with Recipient Configuration / Payout Methods / Outbound
// Payments write permissions — env `STRIPE_PAYOUTS_KEY` (falls back to
// `STRIPE_SECRET_KEY`). Until the key lands on Netlify, every call fails
// with a clear "not configured" error — the rail ships dark by design.
//
// Privacy invariant: the vendor's BANK DETAILS are collected by Stripe's
// hosted onboarding form (AccountLink) — this codebase never sees them. The
// only Stripe datum we persist is the recipient Account id (acct_…).

const STRIPE_API = 'https://api.stripe.com';
const STRIPE_VERSION = process.env.STRIPE_V2_VERSION || '2026-07-29.preview';

function payoutsKey() {
  return process.env.STRIPE_PAYOUTS_KEY || process.env.STRIPE_SECRET_KEY || '';
}

export function stripeConfigured() {
  return Boolean(payoutsKey());
}

/** Raw v2 call. `context` sets Stripe-Context (required for recipient-scoped
 *  reads like payout methods). Throws with Stripe's own error text. */
export async function stripeV2(method, path, body, context) {
  const key = payoutsKey();
  if (!key) throw new Error('Stripe payouts are not configured — set STRIPE_PAYOUTS_KEY (a restricted key with Global Payouts write permissions) on this Netlify site.');
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_VERSION,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(context ? { 'Stripe-Context': context } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text for the error */ }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 300);
    throw new Error(`Stripe ${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

/** The account's open USD financial account (source of every payout).
 *  Discovered at call time — no env pin, no drift. */
export async function getFinancialAccount() {
  const res = await stripeV2('GET', '/v2/money_management/financial_accounts');
  const fa = (res?.data || []).find((f) => f.status === 'open' && f.balance?.available?.usd);
  if (!fa) throw new Error('No open USD financial account on the Stripe account — activate Global Payouts (Dashboard → Balances → Financial accounts).');
  return {
    id: fa.id,
    availableCents: fa.balance.available.usd.value ?? 0,
  };
}

/** Create (or reuse) the v2 recipient Account for a vendor. Returns the id. */
export async function createRecipient({ displayName, contactEmail }) {
  const res = await stripeV2('POST', '/v2/core/accounts', {
    display_name: displayName,
    contact_email: contactEmail,
    identity: { country: 'us', entity_type: 'company' },
    configuration: {
      recipient: {
        capabilities: { bank_accounts: { local: { requested: true } } },
      },
    },
    include: ['identity', 'configuration.recipient', 'requirements'],
  });
  if (!res?.id) throw new Error('Stripe did not return a recipient account id');
  return res.id;
}

/** Stripe-hosted onboarding link where the VENDOR enters their bank details
 *  with Stripe directly. Single-use, ~10-minute expiry — mint fresh per send. */
export async function createOnboardingLink({ recipientId, returnUrl, refreshUrl }) {
  const res = await stripeV2('POST', '/v2/core/account_links', {
    account: recipientId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        return_url: returnUrl,
        refresh_url: refreshUrl,
      },
    },
  });
  if (!res?.url) throw new Error('Stripe did not return an onboarding link');
  return res.url;
}

/** Is the recipient ready to be paid? Capability active + a payout method
 *  attached (both required per the Global Payouts docs). */
export async function recipientStatus(recipientId) {
  const acct = await stripeV2('GET',
    `/v2/core/accounts/${recipientId}?include=configuration.recipient&include=requirements`);
  const cap = acct?.configuration?.recipient?.capabilities?.bank_accounts?.local;
  const capabilityActive = cap?.status === 'active';
  let methods = [];
  try {
    const pm = await stripeV2('GET', '/v2/money_management/payout_methods', undefined, recipientId);
    methods = pm?.data || [];
  } catch { /* recipient with nothing attached yet — treat as no methods */ }
  const defaultDestination = acct?.configuration?.recipient?.default_outbound_destination?.id
    || acct?.configuration?.recipient?.default_outbound_destination
    || methods[0]?.id
    || null;
  return {
    ready: capabilityActive && methods.length > 0,
    capability_status: cap?.status || 'not_requested',
    payout_methods: methods.length,
    payout_method_id: defaultDestination,
  };
}

/** Send the money. Amount in CENTS. Returns { id, status }. */
export async function createOutboundPayment({ financialAccountId, recipientId, payoutMethodId, amountCents, description }) {
  const body = {
    from: { financial_account: financialAccountId, currency: 'usd' },
    to: { recipient: recipientId, ...(payoutMethodId ? { payout_method: payoutMethodId } : {}) },
    amount: { value: amountCents, currency: 'usd' },
    ...(description ? { description: String(description).slice(0, 100) } : {}),
  };
  const res = await stripeV2('POST', '/v2/money_management/outbound_payments', body);
  if (!res?.id) throw new Error('Stripe did not return an outbound payment id');
  return { id: res.id, status: res.status || 'processing' };
}
