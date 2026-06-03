// ============================================================
// expense-request-pay.mjs — Tier-1 payout.
// Records a vendor payment on an expense_requests row (marks it paid,
// captures method + reference + from-account) and, when the row has a
// QBO bill, optionally writes a matching QBO BillPayment back to QuickBooks.
//
// Money movement itself stays manual (QBO Bill Pay, Amex, Zelle, Venmo,
// check, ACH) — this is the system-of-record + QBO reconciliation step.
// Auth: Bearer JWT; caller must be superadmin/admin.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { qboRequest } from './qbo-helpers.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const ALLOWED_METHODS = ['qbo_bill_pay', 'amex', 'zelle', 'venmo', 'check', 'ach', 'other'];
// Methods that fund from a credit card (QBO PayType = CreditCard); the rest pay from a bank (Check).
const CARD_METHODS = ['amex'];

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400) { return json({ error: m }, s); }
function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('POST only', 405);

  // ── Auth: validate the caller's JWT and require superadmin/admin ──
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return err('Missing Authorization bearer token', 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const caller = userData?.user;
  if (userErr || !caller) return err('Invalid or expired session', 401);
  const role = caller.user_metadata?.role || caller.app_metadata?.role || '';
  if (!['superadmin', 'admin'].includes(role)) {
    return err('Recording a payment requires an admin or superadmin account', 403);
  }

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }

  const {
    requestId,
    method,
    accountId,            // QBO account id to pay FROM (bank or credit-card account)
    accountName,
    accountType,          // 'bank' | 'credit_card' (UI hint; falls back to method)
    reference,            // confirmation / check / txn number
    paidAt,               // ISO date string; defaults to now
    writeToQbo = true,    // create the QBO BillPayment when a qbo_bill_id exists
  } = body || {};

  if (!requestId) return err('requestId required');
  if (!method || !ALLOWED_METHODS.includes(method)) {
    return err(`method must be one of: ${ALLOWED_METHODS.join(', ')}`);
  }

  // Service-role client for the cross-cutting write (bypasses per-row RLS); fall
  // back to the caller-bound client if the service key isn't configured.
  const writer = SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'ops' }, auth: { persistSession: false } })
    : userClient;

  // ── Load the row ──
  const { data: row, error: loadErr } = await writer
    .from('expense_requests')
    .select('id, status, vendor_name, vendor_id, total_amount, qbo_bill_id, qbo_billpayment_id, payment_method')
    .eq('id', requestId)
    .single();
  if (loadErr || !row) return err(`Expense request ${requestId} not found`, 404);
  if (row.status === 'paid' || row.qbo_billpayment_id) {
    return err('This bill is already marked paid', 409);
  }

  const isCard = accountType === 'credit_card' || CARD_METHODS.includes(method);
  const paidStamp = paidAt ? new Date(paidAt).toISOString() : new Date().toISOString();
  const txnDate = paidStamp.slice(0, 10);

  // ── Optional QBO BillPayment writeback ──
  let qboBillPaymentId = null;
  let qboNote = null;
  if (writeToQbo && row.qbo_bill_id) {
    if (!accountId) return err('accountId (QBO account to pay from) is required to write the payment to QBO');
    try {
      // Fetch the Bill for the authoritative VendorRef + balance.
      const billRes = await qboRequest('GET', `/bill/${row.qbo_bill_id}`);
      const bill = billRes?.Bill || billRes;
      const vendorRef = bill?.VendorRef?.value;
      const amount = round(bill?.Balance ?? bill?.TotalAmt ?? row.total_amount);
      if (!vendorRef) throw new Error('Bill has no VendorRef');
      if (!(amount > 0)) throw new Error('Bill balance is zero — nothing to pay');

      const payload = {
        VendorRef: { value: String(vendorRef) },
        TotalAmt: amount,
        TxnDate: txnDate,
        PayType: isCard ? 'CreditCard' : 'Check',
        PrivateNote: `Brixpense payout via ${method}${reference ? ` (ref ${reference})` : ''}`,
        Line: [{ Amount: amount, LinkedTxn: [{ TxnId: String(row.qbo_bill_id), TxnType: 'Bill' }] }],
      };
      if (isCard) payload.CreditCardPayment = { CCAccountRef: { value: String(accountId) } };
      else payload.CheckPayment = { BankAccountRef: { value: String(accountId) } };

      const payRes = await qboRequest('POST', '/billpayment', payload);
      qboBillPaymentId = payRes?.BillPayment?.Id || payRes?.Id || null;
    } catch (e) {
      // QBO failed — do NOT mark paid, so the operator can retry or pay manually.
      return err(`QBO BillPayment failed: ${e.message?.substring(0, 300) || e}`, 502);
    }
  } else if (writeToQbo && !row.qbo_bill_id) {
    qboNote = 'No QBO bill linked — recorded payment without a QBO BillPayment.';
  }

  // ── Mark paid in Brixpense ──
  const update = {
    status: 'paid',
    payment_method: method,
    payment_reference: reference || null,
    payment_account_id: accountId || null,
    payment_account_name: accountName || null,
    payment_account_type: accountType || (isCard ? 'credit_card' : 'bank'),
    paid_at: paidStamp,
    paid_by: caller.email || caller.id,
    qbo_billpayment_id: qboBillPaymentId,
    updated_at: new Date().toISOString(),
  };
  const { data: updated, error: updErr } = await writer
    .from('expense_requests')
    .update(update)
    .eq('id', requestId)
    .select()
    .single();
  if (updErr) {
    // The QBO payment may have posted — surface that so it isn't double-paid.
    return err(
      `Recorded the QBO payment (${qboBillPaymentId || 'n/a'}) but failed to update Brixpense: ${updErr.message}. Do not re-run.`,
      500
    );
  }

  return json({ ok: true, request: updated, qboBillPaymentId, note: qboNote });
}
