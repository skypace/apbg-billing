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
import { renderFreshpetInvoicePdf } from './lib/freshpet-invoice-pdf.mjs';
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
// When the PM was signed (client clock) + the tech's GPS at signing.
function fmtSignedAt(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return String(iso); }
}
function fmtGps(lat, lng) {
  if (lat == null || lng == null) return '';
  const a = Number(lat), b = Number(lng);
  if (isNaN(a) || isNaN(b)) return '';
  return a.toFixed(5) + ', ' + b.toFixed(5);
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
async function uploadInvoicePdf(jwt, docNumber, bytes) {
  try {
    const path = `Invoice-${String(docNumber).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
    const res = await fetch(`${FRESHPET_SUPABASE_URL}/storage/v1/object/fp-invoices/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: {
        apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/pdf', 'x-upsert': 'true',
      },
      body: Buffer.from(bytes),
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
      `completed_pms?id=in.(${pmIds.join(',')})&select=id,store,serial,pm_date,tech_name,prev_comp,billed,added_asset,visit_type,signed_at,gps_lat,gps_lng,billing_hold_at,billing_hold_outcome,revisit_done_pm_id,assets(city,model,warranty)`, jwt);
  } catch (e) {
    return json(502, { error: 'Could not load PMs: ' + e.message });
  }
  // Two visit types are never billable to Freshpet, enforced here as well as in
  // the admin UI so a stale client can't invoice one:
  //   'exception' — the tech reached the site but could not service the unit
  //     (store closed / unit missing). Documented for Freshpet, not a PM.
  //     Invoice #172825 shipped 5 closed-store "PMs" before this gate existed.
  //   'reshoot'   — a stop we sent someone back to because OUR documentation was
  //     unusable. The customer already paid for that stop once; charging them for
  //     our own remediation is not on. The tech is still paid in full (that runs
  //     off completed_pms.paid_out, which does not look at visit_type).
  const NOT_BILLABLE = { exception: 'site exception — not a billable PM', reshoot: 're-shoot — our remediation, never charged to Freshpet' };
  // A RE-SHOOT IS NEVER BILLED, and that means the STOP, not just the new
  // report. Excluding visit_type 'reshoot' only covers half of it: the ORIGINAL
  // is an ordinary 'pm' row, and closing its billing hold as 'released' used to
  // drop it straight back in here. On the 19 held lines that were never
  // invoiced that would not have reinstated a charge, it would have CREATED one
  // — for the very stop whose documentation we told the customer we could not
  // stand behind. A stop we sent someone back to is not charged, full stop.
  // Also enforced by tg_reshot_never_billed in Postgres, which refuses to set
  // billed on such a row at all.
  const wasReshot = r => !!r.revisit_done_pm_id;
  // A line under a live billing hold does not go out. The hold means we are not
  // standing behind that unit's documentation yet, and invoicing it anyway is
  // exactly the thing the hold exists to stop — it is checked HERE, at the last
  // step before a real QBO invoice, not only in the admin list, because that
  // list is a convenience and this is the gate.
  const onHold = r => !!r.billing_hold_at && !r.billing_hold_outcome;
  const eligible = rows.filter(r => !r.prev_comp && !r.billed && !NOT_BILLABLE[r.visit_type]
    && !wasReshot(r) && !onHold(r));
  const skipped = rows.filter(r => r.prev_comp || r.billed || NOT_BILLABLE[r.visit_type]
    || wasReshot(r) || onHold(r))
    .map(r => ({ id: r.id, store: r.store, reason: r.billed ? 'already billed'
      : wasReshot(r) ? 're-shot stop — never charged to Freshpet (replaced by report ' + r.revisit_done_pm_id + ')'
      : onHold(r) ? 'billing hold — held pending re-documentation'
      : (NOT_BILLABLE[r.visit_type] || 'prev comp') }));

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

  // Field-added assets are units our techs discovered on site that weren't on
  // Freshpet's asset list — call them out on the invoice line.
  const addedCount = eligible.filter(r => r.added_asset).length;
  const addedLabel = addedCount === count && count
    ? ' — newly found units added in the field'
    : (addedCount ? ` (incl. ${addedCount} newly found unit${addedCount === 1 ? '' : 's'} added in the field)` : '');
  const description =
    `Freshpet Preventive Maintenance — ${count} completed visit${count === 1 ? '' : 's'}` +
    addedLabel + (periodLabel ? ` (${periodLabel})` : '');

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

  // Render our branded invoice PDF (page 1 = invoice + FP-SVC summary line,
  // page 2+ = the per-visit asset report) and stash it in fp-invoices for the
  // portal. Same template the Quarterly Reactive invoice uses.
  const docRef = created.DocNumber || String(created.Id);
  let pdfBytes = null, invoicePdfPath = null;
  try {
    pdfBytes = await renderFreshpetInvoicePdf({
      invoiceRef: docRef, billingType: 'pm', customerName: created.CustomerRef?.name || 'FRESH PET',
      billTo: null, invoiceDate: created.TxnDate || new Date().toISOString().slice(0, 10),
      dueDate: created.DueDate || null, summaryLabel: description, qty: count, rate, total,
      assets: eligible.map(r => ({ store: r.store, city: r.assets?.city || '', serial: r.serial,
        model: r.assets?.model || '', warranty: r.assets?.warranty || '',
        signedAt: fmtSignedAt(r.signed_at), gps: fmtGps(r.gps_lat, r.gps_lng) })),
    });
    invoicePdfPath = await uploadInvoicePdf(jwt, docRef, pdfBytes);
  } catch (e) { /* non-fatal — invoice still created */ }

  // Mark billed (best-effort but important — surface a clear warning if it fails
  // so the operator doesn't double-bill).
  try {
    await fpPatch(`completed_pms?id=in.(${eligible.map(r => r.id).join(',')})`, jwt, {
      billed: true, bill_amount: rate, invoice_id: created.Id,
      // Some invoices come back with no DocNumber (custom numbering off) — fall
      // back to the QBO id so the portal never mislabels a billed visit.
      invoice_doc_number: created.DocNumber || (created.Id != null ? String(created.Id) : null),
      invoice_pdf_path: invoicePdfPath,
      invoiced_at: new Date().toISOString(), invoiced_by: adminEmail,
    });
  } catch (e) {
    warnings.push(`Invoice #${created.DocNumber || created.Id} was created but marking the PMs as billed FAILED (${e.message}). Do NOT re-bill these — mark them manually. PM ids: ${eligible.map(r => r.id).join(', ')}`);
  }

  // Build CSV visit report.
  const csvHeader = 'Store,City,Serial,PM Date,Technician,Signed At,GPS,Added Asset,Amount';
  const csvBody = eligible.map(r =>
    [csvCell(r.store), csvCell(r.assets?.city || ''), csvCell(r.serial), csvCell(r.pm_date), csvCell(r.tech_name),
     csvCell(fmtSignedAt(r.signed_at)), csvCell(fmtGps(r.gps_lat, r.gps_lng)), r.added_asset ? 'Yes' : '', rate.toFixed(2)].join(',')
  ).join('\n');
  const csvB64 = Buffer.from(`${csvHeader}\n${csvBody}\n`).toString('base64');
  const periodTag = (minDate || 'report').replace(/[^0-9]/g, '') || 'report';

  // Email (optional).
  let emailed = false;
  if (recipientEmail) {
    try {
      const attachments = [{ filename: `freshpet-pm-report-${periodTag}.csv`, content: csvB64 }];
      if (pdfBytes) attachments.push({ filename: `Invoice-${docRef}.pdf`, content: Buffer.from(pdfBytes).toString('base64') });
      const { subject, html, text } = renderFreshpetInvoiceEmail({
        recipientName: null, customerName: created.CustomerRef?.name || 'FRESH PET',
        docNumber: created.DocNumber || created.Id,
        invoiceDate: created.TxnDate || new Date().toISOString().slice(0, 10),
        dueDate: created.DueDate || null,
        totalAmount: total, balance: created.Balance != null ? created.Balance : total,
        invoiceUrl: created.InvoiceLink || '', visitCount: count, periodLabel,
        portalUrl: 'https://alamedapointbg.com/freshpet/portal?invoice=' +
          encodeURIComponent(created.DocNumber || String(created.Id)),
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
