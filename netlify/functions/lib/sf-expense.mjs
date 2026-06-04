// Land a Service Fusion job's expenses into Brixpense when the WO is invoiced.
// ONE combined ops.expense_requests row per job: line_items = the SF expense
// lines, total = sum, tag 'Service Fusion'. Each SF expense receipt is fetched
// host-aware and uploaded to the private `expense-attachments` bucket with an
// expense_request_attachments row, so the receipt shows up in Brixpense.
//
// Server-side via the service-role key. Best-effort: the row lands even if a
// receipt fetch/upload fails. Caller is responsible for idempotency (don't call
// twice for the same job).
import { sfRequest } from '../sf-helpers.mjs';
import { SUPABASE_URL } from '../supabase-helpers.mjs';

const ATTACH_BUCKET = 'expense-attachments';

function srHeaders(extra = {}) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: `Bearer ${k}`, ...extra };
}

export async function landSfJobExpense({ sfJobId, resqCode, submitter }) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, error: 'no service key' };
  if (!submitter?.id) return { ok: false, error: 'no submitter id' };

  // 1. Pull the SF job's expenses (and customer name).
  let job;
  try {
    job = await sfRequest('GET', `/jobs/${sfJobId}?expand=expenses`);
  } catch (e) {
    return { ok: false, error: `fetch SF job ${sfJobId}: ${String(e.message).slice(0, 200)}` };
  }
  const expenses = Array.isArray(job.expenses) ? job.expenses : [];
  if (!expenses.length) return { ok: false, empty: true, error: 'no SF expenses on job' };

  // 2. One row per job — just the lines + total.
  const lineItems = expenses.map((ex) => {
    const amount = Number(ex.amount ?? ex.total ?? 0) || 0;
    const description =
      [ex.category, ex.notes].filter(Boolean).join(' — ') || 'Service Fusion expense';
    return { description, qty: 1, unit_price: amount, amount };
  });
  const total = Math.round(lineItems.reduce((s, l) => s + (l.amount || 0), 0) * 100) / 100;

  const row = {
    request_type: 'expense',
    status: 'posted',
    as_bill: true,
    auto_approved: true,
    tag: 'Service Fusion',
    submitted_by: submitter.id,
    submitter_name: submitter.user_metadata?.name || submitter.email || 'Service Fusion',
    submitter_email: submitter.email || null,
    vendor_name: null,
    total_amount: total,
    currency: 'USD',
    line_items: lineItems,
    customer_name: job.customer_name || null,
    job_number: String(sfJobId),
    memo: [resqCode ? `ResQ ${resqCode}` : null, `SF Job #${sfJobId}`, `${expenses.length} SF expense line(s)`]
      .filter(Boolean).join(' | '),
    description: `Service Fusion job #${sfJobId} expenses`,
    posted_at: new Date().toISOString(),
  };

  // 3. Insert the expense_requests row.
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/expense_requests`, {
    method: 'POST',
    headers: srHeaders({
      'Content-Type': 'application/json',
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify([row]),
  });
  if (!ins.ok) return { ok: false, error: `insert expense: ${ins.status} ${(await ins.text()).slice(0, 200)}` };
  const out = await ins.json();
  const requestId = Array.isArray(out) ? out[0]?.id : out?.id;
  if (!requestId) return { ok: false, error: 'insert returned no id' };

  // 4. Attach receipts (best-effort — the row already landed).
  const attached = [];
  const attachErrors = [];
  for (let i = 0; i < expenses.length; i++) {
    const ex = expenses[i];
    const recRef = ex.receipt_url || ex.receipt || ex.file_location || null;
    if (!recRef) continue;
    try {
      const { fetchSfAssetToBytes } = await import('./sf-assets.mjs');
      const r = await fetchSfAssetToBytes(recRef);
      if (!r.ok) { attachErrors.push(`exp ${ex.id || i}: ${r.error}`); continue; }
      const ct = r.contentType || 'application/octet-stream';
      const ext = (ct.split('/')[1] || 'pdf').replace(/[^a-z0-9]/gi, '') || 'pdf';
      const fileName = `sf-expense-${ex.id || i}.${ext}`;
      const storagePath = `${submitter.id}/${requestId}/${fileName}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATTACH_BUCKET}/${encodeURI(storagePath)}`, {
        method: 'POST',
        headers: srHeaders({ 'Content-Type': ct, 'x-upsert': 'true' }),
        body: Buffer.from(r.bytes),
      });
      if (!up.ok) { attachErrors.push(`exp ${ex.id || i} upload: ${up.status}`); continue; }
      await fetch(`${SUPABASE_URL}/rest/v1/expense_request_attachments`, {
        method: 'POST',
        headers: srHeaders({
          'Content-Type': 'application/json',
          'Accept-Profile': 'ops',
          'Content-Profile': 'ops',
          Prefer: 'return=minimal',
        }),
        body: JSON.stringify([{
          request_id: requestId,
          file_name: fileName,
          file_type: ct,
          file_size: r.bytes.byteLength ?? null,
          storage_path: storagePath,
        }]),
      });
      attached.push(fileName);
    } catch (e) {
      attachErrors.push(`exp ${ex.id || i}: ${String(e.message).slice(0, 150)}`);
    }
  }

  return { ok: true, id: requestId, lines: lineItems.length, total, attached: attached.length, attachErrors };
}
