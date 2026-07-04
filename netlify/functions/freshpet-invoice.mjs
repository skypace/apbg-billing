// Freshpet PM billing → QBO invoice.
//
// Called from the Freshpet admin console (Billing tab). The operator selects
// completed PMs (unbilled, not "prev comp") and requests an invoice for the
// FRESH PET QBO customer. This function:
//   1. Verifies the caller's *Freshpet* Supabase JWT (project mmkncrsaijexezmhfmiw)
//      and that they are a tech_profiles.role='admin' there.
//   2. Re-reads the selected completed_pms server-side (using the caller's JWT)
//      so line counts/amounts can't be tampered client-side.
//   3. mode='preview' → returns the computed totals, nothing written.
//      mode='create'  → posts a single summary line to a QBO invoice, marks the
//      PMs billed, fetches the invoice PDF + builds a CSV visit report, and
//      (optionally) emails a brix-branded "invoice is ready" note with both
//      attached.
//
// Auth boundary note: apbg-billing's lib/auth.mjs verifies the GATEWAY Supabase
// project (gfsdpwiqzshhexkofiif). Freshpet lives in a different project, so this
// function does its own JWT verification against the Freshpet project. The only
// secret it needs is the QBO connection (already here) + RESEND; the Freshpet
// URL + anon key are public (shipped in the Freshpet HTML) and hardcoded as
// fallbacks so this works before any new env var is set.

import { qboRequest, qboQuery, getAccessToken, corsHeaders } from './qbo-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { renderFreshpetInvoiceEmail } from './freshpet-invoice-email.mjs';

const QBO_BASE = 'https://quickbooks.api.intuit.com';

const FRESHPET_SUPABASE_URL =
  process.env.FRESHPET_SUPABASE_URL || 'https://mmkncrsaijexezmhfmiw.supabase.co';
const FRESHPET_ANON_KEY =
  process.env.FRESHPET_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ta25jcnNhaWpleGV6bWhmbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkyMjUsImV4cCI6MjA5NjM3NTIyNX0.lx4J-YhlFFrQVJMqjeBXXHNmgZfRe23xYGKZMEL8dPM';

const FRESHPET_QBO_CUSTOMER_ID = process.env.FRESHPET_QBO_CUSTOMER_ID || '759'; // FRESH PET
// Preferred QBO service item to bill against, tried in order. FP-SVC-PM may not
// exist yet — falls back to existing Freshpet / PM service items.
const ITEM_NAME_CANDIDATES = [
  process.env.FRESHPET_QBO_ITEM_NAME || 'FP-SVC-PM',
  'FP-SVC-CALL',
  'SVC-PM',
  'Service Provided',
];
const DEFAULT_RATE = 30;

function json(statusCode, obj) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) };
}
function round(n) { return Math.round(Number(n) * 100) / 100; }
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// PostgREST GET against the Freshpet project using the caller's JWT (so RLS
// applies as the authenticated admin).
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
    headers: {
      apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Freshpet write ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

async function resolveItemId() {
  for (const name of ITEM_NAME_CANDIDATES) {
    if (!name) continue;
    const safe = name.replace(/'/g, "\\'");
    try {
      const q = await qboQuery(`SELECT Id, Name FROM Item WHERE Name = '${safe}'`);
      const item = q?.QueryResponse?.Item?.[0];
      if (item?.Id) return { id: item.Id, name: item.Name };
    } catch (e) { /* try next */ }
  }
  return null;
}

// Upload the invoice PDF to the Freshpet `fp-invoices` public bucket (using the
// caller's JWT) so the customer portal can link to it. Returns the object path.
async function uploadInvoicePdf(jwt, docNumber, pdfB64) {
  try {
    const path = `Invoice-${String(docNumber).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
    const res = await fetch(`${FRESHPET_SUPABASE_URL}/storage/v1/object/fp-invoices/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: {
        apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/pdf', 'x-upsert': 'true',
      },
      body: Buffer.from(pdfB64, 'base64'),
    });
    if (!res.ok) return null;
    return path;
  } catch (e) { return null; }
}

async function fetchInvoicePdfBase64(invoiceId) {
  try {
    const token = await getAccessToken();
    const realm = process.env.QBO_REALM_ID;
    const res = await fetch(`${QBO_BASE}/v3/company/${realm}/invoice/${invoiceId}/pdf`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } catch (e) { return null; }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // ── auth: verify the Freshpet JWT + admin role ──
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return json(401, { error: 'Missing Authorization bearer token' });
  const jwt = m[1];

  let adminEmail, adminName;
  try {
    const uRes = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!uRes.ok) return json(401, { error: 'Invalid or expired token' });
    const u = await uRes.json();
    adminEmail = u?.email;
    if (!adminEmail) return json(401, { error: 'Invalid token' });
    const profiles = await fpGet(
      `tech_profiles?email=eq.${encodeURIComponent(adminEmail)}&select=email,role,name`, jwt);
    const prof = Array.isArray(profiles) ? profiles[0] : null;
    if (!prof || prof.role !== 'admin') return json(403, { error: 'Freshpet admin role required' });
    adminName = prof.name || adminEmail;
  } catch (e) {
    return json(502, { error: 'Freshpet auth check failed: ' + e.message });
  }

  // ── payload ──
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const mode = payload.mode === 'create' ? 'create' : 'preview';
  const pmIds = Array.isArray(payload.pmIds) ? payload.pmIds.map(Number).filter(Boolean) : [];
  const rate = payload.rate != null && Number(payload.rate) > 0 ? round(payload.rate) : DEFAULT_RATE;
  const recipientEmail = (payload.recipientEmail || '').trim();
  if (!pmIds.length) return json(400, { error: 'Select at least one completed PM' });

  // ── re-read PMs authoritatively ──
  let rows;
  try {
    // completed_pms has no city column — embed it from the linked asset via FK.
    rows = await fpGet(
      `completed_pms?id=in.(${pmIds.join(',')})&select=id,store,serial,pm_date,tech_name,prev_comp,billed,assets(city)`, jwt);
  } catch (e) {
    return json(502, { error: 'Could not load PMs: ' + e.message });
  }
  const eligible = rows.filter(r => !r.prev_comp && !r.billed);
  const skipped = rows.filter(r => r.prev_comp || r.billed)
    .map(r => ({ id: r.id, store: r.store, reason: r.billed ? 'already billed' : 'prev comp' }));

  if (!eligible.length) {
    return json(400, { error: 'None of the selected PMs are billable', skipped });
  }

  const dates = eligible.map(r => r.pm_date).filter(Boolean).sort();
  const minDate = dates[0] || '';
  const maxDate = dates[dates.length - 1] || '';
  const periodLabel = minDate ? (minDate === maxDate ? minDate : `${minDate} – ${maxDate}`) : '';
  const count = eligible.length;
  const total = round(count * rate);

  const lines = eligible.map(r => ({
    id: r.id, store: r.store, serial: r.serial, city: r.assets?.city || '', pm_date: r.pm_date,
    tech: r.tech_name, amount: rate,
  }));

  if (mode === 'preview') {
    return json(200, {
      mode: 'preview', customerId: FRESHPET_QBO_CUSTOMER_ID,
      count, rate, total, periodLabel, skipped, lines,
    });
  }

  // ── mode=create ──
  const item = await resolveItemId();
  if (!item) return json(500, { error: 'No QBO service item found (tried ' + ITEM_NAME_CANDIDATES.filter(Boolean).join(', ') + ')' });

  const description =
    `Freshpet Preventive Maintenance — ${count} completed visit${count === 1 ? '' : 's'}` +
    (periodLabel ? ` (${periodLabel})` : '');

  const invoicePayload = {
    CustomerRef: { value: FRESHPET_QBO_CUSTOMER_ID },
    Line: [{
      DetailType: 'SalesItemLineDetail',
      Amount: total,
      Description: description,
      SalesItemLineDetail: { ItemRef: { value: item.id }, Qty: count, UnitPrice: rate },
    }],
    CustomerMemo: { value: description },
    PrivateNote: `Freshpet PM billing · ${count} visits @ $${rate} · ${periodLabel || 'n/a'} · billed by ${adminEmail}`,
  };

  let created;
  try {
    const result = await qboRequest('POST', '/invoice', invoicePayload);
    created = result.Invoice;
  } catch (e) {
    return json(502, { error: 'QBO invoice create failed: ' + e.message });
  }

  const warnings = [];

  // Fetch the QBO invoice PDF + stash it in the Freshpet `fp-invoices` bucket so
  // the customer portal can link to it (both best-effort).
  const pdfB64 = await fetchInvoicePdfBase64(created.Id);
  let invoicePdfPath = null;
  if (pdfB64) invoicePdfPath = await uploadInvoicePdf(jwt, created.DocNumber || created.Id, pdfB64);

  // Mark billed (best-effort but important — surface a clear warning if it fails
  // so the operator doesn't double-bill).
  try {
    await fpPatch(`completed_pms?id=in.(${eligible.map(r => r.id).join(',')})`, jwt, {
      billed: true, bill_amount: rate, invoice_id: created.Id,
      invoice_doc_number: created.DocNumber || null,
      invoice_pdf_path: invoicePdfPath,
      invoiced_at: new Date().toISOString(), invoiced_by: adminEmail,
    });
  } catch (e) {
    warnings.push(`Invoice #${created.DocNumber || created.Id} was created but marking the PMs as billed FAILED (${e.message}). Do NOT re-bill these — mark them manually. PM ids: ${eligible.map(r => r.id).join(', ')}`);
  }

  // Build CSV visit report.
  const csvHeader = 'Store,City,Serial,PM Date,Technician,Amount';
  const csvBody = eligible.map(r =>
    [csvCell(r.store), csvCell(r.assets?.city || ''), csvCell(r.serial), csvCell(r.pm_date), csvCell(r.tech_name), rate.toFixed(2)].join(',')
  ).join('\n');
  const csvB64 = Buffer.from(`${csvHeader}\n${csvBody}\n`).toString('base64');
  const periodTag = (minDate || 'report').replace(/[^0-9]/g, '') || 'report';

  // Email (optional).
  let emailed = false;
  if (recipientEmail) {
    try {
      const attachments = [{ filename: `freshpet-pm-report-${periodTag}.csv`, content: csvB64 }];
      if (pdfB64) attachments.push({ filename: `Invoice-${created.DocNumber || created.Id}.pdf`, content: pdfB64 });
      const { subject, html, text } = renderFreshpetInvoiceEmail({
        recipientName: null, customerName: created.CustomerRef?.name || 'FRESH PET',
        docNumber: created.DocNumber || created.Id,
        invoiceDate: created.TxnDate || new Date().toISOString().slice(0, 10),
        dueDate: created.DueDate || null,
        totalAmount: total, balance: created.Balance != null ? created.Balance : total,
        invoiceUrl: created.InvoiceLink || '', visitCount: count, periodLabel,
      });
      await sendEmail({ to: recipientEmail, subject, html, text, attachments, from: 'APBG Billing <alerts@alamedapointbg.com>' });
      emailed = true;
    } catch (e) {
      warnings.push('Invoice created but email send failed: ' + e.message);
    }
  }

  return json(200, {
    mode: 'create',
    invoice: {
      id: created.Id, docNumber: created.DocNumber || created.Id, total,
      customerName: created.CustomerRef?.name || 'FRESH PET',
      itemUsed: item.name, invoiceLink: created.InvoiceLink || null,
      pdfStored: !!invoicePdfPath,
    },
    billedCount: count, rate, periodLabel, emailed, skipped, warnings,
  });
}
