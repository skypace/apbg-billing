// Land a Service Fusion job's expense RECEIPTS into Brixpense as reviewable
// DRAFTS — one per SF expense that has a receipt attachment.
//
//   1. fetch the SF job's expenses (host-aware receipt bytes via sf-assets)
//   2. run the Claude receipt scanner on each receipt → vendor / amount / date
//   3. land a DRAFT ops.expense_requests row (status='draft', as_bill,
//      tag='Service Fusion') pre-filled from the scan, with the receipt
//      attached, so the operator can review and SUBMIT (which posts the QBO
//      bill). NOTHING posts to QBO here.
//
// Deduped by ops.expense_requests.sf_expense_id, gated to a start date, and
// idempotent — safe to call repeatedly (sync-time + cron sweep both use it).
import { sfRequest } from '../sf-helpers.mjs';
import { SUPABASE_URL } from '../supabase-helpers.mjs';

const ATTACH_BUCKET = 'expense-attachments';
// Only land expenses dated on/after this (fresh start; override per env).
const START_DATE = process.env.SF_SWEEP_START_DATE || '2026-06-03';

const ACCOUNT_MAP = {
  equipment: { id: '42', name: 'Equipment Sales COGS' },
  service:   { id: '101', name: 'Service COGS' },
};

function srHeaders(extra = {}) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: `Bearer ${k}`, ...extra };
}

// Pull a receipt reference out of an SF expense (string / object / array shapes).
function receiptRefs(ex) {
  const refOf = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return v.file_location || v.url || v.receipt_url || v.path || v.location || null;
    return null;
  };
  const out = [];
  for (const k of ['receipt', 'receipt_url', 'file_location', 'picture', 'image', 'photo']) {
    const r = refOf(ex[k]); if (r) out.push(r);
  }
  for (const k of ['receipts', 'pictures', 'images', 'attachments', 'documents', 'files']) {
    if (Array.isArray(ex[k])) for (const item of ex[k]) { const r = refOf(item); if (r) out.push(r); }
  }
  return [...new Set(out)];
}

// Claude vision scan of a receipt → { vendorName, billDate, lineItems, total }.
// Best-effort: returns null on any failure (the draft still lands from SF data).
async function scanReceipt(bytes, contentType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !bytes?.length) return null;
  const isPdf = (contentType || '').includes('pdf');
  const b64 = Buffer.from(bytes).toString('base64');
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: contentType || 'image/jpeg', data: b64 } };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: 'Extract bill/receipt data. Return ONLY valid JSON, no markdown: {"vendorName":string,"billDate":"YYYY-MM-DD"|null,"total":number|null,"lineItems":[{"description":string,"quantity":number,"unitCost":number,"category":"equipment"|"service"}]}. Labor/service/install/repair=service; goods/parts/materials=equipment. qty defaults 1.',
        messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract the receipt data as JSON.' }] }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch { return null; }
}

async function alreadyLanded(sfExpenseId) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/expense_requests?sf_expense_id=eq.${encodeURIComponent(sfExpenseId)}&select=id&limit=1`,
      { headers: srHeaders({ 'Accept-Profile': 'ops', Accept: 'application/json' }) },
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

export async function landSfJobExpense({ sfJobId, resqCode, submitter }) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, error: 'no service key' };
  if (!submitter?.id) return { ok: false, error: 'no submitter id' };

  let job;
  try {
    job = await sfRequest('GET', `/jobs/${sfJobId}?expand=expenses`);
  } catch (e) {
    return { ok: false, error: `fetch SF job ${sfJobId}: ${String(e.message).slice(0, 200)}` };
  }
  const expenses = Array.isArray(job.expenses) ? job.expenses : [];
  if (!expenses.length) return { ok: false, empty: true, error: 'no SF expenses on job' };

  const startMs = Date.parse(`${START_DATE}T00:00:00Z`) || 0;
  const { fetchSfAssetToBytes } = await import('./sf-assets.mjs');
  let landed = 0, attached = 0;
  const errors = [];

  for (const ex of expenses) {
    const exId = String(ex.id ?? '');
    if (!exId) continue;
    const exDate = ex.expense_date || ex.created_at || null;
    if (exDate && Date.parse(exDate) < startMs) continue;      // before the start date
    const refs = receiptRefs(ex);
    if (!refs.length) continue;                                 // no attachment → nothing to read
    if (await alreadyLanded(exId)) continue;                    // dedup

    // Fetch the receipt bytes (host-aware) + scan it.
    let bytes = null, ct = 'application/octet-stream';
    try {
      const r = await fetchSfAssetToBytes(refs[0]);
      if (r.ok) { bytes = r.bytes; ct = r.contentType || ct; }
      else errors.push(`exp ${exId} fetch: ${r.error}`);
    } catch (e) { errors.push(`exp ${exId} fetch: ${String(e.message).slice(0, 120)}`); }

    const ocr = bytes ? await scanReceipt(bytes, ct) : null;
    const sfAmount = Number(ex.amount ?? ex.total ?? 0) || 0;
    const ocrLines = Array.isArray(ocr?.lineItems) ? ocr.lineItems : [];
    const lineItems = ocrLines.length
      ? ocrLines.map((li) => {
          const amount = Math.round(((li.quantity || 1) * (li.unitCost || 0)) * 100) / 100;
          return { description: li.description || 'Item', qty: li.quantity || 1, unit_price: li.unitCost || 0, amount };
        })
      : [{ description: ex.notes || ex.category || 'Service Fusion expense', qty: 1, unit_price: sfAmount, amount: sfAmount }];
    const total = (ocr?.total ?? lineItems.reduce((s, l) => s + (l.amount || 0), 0)) || sfAmount;
    const acct = ACCOUNT_MAP[String(ex.category || '').toLowerCase()] || null;

    const row = {
      request_type: 'expense',
      status: 'draft',
      as_bill: true,
      tag: 'Service Fusion',
      sf_expense_id: exId,
      submitted_by: submitter.id,
      submitter_name: submitter.user_metadata?.name || submitter.email || 'Service Fusion',
      submitter_email: submitter.email || null,
      vendor_name: ocr?.vendorName || null,
      total_amount: total || null,
      currency: 'USD',
      receipt_date: ocr?.billDate || ex.expense_date || null,
      line_items: lineItems,
      customer_name: job.customer_name || null,
      cogs_account_id: acct?.id || null,
      cogs_account_label: acct?.name || null,
      job_number: String(job.number || sfJobId),
      memo: [resqCode ? `ResQ ${resqCode}` : null, `SF Job #${job.number || sfJobId}`, ex.notes]
        .filter(Boolean).join(' | ') || null,
      description: `Service Fusion job #${job.number || sfJobId} expense — review & submit`,
      qbo_bill_id: null,
    };

    // Insert the draft.
    let requestId;
    try {
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/expense_requests`, {
        method: 'POST',
        headers: srHeaders({ 'Content-Type': 'application/json', 'Accept-Profile': 'ops', 'Content-Profile': 'ops', Prefer: 'return=representation' }),
        body: JSON.stringify([row]),
      });
      if (!ins.ok) { errors.push(`exp ${exId} insert: ${ins.status}`); continue; }
      const out = await ins.json();
      requestId = Array.isArray(out) ? out[0]?.id : out?.id;
    } catch (e) { errors.push(`exp ${exId} insert: ${String(e.message).slice(0, 120)}`); continue; }
    if (!requestId) continue;
    landed++;

    // Attach the receipt image.
    if (bytes) {
      try {
        const ext = (ct.split('/')[1] || 'pdf').replace(/[^a-z0-9]/gi, '') || 'pdf';
        const fileName = `sf-receipt-${exId}.${ext}`;
        const storagePath = `${submitter.id}/${requestId}/${fileName}`;
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATTACH_BUCKET}/${encodeURI(storagePath)}`, {
          method: 'POST', headers: srHeaders({ 'Content-Type': ct, 'x-upsert': 'true' }), body: Buffer.from(bytes),
        });
        if (up.ok) {
          await fetch(`${SUPABASE_URL}/rest/v1/expense_request_attachments`, {
            method: 'POST',
            headers: srHeaders({ 'Content-Type': 'application/json', 'Accept-Profile': 'ops', 'Content-Profile': 'ops', Prefer: 'return=minimal' }),
            body: JSON.stringify([{ request_id: requestId, file_name: fileName, file_type: ct, file_size: bytes.byteLength ?? null, storage_path: storagePath }]),
          });
          attached++;
        }
      } catch (e) { errors.push(`exp ${exId} attach: ${String(e.message).slice(0, 120)}`); }
    }
  }

  if (landed === 0) return { ok: false, empty: true, error: errors.join(' | ').slice(0, 200) || 'no new receipts to land' };
  return { ok: true, landed, attached, errors };
}
