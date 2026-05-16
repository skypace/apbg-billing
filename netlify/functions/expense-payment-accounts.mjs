// /api/expense-payment-accounts — list QBO Bank + Credit Card accounts so the
// Brixpense expense form can show a "Paid with" dropdown. Receipt expenses
// post as QBO Purchases (not Bills) and need an AccountRef for the account
// the expense was paid FROM. No vendor required.

import { qboQuery } from './qbo-helpers.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: CORS });
}

// PaymentType on a QBO Purchase is one of {Cash, Check, CreditCard}. Map from
// the account's AccountType so the operator doesn't have to think about it.
function paymentTypeFor(account) {
  const t = String(account?.AccountType || '').toLowerCase();
  if (t === 'credit card') return 'CreditCard';
  if (t === 'bank') return 'Check';
  return 'Cash';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  // Bearer-only auth — matches the sibling Brixpense submitter endpoints
  // (expense-ocr / expense-request-notify / expense-request-decide /
  // expense-request-link-bill). Any logged-in @brixbev.com user needs the
  // dropdown to file a receipt; gating on role='superadmin' (the
  // requireAuth default) would lock out every employee. JWT validity is
  // verified by Supabase RLS on any expense_requests insert downstream.
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized — Bearer token required' }, 401);
  }

  try {
    // Pull Bank + Credit Card accounts in one shot — only ~10 rows total
    // for APBG so a single query is fine. We deliberately don't SELECT
    // CurrentBalance: the only consumer is a form dropdown that renders
    // "name (type)" and never reads balance, so excluding it tightens
    // blast radius for any future auth regression.
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
      payment_type: paymentTypeFor(a),
    }));
    return json({ accounts });
  } catch (e) {
    console.error('expense-payment-accounts: QBO query failed', e);
    return json({ error: e?.message || 'QBO query failed' }, 502);
  }
}

export const config = { path: '/api/expense-payment-accounts' };
