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

const ACCOUNT_MAP = {
  equipment: { id: '42', name: 'Equipment Sales COGS' },
  service:   { id: '101', name: 'Service COGS' },
};
const DEFAULT_ACCOUNT = ACCOUNT_MAP.service;

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

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

    // ── 2. Match vendor in QBO ──
    let qboVendor = null;
    // Try hint name first (manual override from UI), then extracted name
    const vendorNames = [vendorNameHint, extracted.vendorName].filter(Boolean);
    for (const vn of vendorNames) {
      qboVendor = await findQBOVendor(vn);
      if (qboVendor) break;
    }

    if (!qboVendor) {
      // Return extracted data but don't create bill — need vendor match
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({
          success: false,
          needsVendor: true,
          extracted,
          message: `Could not match vendor "${extracted.vendorName}" in QuickBooks. Select a vendor manually.`,
        }),
      };
    }

    // ── 3. Create QBO bill ──
    const billResult = await createQBOBill({
      vendor: qboVendor,
      extracted,
      sfJobId,
      resqCode,
    });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        extracted,
        vendor: { id: qboVendor.Id, name: qboVendor.DisplayName },
        bill: billResult,
        message: `Bill #${billResult.number || billResult.id} created for ${qboVendor.DisplayName} — $${billResult.total.toFixed(2)}`,
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

async function createQBOBill({ vendor, extracted, sfJobId, resqCode }) {
  const lineItems = extracted.lineItems || [];
  if (lineItems.length === 0) {
    throw new Error('No line items found on receipt');
  }

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

function round(n) { return Math.round(n * 100) / 100; }

function err400(msg) {
  return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
}
function err500(msg) {
  return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
}
