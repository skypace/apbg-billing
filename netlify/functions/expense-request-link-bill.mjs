// ============================================================
// expense-request-link-bill.mjs
// Modes: create (default), preview, link.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { qboRequest, qboQuery } from './qbo-helpers.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const LINKABLE_STATUSES = ['approved', 'awaiting_invoice', 'fulfilled'];
const DEFAULT_COGS_ACCOUNT_ID = '101';

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400) { return json({ error: m }, s); }
function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

async function findQBOVendor(name) {
  if (!name) return null;
  try {
    const safe = name.replace(/'/g, "\\'");
    const exact = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName = '${safe}'`);
    const v = exact.QueryResponse?.Vendor || [];
    if (v.length > 0) return v[0];
  } catch {}
  try {
    const words = name.split(/\s+/).filter(w => w.length > 2);
    for (const w of words.slice(0, 3)) {
      const clean = w.replace(/[^a-zA-Z0-9]/g, '');
      if (!clean) continue;
      const like = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${clean}%'`);
      const v2 = like.QueryResponse?.Vendor || [];
      if (v2.length === 1) return v2[0];
      if (v2.length > 1) {
        const best = v2.find(x => x.DisplayName.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.DisplayName.toLowerCase()));
        if (best) return best;
      }
    }
  } catch {}
  return null;
}

async function findQBODepartmentRef(name) {
  if (!name) return null;
  try {
    const safe = name.replace(/'/g, "\\'");
    const res = await qboQuery(`SELECT * FROM Department WHERE Name = '${safe}'`);
    const depts = res.QueryResponse?.Department || [];
    if (depts.length > 0) return { value: depts[0].Id, name: depts[0].Name };
  } catch {}
  return null;
}

function buildBillPayload(request, vendor, departmentRef, fallbackAccountId) {
  const lineItems = Array.isArray(request.line_items) ? request.line_items : [];
  const accountId = request.cogs_account_id || fallbackAccountId;
  const lines = lineItems.length > 0
    ? lineItems.map((li, idx) => {
        const amount = round((li.qty || li.quantity || 1) * (li.unit_price || li.unitCost || 0)) || round(li.amount || 0);
        return {
          DetailType: 'AccountBasedExpenseLineDetail',
          Amount: amount,
          Description: li.description || `Line ${idx + 1}`,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: accountId },
            BillableStatus: 'NotBillable',
            ...(departmentRef ? { DepartmentRef: { value: departmentRef.value } } : {}),
          },
        };
      })
    : [{
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: round(request.total_amount),
        Description: request.memo || request.vendor_name || 'Brixpense expense',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: accountId },
          BillableStatus: 'NotBillable',
          ...(departmentRef ? { DepartmentRef: { value: departmentRef.value } } : {}),
        },
      }];
  const memoParts = [
    `BRIXpense ${request.request_type === 'purchase_request' ? 'PR' : 'expense'} ${request.id}`,
    request.entity ? `entity:${request.entity}` : null,
    request.department ? `dept:${request.department}` : null,
    request.tag ? `tag:${request.tag}` : null,
    request.customer_name ? `cust:${request.customer_name}` : null,
    request.job_number ? `job:${request.job_number}` : null,
    request.memo || null,
  ].filter(Boolean);
  const payload = {
    VendorRef: { value: vendor.Id },
    Line: lines,
    PrivateNote: memoParts.join(' | ').substring(0, 4000),
  };
  if (request.receipt_date) payload.TxnDate = request.receipt_date;
  if (departmentRef) payload.DepartmentRef = { value: departmentRef.value };
  return payload;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return err('Unauthorized — Bearer token required', 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: 'ops' },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return err('Invalid or expired session', 401);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON body'); }

  const { requestId, mode = 'create', qboBillId } = body;
  if (!requestId) return err('Missing requestId');
  if (!['create', 'preview', 'link'].includes(mode)) return err(`Invalid mode "${mode}"`);

  const { data: request, error: fetchErr } = await supabase
    .from('expense_requests').select('*').eq('id', requestId).single();
  if (fetchErr || !request) return err('Expense request not found', 404);

  if (mode === 'link') {
    if (!qboBillId) return err('mode=link requires qboBillId');
    if (!LINKABLE_STATUSES.includes(request.status)) {
      return err(`Cannot link from status "${request.status}". Must be: ${LINKABLE_STATUSES.join(', ')}`, 409);
    }
    const { error: updateErr } = await supabase
      .from('expense_requests')
      .update({ qbo_bill_id: qboBillId, status: 'posted', posted_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updateErr) return err('Failed to link bill: ' + updateErr.message, 500);
    return json({ success: true, mode: 'link', request_id: requestId, qbo_bill_id: qboBillId, new_status: 'posted' });
  }

  if (!LINKABLE_STATUSES.includes(request.status)) {
    return err(`Cannot post bill from status "${request.status}". Must be: ${LINKABLE_STATUSES.join(', ')}`, 409);
  }

  const vendor = await findQBOVendor(request.vendor_name);
  if (!vendor) {
    return json({
      success: false, needs_vendor: true,
      message: `Could not match vendor "${request.vendor_name || '(blank)'}" in QuickBooks.`,
      request_id: requestId,
    });
  }

  const departmentRef = await findQBODepartmentRef(request.department);
  const payload = buildBillPayload(request, vendor, departmentRef, DEFAULT_COGS_ACCOUNT_ID);

  if (mode === 'preview') {
    return json({
      success: true, mode: 'preview', request_id: requestId,
      vendor: { id: vendor.Id, name: vendor.DisplayName },
      department: departmentRef,
      payload,
    });
  }

  let billResult;
  try {
    const qboRes = await qboRequest('POST', '/bill', payload);
    billResult = qboRes.Bill;
  } catch (e) {
    console.error('QBO bill creation failed:', e);
    return err('QBO bill creation failed: ' + e.message, 502);
  }

  if (!billResult || !billResult.Id) return err('QBO did not return a bill ID', 502);

  const { error: updateErr } = await supabase
    .from('expense_requests')
    .update({
      qbo_bill_id: billResult.Id,
      status: 'posted',
      posted_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  if (updateErr) {
    return json({
      success: true, mode: 'create', partial: true,
      message: 'Bill created in QBO but local status update failed.',
      request_id: requestId, qbo_bill_id: billResult.Id,
      qbo_doc_number: billResult.DocNumber, qbo_total: billResult.TotalAmt,
      update_error: updateErr.message,
    }, 207);
  }

  return json({
    success: true, mode: 'create', request_id: requestId,
    qbo_bill_id: billResult.Id, qbo_doc_number: billResult.DocNumber, qbo_total: billResult.TotalAmt,
    vendor: { id: vendor.Id, name: vendor.DisplayName },
    department: departmentRef,
    new_status: 'posted',
  });
}

export const config = { path: '/api/expense-request-link-bill' };
