// vendor-email-intake — Resend inbound webhook → Service Fusion job tickets.
//
// One endpoint, three inboxes, zero crons:
//   rbfreeflow@alamedapointbg.com  → Red Bull emails  → parse → SF job → notify send list
//   freshpet@alamedapointbg.com    → Freshpet emails  → parse → SF job → notify send list
//   sf-status@alamedapointbg.com   → Service Fusion's own job-status notification
//                                    emails → parse job # + status → notify send list
//
// Routing config (send lists, SF customer, category, parser hints) lives in
// ops.vendor_email_routes — seeded by migration 20260722a, editable via SQL.
// Every processed email lands in ops.vendor_email_tickets (deduped on the
// Resend email id); status changes append to ops.vendor_ticket_events.
//
// Auth: Resend signs webhooks with Svix headers. RESEND_INBOUND_SECRET
// (whsec_...) is REQUIRED — unsigned or badly-signed calls are rejected.
//
// Env:
//   RESEND_INBOUND_SECRET  — Resend webhook signing secret (required)
//   RESEND_API_KEY         — used to fetch full email bodies when the webhook
//                            payload doesn't inline them (and by email-helpers)
//   ANTHROPIC_API_KEY      — email parsing
//   VENDOR_INTAKE_MODEL    — parser model override (default claude-sonnet-5)
//   VENDOR_STATUS_INBOX    — status-notification inbox override
//                            (default sf-status@alamedapointbg.com)

import crypto from 'node:crypto';
import { sfRequest } from './sf-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const STATUS_INBOX =
  (process.env.VENDOR_STATUS_INBOX || 'sf-status@alamedapointbg.com').toLowerCase();
const PARSE_MODEL = process.env.VENDOR_INTAKE_MODEL || 'claude-sonnet-5';
const MAX_DESC = 4000; // keep SF job descriptions sane

// ─── Supabase service-role REST (ops schema) ───

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
  };
}

async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: sbHeaders(),
  });
  if (!res.ok) throw new Error(`ops.${table} read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function sbInsert(table, row, { ignoreDuplicates = false } = {}) {
  const headers = {
    ...sbHeaders(),
    Prefer: ignoreDuplicates
      ? 'return=representation,resolution=ignore-duplicates'
      : 'return=representation',
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers,
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`ops.${table} insert failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  return Array.isArray(out) ? out[0] || null : out || null;
}

async function sbUpdate(table, idFilter, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${idFilter}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`ops.${table} update failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ─── Svix signature verification (Resend webhook auth) ───

function verifySvix(headers, rawBody, secret) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) return false;

  // Reject stale timestamps (replay window: 5 minutes)
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  // Header carries space-delimited "v1,<base64>" entries
  return signature.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// ─── Email body helpers ───

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The email.received payload shape has varied as Resend's inbound feature
// matured; when the body isn't inlined, fetch the full email by id.
async function fetchReceivedEmail(emailId) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !emailId) return null;
  for (const path of ['emails/receiving', 'emails/received', 'emails']) {
    try {
      const res = await fetch(`https://api.resend.com/${path}/${emailId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) return await res.json();
    } catch (e) { /* try next shape */ }
  }
  return null;
}

function addr(value) {
  // "Name <a@b.com>" | "a@b.com" | { email } → bare lowercase address
  if (!value) return '';
  if (typeof value === 'object') return addr(value.email || value.address || '');
  const m = String(value).match(/<([^>]+)>/);
  return (m ? m[1] : String(value)).trim().toLowerCase();
}

// ─── Claude parsing ───

async function claude(prompt, maxTokens = 1024) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: PARSE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

function parseJsonBlock(text) {
  const cleaned = String(text).replace(/```json/gi, '```').split('```').find((s) => s.trim().startsWith('{')) || text;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('parser returned no JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function parseVendorEmail(route, { from, subject, text }) {
  const raw = await claude(
    `You are parsing a forwarded vendor service email so a Service Fusion job ticket can be created.
Vendor: ${route.display_name} (${route.vendor_key})
${route.extraction_hints ? `Vendor-specific guidance: ${route.extraction_hints}` : ''}

Return ONLY a JSON object with these keys (null when absent — never invent values):
{
  "location_name": string|null,     // venue/store name (+ store number if present)
  "address": string|null,           // full street address
  "contact_name": string|null,
  "contact_phone": string|null,
  "reference_number": string|null,  // the vendor's WO/dispatch/reference number
  "equipment": string|null,         // equipment involved
  "issue_summary": string,          // 1-2 sentence description of what is needed
  "requested_date": string|null,    // any requested service date/window, verbatim
  "urgency": "normal"|"urgent"
}

FROM: ${from}
SUBJECT: ${subject}

EMAIL BODY:
${String(text || '').slice(0, 12000)}`,
  );
  return parseJsonBlock(raw);
}

async function parseStatusEmail({ subject, text }) {
  // Cheap regex pass first — SF notification emails carry "Job #<number>"
  const blob = `${subject}\n${text}`;
  const jobMatch = blob.match(/job\s*(?:number|no\.?|#)?\s*[:#]?\s*(\d{6,})/i);
  const statusMatch = blob.match(/status\s*(?:changed|updated)?\s*(?:to|:)\s*["“']?([A-Za-z][A-Za-z0-9 \-\/]{2,40})/i);
  if (jobMatch && statusMatch) {
    return { job_number: jobMatch[1], status: statusMatch[1].trim().replace(/["”'.]+$/, '') };
  }
  const raw = await claude(
    `This is an automated Service Fusion job notification email. Extract the job number and the job's current/new status.
Return ONLY JSON: { "job_number": string|null, "status": string|null }

SUBJECT: ${subject}

BODY:
${String(text || '').slice(0, 8000)}`,
    300,
  );
  return parseJsonBlock(raw);
}

// ─── SF job creation ───

async function createSfJob(route, parsed, { from, subject, text, receivedAt }) {
  const lines = [
    `${route.display_name.toUpperCase()} — AUTOMATED EMAIL TICKET`,
    parsed.location_name && `Location: ${parsed.location_name}`,
    parsed.address && `Address: ${parsed.address}`,
    parsed.equipment && `Equipment: ${parsed.equipment}`,
    parsed.reference_number && `Vendor ref #: ${parsed.reference_number}`,
    parsed.contact_name && `On-site contact: ${parsed.contact_name}${parsed.contact_phone ? ` (${parsed.contact_phone})` : ''}`,
    parsed.requested_date && `Requested date: ${parsed.requested_date}`,
    parsed.urgency === 'urgent' && `⚠ URGENT per vendor email`,
    '',
    `Issue: ${parsed.issue_summary || subject}`,
    '',
    `— Source email —`,
    `From: ${from}`,
    `Subject: ${subject}`,
    `Received: ${receivedAt}`,
    '',
    String(text || '').slice(0, MAX_DESC),
  ].filter((l) => l !== false && l !== null && l !== undefined);

  const payload = {
    customer_name: route.sf_customer_name,
    status: route.sf_job_status_initial || 'Unscheduled',
    description: lines.join('\n').slice(0, MAX_DESC + 800),
  };

  // SF only ATTACHES existing categories — an unknown name 422s the whole
  // job, so retry once without it rather than losing the ticket.
  if (route.sf_job_category) {
    try {
      return { job: await sfRequest('POST', '/jobs', { ...payload, category: route.sf_job_category }) };
    } catch (e) {
      console.warn(`SF rejected category "${route.sf_job_category}" (${e.message}); retrying without`);
      return {
        job: await sfRequest('POST', '/jobs', payload),
        warning: `SF rejected job category "${route.sf_job_category}" — job created without it. Add the category in SF Settings → Job Categories.`,
      };
    }
  }
  return { job: await sfRequest('POST', '/jobs', payload) };
}

// ─── Notification emails ───

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shellHtml(title, rowsHtml) {
  return `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
  <div style="background:#0F172A;padding:18px 24px"><span style="color:#fff;font-size:16px;font-weight:700">${esc(title)}</span></div>
  <div style="padding:20px 24px;color:#0F172A;font-size:14px;line-height:1.55">${rowsHtml}</div>
  <div style="padding:12px 24px;background:#f8fafc;color:#64748b;font-size:12px">Automated vendor-email ticketing · Alameda Point Beverage Group</div>
</div>`;
}

function row(label, value) {
  if (!value) return '';
  return `<p style="margin:4px 0"><strong>${esc(label)}:</strong> ${esc(value)}</p>`;
}

async function notifySendList(route, subject, rowsHtml) {
  const to = (route.send_list || []).filter(Boolean);
  if (!to.length) return;
  try {
    await sendEmail({
      to,
      subject,
      html: shellHtml(subject, rowsHtml),
      from: 'APBG Service Desk <alerts@alamedapointbg.com>',
    });
  } catch (e) {
    // Notification failure never undoes the ticket
    console.warn('send-list email failed:', e.message);
  }
}

// ─── Handlers ───

async function handleVendorEmail(route, email) {
  // Dedup on the Resend email id — a webhook retry must not double-ticket
  const ticket = await sbInsert(
    'vendor_email_tickets',
    {
      route_id: route.id,
      vendor_key: route.vendor_key,
      resend_email_id: email.emailId || null,
      from_email: email.from,
      to_email: email.to,
      subject: email.subject,
      received_at: email.receivedAt,
      raw_text: String(email.text || '').slice(0, 50000),
      status: 'received',
    },
    { ignoreDuplicates: !!email.emailId },
  );
  if (!ticket) return { ok: true, duplicate: true };

  if (!route.sf_customer_name) {
    await sbUpdate('vendor_email_tickets', `id=eq.${ticket.id}`, {
      status: 'needs_route_config',
      error: `route "${route.inbox}" has no sf_customer_name configured — SF job not created`,
    });
    await notifySendList(
      route,
      `⚠ ${route.display_name} email received — route not configured`,
      row('Subject', email.subject) +
        row('From', email.from) +
        `<p style="margin:10px 0 0">The <code>${esc(route.inbox)}</code> route has no Service Fusion customer set, so no job was created. Set <code>sf_customer_name</code> on ops.vendor_email_routes and re-forward the email.</p>`,
    );
    return { ok: true, ticketId: ticket.id, status: 'needs_route_config' };
  }

  let parsed;
  try {
    parsed = await parseVendorEmail(route, email);
  } catch (e) {
    parsed = { issue_summary: email.subject, parse_error: e.message };
  }

  try {
    const { job, warning } = await createSfJob(route, parsed, email);
    const jobId = job?.id ?? job?.job_id ?? null;
    const jobNumber = String(job?.number ?? job?.job_number ?? jobId ?? '');
    await sbUpdate('vendor_email_tickets', `id=eq.${ticket.id}`, {
      parsed,
      sf_job_id: jobId ? String(jobId) : null,
      sf_job_number: jobNumber || null,
      sf_customer_name: route.sf_customer_name,
      status: 'sf_created',
      error: warning || null,
    });
    await notifySendList(
      route,
      `🎫 ${route.display_name} ticket created — SF job ${jobNumber || '(no number returned)'}`,
      row('SF job #', jobNumber) +
        row('Customer', route.sf_customer_name) +
        row('Location', parsed.location_name) +
        row('Address', parsed.address) +
        row('Vendor ref #', parsed.reference_number) +
        row('Issue', parsed.issue_summary) +
        row('Requested date', parsed.requested_date) +
        row('Source email', `${email.from} — ${email.subject}`) +
        (warning ? `<p style="margin:10px 0 0;color:#b45309">${esc(warning)}</p>` : ''),
    );
    return { ok: true, ticketId: ticket.id, sfJob: jobNumber };
  } catch (e) {
    await sbUpdate('vendor_email_tickets', `id=eq.${ticket.id}`, {
      parsed,
      status: 'sf_failed',
      error: e.message.slice(0, 500),
    });
    await notifySendList(
      route,
      `⚠ ${route.display_name} email received — SF job creation FAILED`,
      row('Subject', email.subject) +
        row('From', email.from) +
        row('Error', e.message.slice(0, 300)) +
        `<p style="margin:10px 0 0">The email is recorded (ticket ${esc(ticket.id)}); create the SF job by hand or fix the route and re-forward.</p>`,
    );
    return { ok: true, ticketId: ticket.id, status: 'sf_failed' };
  }
}

async function handleStatusEmail(email) {
  let extracted;
  try {
    extracted = await parseStatusEmail(email);
  } catch (e) {
    console.warn('status email parse failed:', e.message);
    return { ok: true, ignored: 'unparseable status email' };
  }
  if (!extracted?.job_number) return { ok: true, ignored: 'no job number found' };

  const jobNumber = String(extracted.job_number);
  const tickets = await sbSelect(
    'vendor_email_tickets',
    `or=(sf_job_number.eq.${jobNumber},sf_job_id.eq.${jobNumber})&select=*&limit=1`,
  );
  const ticket = tickets[0];
  // SF notifies for EVERY job; only vendor-email tickets are ours to relay
  if (!ticket) return { ok: true, ignored: `job ${jobNumber} is not a vendor-email ticket` };

  const newStatus = (extracted.status || '').trim();
  if (!newStatus || newStatus.toLowerCase() === (ticket.last_sf_status || '').toLowerCase()) {
    return { ok: true, ignored: 'status unchanged' };
  }

  const routes = ticket.route_id
    ? await sbSelect('vendor_email_routes', `id=eq.${ticket.route_id}&select=*&limit=1`)
    : [];
  const route = routes[0] || { display_name: ticket.vendor_key || 'Vendor', send_list: ['service@brixbev.com'] };

  await sbInsert('vendor_ticket_events', {
    ticket_id: ticket.id,
    sf_job_number: jobNumber,
    sf_status: newStatus,
    notified_to: route.send_list || [],
    raw: { subject: email.subject, from: email.from },
  });
  await sbUpdate('vendor_email_tickets', `id=eq.${ticket.id}`, {
    last_sf_status: newStatus,
    last_status_at: new Date().toISOString(),
  });
  await notifySendList(
    route,
    `📋 ${route.display_name} — SF job ${jobNumber} is now "${newStatus}"`,
    row('SF job #', jobNumber) +
      row('New status', newStatus) +
      row('Previous status', ticket.last_sf_status || '(first update)') +
      row('Location', ticket.parsed?.location_name) +
      row('Vendor ref #', ticket.parsed?.reference_number) +
      row('Original request', ticket.subject),
  );
  return { ok: true, ticketId: ticket.id, status: newStatus };
}

// ─── Entry point ───

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  const secret = process.env.RESEND_INBOUND_SECRET;
  if (!secret) {
    console.error('RESEND_INBOUND_SECRET not set — refusing unauthenticated inbound email');
    return { statusCode: 503, body: JSON.stringify({ error: 'intake not configured' }) };
  }
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (!verifySvix(headers, rawBody, secret)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'bad signature' }) };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON' }) };
  }
  if (payload.type !== 'email.received') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: payload.type }) };
  }

  try {
    const d = payload.data || {};
    const emailId = d.email_id || d.id || null;
    let subject = d.subject || '';
    let from = addr(d.from);
    let toList = (Array.isArray(d.to) ? d.to : [d.to]).map(addr).filter(Boolean);
    let text = d.text || (d.html ? stripHtml(d.html) : '');

    // Webhook payloads don't always inline the body — pull the full email
    if ((!text || !toList.length) && emailId) {
      const full = await fetchReceivedEmail(emailId);
      if (full) {
        subject = subject || full.subject || '';
        from = from || addr(full.from);
        if (!toList.length) toList = (Array.isArray(full.to) ? full.to : [full.to]).map(addr).filter(Boolean);
        text = text || full.text || (full.html ? stripHtml(full.html) : '');
      }
    }

    const email = {
      emailId,
      from,
      subject,
      text,
      receivedAt: payload.created_at || new Date().toISOString(),
    };

    if (toList.includes(STATUS_INBOX)) {
      const result = await handleStatusEmail(email);
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    const routes = await sbSelect('vendor_email_routes', 'active=eq.true&select=*');
    const route = routes.find((r) => toList.includes(String(r.inbox).toLowerCase()));
    if (!route) {
      console.log('no route for recipients:', toList.join(', '));
      return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: 'no matching route' }) };
    }
    email.to = toList.find((t) => t === String(route.inbox).toLowerCase());

    const result = await handleVendorEmail(route, email);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    // Throwing 5xx makes Resend retry — correct for infra blips (Supabase or
    // SF token hiccups); business failures were already recorded above as 200s.
    console.error('vendor-email-intake uncaught:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}
