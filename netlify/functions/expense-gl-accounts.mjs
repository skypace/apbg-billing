// /api/expense-gl-accounts — list QBO General-Ledger accounts that a Brixpense
// expense line can post against: Cost of Goods Sold, Expense, Other Expense,
// and Fixed Asset.
//
// Used by Settings → Organization → "COGS / Expense accounts" so an admin can
// build the shared `ops.expense_settings.cogs_accounts` list by checking boxes
// against the live chart of accounts, instead of hand-typing id + label.
//
// Read-only, Bearer-gated (any authenticated user). The actual write of the
// curated list goes through the role-gated ops.fn_set_expense_setting RPC.

import { qboQuery } from './qbo-helpers.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// QBO AccountType values an expense line can legitimately hit.
const TYPES = ['Cost of Goods Sold', 'Expense', 'Other Expense', 'Fixed Asset'];

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: CORS });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized — Bearer token required' }, 401);
  }

  try {
    const inList = TYPES.map((t) => `'${t}'`).join(',');
    const accounts = [];
    // Page through in case the chart of accounts exceeds one QBO page (1000).
    for (let start = 1; ; start += 1000) {
      const result = await qboQuery(
        `SELECT Id, Name, FullyQualifiedName, AccountType, AccountSubType, Active ` +
          `FROM Account ` +
          `WHERE Active = true AND AccountType IN (${inList}) ` +
          `ORDER BY AccountType, Name STARTPOSITION ${start} MAXRESULTS 1000`
      );
      const page = result?.QueryResponse?.Account || [];
      for (const a of page) {
        accounts.push({
          id: String(a.Id),
          name: a.FullyQualifiedName || a.Name,
          account_type: a.AccountType,
          account_sub_type: a.AccountSubType || null,
        });
      }
      if (page.length < 1000) break;
    }
    return json({ accounts });
  } catch (e) {
    return json({ error: `QBO account query failed: ${e.message?.substring(0, 300) || e}` }, 502);
  }
}

// config.path is required: with it set, the function is reachable ONLY here
// (not at /.netlify/functions/<name>). The Brixpense SPA hits /expense/api/<name>,
// which netlify.toml rewrites to /api/<name>.
export const config = { path: '/api/expense-gl-accounts' };
