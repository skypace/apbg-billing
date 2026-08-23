// card-receipt-audit-background.mjs — weekly "you need to send receipts for
// these card transactions" email.
//
// Where the data comes from: the corporate card feeds into QBO Banking; once
// the bookkeeper accepts a feed line it becomes a QBO Purchase. QBO's API does
// NOT expose the raw bank feed (pending swipes are invisible), so this audits
// accepted card Purchases — freshness = however fast feed lines get accepted.
//
// Matching, two tiers against ops.expense_requests:
//   1. EXACT   — the Purchase was CREATED BY Brixpense (expense_requests.
//                qbo_bill_id stores the Purchase id for paid expenses).
//   2. FUZZY   — amount matches (±1¢) and receipt_date within ±4 days of the
//                TxnDate (covers "bookkeeper accepted the feed line directly
//                while the receipt lives in Brixpense separately"). Each
//                Brixpense row is consumed at most once.
// Anything unmatched → listed in the weekly email as needing a receipt.
//
// Modes: ?mode=list (JSON only, default — safe to poke) · ?mode=send (emails).
// Auth: superadmin Bearer OR x-sf-autopost-secret (same cron secret as the
// SF expense autopost — one secret for the Brixpense cron family).
// Cron: pg_cron 'card-receipt-audit', Mondays 15:00 UTC (8am PT).
// Always sends (missing list OR all-clear) — a weekly email that never arrives
// is itself the signal something died, which silence-on-clean would hide.

import { requireAuth } from './lib/auth.mjs';
import { qboQuery } from './qbo-helpers.mjs';
import { cardLast4 } from './expense-cc-match.mjs';
import { brixpenseEmail, esc, money } from './lib/brixpense-email.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';

const REPORT_TO = process.env.SF_EXPENSE_REPORT_TO || 'whitney@alamedasoda.com';
const LOOKBACK_DAYS = Number(process.env.CARD_AUDIT_LOOKBACK_DAYS || 45);
const MIN_AMOUNT = Number(process.env.CARD_AUDIT_MIN_AMOUNT || 1); // ignore sub-$1 noise

function srHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'ops', 'Content-Profile': 'ops', ...extra };
}
async function opsGet(q) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: srHeaders() });
  if (!res.ok) throw new Error(`ops read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function logRun(started, status, records, metadata, errorMessage = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST', headers: srHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ source: 'qbo', sync_type: 'card-receipt-audit', status, records_synced: records, started_at: started, completed_at: new Date().toISOString(), error_message: errorMessage, metadata }),
    });
  } catch { /* best-effort */ }
}

// A "card transaction" = QBO Purchase paid by credit card. PaymentType is the
// primary signal; account-name heuristic catches purchases QBO stored without
// a PaymentType but sitting on a card account.
function isCardPurchase(p) {
  if (p.PaymentType === 'CreditCard') return true;
  return /card|amex|visa|mastercard|m\/c/i.test(p.AccountRef?.name || '');
}
const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

export default async (req) => {
  const url = new URL(req.url);
  const mode = (url.searchParams.get('mode') || 'list').toLowerCase();

  const cronSecret = req.headers.get('x-sf-autopost-secret') || '';
  const isCron = !!cronSecret && (
    cronSecret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32) ||
    (!!process.env.SF_AUTOPOST_CRON_SECRET && cronSecret === process.env.SF_AUTOPOST_CRON_SECRET)
  );
  if (!isCron) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }

  const started = new Date().toISOString();
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

    // 1) Card purchases from QBO (live query — the mirror's line table doesn't
    //    carry the header payment account, and this is one cheap call).
    const qres = await qboQuery(`SELECT * FROM Purchase WHERE TxnDate >= '${since}' ORDER BY TxnDate DESC MAXRESULTS 1000`);
    const purchases = (qres.QueryResponse?.Purchase || [])
      .filter(isCardPurchase)
      .filter((p) => !p.Credit) // skip refunds/credits — nothing to receipt
      .filter((p) => Number(p.TotalAmt || 0) >= MIN_AMOUNT);

    // 2) Brixpense expense rows in a slightly wider window for fuzzy matching,
    //    plus the card → cardholder map for attribution.
    const rows = await opsGet(`expense_requests?request_type=eq.expense&receipt_date=gte.${new Date(Date.now() - (LOOKBACK_DAYS + 10) * 86400000).toISOString().slice(0, 10)}&select=id,qbo_bill_id,total_amount,receipt_date,vendor_name,status,submitter_name&limit=1000`);
    const cardMap = {};
    try {
      for (const c of await opsGet('expense_card_map?select=last4,user_name,user_email,receipts_from')) {
        cardMap[c.last4] = { who: c.user_name || c.user_email || null, from: c.receipts_from || null };
      }
    } catch { /* attribution optional */ }
    const byQboId = new Map();
    for (const r of rows) if (r.qbo_bill_id) byQboId.set(String(r.qbo_bill_id), r);

    const usedFuzzy = new Set();
    const missing = []; let exact = 0; let fuzzy = 0;
    for (const p of purchases) {
      if (byQboId.has(String(p.Id))) { exact++; continue; }
      const amt = Number(p.TotalAmt || 0);
      // Fuzzy candidates: rows NOT already tied to their own QBO txn
      // (qbo_bill_id null = receipt exists but was never posted / bookkeeper
      // accepted the feed line directly), unused, amount ±1¢, date ±4 days.
      const hit = rows.find((r) =>
        !usedFuzzy.has(r.id)
        && !r.qbo_bill_id
        && Math.abs(Number(r.total_amount || 0) - amt) < 0.01
        && r.receipt_date && p.TxnDate && dayDiff(r.receipt_date, p.TxnDate) <= 4);
      if (hit) { usedFuzzy.add(hit.id); fuzzy++; continue; }
      const last4 = cardLast4(p.PrivateNote || '');
      const card = (last4 && cardMap[last4]) || null;
      // Accountability starts at assignment: swipes dated before the card's
      // receipts_from predate the cardholder having the app — not chased.
      if (card?.from && p.TxnDate && p.TxnDate < card.from) continue;
      missing.push({
        qbo_id: p.Id,
        date: p.TxnDate,
        payee: p.EntityRef?.name || '(no payee)',
        amount: amt,
        account: p.AccountRef?.name || '?',
        card_last4: last4,
        cardholder: card?.who || null,
      });
    }
    missing.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const summary = { mode, lookback_days: LOOKBACK_DAYS, card_purchases: purchases.length, matched_exact: exact, matched_fuzzy: fuzzy, missing: missing.length };

    if (mode === 'send') {
      const total = missing.reduce((s, m) => s + m.amount, 0);
      const rowsHtml = missing.map((m) =>
        `<tr>
          <td style="padding:6px 10px 6px 0;color:#94A3B8;white-space:nowrap">${esc(m.date)}</td>
          <td style="padding:6px 10px 6px 0;color:#F1F5F9"><b>${esc(m.payee)}</b><br/><span style="color:#64748B;font-size:12px">${esc(m.account)}${m.card_last4 ? ` · 💳 ${m.cardholder ? esc(m.cardholder) : 'unassigned'} (••${esc(m.card_last4)})` : ''}</span></td>
          <td style="padding:6px 0;text-align:right;color:#FBBF24;font-weight:700;white-space:nowrap">${money(m.amount)}</td>
        </tr>`).join('');
      // Per-cardholder rollup so it's obvious WHO owes receipts.
      const byHolder = {};
      for (const m of missing) { const k = m.cardholder || (m.card_last4 ? `unassigned ••${m.card_last4}` : 'no card id'); byHolder[k] = (byHolder[k] || 0) + 1; }
      const holderLine = Object.entries(byHolder).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${esc(k)}: ${n}`).join(' · ');
      const inner = missing.length > 0
        ? `<p style="margin:0 0 6px;color:#fff;font-size:16px;font-weight:700">Receipts needed for ${missing.length} card transaction${missing.length === 1 ? '' : 's'} — ${money(total)}</p>
           <p style="margin:0 0 14px;color:#CBD5E1">These company-card charges (last ${LOOKBACK_DAYS} days) have no matching receipt in Brixpense. Submit the receipt at <a href="https://alamedapointbg.com/expense/" style="color:#60A5FA">alamedapointbg.com/expense</a> (photo → auto-fill → submit) and it will match automatically on next week's audit.</p>
           <p style="margin:0 0 10px;color:#93C5FD;font-size:12.5px"><b>By cardholder:</b> ${holderLine}</p>
           <table role="presentation" style="border-collapse:collapse;width:100%">${rowsHtml}</table>
           <p style="color:#64748B;font-size:12px;margin-top:14px">Matched this week: ${exact + fuzzy} of ${purchases.length} card transactions (${exact} posted through Brixpense, ${fuzzy} matched by amount + date). Assign cards to users in Master Control → Card &amp; Expense Match → Cardholders. Pending card swipes not yet accepted in QuickBooks aren't visible to this audit.</p>`
        : `<p style="margin:0 0 6px;color:#fff;font-size:16px;font-weight:700">All card transactions accounted for ✓</p>
           <p style="margin:0;color:#CBD5E1">Every company-card charge in the last ${LOOKBACK_DAYS} days (${purchases.length} transaction${purchases.length === 1 ? '' : 's'}) has a matching receipt in Brixpense. Nothing to chase this week.</p>`;
      await sendEmail({
        to: REPORT_TO,
        subject: missing.length > 0
          ? `🧾 Brixpense — receipts needed for ${missing.length} card transaction${missing.length === 1 ? '' : 's'} (${money(total)})`
          : 'Brixpense — card receipts: all accounted for ✓',
        html: brixpenseEmail(missing.length > 0 ? '#F59E0B' : '#22C55E', 'Card receipt audit', inner),
      });
    }

    await logRun(started, 'success', missing.length, summary);
    return new Response(JSON.stringify({ ok: true, ...summary, missing }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[card-receipt-audit]', e);
    await logRun(started, 'error', 0, { mode }, String(e?.message || e).slice(0, 500));
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
