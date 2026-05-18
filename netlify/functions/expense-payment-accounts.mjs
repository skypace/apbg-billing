// /api/expense-payment-accounts — list payment options for the Brixpense
// "Paid with" dropdown.
//
// Each user gets a *curated* list scoped to their email via the
// `ops.expense_settings.payment_accounts_by_user` JSONB (set from the Brixpense
// Settings page). When a user has no curated list, we fall back to the live
// QBO query of all Bank + Credit Card accounts so new users aren't blocked.
//
// A synthetic "Not paid — create bill" option is always appended. When the
// submitter picks it, ExpenseForm sets `as_bill=true` on the request and
// expense-request-notify routes the QBO post to a Bill (unpaid AP) instead
// of a Purchase (paid).

import { createClient } from '@supabase/supabase-js';
import { qboQuery } from './qbo-helpers.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const BILL_OPTION = {
  id: '__bill__',
  name: 'Not paid — create bill',
  account_type: 'Bill',
  account_sub_type: null,
  payment_type: 'Bill',
};

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: CORS });
}

// PaymentType on a QBO Purchase is one of {Cash, Check, CreditCard}. Map from
// the account's AccountType so the operator doesn't have to think about it.
function paymentTypeFor(accountType) {
  const t = String(accountType || '').toLowerCase();
  if (t === 'credit card') return 'CreditCard';
  if (t === 'bank') return 'Check';
  return 'Cash';
}

// Pulls the submitter's email from the Bearer token without making the full
// supabase.auth.getUser() round trip. We just need the email to key into
// payment_accounts_by_user. Falls back to null when the JWT shape is
// unexpected — the function gracefully degrades to the full QBO list.
function emailFromJwt(authHeader) {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'),
    );
    return (decoded?.email || decoded?.user_metadata?.email || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

async function curatedListFor(email) {
  if (!email || !SB_URL || !(SB_SERVICE_KEY || SB_ANON_KEY)) return null;
  const sb = createClient(SB_URL, SB_SERVICE_KEY || SB_ANON_KEY, { db: { schema: 'ops' } });
  const { data, error } = await sb
    .from('expense_settings')
    .select('value')
    .eq('key', 'payment_accounts_by_user')
    .maybeSingle();
  if (error || !data?.value || typeof data.value !== 'object') return null;
  const byUser = data.value;
  const list = byUser[email] || byUser[email.toLowerCase()];
  if (!Array.isArray(list) || list.length === 0) return null;
  // Normalize shape — settings page may write rows without payment_type
  return list.map((a) => ({
    id: String(a.id),
    name: String(a.name ?? ''),
    account_type: a.account_type || 'Bank',
    account_sub_type: a.account_sub_type || null,
    payment_type: a.payment_type || paymentTypeFor(a.account_type),
  }));
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized — Bearer token required' }, 401);
  }

  const email = emailFromJwt(authHeader);
  const url = new URL(req.url);
  // ?all=1 — bypass curation, always return the full live QBO list and skip
  // the synthetic Bill option. The Settings page uses this to render the
  // master checklist when the user is picking which accounts to keep.
  const allMode = url.searchParams.get('all') === '1';

  try {
    if (!allMode) {
      // Curated list first — most users will have one once they've set it up.
      const curated = await curatedListFor(email);
      if (curated && curated.length > 0) {
        return json({ accounts: [...curated, BILL_OPTION], source: 'curated', user: email });
      }
    }

    // Live QBO query of every active Bank + Credit Card account.
    const res = await qboQuery(
      `SELECT Id, Name, AccountType, AccountSubType, Active ` +
        `FROM Account ` +
        `WHERE Active = true AND AccountType IN ('Bank','Credit Card') ` +
        `ORDER BY AccountType, Name`
    );
    const rows = res?.QueryResponse?.Account || [];
    const accounts = rows.map((a) => ({
      id: a.Id,
      name: a.Name,
      account_type: a.AccountType,
      account_sub_type: a.AccountSubType,
      payment_type: paymentTypeFor(a.AccountType),
    }));
    return json({
      accounts: allMode ? accounts : [...accounts, BILL_OPTION],
      source: 'qbo',
      user: email,
    });
  } catch (e) {
    console.error('expense-payment-accounts: QBO query failed', e);
    // Still expose the Bill option so the form is usable even if QBO is down.
    return json({ accounts: [BILL_OPTION], source: 'fallback', user: email, error: e?.message }, 502);
  }
}

export const config = { path: '/api/expense-payment-accounts' };
