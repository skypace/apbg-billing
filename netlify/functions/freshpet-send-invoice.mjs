// Freshpet — send (or re-send) an invoice email to Freshpet accounting.
//
// A standalone "email this invoice" endpoint the admin console calls from its
// Send Invoice tab. The operator picks an already-created invoice (PM or
// Reactive), types one or more recipient emails, and this sends the clean
// branded "your invoice is ready" email:
//   • Reactive  → the FP-QRB invoice PDF (from the fp-invoices bucket) is ATTACHED.
//   • PM        → the email links to the customer portal so Freshpet can view
//                 the service backup (photos + signed reports); the PM invoice
//                 PDF is also attached unless the operator turns it off.
//
// No QBO / DB writes — this only reads invoice metadata + the stored PDF and
// sends mail. Auth: the caller's Freshpet Supabase JWT (project
// mmkncrsaijexezmhfmiw) must belong to a tech_profiles.role='admin'.

import { corsHeaders } from './qbo-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { renderFreshpetInvoiceEmail } from './freshpet-invoice-email.mjs';

const FRESHPET_SUPABASE_URL =
  process.env.FRESHPET_SUPABASE_URL || 'https://mmkncrsaijexezmhfmiw.supabase.co';
const FRESHPET_ANON_KEY =
  process.env.FRESHPET_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ta25jcnNhaWpleGV6bWhmbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkyMjUsImV4cCI6MjA5NjM3NTIyNX0.lx4J-YhlFFrQVJMqjeBXXHNmgZfRe23xYGKZMEL8dPM';
const PORTAL_BASE = 'https://alamedapointbg.com/freshpet/portal';

function json(statusCode, obj) { return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) }; }
function round(n) { return Math.round(Number(n) * 100) / 100; }
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }
function pdfPath(ref) { return `Invoice-${String(ref).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`; }

async function fpGet(path, jwt) {
  const res = await fetch(`${FRESHPET_SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`Freshpet read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Fetch a stored invoice PDF from the public fp-invoices bucket → base64.
async function fetchPdfBase64(path) {
  try {
    const res = await fetch(`${FRESHPET_SUPABASE_URL}/storage/v1/object/public/fp-invoices/${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch (e) { return null; }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // ── auth: Freshpet JWT + admin role ──
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return json(401, { error: 'Missing Authorization bearer token' });
  const jwt = m[1];
  try {
    const uRes = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` } });
    if (!uRes.ok) return json(401, { error: 'Invalid or expired token' });
    const email = (await uRes.json())?.email;
    if (!email) return json(401, { error: 'Invalid token' });
    const prof = (await fpGet(`tech_profiles?email=eq.${encodeURIComponent(email)}&select=role`, jwt))[0];
    if (!prof || prof.role !== 'admin') return json(403, { error: 'Freshpet admin role required' });
  } catch (e) { return json(502, { error: 'Freshpet auth check failed: ' + e.message }); }

  // ── payload ──
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const type = payload.type === 'pm' ? 'pm' : payload.type === 'reactive' ? 'reactive' : null;
  const ref = (payload.ref || '').toString().trim();
  const attachPdf = payload.attachPdf !== false; // default true
  if (!type) return json(400, { error: "type must be 'reactive' or 'pm'" });
  if (!ref) return json(400, { error: 'ref (invoice number) is required' });

  const recipients = (Array.isArray(payload.recipients) ? payload.recipients : String(payload.recipients || '').split(/[,;\s]+/))
    .map(s => String(s || '').trim()).filter(Boolean);
  if (!recipients.length) return json(400, { error: 'At least one recipient email is required' });
  const bad = recipients.find(e => !isEmail(e));
  if (bad) return json(400, { error: 'Invalid recipient email: ' + bad });

  // ── resolve the invoice's totals + PDF path from the Freshpet DB ──
  let customerName = 'FRESH PET', total = 0, count = 0, periodLabel = '', invoiceDate = null, storedPdf = null;
  try {
    if (type === 'reactive') {
      const b = (await fpGet(`reactive_batches?invoice_ref=eq.${encodeURIComponent(ref)}&select=invoice_ref,quarter_label,location,total,billable_count,invoice_pdf_path,created_at`, jwt))[0];
      if (!b) return json(404, { error: `No reactive invoice ${ref} found` });
      total = round(b.total || 0);
      count = b.billable_count || 0;
      periodLabel = [b.quarter_label, b.location].filter(Boolean).join(' · ');
      invoiceDate = b.created_at ? String(b.created_at).slice(0, 10) : null;
      storedPdf = b.invoice_pdf_path || pdfPath(ref);
    } else {
      const rows = await fpGet(`completed_pms?invoice_doc_number=eq.${encodeURIComponent(ref)}&select=bill_amount,pm_date,invoice_pdf_path,invoiced_at`, jwt);
      if (!rows.length) return json(404, { error: `No PM invoice #${ref} found` });
      count = rows.length;
      total = round(rows.reduce((s, r) => s + Number(r.bill_amount || 0), 0));
      const dates = rows.map(r => r.pm_date).filter(Boolean).sort();
      if (dates.length) periodLabel = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`;
      invoiceDate = (rows.find(r => r.invoiced_at)?.invoiced_at || dates[dates.length - 1] || null);
      if (invoiceDate) invoiceDate = String(invoiceDate).slice(0, 10);
      storedPdf = rows.find(r => r.invoice_pdf_path)?.invoice_pdf_path || pdfPath(ref);
    }
  } catch (e) { return json(502, { error: 'Could not load invoice: ' + e.message }); }

  // ── attachment (best-effort) ──
  const attachments = [];
  let attached = false;
  if (attachPdf && storedPdf) {
    const b64 = await fetchPdfBase64(storedPdf);
    if (b64) { attachments.push({ filename: `${ref}.pdf`, content: b64 }); attached = true; }
  }

  // ── render + send ──
  const portalUrl = `${PORTAL_BASE}?invoice=${encodeURIComponent(ref)}`;
  const { subject, html, text } = renderFreshpetInvoiceEmail({
    recipientName: null, customerName, docNumber: ref, invoiceDate, dueDate: null,
    totalAmount: total, balance: total, invoiceUrl: '', visitCount: count, periodLabel,
    billingType: type, portalUrl,
  });
  try {
    await sendEmail({ to: recipients, subject, html, text, attachments, from: 'APBG Billing <alerts@alamedapointbg.com>' });
  } catch (e) { return json(502, { error: 'Email send failed: ' + e.message }); }

  return json(200, { sent: true, type, ref, recipients, attached, portalUrl, total, count });
}
