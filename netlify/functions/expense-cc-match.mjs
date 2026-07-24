// expense-cc-match.mjs — merge the QBO card/expense feed with Brixpense.
//
// Every posted card swipe / cash expense / check in QuickBooks is a Purchase
// transaction. Brixpense (ops.expense_requests) holds the human side of the
// same spend: who bought it, the receipt, the department/COGS tagging. This
// endpoint joins the two so operators can reconcile them from Master Control:
//
//   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD
//     → { linked, suggestions, unmatched_purchases, unmatched_expenses, totals }
//       - linked: purchases already tied to a Brixpense row (qbo_purchase_id)
//       - suggestions: auto-match candidates (same amount ±1¢, dates within
//         14 days; vendor-name similarity breaks ties; greedy 1:1)
//       - unmatched_purchases: card/expense spend with NO Brixpense record
//         (i.e. no receipt/context) — importable
//       - unmatched_expenses: Brixpense expenses that never hit the books as
//         a Purchase (bill-path rows with qbo_bill_id are excluded — a Bill
//         is a different QBO transaction, already linked)
//   POST { action:'link',   purchaseId, expenseId }
//   POST { action:'unlink', expenseId }
//   POST { action:'import', purchaseId }  → creates a Brixpense expense row
//         from the QBO Purchase (status='posted', as_bill=false — it is
//         ALREADY in the books; importing must never double-post to QBO).
//   POST { action:'assign_card',   last4, user_id?, user_email?, user_name?, label? }
//         → upsert ops.expense_card_map (card → cardholder)
//   POST { action:'unassign_card', last4 }
//   POST { action:'list_users' } → auth users (id/email/name/role) for the
//         cardholder dropdown. New users are created in the gateway admin
//         (alamedapointbg.com/admin.html), then assigned here.
//
// Card attribution: bank memos on card Purchases carry the card's last four —
// 'XXXX1029' (Capital One) or a trailing '- 5939'. cardLast4() parses it and
// every purchase row carries card_last4 + the GET response carries card_map,
// so the panel (and the weekly receipt audit) can say WHOSE swipe it is.
//
// Superadmin-gated. Writes ops.expense_requests via the service-role key
// (writer registered under brix-expense:app-and-functions in
// architecture/sync-manifest.json).

import { requireAuth } from './lib/auth.mjs';
import { qboQuery, qboRequest, corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const HEADERS = { 'Content-Type': 'application/json', ...corsHeaders() };
const MATCH_WINDOW_DAYS = 14;
const AMOUNT_TOLERANCE = 0.011;

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function serviceHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function opsGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: serviceHeaders({ 'Accept-Profile': 'ops' }),
  });
  if (!res.ok) throw new Error(`ops read failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function opsWrite(method, pathAndQuery, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: serviceHeaders({
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ops write failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── QBO purchases (dates are the ONLY server-side filter QBO combines reliably) ──

async function fetchPurchases(from, to) {
  const rows = [];
  for (let start = 1; start <= 3001; start += 1000) {
    const q = `SELECT * FROM Purchase WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' STARTPOSITION ${start} MAXRESULTS 1000`;
    const r = await qboQuery(q);
    const page = r?.QueryResponse?.Purchase || [];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows.map((p) => ({
    id: String(p.Id),
    txn_date: p.TxnDate || null,
    amount: p.TotalAmt ?? 0,
    is_credit: Boolean(p.Credit),
    payment_type: p.PaymentType || '',
    account: p.AccountRef?.name || '',
    account_id: p.AccountRef?.value || '',
    payee: p.EntityRef?.name || '',
    memo: p.PrivateNote || '',
    doc_number: p.DocNumber || '',
    card_last4: cardLast4(p.PrivateNote || ''),
    lines: (p.Line || [])
      .filter((l) => l.Amount !== undefined && l.DetailType !== 'TaxLineDetail')
      .map((l) => ({
        amount: l.Amount ?? 0,
        description: l.Description || '',
        account: l.AccountBasedExpenseLineDetail?.AccountRef?.name || l.ItemBasedExpenseLineDetail?.ItemRef?.name || '',
      })),
  }));
}

// ── card attribution ──
// Bank memo formats observed live on the card feeds:
//   Capital One: 'STATE OF CALIF DMV ISACRAMENTO CA XXXX1011'  → XXXX + last4
//   Amex/other:  'SQ *SANTOS REFRIGERATI - 6681'               → trailing '- 1234'
// Masked pattern wins over the trailing pattern (a trailing 4-digit group can
// occasionally be part of a merchant name; masked is unambiguous).
export function cardLast4(memo) {
  if (!memo) return null;
  const masked = /(?:[xX*]{2,})[-. ]?(\d{4})\b/.exec(memo);
  if (masked) return masked[1];
  const trailing = /[-–]\s?(\d{4})\s*$/.exec(memo.trim());
  if (trailing) return trailing[1];
  return null;
}

// ── matching ──

function vendorSimilarity(a, b) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const ta = new Set(norm(a));
  const tb = new Set(norm(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

function daysBetween(a, b) {
  if (!a || !b) return 999;
  return Math.abs(new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000;
}

function buildSuggestions(purchases, expenses) {
  const pairs = [];
  for (const p of purchases) {
    for (const e of expenses) {
      if (Math.abs(p.amount - Number(e.total_amount ?? -1)) > AMOUNT_TOLERANCE) continue;
      const dd = daysBetween(p.txn_date, e.receipt_date);
      if (dd > MATCH_WINDOW_DAYS) continue;
      const sim = vendorSimilarity(p.payee, e.vendor_name);
      pairs.push({ p, e, score: Math.round(100 - dd * 3 + sim * 40), days_apart: Math.round(dd), vendor_similarity: Math.round(sim * 100) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedP = new Set();
  const usedE = new Set();
  const out = [];
  for (const pair of pairs) {
    if (usedP.has(pair.p.id) || usedE.has(pair.e.id)) continue;
    usedP.add(pair.p.id);
    usedE.add(pair.e.id);
    out.push({ purchase: pair.p, expense: expenseSummary(pair.e), score: pair.score, days_apart: pair.days_apart, vendor_similarity: pair.vendor_similarity });
  }
  return { suggestions: out, usedP, usedE };
}

function expenseSummary(e) {
  return {
    id: e.id,
    vendor_name: e.vendor_name,
    total_amount: e.total_amount,
    receipt_date: e.receipt_date,
    status: e.status,
    tag: e.tag,
    submitter_name: e.submitter_name,
    department: e.department,
    description: e.description,
    qbo_purchase_id: e.qbo_purchase_id || null,
  };
}

// ── handler ──

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  const actorEmail = auth.user?.email || 'superadmin';

  try {
    if (event.httpMethod === 'GET') {
      const qp = event.queryStringParameters || {};
      const to = qp.to || new Date().toISOString().slice(0, 10);
      const from = qp.from || new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

      // Widen the Brixpense window: a receipt can predate/postdate the posted txn.
      const eFrom = new Date(new Date(from + 'T00:00:00Z') - MATCH_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
      const eTo = new Date(new Date(to + 'T00:00:00Z').getTime() + MATCH_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

      const select = 'id,vendor_name,total_amount,receipt_date,status,tag,submitter_name,department,description,qbo_purchase_id,qbo_bill_id';
      const [purchases, expenses, cardMap] = await Promise.all([
        fetchPurchases(from, to),
        opsGet(`expense_requests?select=${select}&receipt_date=gte.${eFrom}&receipt_date=lte.${eTo}&order=receipt_date.desc&limit=2000`),
        opsGet('expense_card_map?select=*&order=last4.asc').catch(() => []),
      ]);

      // Distinct cards seen in this window (count + $ per last4) — the panel's
      // Cardholders block assigns users to these.
      const cardSummary = {};
      for (const p of purchases) {
        if (!p.card_last4) continue;
        const c = (cardSummary[p.card_last4] ||= { last4: p.card_last4, count: 0, amount: 0 });
        c.count++; c.amount = Math.round((c.amount + (p.is_credit ? -p.amount : p.amount)) * 100) / 100;
      }

      const linkedByPurchase = new Map();
      for (const e of expenses) if (e.qbo_purchase_id) linkedByPurchase.set(String(e.qbo_purchase_id), e);

      const linked = [];
      const openPurchases = [];
      for (const p of purchases) {
        const e = linkedByPurchase.get(p.id);
        if (e) linked.push({ purchase: p, expense: expenseSummary(e) });
        else openPurchases.push(p);
      }

      // Candidate Brixpense rows: not linked to a Purchase, not on the bill
      // path (a Bill is its own QBO transaction), not denied.
      const openExpenses = expenses.filter((e) => !e.qbo_purchase_id && !e.qbo_bill_id && e.status !== 'denied');

      const { suggestions, usedP, usedE } = buildSuggestions(openPurchases, openExpenses);
      const unmatchedPurchases = openPurchases.filter((p) => !usedP.has(p.id));
      const unmatchedExpenses = openExpenses.filter((e) => !usedE.has(e.id)).map(expenseSummary);

      const sum = (arr, f) => Math.round(arr.reduce((s, x) => s + f(x), 0) * 100) / 100;
      return json(200, {
        from, to,
        linked,
        suggestions,
        unmatched_purchases: unmatchedPurchases,
        unmatched_expenses: unmatchedExpenses,
        card_map: cardMap,
        card_summary: Object.values(cardSummary).sort((a, b) => b.count - a.count),
        totals: {
          purchases: purchases.length,
          purchases_amount: sum(purchases, (p) => (p.is_credit ? -p.amount : p.amount)),
          linked: linked.length,
          suggestions: suggestions.length,
          unmatched_purchases: unmatchedPurchases.length,
          unmatched_purchases_amount: sum(unmatchedPurchases, (p) => (p.is_credit ? -p.amount : p.amount)),
          unmatched_expenses: unmatchedExpenses.length,
        },
      });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      if (action === 'link') {
        const { purchaseId, expenseId } = body;
        if (!purchaseId || !expenseId) return json(400, { error: 'purchaseId and expenseId required' });
        const rows = await opsWrite('PATCH', `expense_requests?id=eq.${encodeURIComponent(expenseId)}&qbo_purchase_id=is.null`, {
          qbo_purchase_id: String(purchaseId),
          qbo_purchase_matched_at: new Date().toISOString(),
          qbo_purchase_matched_by: actorEmail,
        });
        if (!rows || !rows.length) return json(409, { error: 'Expense not found or already linked' });
        return json(200, { ok: true, expense_id: expenseId, qbo_purchase_id: String(purchaseId) });
      }

      if (action === 'unlink') {
        const { expenseId } = body;
        if (!expenseId) return json(400, { error: 'expenseId required' });
        const rows = await opsWrite('PATCH', `expense_requests?id=eq.${encodeURIComponent(expenseId)}`, {
          qbo_purchase_id: null,
          qbo_purchase_matched_at: null,
          qbo_purchase_matched_by: null,
        });
        if (!rows || !rows.length) return json(404, { error: 'Expense not found' });
        return json(200, { ok: true });
      }

      if (action === 'import') {
        const { purchaseId } = body;
        if (!purchaseId) return json(400, { error: 'purchaseId required' });

        const existing = await opsGet(`expense_requests?select=id&qbo_purchase_id=eq.${encodeURIComponent(purchaseId)}&limit=1`);
        if (existing.length) return json(409, { error: 'This charge is already linked to a Brixpense record', expense_id: existing[0].id });

        const pr = await qboRequest('GET', `/purchase/${encodeURIComponent(purchaseId)}`);
        const p = pr?.Purchase;
        if (!p) return json(404, { error: 'QBO Purchase not found' });

        const now = new Date().toISOString();
        // status='posted' + as_bill=false: this spend is ALREADY in QBO — the
        // imported row is the Brixpense mirror/receipt-holder, and must never
        // trigger a second QBO posting.
        const row = {
          request_type: 'expense',
          status: 'posted',
          as_bill: false,
          tag: 'Card Feed',
          submitted_by: auth.user?.id || null,
          submitter_name: `${actorEmail} (card-feed import)`,
          submitter_email: actorEmail,
          vendor_name: p.EntityRef?.name || null,
          total_amount: p.TotalAmt ?? 0,
          currency: 'USD',
          receipt_date: p.TxnDate || null,
          memo: p.PrivateNote || null,
          description: `Imported from QBO ${p.PaymentType === 'CreditCard' ? 'credit-card' : 'expense'} feed — ${p.AccountRef?.name || 'unknown account'}${p.DocNumber ? ` #${p.DocNumber}` : ''}`,
          line_items: (p.Line || [])
            .filter((l) => l.Amount !== undefined && l.DetailType !== 'TaxLineDetail')
            .map((l) => ({
              description: l.Description || '',
              amount: l.Amount ?? 0,
              account: l.AccountBasedExpenseLineDetail?.AccountRef?.name || l.ItemBasedExpenseLineDetail?.ItemRef?.name || '',
            })),
          payment_account_id: p.AccountRef?.value || null,
          payment_account_name: p.AccountRef?.name || null,
          payment_account_type: p.PaymentType || null,
          payment_method: p.PaymentType || null,
          auto_approved: true,
          approved_by: 'system (card-feed import)',
          approved_at: now,
          posted_at: p.TxnDate ? `${p.TxnDate}T00:00:00Z` : now,
          qbo_purchase_id: String(p.Id),
          qbo_purchase_matched_at: now,
          qbo_purchase_matched_by: actorEmail,
        };
        const inserted = await opsWrite('POST', 'expense_requests', row);
        return json(200, { ok: true, expense_id: inserted?.[0]?.id || null });
      }

      if (action === 'assign_card') {
        const last4 = String(body.last4 || '').trim();
        if (!/^\d{4}$/.test(last4)) return json(400, { error: 'last4 must be exactly 4 digits' });
        // Accountability starts at assignment: the weekly audit only expects
        // receipts for txns dated >= receipts_from. Defaults to today;
        // back/future-datable so someone already submitting can own history.
        const receiptsFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(body.receipts_from || ''))
          ? body.receipts_from
          : new Date().toISOString().slice(0, 10);
        const row = {
          last4,
          label: body.label || null,
          user_id: body.user_id || null,
          user_email: body.user_email || null,
          user_name: body.user_name || null,
          receipts_from: receiptsFrom,
          active: true,
          updated_at: new Date().toISOString(),
          updated_by: actorEmail,
        };
        const res = await fetch(`${SUPABASE_URL}/rest/v1/expense_card_map?on_conflict=last4`, {
          method: 'POST',
          headers: serviceHeaders({
            'Content-Profile': 'ops', 'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=representation',
          }),
          body: JSON.stringify(row),
        });
        if (!res.ok) return json(502, { error: `card map write failed (${res.status}): ${(await res.text()).slice(0, 200)}` });
        return json(200, { ok: true, card: (await res.json())[0] || row });
      }

      if (action === 'unassign_card') {
        const last4 = String(body.last4 || '').trim();
        if (!/^\d{4}$/.test(last4)) return json(400, { error: 'last4 must be exactly 4 digits' });
        await opsWrite('PATCH', `expense_card_map?last4=eq.${last4}`, {
          user_id: null, user_email: null, user_name: null,
          updated_at: new Date().toISOString(), updated_by: actorEmail,
        });
        return json(200, { ok: true });
      }

      if (action === 'list_users') {
        // Auth users for the cardholder dropdown (shared gateway auth). New
        // users are created in the gateway admin (alamedapointbg.com/admin.html).
        const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, { headers: serviceHeaders() });
        if (!res.ok) return json(502, { error: `auth users read failed (${res.status})` });
        const data = await res.json();
        const users = (data.users || data || []).map((u) => ({
          id: u.id,
          email: u.email,
          name: u.user_metadata?.full_name || u.user_metadata?.name || '',
          role: u.user_metadata?.role || '',
        })).sort((a, b) => (a.email || '').localeCompare(b.email || ''));
        return json(200, { ok: true, users });
      }

      return json(400, { error: `Unknown action '${action}'` });
    }

    return json(405, { error: 'GET or POST only' });
  } catch (e) {
    console.error('[expense-cc-match]', e);
    return json(500, { error: e.message || String(e) });
  }
}
