// Freshpet Quarterly Reactive Service → QBO invoice.
//
// The Reactive contract: Freshpet prepays a quarterly retainer of a flat rate
// per OUT-OF-WARRANTY cooler in a location; when they call, we fix it. The
// admin console imports a CSV as a reactive_batch (+ reactive_assets, each
// flagged under_warranty / billable / approved) and calls this to invoice it.
//
// One QBO invoice, one FP-SVC summary line (qty = billable/out-of-warranty
// count × rate), numbered FP-QRB-####. The PDF is our shared template: page 1
// = branded invoice, page 2+ = the full asset report (every asset pulled in,
// with its warranty status) so Freshpet sees exactly what's covered vs billed.
// PDF is stored to fp-invoices for the portal; optionally emailed.

import { qboRequest, qboQuery, corsHeaders } from './qbo-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { renderFreshpetInvoiceEmail } from './freshpet-invoice-email.mjs';
import { renderFreshpetInvoicePdf } from './lib/freshpet-invoice-pdf.mjs';

const FRESHPET_SUPABASE_URL =
  process.env.FRESHPET_SUPABASE_URL || 'https://mmkncrsaijexezmhfmiw.supabase.co';
const FRESHPET_ANON_KEY =
  process.env.FRESHPET_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ta25jcnNhaWpleGV6bWhmbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkyMjUsImV4cCI6MjA5NjM3NTIyNX0.lx4J-YhlFFrQVJMqjeBXXHNmgZfRe23xYGKZMEL8dPM';
const FRESHPET_QBO_CUSTOMER_ID = process.env.FRESHPET_QBO_CUSTOMER_ID || '759';
const ITEM_NAME_CANDIDATES = [
  process.env.FRESHPET_QBO_REACTIVE_ITEM_NAME || 'FP-SVC',
  'FP-SVC-CALL', 'SVC-PM', 'Service Provided',
];

function json(statusCode, obj) { return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) }; }
function round(n) { return Math.round(Number(n) * 100) / 100; }

async function fpGet(path, jwt) {
  const res = await fetch(`${FRESHPET_SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`Freshpet read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function fpPatch(path, jwt, body) {
  const res = await fetch(`${FRESHPET_SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Freshpet write ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
async function resolveItemId() {
  for (const name of ITEM_NAME_CANDIDATES) {
    if (!name) continue;
    try {
      const q = await qboQuery(`SELECT Id, Name FROM Item WHERE Name = '${name.replace(/'/g, "\\'")}'`);
      const item = q?.QueryResponse?.Item?.[0];
      if (item?.Id) return { id: item.Id, name: item.Name };
    } catch (e) { /* next */ }
  }
  return null;
}
async function uploadPdf(jwt, ref, bytes) {
  try {
    const path = `Invoice-${String(ref).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
    const res = await fetch(`${FRESHPET_SUPABASE_URL}/storage/v1/object/fp-invoices/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
      body: Buffer.from(bytes),
    });
    if (!res.ok) return null;
    return path;
  } catch (e) { return null; }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return json(401, { error: 'Missing Authorization bearer token' });
  const jwt = m[1];

  let adminEmail;
  try {
    const uRes = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` } });
    if (!uRes.ok) return json(401, { error: 'Invalid or expired token' });
    adminEmail = (await uRes.json())?.email;
    const prof = (await fpGet(`tech_profiles?email=eq.${encodeURIComponent(adminEmail)}&select=role`, jwt))[0];
    if (!prof || prof.role !== 'admin') return json(403, { error: 'Freshpet admin role required' });
  } catch (e) { return json(502, { error: 'Freshpet auth check failed: ' + e.message }); }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const mode = payload.mode === 'create' ? 'create' : 'preview';
  const batchId = payload.batchId;
  const recipientEmail = (payload.recipientEmail || '').trim();
  if (!batchId) return json(400, { error: 'batchId is required' });

  // Load the batch + its approved assets.
  let batch, assets;
  try {
    batch = (await fpGet(`reactive_batches?id=eq.${encodeURIComponent(batchId)}&select=*`, jwt))[0];
    if (!batch) return json(404, { error: 'Reactive batch not found' });
    if (batch.status === 'invoiced') return json(409, { error: `Batch already invoiced (${batch.invoice_ref})` });
    assets = await fpGet(`reactive_assets?batch_id=eq.${encodeURIComponent(batchId)}&approved=eq.true&select=store,city,serial,model,manufacturer,under_warranty,billable&order=store`, jwt);
  } catch (e) { return json(502, { error: 'Could not load batch: ' + e.message }); }

  const billable = assets.filter(a => a.billable && !a.under_warranty);
  const rate = payload.rate != null && Number(payload.rate) > 0 ? round(payload.rate) : round(batch.rate || 30);
  const count = billable.length;
  const total = round(count * rate);
  const ref = batch.invoice_ref;
  const summaryLabel = `Freshpet Quarterly Reactive Service — ${count} out-of-warranty cooler${count === 1 ? '' : 's'}` +
    (batch.quarter_label ? ` (${batch.quarter_label})` : '') + (batch.location ? ` · ${batch.location}` : '');

  if (mode === 'preview') {
    return json(200, { mode: 'preview', invoiceRef: ref, quarter: batch.quarter_label, location: batch.location,
      assetCount: assets.length, billableCount: count, rate, total });
  }

  if (!count) return json(400, { error: 'No out-of-warranty (billable) assets in this batch' });

  // ── create QBO invoice (one FP-SVC summary line) ──
  const item = await resolveItemId();
  if (!item) return json(500, { error: 'No QBO service item found (tried ' + ITEM_NAME_CANDIDATES.filter(Boolean).join(', ') + ')' });

  const invoicePayload = {
    CustomerRef: { value: FRESHPET_QBO_CUSTOMER_ID },
    DocNumber: ref,   // FP-QRB-#### (used if custom transaction numbers are on)
    Line: [{
      DetailType: 'SalesItemLineDetail', Amount: total, Description: summaryLabel,
      SalesItemLineDetail: { ItemRef: { value: item.id }, Qty: count, UnitPrice: rate },
    }],
    CustomerMemo: { value: summaryLabel },
    PrivateNote: `Freshpet Quarterly Reactive · ${ref} · ${count} OOW @ $${rate} · ${assets.length} assets total · by ${adminEmail}`,
  };

  let created;
  try { created = (await qboRequest('POST', '/invoice', invoicePayload)).Invoice; }
  catch (e) { return json(502, { error: 'QBO invoice create failed: ' + e.message }); }

  const warnings = [];

  // ── render the shared template PDF (page 1 invoice + page 2+ asset report) ──
  let pdfPath = null, pdfBytes = null;
  try {
    pdfBytes = await renderFreshpetInvoicePdf({
      invoiceRef: ref, billingType: 'reactive', customerName: created.CustomerRef?.name || 'FRESH PET',
      billTo: null, invoiceDate: created.TxnDate || new Date().toISOString().slice(0, 10),
      dueDate: created.DueDate || null, summaryLabel, qty: count, rate, total,
      assets: assets.map(a => ({ store: a.store, city: a.city, serial: a.serial, model: a.model,
        warranty: a.under_warranty ? 'Under warranty' : 'Out of warranty' })),
    });
    pdfPath = await uploadPdf(jwt, ref, pdfBytes);
  } catch (e) { warnings.push('PDF render/store failed: ' + e.message); }

  // ── mark the batch invoiced ──
  try {
    await fpPatch(`reactive_batches?id=eq.${encodeURIComponent(batchId)}`, jwt, {
      status: 'invoiced', invoice_id: created.Id, invoice_pdf_path: pdfPath,
      billable_count: count, asset_count: assets.length, total,
    });
  } catch (e) {
    warnings.push(`Invoice ${ref} created but marking the batch invoiced FAILED (${e.message}). QBO invoice id ${created.Id}.`);
  }

  // ── email (optional) ──
  let emailed = false;
  if (recipientEmail) {
    try {
      const attachments = [];
      if (pdfBytes) attachments.push({ filename: `${ref}.pdf`, content: Buffer.from(pdfBytes).toString('base64') });
      const { subject, html, text } = renderFreshpetInvoiceEmail({
        recipientName: null, customerName: created.CustomerRef?.name || 'FRESH PET', docNumber: ref,
        invoiceDate: created.TxnDate || new Date().toISOString().slice(0, 10), dueDate: created.DueDate || null,
        totalAmount: total, balance: created.Balance != null ? created.Balance : total,
        invoiceUrl: created.InvoiceLink || '', visitCount: count, periodLabel: batch.quarter_label || '',
        portalUrl: 'https://alamedapointbg.com/freshpet/portal?invoice=' + encodeURIComponent(ref),
      });
      await sendEmail({ to: recipientEmail, subject, html, text, attachments, from: 'APBG Billing <alerts@alamedapointbg.com>' });
      emailed = true;
    } catch (e) { warnings.push('Invoice created but email send failed: ' + e.message); }
  }

  return json(200, {
    mode: 'create',
    invoice: { ref, qboId: created.Id, total, billableCount: count, assetCount: assets.length, itemUsed: item.name, pdfStored: !!pdfPath },
    emailed, warnings,
  });
}
