// Freshpet — email an ISSUE REPORT with photos + signed PM reports attached.
//
// Called from the Freshpet admin console's "Report Issues" tab. The operator
// selects completed PMs (extra coolers found in the field, coolers with
// service issues, or any visit worth flagging), picks recipients, and this
// sends one email to Freshpet listing every unit — with each PM's photos and
// signed report PDF attached — so Freshpet can record the extra/problem
// coolers on their side.
//
// Auth: the caller's Freshpet Supabase JWT (project mmkncrsaijexezmhfmiw)
// must belong to a tech_profiles.role='admin' (same boundary as
// freshpet-invoice / freshpet-send-invoice). No QBO writes — this reads PM
// rows + public-bucket files, sends mail, and stamps issue_emailed_at/_to on
// the included PMs so the console shows what was already sent.

import { corsHeaders } from './qbo-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';

const FRESHPET_SUPABASE_URL =
  process.env.FRESHPET_SUPABASE_URL || 'https://mmkncrsaijexezmhfmiw.supabase.co';
const FRESHPET_ANON_KEY =
  process.env.FRESHPET_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ta25jcnNhaWpleGV6bWhmbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkyMjUsImV4cCI6MjA5NjM3NTIyNX0.lx4J-YhlFFrQVJMqjeBXXHNmgZfRe23xYGKZMEL8dPM';

// Resend caps an email (body + attachments) at 40MB; leave headroom for the
// base64 inflation (~4/3) by budgeting raw bytes.
const MAX_ATTACH_RAW_BYTES = 24 * 1024 * 1024;
const MAX_PMS_PER_EMAIL = 40;

function json(statusCode, obj) { return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) }; }
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeName(s) { return String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'unit'; }

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

// Fetch a file from a PUBLIC Freshpet storage bucket → { b64, bytes } or null.
async function fetchPublicFile(bucket, path) {
  try {
    const res = await fetch(`${FRESHPET_SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(path).replace(/%2F/g, '/')}`);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { b64: buf.toString('base64'), bytes: buf.length };
  } catch (e) { return null; }
}

function issueTypeLabel(pm) {
  const tags = [];
  if (pm.added_asset) tags.push('ADDED ASSET — new unit found in field');
  if (pm.needs_review && !pm.added_asset) tags.push('SERVICE ISSUE');
  if (!tags.length) tags.push('PM VISIT');
  return tags.join(' · ');
}

function renderIssueEmail({ rows, note, senderName, attachedCount, skippedCount }) {
  const today = new Date().toISOString().slice(0, 10);
  const subject = `Freshpet cooler report — ${rows.length} unit${rows.length === 1 ? '' : 's'} (${today})`;

  const tr = rows.map(r => {
    const a = r.assets || {};
    const loc = [a.address, a.city, a.state].filter(Boolean).join(', ');
    const typeColor = r.added_asset ? '#E56A15' : (r.needs_review ? '#DB4A44' : '#786B5E');
    return `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #EEE0CF;vertical-align:top">
        <strong>${escHtml(r.store)}</strong><br>
        <span style="color:#786B5E;font-size:12px">${escHtml(loc)}</span></td>
      <td style="padding:9px 10px;border-bottom:1px solid #EEE0CF;vertical-align:top;white-space:nowrap;font-family:monospace;font-size:12px">${escHtml(r.serial)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #EEE0CF;vertical-align:top">${escHtml([a.manufacturer, a.model].filter(Boolean).join(' '))}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #EEE0CF;vertical-align:top;white-space:nowrap">${escHtml(r.pm_date || '')}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #EEE0CF;vertical-align:top">
        <span style="color:${typeColor};font-weight:700;font-size:12px">${escHtml(issueTypeLabel(r))}</span>
        ${r.comments ? `<br><span style="color:#2A2521;font-size:12px">${escHtml(r.comments)}</span>` : ''}
        <br><span style="color:#786B5E;font-size:11px">Tech: ${escHtml(r.tech_name || '')}</span></td>
    </tr>`;
  }).join('');

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#FFF8F0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2A2521">
  <div style="max-width:720px;margin:0 auto;padding:24px 16px">
    <div style="background:#E56A15;border-radius:12px 12px 0 0;padding:18px 22px">
      <div style="color:#fff;font-size:19px;font-weight:800">Freshpet Cooler Report</div>
      <div style="color:rgba(255,255,255,.9);font-size:13px">Freeflow Beverage Solutions — field service</div>
    </div>
    <div style="background:#fff;border:1px solid #EEE0CF;border-top:none;border-radius:0 0 12px 12px;padding:22px">
      <p style="margin:0 0 14px;font-size:14px;line-height:1.55">
        Please record the following ${rows.length === 1 ? 'cooler' : `${rows.length} coolers`} — extra units our technicians
        found in the field and/or units with service issues. Each unit's photos and signed PM report are attached to this email.
      </p>
      ${note ? `<div style="background:#F6EEE3;border-radius:10px;padding:12px 14px;margin:0 0 16px;font-size:13.5px;line-height:1.55">${escHtml(note)}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #DCC8AC;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8A7A66">Store</th>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #DCC8AC;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8A7A66">Serial</th>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #DCC8AC;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8A7A66">Unit</th>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #DCC8AC;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8A7A66">Visit</th>
          <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #DCC8AC;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8A7A66">Issue / notes</th>
        </tr></thead>
        <tbody>${tr}</tbody>
      </table>
      <p style="margin:16px 0 0;font-size:12.5px;color:#786B5E">
        ${attachedCount} file${attachedCount === 1 ? '' : 's'} attached${skippedCount ? ` (${skippedCount} skipped for email-size limits — ask us for the rest)` : ''}.
        Questions: reply to this email or contact service@brixbev.com.
      </p>
      <p style="margin:12px 0 0;font-size:12.5px;color:#786B5E">Sent by ${escHtml(senderName)} · Freeflow Beverage Solutions</p>
    </div>
  </div></body></html>`;

  const text = `Freshpet Cooler Report (${today})\n\n` +
    (note ? note + '\n\n' : '') +
    rows.map(r => {
      const a = r.assets || {};
      return `• ${r.store} — S/N ${r.serial} — ${[a.manufacturer, a.model].filter(Boolean).join(' ')} — ${r.pm_date || ''} — ${issueTypeLabel(r)}${r.comments ? ` — ${r.comments}` : ''}`;
    }).join('\n') +
    `\n\n${attachedCount} files attached. Questions: service@brixbev.com`;

  return { subject, html, text };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // ── auth: Freshpet JWT + admin role ──
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return json(401, { error: 'Missing Authorization bearer token' });
  const jwt = m[1];
  let adminEmail, adminName;
  try {
    const uRes = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` } });
    if (!uRes.ok) return json(401, { error: 'Invalid or expired token' });
    adminEmail = (await uRes.json())?.email;
    if (!adminEmail) return json(401, { error: 'Invalid token' });
    const prof = (await fpGet(`tech_profiles?email=eq.${encodeURIComponent(adminEmail)}&select=role,name`, jwt))[0];
    if (!prof || prof.role !== 'admin') return json(403, { error: 'Freshpet admin role required' });
    adminName = prof.name || adminEmail;
  } catch (e) { return json(502, { error: 'Freshpet auth check failed: ' + e.message }); }

  // ── payload ──
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const pmIds = Array.isArray(payload.pmIds) ? payload.pmIds.map(Number).filter(Boolean) : [];
  if (!pmIds.length) return json(400, { error: 'Select at least one PM to report' });
  if (pmIds.length > MAX_PMS_PER_EMAIL) return json(400, { error: `Too many units for one email — send ${MAX_PMS_PER_EMAIL} or fewer at a time` });
  const note = String(payload.note || '').slice(0, 4000);
  const attachPhotos = payload.attachPhotos !== false; // default true
  const attachPdfs = payload.attachPdfs !== false;     // default true

  const recipients = (Array.isArray(payload.recipients) ? payload.recipients : String(payload.recipients || '').split(/[,;\s]+/))
    .map(s => String(s || '').trim()).filter(Boolean);
  if (!recipients.length) return json(400, { error: 'At least one recipient email is required' });
  const bad = recipients.find(e => !isEmail(e));
  if (bad) return json(400, { error: 'Invalid recipient email: ' + bad });

  // ── re-read the PMs server-side (RLS as the admin) ──
  let rows;
  try {
    rows = await fpGet(
      `completed_pms?id=in.(${pmIds.join(',')})&select=id,store,serial,pm_date,tech_name,prev_comp,needs_review,added_asset,photo_paths,pdf_path,comments:form_data->>comments,assets(city,state,address,manufacturer,model)`, jwt);
  } catch (e) { return json(502, { error: 'Could not load PMs: ' + e.message }); }
  rows = rows.filter(r => !r.prev_comp);
  if (!rows.length) return json(400, { error: 'None of the selected PMs are reportable (PREV COMP entries have no report/photos)' });
  rows.sort((a, b) => String(a.store).localeCompare(String(b.store)) || String(a.serial).localeCompare(String(b.serial)));

  // ── gather attachments (photos + signed report PDFs), size-capped ──
  const attachments = [];
  const skipped = [];
  let rawBytes = 0;
  for (const r of rows) {
    const base = `${safeName(r.store)}_${safeName(r.serial)}`;
    if (attachPdfs && r.pdf_path) {
      if (rawBytes < MAX_ATTACH_RAW_BYTES) {
        const f = await fetchPublicFile('fp-pdfs', r.pdf_path);
        if (f && rawBytes + f.bytes <= MAX_ATTACH_RAW_BYTES) {
          attachments.push({ filename: `${base}_PM-report.pdf`, content: f.b64 });
          rawBytes += f.bytes;
        } else { skipped.push(`${base}_PM-report.pdf`); }
      } else { skipped.push(`${base}_PM-report.pdf`); }
    }
    if (attachPhotos && Array.isArray(r.photo_paths)) {
      for (let i = 0; i < r.photo_paths.length; i++) {
        const name = `${base}_photo_${i + 1}.jpg`;
        if (rawBytes >= MAX_ATTACH_RAW_BYTES) { skipped.push(name); continue; }
        const f = await fetchPublicFile('fp-photos', r.photo_paths[i]);
        if (f && rawBytes + f.bytes <= MAX_ATTACH_RAW_BYTES) {
          attachments.push({ filename: name, content: f.b64 });
          rawBytes += f.bytes;
        } else { skipped.push(name); }
      }
    }
  }

  // ── render + send ──
  const { subject, html, text } = renderIssueEmail({
    rows, note, senderName: adminName, attachedCount: attachments.length, skippedCount: skipped.length,
  });
  try {
    await sendEmail({
      to: recipients, subject, html, text, attachments,
      from: 'APBG Billing <alerts@alamedapointbg.com>', replyTo: 'service@brixbev.com',
    });
  } catch (e) { return json(502, { error: 'Email send failed: ' + e.message }); }

  // ── stamp the PMs as reported (best-effort) ──
  const warnings = [];
  try {
    await fpPatch(`completed_pms?id=in.(${rows.map(r => r.id).join(',')})`, jwt, {
      issue_emailed_at: new Date().toISOString(),
      issue_emailed_to: recipients.join(', ').slice(0, 500),
    });
  } catch (e) {
    warnings.push('Email sent, but stamping the PMs as reported failed: ' + e.message);
  }

  return json(200, {
    sent: true, count: rows.length, recipients,
    attachedCount: attachments.length, attachedBytes: rawBytes, skipped, warnings,
  });
}
