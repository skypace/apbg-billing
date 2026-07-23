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
//   RESEND_INBOUND_SECRET  — webhook auth (required): either the shared
//                            ?secret= value baked into the webhook URL, or
//                            the Svix whsec_ signing secret
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

// Red Bull reactive work orders arrive as machine-generated
// "RED BULL REACTIVE WORK ORDER RECEIVED - SF <n> / ZENDESK <n>" notifications
// with stable labeled sections — parse those exactly, no AI involved. Returns
// null when the email doesn't look like that format (→ Claude fallback).
function parseRedBullDeterministic(subject, text) {
  const t = String(text || '');
  const grab = (re) => {
    const m = t.match(re);
    const v = m ? m[1].trim() : null;
    return v && v !== '' ? v : null;
  };

  const zendesk =
    grab(/ZENDESK\s+(?:REPAIR\s+)?TICKET\s*(?:NUMBER\s*)?#?\s*(\d+)/i) ||
    (String(subject).match(/ZENDESK\s+#?(\d+)/i)?.[1] ?? null);
  const vendorSfRef =
    String(subject).match(/\bSF\s+#?(\d{4,})\b/i)?.[1] ||
    grab(/Service Fusion Job\s+#?(\d{4,})/i);
  const issueReported = grab(/ISSUE REPORTED:[ \t]*([^\n]*)/i);
  if (!zendesk && !issueReported) return null; // not this format

  // Headline line right under the ticket number, e.g.
  // "LEAKING COOLER - LUCKY STORE 755 (S/N: 10612477)"
  const headline = grab(/ZENDESK\s+(?:REPAIR\s+)?TICKET\s*#\s*\d+\s*\n\s*([^\n]+)/i);

  // LOCATION DETAILS block: store name, street, "CITY, ST ZIP"
  let locationName = null;
  let address = null;
  const locBlock = t.match(/LOCATION DETAILS:\s*\n([\s\S]{0,500})/i)?.[1];
  if (locBlock) {
    const lines = locBlock
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((l) => !/^(IN\s.*TERRITORY|CONTACT|NTE)/i.test(l));
    if (lines.length) {
      locationName = lines[0];
      if (lines.length >= 2) address = lines.slice(1, 3).join(', ');
    }
  }

  const contact =
    t.match(/LOCATION CONTACT:\s*\n?\s*([^\/\n]+?)\s*\/\s*([\d\-\(\)\s.+]{7,})/i) ||
    t.match(/CONTACT:\s*([^\/\n]+?)\s*\/\s*([\d\-\(\)\s.+]{7,})/i);

  const makeModel = grab(/ASSET MAKE\/MODEL:[ \t]*([^\n]*)/i);
  const serial = grab(/ASSET SERIAL:[ \t]*([^\n]*)/i);

  // Verbatim section slices (everything between a label line and the next
  // known section) — used to rebuild the SF description exactly as received.
  const section = (label, stops) => {
    const re = new RegExp(`${label}:\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:${stops})|$)`, 'i');
    const m = t.match(re);
    const v = m ? m[1].trim() : null;
    return v && v !== '' ? v : null;
  };
  const descriptionBlock = section(
    'DESCRIPTION',
    'LOCATION CONTACT:|IN NATIVE|IN FREEFLOW|ZENDESK LINK:|LOCATION DETAILS:|NTE INFORMATION:',
  );
  const locationBlock = section(
    'LOCATION DETAILS',
    'NTE INFORMATION:|MANUFACTURE DATE:|Click for',
  );

  return {
    location_name: locationName,
    address,
    contact_name: contact ? contact[1].trim() : null,
    contact_phone: contact ? contact[2].trim() : null,
    reference_number: zendesk ? `ZENDESK ${zendesk}` : vendorSfRef,
    equipment: makeModel ? `${makeModel}${serial ? ` (S/N: ${serial})` : ''}` : serial,
    issue_summary: issueReported || headline || subject,
    requested_date: null,
    urgency: /urgent|emergency|asap/i.test(t) ? 'urgent' : 'normal',
    vendor_fields: {
      zendesk_ticket: zendesk,
      vendor_sf_ref: vendorSfRef,
      headline,
      created: grab(/CREATED:[ \t]*([^\n]*)/i),
      asset_make_model: makeModel,
      asset_serial: serial,
      asset_material_number: grab(/ASSET MATERIAL NUMBER:[ \t]*([^\n]*)/i),
      nte: grab(/NTE:[ \t]*(\$?\s?[\d,]+(?:\.\d{2})?)/i),
      nte_type: grab(/NTE TYPE:[ \t]*([^\n]*)/i),
      manufacture_date: grab(/MANUFACTURE DATE:[ \t]*([^\n]*)/i),
      service_years: grab(/SERVICE YEARS:[ \t]*([^\n]*)/i),
      native_reactive_territory: grab(/IN (?:FREEFLOW )?NATIVE REACTIVE TERRITORY:[ \t]*([^\n]*)/i),
      zendesk_link: grab(/(https:\/\/\S*zendesk\.com\/\S+)/i),
      description_block: descriptionBlock,
      location_block: locationBlock,
    },
    parser: 'deterministic-redbull',
  };
}

async function parseVendorEmail(route, { from, subject, text }) {
  if (route.vendor_key === 'redbull') {
    const exact = parseRedBullDeterministic(subject, text);
    if (exact) return exact;
    console.warn('Red Bull email did not match the known format — falling back to Claude parse');
  }
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
  // Known live format (the account's custom SF status template, verified
  // 2026-07-22): "SF-JOB NUMBER: 1092930655" + "STATUS UPDATE: Completed- Service"
  const jobMatch =
    blob.match(/SF-?\s*JOB\s*NUMBER\s*[:#]?\s*(\d{6,})/i) ||
    blob.match(/job\s*(?:number|no\.?|#)?\s*[:#]?\s*(\d{6,})/i);
  const statusMatch = blob.match(/status\s*(?:changed|updated|update)?\s*(?:to|:)\s*["“']?([A-Za-z][A-Za-z0-9 \-\/]{2,40})/i);
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

// ─── SF job payload builders ───

// Red Bull mapping (per Sky, 2026-07-22):
//   PO number      = ZENDESK REPAIR TICKET # + vendor SERVICE FUSION JOB #
//   Description    = ISSUE REPORTED + DESCRIPTION block + LOCATION CONTACT +
//                    ZENDESK LINK + LOCATION DETAILS + NTE INFO lines
//   Job notes      = MANUFACTURE DATE, SERVICE YEARS, ZENDESK TICKET LINK
// Plus the store's name/address/contact into the job's structured location
// fields so dispatch sees where the work actually is.
function buildRedBullSfJob(route, parsed) {
  const vf = parsed.vendor_fields || {};
  const po = [
    vf.zendesk_ticket && `ZD ${vf.zendesk_ticket}`,
    vf.vendor_sf_ref && `SF ${vf.vendor_sf_ref}`,
  ].filter(Boolean).join(' / ');

  const assetLines = [
    vf.asset_make_model && `ASSET MAKE/MODEL: ${vf.asset_make_model}`,
    vf.asset_serial && `ASSET SERIAL: ${vf.asset_serial}`,
    vf.asset_material_number && `ASSET MATERIAL NUMBER: ${vf.asset_material_number}`,
  ].filter(Boolean);

  const description = [
    `ISSUE REPORTED: ${parsed.issue_summary || vf.headline || ''}`,
    assetLines.length && `ASSET INFORMATION:\n${assetLines.join('\n')}`,
    vf.description_block && `DESCRIPTION:\n${vf.description_block}`,
    (parsed.contact_name || parsed.contact_phone) &&
      `LOCATION CONTACT:\n${[parsed.contact_name, parsed.contact_phone].filter(Boolean).join(' / ')}`,
    vf.zendesk_link && `ZENDESK LINK:\n${vf.zendesk_link}`,
    vf.location_block && `LOCATION DETAILS:\n${vf.location_block}`,
    (vf.nte || vf.nte_type) &&
      `NTE INFORMATION:${vf.nte ? `\nNTE: ${vf.nte}` : ''}${vf.nte_type ? `\nNTE TYPE: ${vf.nte_type}` : ''}`,
  ].filter(Boolean).join('\n\n');

  const notes = [
    vf.manufacture_date && { notes: `MANUFACTURE DATE: ${vf.manufacture_date}` },
    vf.service_years && { notes: `SERVICE YEARS: ${vf.service_years}` },
    vf.zendesk_link && { notes: `ZENDESK TICKET LINK: ${vf.zendesk_link}` },
  ].filter(Boolean);

  // Structured location from the LOCATION DETAILS block (name / street / "CITY, ST ZIP")
  const location = {};
  const locLines = String(vf.location_block || '')
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((l) => !/^(IN\s.*TERRITORY|CONTACT|NTE)/i.test(l));
  if (locLines[0]) location.location_name = locLines[0];
  if (locLines[1]) location.street_1 = locLines[1];
  const cityLine = (locLines[2] || '').match(/^(.*?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (cityLine) {
    location.city = cityLine[1];
    location.state_prov = cityLine[2];
    location.postal_code = cityLine[3];
  }
  const contactFirst = (parsed.contact_name || '').trim().split(/\s+/)[0];

  return {
    customer_name: route.sf_customer_name,
    status: route.sf_job_status_initial || 'Unscheduled',
    ...(route.sf_job_category ? { category: route.sf_job_category } : {}),
    ...(po ? { po_number: po.slice(0, 50) } : {}),
    description: description.slice(0, MAX_DESC),
    ...(notes.length ? { notes } : {}),
    ...location,
    ...(contactFirst ? { contact_first_name: contactFirst } : {}),
  };
}

function buildGenericSfJob(route, parsed, { from, subject, text, receivedAt }) {
  const lines = [
    `${route.display_name.toUpperCase()} — AUTOMATED EMAIL TICKET`,
    parsed.location_name && `Location: ${parsed.location_name}`,
    parsed.address && `Address: ${parsed.address}`,
    parsed.equipment && `Equipment: ${parsed.equipment}`,
    parsed.reference_number && `Vendor ref #: ${parsed.reference_number}`,
    parsed.contact_name && `On-site contact: ${parsed.contact_name}${parsed.contact_phone ? ` (${parsed.contact_phone})` : ''}`,
    parsed.requested_date && `Requested date: ${parsed.requested_date}`,
    parsed.urgency === 'urgent' && `⚠ URGENT per vendor email`,
    ...(parsed.vendor_fields
      ? Object.entries(parsed.vendor_fields)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}: ${v}`)
      : []),
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

  return {
    customer_name: route.sf_customer_name,
    status: route.sf_job_status_initial || 'Unscheduled',
    ...(route.sf_job_category ? { category: route.sf_job_category } : {}),
    ...(parsed.reference_number ? { po_number: String(parsed.reference_number).slice(0, 50) } : {}),
    description: lines.join('\n').slice(0, MAX_DESC + 800),
  };
}

function buildSfJobPayload(route, parsed, email) {
  return parsed.parser === 'deterministic-redbull'
    ? buildRedBullSfJob(route, parsed)
    : buildGenericSfJob(route, parsed, email);
}

// SF only ATTACHES existing categories, and other by-name fields can 422 on
// a mismatch. On a 422, drop ONLY the field SF\'s error message names (falling
// back to the riskiest remaining field) and retry — one bad value must never
// strip the rest of the job or lose the ticket.
const DROPPABLE_SF_FIELDS = ['category', 'notes'];

async function createSfJobWithRetries(payload) {
  const body = { ...payload };
  const dropped = [];
  for (;;) {
    try {
      const job = await sfRequest('POST', '/jobs', body);
      const warning = dropped.length
        ? `SF rejected field(s): ${dropped.join(', ')} — job created without them. Fix the value (SF Settings / ops.vendor_email_routes) and add them to the job by hand.`
        : null;
      return { job, warning };
    } catch (e) {
      if (!/422/.test(e.message)) throw e; // only field rejections get retried
      const present = DROPPABLE_SF_FIELDS.filter((f) => body[f] !== undefined);
      const named = present.find((f) => new RegExp(f.replace(/_/g, '[_ ]?'), 'i').test(e.message));
      const target = named || present[0];
      if (!target) throw e;
      delete body[target];
      dropped.push(target);
      console.warn(`SF 422 → dropping "${target}" and retrying: ${e.message}`);
    }
  }
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

// Outbound emails prefer the Resend-hosted templates (editable in the Resend
// dashboard, aliases vendor-ticket-*); the code-built HTML is the fallback so
// a deleted/unpublished template can never silence a notification.
async function sendTemplate(to, subject, alias, variables) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'APBG Service Desk <alerts@alamedapointbg.com>',
      to,
      subject,
      reply_to: 'service@brixbev.com',
      template: { id: alias, variables },
    }),
  });
  if (!res.ok) {
    console.warn(`template "${alias}" send failed (${res.status}): ${(await res.text()).slice(0, 200)} — falling back to inline HTML`);
    return false;
  }
  return true;
}

async function sendTo(recipients, subject, rowsHtml, tpl = null) {
  const to = dedupeEmails(recipients);
  if (!to.length) return;
  try {
    if (tpl && (await sendTemplate(to, subject, tpl.alias, tpl.variables))) return;
    await sendEmail({
      to,
      subject,
      html: shellHtml(subject, rowsHtml),
      from: 'APBG Service Desk <alerts@alamedapointbg.com>',
      replyTo: 'service@brixbev.com',
    });
  } catch (e) {
    // Notification failure never undoes the ticket
    console.warn('notification email failed:', e.message);
  }
}

function dedupeEmails(list) {
  const seen = new Set();
  return (list || []).filter(Boolean).map((e) => String(e).trim()).filter((e) => {
    const k = e.toLowerCase();
    if (!k.includes('@') || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Vendor-facing recipients: the route's configured list + whoever sent the
// original email (the submitter always hears back).
function vendorRecipients(route, fromEmail) {
  return dedupeEmails([...(route.vendor_notify_list || []), fromEmail]);
}

async function notifySendList(route, subject, rowsHtml, tpl = null) {
  await sendTo(route.send_list || [], subject, rowsHtml, tpl);
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
  const payload = buildSfJobPayload(route, parsed, email);

  // Confirm-before-create (per-route; default ON): hold the built job and
  // email the send list an Approve/Decline link instead of creating it.
  if (route.require_confirmation !== false) {
    const token = crypto.randomBytes(24).toString('hex');
    await sbUpdate('vendor_email_tickets', `id=eq.${ticket.id}`, {
      parsed,
      sf_payload: payload,
      confirm_token: token,
      sf_customer_name: route.sf_customer_name,
      status: 'awaiting_confirmation',
    });
    const base = `${process.env.URL || 'https://apbg-billing.netlify.app'}/.netlify/functions/vendor-email-intake`;
    const link = (action) => `${base}?action=${action}&ticket=${ticket.id}&token=${token}`;
    const previewText = `Customer: ${payload.customer_name}\nStatus: ${payload.status}${payload.category ? `\nCategory: ${payload.category}` : ''}${payload.po_number ? `\nPO #: ${payload.po_number}` : ''}\n\n${payload.description}`;
    await notifySendList(
      route,
      `🟡 ${route.display_name} work order pending — confirm to create SF job`,
      ticketSummaryRows(route, parsed, email) +
        `<p style="margin:14px 0 4px"><strong>Work order preview</strong></p>
         <pre style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:12px;font-size:12px;white-space:pre-wrap">${esc(previewText)}</pre>
         <div style="margin:16px 0">
           <a href="${link('create')}" style="background:#16a34a;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block">✓ Create SF work order</a>
           &nbsp;&nbsp;
           <a href="${link('decline')}" style="background:#dc2626;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block">✕ Decline</a>
         </div>
         <p style="margin:4px 0;color:#64748b;font-size:12px">No SF job exists yet — nothing is billed or dispatched until someone clicks Create.</p>`,
      {
        alias: 'vendor-ticket-pending',
        variables: {
          VENDOR: route.display_name,
          ROWS_HTML: ticketSummaryRows(route, parsed, email),
          WO_PREVIEW: esc(previewText),
          CREATE_URL: link('create'),
          DECLINE_URL: link('decline'),
        },
      },
    );
    return { ok: true, ticketId: ticket.id, status: 'awaiting_confirmation' };
  }

  return finalizeSfCreation(ticket.id, route, payload, parsed, email);
}

function ticketSummaryRows(route, parsed, email) {
  return (
    row('Customer', route.sf_customer_name) +
    row('Location', parsed.location_name) +
    row('Address', parsed.address) +
    row('Vendor ref #', parsed.reference_number) +
    row('Equipment', parsed.equipment) +
    row('NTE', parsed.vendor_fields?.nte && `${parsed.vendor_fields.nte}${parsed.vendor_fields.nte_type ? ` (${parsed.vendor_fields.nte_type})` : ''}`) +
    row('Issue', parsed.issue_summary) +
    row('Requested date', parsed.requested_date) +
    row('Source email', email ? `${email.from} — ${email.subject}` : null)
  );
}

async function finalizeSfCreation(ticketId, route, payload, parsed, email) {
  try {
    const { job, warning } = await createSfJobWithRetries(payload);
    const jobId = job?.id ?? job?.job_id ?? null;
    const jobNumber = String(job?.number ?? job?.job_number ?? jobId ?? '');
    await sbUpdate('vendor_email_tickets', `id=eq.${ticketId}`, {
      parsed,
      sf_payload: payload,
      confirm_token: null,
      sf_job_id: jobId ? String(jobId) : null,
      sf_job_number: jobNumber || null,
      sf_customer_name: route.sf_customer_name,
      status: 'sf_created',
      error: warning || null,
    });
    // Muted on the confirm-click path (per Sky 2026-07-22): whoever clicked
    // Create sees the result page, and the vendor acceptance email is the
    // record — the internal copy only sends when a field was dropped (needs
    // attention) or on auto-created jobs (nobody clicked a button).
    if (email || warning) {
      await notifySendList(
        route,
        `🎫 ${route.display_name} ticket created — SF job ${jobNumber || '(no number returned)'}`,
        row('SF job #', jobNumber) +
          ticketSummaryRows(route, parsed, email) +
          (warning ? `<p style="margin:10px 0 0;color:#b45309">${esc(warning)}</p>` : ''),
      );
    }
    return { ok: true, ticketId, sfJob: jobNumber };
  } catch (e) {
    await sbUpdate('vendor_email_tickets', `id=eq.${ticketId}`, {
      parsed,
      sf_payload: payload,
      status: 'sf_failed',
      error: e.message.slice(0, 500),
    });
    await notifySendList(
      route,
      `⚠ ${route.display_name} email received — SF job creation FAILED`,
      (email ? row('Subject', email.subject) + row('From', email.from) : '') +
        row('Error', e.message.slice(0, 300)) +
        `<p style="margin:10px 0 0">The email is recorded (ticket ${esc(ticketId)}); create the SF job by hand or fix the route and re-forward.</p>`,
    );
    return { ok: true, ticketId, status: 'sf_failed' };
  }
}

// GET ?action=create|decline&ticket=<id>&token=<confirm_token> — the links
// in the confirmation email. Token is single-use (cleared on decision).
async function handleConfirmClick(params) {
  const { action, ticket: ticketId, token } = params;
  const page = (title, body, code = 200) => ({
    statusCode: code,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:'DM Sans',Arial,sans-serif;background:#0F172A;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0"><div style="max-width:440px;padding:32px;text-align:center"><h2 style="color:#fff">${title}</h2><p style="line-height:1.6">${body}</p></div></body>`,
  });

  if (!['create', 'decline', 'decline_confirm'].includes(action) || !ticketId || !token) {
    return page('Invalid link', 'This confirmation link is malformed.', 400);
  }
  const tickets = await sbSelect(
    'vendor_email_tickets',
    `id=eq.${encodeURIComponent(ticketId)}&select=*&limit=1`,
  );
  const ticket = tickets[0];
  if (!ticket || !ticket.confirm_token || ticket.confirm_token !== token) {
    return page('Link expired', 'This confirmation link is invalid or was already used.', 400);
  }
  if (ticket.status !== 'awaiting_confirmation') {
    return page('Already handled', `This work order is already "${esc(ticket.status)}".`);
  }
  const routes = await sbSelect('vendor_email_routes', `id=eq.${ticket.route_id}&select=*&limit=1`);
  const route = routes[0];
  if (!route) return page('Route missing', 'The route for this ticket no longer exists.', 400);

  const ref = ticket.parsed?.reference_number || ticket.subject || '';

  // Step 1 of decline: pick a reason (form GETs back into this handler)
  if (action === 'decline') {
    const base = `${process.env.URL || 'https://apbg-billing.netlify.app'}/.netlify/functions/vendor-email-intake`;
    const opt = (v) => `<option value="${v}">${v}</option>`;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:'DM Sans',Arial,sans-serif;background:#0F172A;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0">
<form method="GET" action="${base}" style="max-width:460px;width:100%;padding:32px;background:#1e293b;border-radius:12px;margin:16px">
  <h2 style="color:#fff;margin-top:0">Decline work order</h2>
  <p style="line-height:1.5;color:#94a3b8">${esc(ref)}</p>
  <input type="hidden" name="action" value="decline_confirm">
  <input type="hidden" name="ticket" value="${esc(ticket.id)}">
  <input type="hidden" name="token" value="${esc(token)}">
  <label style="display:block;margin:14px 0 6px;font-weight:700">Reason</label>
  <select name="reason" required style="width:100%;padding:10px;border-radius:6px;border:1px solid #475569;background:#0F172A;color:#e2e8f0">
    <option value="" disabled selected>Choose a reason…</option>
    ${opt('Out of native reactive territory')}
    ${opt('NTE too low for the work required')}
    ${opt('Cannot service this equipment type')}
    ${opt('Duplicate request')}
    ${opt('Location not serviceable / access issue')}
    ${opt('Other (explain below)')}
  </select>
  <label style="display:block;margin:14px 0 6px;font-weight:700">Notes (optional)</label>
  <textarea name="notes" rows="3" style="width:100%;padding:10px;border-radius:6px;border:1px solid #475569;background:#0F172A;color:#e2e8f0"></textarea>
  <button type="submit" style="margin-top:18px;background:#dc2626;color:#fff;border:none;padding:12px 26px;border-radius:6px;font-weight:700;font-size:15px;cursor:pointer">Decline work order</button>
</form></body>`,
    };
  }

  // Step 2 of decline: reason chosen — record + notify vendor and internal lists
  if (action === 'decline_confirm') {
    const reason = [params.reason, params.notes].filter(Boolean).join(' — ').slice(0, 500)
      || 'No reason given';
    await sbUpdate('vendor_email_tickets', `id=eq.${ticket.id}`, {
      status: 'declined',
      decline_reason: reason,
      confirm_token: null,
    });
    const declineRows =
      row('Reference', ref) +
      row('Reason', reason) +
      ticketSummaryRows(route, ticket.parsed || {}, null) +
      `<p style="margin:10px 0 0">No Service Fusion job was created for this request.</p>`;
    const declineTpl = {
      alias: 'vendor-ticket-declined',
      variables: {
        VENDOR: route.display_name,
        REFERENCE: ref,
        REASON: reason,
        ROWS_HTML: ticketSummaryRows(route, ticket.parsed || {}, null),
      },
    };
    await sendTo(
      vendorRecipients(route, ticket.from_email),
      `Work order declined — ${ref}`,
      declineRows,
      declineTpl,
    );
    await notifySendList(route, `⛔ ${route.display_name} work order DECLINED — ${ref}`, declineRows, declineTpl);
    return page('Declined', `The work order was declined ("${esc(reason)}"). The submitter and notification list have been emailed.`);
  }

  const result = await finalizeSfCreation(ticket.id, route, ticket.sf_payload, ticket.parsed || {}, null);
  if (result.sfJob) {
    // Vendor-facing acceptance: submitter + configured vendor contacts
    const acceptRows =
      row('Reference', ref) +
      row('Our job #', result.sfJob) +
      row('Location', ticket.parsed?.location_name) +
      row('Issue', ticket.parsed?.issue_summary);
    await sendTo(
      vendorRecipients(route, ticket.from_email),
      `Work order accepted — ${ref}`,
      acceptRows +
        `<p style="margin:12px 0 0">Your work order has been <strong>accepted and received</strong>. You will receive email updates as the job progresses — through scheduling, completion, and billing.</p>`,
      {
        alias: 'vendor-ticket-accepted',
        variables: {
          VENDOR: route.display_name,
          REFERENCE: ref,
          JOB_NUMBER: result.sfJob,
          ROWS_HTML: acceptRows,
        },
      },
    );
    return page('✓ Work order created', `Service Fusion job <strong>${esc(result.sfJob)}</strong> is in — status ${esc(route.sf_job_status_initial || 'Unscheduled')}. The submitter and notification lists have been emailed.`);
  }
  return page('Creation failed', 'Service Fusion rejected the job — the send list got the error details, and the ticket is saved for retry.', 502);
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

  return applyStatusChange(ticket, extracted.status, {
    source: 'sf-notification-email',
    raw: { subject: email.subject, from: email.from },
  });
}

async function loadRouteForTicket(ticket) {
  const routes = ticket.route_id
    ? await sbSelect('vendor_email_routes', `id=eq.${ticket.route_id}&select=*&limit=1`)
    : [];
  return (
    routes[0] ||
    { display_name: ticket.vendor_key || 'Vendor', send_list: ['service@brixbev.com'], vendor_notify_list: [] }
  );
}

// The ONE status-change pipeline — fed by both the SF notification email
// (instant, when SF sends one) and the 5-minute poller (the guarantee).
// Updates go to the vendor (submitter + configured contacts) AND the internal
// send list — "all the way to the billing".
async function applyStatusChange(ticket, rawStatus, { source = 'sf-notification-email', raw = {}, jobDetail = null } = {}) {
  const jobNumber = String(ticket.sf_job_number || ticket.sf_job_id || '');
  const newStatus = String(rawStatus || '').trim();
  if (!newStatus || newStatus.toLowerCase() === (ticket.last_sf_status || '').toLowerCase()) {
    return { ok: true, ignored: 'status unchanged' };
  }

  const route = await loadRouteForTicket(ticket);
  const recipients = dedupeEmails([
    ...(route.send_list || []),
    ...(route.vendor_notify_list || []),
    ticket.from_email,
  ]);

  await sbInsert('vendor_ticket_events', {
    ticket_id: ticket.id,
    sf_job_number: jobNumber,
    sf_status: newStatus,
    source,
    notified_to: recipients,
    raw,
  });
  await sbUpdate('vendor_email_tickets', `id=eq.${ticket.id}`, {
    last_sf_status: newStatus,
    last_status_at: new Date().toISOString(),
  });

  // Enrich the update with live job detail so completion/billing emails carry
  // the actual outcome (what was done, totals), not just the status name.
  // Best-effort: a failed SF read still sends the basic update.
  let job = jobDetail;
  if (!job) {
    try {
      job = await sfRequest('GET', `/jobs/${ticket.sf_job_id || jobNumber}`);
    } catch (e) {
      console.warn('SF job detail fetch failed (sending basic update):', e.message);
    }
  }
  const money = (v) => (v !== null && v !== undefined && v !== '' ? `$${v}` : null);

  const updateRows =
    row('Reference', ticket.parsed?.reference_number) +
    row('Our job #', jobNumber) +
    row('New status', newStatus) +
    row('Previous status', ticket.last_sf_status || '(first update)') +
    row('Location', ticket.parsed?.location_name) +
    row('Scheduled for', job?.start_date) +
    row('Completed', job?.closed_at) +
    row('Work performed', job?.completion_notes) +
    row('Tech notes', job?.tech_notes) +
    row('Job total', money(job?.total)) +
    row('Amount due', money(job?.due_total)) +
    row('Payment status', job?.payment_status) +
    row('Original request', ticket.subject);
  await sendTo(
    recipients,
    `Work order update — ${ticket.parsed?.reference_number || `job ${jobNumber}`}: ${newStatus}`,
    updateRows,
    {
      alias: 'vendor-ticket-update',
      variables: {
        VENDOR: route.display_name || 'Vendor',
        REFERENCE: ticket.parsed?.reference_number || `job ${jobNumber}`,
        JOB_NUMBER: jobNumber,
        NEW_STATUS: newStatus,
        ROWS_HTML: updateRows,
      },
    },
  );
  return { ok: true, ticketId: ticket.id, status: newStatus };
}

// The 5-minute safety net (called by vendor-ticket-status-poll.mjs): walk
// every open vendor ticket, read its SF job, and relay any status change
// through the same pipeline as the email trigger. Tickets stop polling once
// they reach a terminal status (invoiced/cancelled) or go stale (60 days).
const TERMINAL_STATUS = /invoiced|cancel/i;
const POLL_MAX_PER_TICK = 25;
const POLL_MAX_AGE_DAYS = 60;

export async function pollVendorTicketStatuses() {
  const tickets = await sbSelect(
    'vendor_email_tickets',
    `status=eq.sf_created&sf_job_id=not.is.null&select=*&order=last_status_at.asc.nullsfirst&limit=${POLL_MAX_PER_TICK}`,
  );
  const results = [];
  let checked = 0;
  for (const ticket of tickets) {
    if (TERMINAL_STATUS.test(ticket.last_sf_status || '')) continue;
    const ageDays = (Date.now() - new Date(ticket.created_at).getTime()) / 86400000;
    if (ageDays > POLL_MAX_AGE_DAYS) continue;
    checked++;
    try {
      const job = await sfRequest('GET', `/jobs/${ticket.sf_job_id}`);
      const status = String(job?.status || '').trim();
      if (!status) continue;
      const r = await applyStatusChange(ticket, status, { source: 'sf-poll', jobDetail: job });
      if (r.status) results.push({ ticketId: ticket.id, job: ticket.sf_job_id, status: r.status });
    } catch (e) {
      console.warn(`[vendor-poll] job ${ticket.sf_job_id} read failed: ${e.message}`);
    }
  }
  const summary = { ok: true, open: tickets.length, checked, changes: results };
  console.log('[vendor-poll]', JSON.stringify(summary));
  return summary;
}

// ─── Entry point ───

export async function handler(event) {
  // Approve/Decline clicks from the confirmation email arrive as GETs
  if (event.httpMethod === 'GET') {
    try {
      return await handleConfirmClick(event.queryStringParameters || {});
    } catch (e) {
      console.error('confirm-click error:', e);
      return { statusCode: 500, body: 'Something went wrong — try the link again.' };
    }
  }
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
  // Two accepted auth shapes: the ?secret= query param baked into the webhook
  // URL (the house pattern — sf-inbound/resq-inbound do the same), or a valid
  // Svix signature when RESEND_INBOUND_SECRET holds the whsec_ signing secret.
  const qsSecret = String((event.queryStringParameters || {}).secret || '');
  const qsOk =
    qsSecret.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(qsSecret), Buffer.from(secret));
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (!qsOk && !verifySvix(headers, rawBody, secret)) {
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
