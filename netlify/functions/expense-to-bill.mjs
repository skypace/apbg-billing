// SF Expense Receipt → QBO Bill
//
// Flow:
//   1. GET ?sfJob=123 — list expenses for an SF job
//   2. POST { sfJobId, resqCode, fileData, mediaType } — scan receipt with Claude AI,
//      match QBO vendor, create QBO bill
//
// Category → QBO Account mapping:
//   "equipment" → Equipment Sales COGS (account 42)
//   "service"   → Service COGS (account 101)

import { sfRequest } from './sf-helpers.mjs';
import { qboRequest, qboQuery, corsHeaders } from './qbo-helpers.mjs';
import { requireAuth } from './lib/auth.mjs';
import { loadSyncCustomers, classifySyncCustomer } from './lib/sync-customers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const ACCOUNT_MAP = {
  equipment: { id: '42', name: 'Equipment Sales COGS' },
  service:   { id: '101', name: 'Service COGS' },
};
const DEFAULT_ACCOUNT = ACCOUNT_MAP.service;

// The ResQ-facility ↔ QBO-customer mapping is no longer hardcoded here — it
// lives in ops.sync_customers (single source of truth, managed in sync.html →
// Settings). Bills for facilities that match a linked customer get a
// CustomerRef (using the row's qbo_customer_id directly — no fuzzy name
// lookup); bills for anything else are still created without one.

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;

  const qs = event.queryStringParameters || {};

  // ── GET: List expenses for an SF job ──
  if (event.httpMethod === 'GET' && qs.sfJob) {
    try {
      const sfJob = await sfRequest('GET', `/jobs/${qs.sfJob}?expand=expenses`);
      const expenses = (sfJob.expenses || []).map(ex => ({
        id: ex.id,
        amount: ex.amount || 0,
        category: ex.category || '',
        notes: ex.notes || '',
        isBillable: !!ex.is_billable,
        date: ex.expense_date || ex.created_at || null,
        hasReceipt: !!(ex.receipt_url || ex.receipt),
      }));
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({
          jobNumber: sfJob.number || sfJob.id,
          customerName: sfJob.customer_name || '',
          expenses,
        }),
      };
    } catch (e) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── POST: Scan receipt + create QBO bill ──
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'GET or POST only' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { sfJobId, resqCode, fileData, mediaType, vendorNameHint } = body;

    if (!sfJobId) return err400('sfJobId is required');
    if (!fileData) return err400('fileData (base64) is required');

    const mType = mediaType || 'application/pdf';

    // ── 1. Scan receipt with Claude AI ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return err500('ANTHROPIC_API_KEY not configured');

    const isPdf = mType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
      : { type: 'image', source: { type: 'base64', media_type: mType, data: fileData } };

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: `You extract structured data from vendor bills, invoices, and receipts. Return ONLY valid JSON with no markdown, no backticks, no preamble. The JSON must have this exact structure:

{
  "vendorName": "string",
  "billNumber": "string or null",
  "billDate": "string or null (YYYY-MM-DD)",
  "dueDate": "string or null (YYYY-MM-DD)",
  "lineItems": [
    { "description": "string", "quantity": number, "unitCost": number, "category": "equipment" or "service" }
  ],
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "notes": "string or null — PO numbers, job references, work order numbers"
}

Rules:
- If a line item has no separate quantity, use 1
- If a line item shows only a total with no unit price, set unitCost to the total and quantity to 1
- Category: physical goods, parts, materials, equipment, supplies = "equipment". Labor, service, installation, repair, consulting, delivery, freight = "service"
- Extract ALL line items, don't combine them
- Look for any job numbers, work order numbers, PO numbers and include in notes
- Return ONLY the JSON`,
        messages: [
          { role: 'user', content: [contentBlock, { type: 'text', text: 'Extract all bill/receipt data from this document. Return only JSON.' }] },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error: ${claudeRes.status} ${err.substring(0, 300)}`);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const extracted = JSON.parse(cleaned);

    // ── 2. Best-effort vendor match (a SUGGESTION only — we no longer create
    //       the QBO bill here, so a miss is fine; the operator confirms the
    //       vendor in Brixpense and the bill posts on submit). ──
    let qboVendor = null;
    const vendorNames = [vendorNameHint, extracted.vendorName].filter(Boolean);
    for (const vn of vendorNames) {
      qboVendor = await findQBOVendor(vn);
      if (qboVendor) break;
    }

    // ── 2b. Best-effort customer + suggested COGS account (also suggestions). ──
    const customerResult = await resolveResqCustomer({ sfJobId, resqCode });
    const suggestedCogs = customerResult.cogsAccountId
      ? { id: String(customerResult.cogsAccountId), name: customerResult.qboName ? `${customerResult.qboName} COGS` : 'COGS' }
      : (ACCOUNT_MAP[(extracted.lineItems?.[0]?.category) || ''] || DEFAULT_ACCOUNT);

    // ── 3. Upload the receipt image so it can ride into Brixpense on landing. ──
    const attachment = await uploadReceiptImage(fileData, mType, sfJobId);

    // ── 4. Build a DRAFT expense (no QBO post) and stash it to land in
    //       Brixpense when the SF job is invoiced (🔒 Close / cron). If the SF
    //       job isn't mapped, land it now. Brixpense posts to QBO on submit. ──
    let landed = { ok: false, deferred: false };
    try {
      const expenseRow = buildExpenseRow({
        extracted, vendor: qboVendor, customer: customerResult.qboCustomer || null,
        sfJobId, resqCode, submitter: auth.user, cogsAccount: suggestedCogs, attachment,
      });
      const store = await getStore();
      let stashed = false;
      if (store && expenseRow) {
        const raw = await store.get('wo-mapping');
        const mapping = raw ? JSON.parse(raw) : {};
        for (const v of Object.values(mapping)) {
          if (String(v.sfJobId) === String(sfJobId) || (resqCode && v.resqCode === resqCode)) {
            v.pendingExpense = expenseRow;
            v.lastSyncAt = new Date().toISOString();
            stashed = true;
          }
        }
        if (stashed) {
          await store.set('wo-mapping', JSON.stringify(mapping));
          landed = { ok: true, deferred: true };
        }
      }
      if (!stashed && expenseRow) {
        landed = await postExpenseRow(expenseRow); // unmapped SF job — land now
      }
    } catch (e) {
      landed = { ok: false, error: e.message };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        staged: true,
        extracted,
        vendor: qboVendor ? { id: qboVendor.Id, name: qboVendor.DisplayName } : null,
        customer: customerResult.qboCustomer
          ? { id: customerResult.qboCustomer.Id, name: customerResult.qboCustomer.DisplayName }
          : null,
        brixpense: landed,
        message: landed?.deferred
          ? 'Receipt scanned — expense + image will land in Brixpense for review when the job is invoiced.'
          : landed?.ok
            ? 'Receipt scanned — expense + image staged in Brixpense for review.'
            : 'Receipt scanned, but staging to Brixpense failed (see brixpense.error).',
      }),
    };

  } catch (e) {
    console.error('expense-to-bill error:', e);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: e.message }) };
  }
}

// ── POST with vendorId override (manual vendor selection) ──
// Body: { sfJobId, resqCode, vendorId, extracted }
// Called when auto-match fails and user picks a vendor

async function createQBOBill({ vendor, customer, extracted, sfJobId, resqCode }) {
  const lineItems = extracted.lineItems || [];
  if (lineItems.length === 0) {
    throw new Error('No line items found on receipt');
  }

  // Customer attached to every line for QBO job-costing rollup. NotBillable —
  // we're not re-billing the customer here, just associating the cost.
  const customerRef = customer ? { value: customer.Id } : null;

  const billLines = lineItems.map(item => {
    const acct = ACCOUNT_MAP[item.category] || DEFAULT_ACCOUNT;
    const amount = round((item.quantity || 1) * (item.unitCost || 0));
    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: amount,
      Description: item.description || '',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: acct.id },
        BillableStatus: 'NotBillable',
        ...(customerRef ? { CustomerRef: customerRef } : {}),
      },
    };
  });

  const total = lineItems.reduce((s, li) => s + round((li.quantity || 1) * (li.unitCost || 0)), 0);

  // Add tax as a separate line if present
  if (extracted.tax && extracted.tax > 0) {
    billLines.push({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: round(extracted.tax),
      Description: 'Tax',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: DEFAULT_ACCOUNT.id },
        BillableStatus: 'NotBillable',
        ...(customerRef ? { CustomerRef: customerRef } : {}),
      },
    });
  }

  const memo = [
    resqCode ? `ResQ ${resqCode}` : null,
    sfJobId ? `SF Job #${sfJobId}` : null,
    extracted.notes || null,
  ].filter(Boolean).join(' | ');

  const payload = {
    VendorRef: { value: vendor.Id },
    Line: billLines,
    PrivateNote: memo.substring(0, 4000),
  };

  if (extracted.billNumber) payload.DocNumber = extracted.billNumber;
  if (extracted.dueDate) payload.DueDate = extracted.dueDate;
  if (extracted.billDate) payload.TxnDate = extracted.billDate;

  const result = await qboRequest('POST', '/bill', payload);
  const bill = result.Bill;

  return {
    id: bill.Id,
    number: bill.DocNumber || bill.Id,
    total: bill.TotalAmt || total,
  };
}

// ── Find QBO vendor by name (fuzzy) ──
async function findQBOVendor(name) {
  if (!name) return null;

  // Strategy 1: Exact DisplayName match
  try {
    const exact = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName = '${name.replace(/'/g, "\\'")}'`);
    const vendors = exact.QueryResponse?.Vendor || [];
    if (vendors.length > 0) return vendors[0];
  } catch (e) {}

  // Strategy 2: LIKE search on DisplayName
  try {
    // Use first significant word (skip short words)
    const words = name.split(/\s+/).filter(w => w.length > 2);
    for (const word of words.slice(0, 3)) {
      const clean = word.replace(/[^a-zA-Z0-9]/g, '');
      if (!clean) continue;
      const like = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${clean}%'`);
      const vendors = like.QueryResponse?.Vendor || [];
      if (vendors.length === 1) return vendors[0];
      // If multiple matches, try to find best match
      if (vendors.length > 1) {
        const best = vendors.find(v =>
          v.DisplayName.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(v.DisplayName.toLowerCase())
        );
        if (best) return best;
        // Return first match if name is contained in vendor name
        const partial = vendors.find(v =>
          v.DisplayName.toLowerCase().includes(words[0].toLowerCase())
        );
        if (partial) return partial;
      }
    }
  } catch (e) {}

  // Strategy 3: CompanyName search
  try {
    const words = name.split(/\s+/).filter(w => w.length > 2);
    if (words[0]) {
      const clean = words[0].replace(/[^a-zA-Z0-9]/g, '');
      const comp = await qboQuery(`SELECT * FROM Vendor WHERE CompanyName LIKE '%${clean}%'`);
      const vendors = comp.QueryResponse?.Vendor || [];
      if (vendors.length > 0) return vendors[0];
    }
  } catch (e) {}

  return null;
}

// ── Resolve which ResQ customer a bill belongs to ──
// Uses the ops.sync_customers identity map (single source of truth). We resolve
// to a linked customer via, in order:
//   1. the wo-mapping blob (customerQboId, set by the sync worker) — exact id;
//   2. the wo-mapping blob's facility / legacy customer keyword — classify;
//   3. the SF job's customer_name — match against linked names/keywords.
// Because the map stores qbo_customer_id, we build the CustomerRef directly —
// no fuzzy QBO name search.
async function resolveResqCustomer({ sfJobId, resqCode }) {
  const customers = await loadSyncCustomers().catch(() => []);
  const byId = (id) => customers.find(c => String(c.qbo_customer_id) === String(id));

  let cust = null;
  let facilityHint = null;

  // 1 + 2. wo-mapping blob keyed by ResQ code
  if (resqCode) {
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore({
        name: 'resq-sf-sync',
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_ACCESS_TOKEN,
      });
      const raw = await store.get('wo-mapping');
      if (raw) {
        const mapping = JSON.parse(raw);
        for (const v of Object.values(mapping)) {
          if (v.resqCode !== resqCode) continue;
          facilityHint = v.facility || null;
          if (v.customerQboId) cust = byId(v.customerQboId);
          if (!cust && v.facility) cust = classifySyncCustomer(v.facility, customers);
          // legacy: v.customer was a facility keyword ('starbird'/'melt')
          if (!cust && v.customer) cust = classifySyncCustomer(String(v.customer), customers);
          break;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // 3. Inspect the SF job's customer_name + match against linked customers
  if (!cust && sfJobId) {
    try {
      const sfJob = await sfRequest('GET', `/jobs/${sfJobId}`);
      const sfName = (sfJob.customer_name || '').toLowerCase();
      cust = customers.find(c => {
        const names = [c.qbo_customer_name, c.sf_customer_name].filter(Boolean).map(n => n.toLowerCase());
        if (names.some(n => sfName.includes(n) || n.includes(sfName))) return true;
        return (c.resq_facility_keywords || []).some(k => k && sfName.includes(String(k).toLowerCase()));
      }) || null;
    } catch (e) { /* fall through */ }
  }

  if (!cust) {
    // No linked customer — create the bill without a CustomerRef (as before).
    return { key: null, qboName: null, qboCustomer: null, facilityHint };
  }

  // We have the QBO id from the map — build the CustomerRef directly.
  return {
    key: cust.qbo_customer_id,
    qboName: cust.qbo_customer_name,
    qboCustomer: { Id: String(cust.qbo_customer_id), DisplayName: cust.qbo_customer_name },
    cogsAccountId: cust.qbo_cogs_account_id || null,
    facilityHint,
  };
}

// Build the ops.expense_requests row for a SF expense (no DB write, no QBO post).
// Lands as a *draft* so it appears in Brixpense for review — the operator picks
// the account / location / misc and SUBMITS in Brixpense, which is what posts
// the QBO bill. `_attachment` (if present) is the receipt image to attach on
// landing. Exported so the close/invoice step can land it later.
export function buildExpenseRow({ extracted, vendor, customer, sfJobId, resqCode, submitter, cogsAccount, attachment }) {
  if (!submitter?.id) return null;
  return {
    request_type: 'expense',
    status: 'draft',          // reviewable in Brixpense; QBO post happens on submit
    as_bill: true,            // submit creates an unpaid QBO Bill (not a Purchase)
    tag: 'Service Fusion',
    submitted_by: submitter.id,
    submitter_name: submitter.user_metadata?.name || submitter.email || 'Service Fusion',
    submitter_email: submitter.email || null,
    vendor_name: vendor?.DisplayName || extracted.vendorName || null,
    vendor_id: vendor?.Id ? String(vendor.Id) : null,
    total_amount: extracted.total ?? null,
    currency: 'USD',
    receipt_date: extracted.billDate || null,
    line_items: extracted.lineItems || [],
    customer_name: customer?.DisplayName || null,
    cogs_account_id: cogsAccount?.id || null,
    cogs_account_label: cogsAccount?.name || null,
    job_number: sfJobId ? String(sfJobId) : null,
    memo: [resqCode ? `ResQ ${resqCode}` : null, sfJobId ? `SF Job #${sfJobId}` : null, extracted.notes]
      .filter(Boolean).join(' | ') || null,
    description: `Service Fusion job #${sfJobId} expense — review & submit`,
    qbo_bill_id: null,
    _attachment: attachment || null,
  };
}

// Insert a prebuilt expense row into ops.expense_requests via the service-role
// key, then attach the receipt image (if stashed). Lands as a draft —
// posted_at stays null until Brixpense posts it to QBO on submit.
export async function postExpenseRow(row) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set' };
  if (!row?.submitted_by) return { ok: false, error: 'no submitter id' };
  const { _attachment, ...finalRow } = row;
  const sbHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    Prefer: 'return=representation',
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/expense_requests`, {
    method: 'POST',
    headers: sbHeaders,
    body: JSON.stringify([finalRow]),
  });
  if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  const out = await res.json();
  const id = Array.isArray(out) ? out[0]?.id : out?.id;

  // Attach the receipt image so it rides along into Brixpense.
  if (id && _attachment?.storage_path) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/expense_request_attachments`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify([{
          request_id: id,
          file_name: _attachment.file_name || 'receipt',
          file_type: _attachment.file_type || null,
          file_size: _attachment.file_size || null,
          storage_path: _attachment.storage_path,
        }]),
      });
    } catch { /* non-fatal — the expense still landed */ }
  }
  return { ok: true, id };
}

// Upload a scanned receipt (base64) to the expense-attachments bucket via the
// service-role key, returning attachment metadata to stash on the WO.
async function uploadReceiptImage(fileData, mediaType, sfJobId) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !fileData) return null;
  try {
    const bytes = Buffer.from(fileData, 'base64');
    const ext = mediaType === 'application/pdf' ? 'pdf'
      : mediaType?.includes('png') ? 'png'
      : mediaType?.includes('webp') ? 'webp' : 'jpg';
    const fileName = `receipt-${Date.now()}.${ext}`;
    const path = `service-fusion/${sfJobId || 'misc'}/${fileName}`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/expense-attachments/${path}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': mediaType || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: bytes,
    });
    if (!res.ok) return null;
    return { storage_path: path, file_name: fileName, file_type: mediaType, file_size: bytes.length };
  } catch {
    return null;
  }
}

// Netlify Blobs store — same store + 'wo-mapping' blob the sync uses, so the
// Bill step can stash the expense onto the WO and Close can land it.
let blobStore;
async function getStore() {
  if (blobStore) return blobStore;
  try {
    const { getStore: createStore } = await import('@netlify/blobs');
    blobStore = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    return blobStore;
  } catch { return null; }
}

function round(n) { return Math.round(n * 100) / 100; }

function err400(msg) {
  return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
}
function err500(msg) {
  return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
}
