// ap-inbox.mjs — shared plumbing for the AP bill inbox
// (bills@alamedapointbg.com → OCR → Brixpense bill draft).
//
// Config lives in ops.expense_settings under the key `ap_inbox`, so the
// address, the notify list and the sender rules are editable without a
// deploy — the same posture as the vendor routes.

import crypto from 'node:crypto';
import { SUPABASE_URL } from '../supabase-helpers.mjs';

export const DEFAULT_INBOX = 'bills@alamedapointbg.com';
export const AP_TAG = 'AP Inbox';

// ─── Supabase service-role REST (ops schema) ───

export function srHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    ...extra,
  };
}

export async function opsGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: srHeaders() });
  if (!res.ok) throw new Error(`ops read ${pathAndQuery} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function opsInsert(table, row, { ignoreDuplicates = false } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: srHeaders({
      Prefer: ignoreDuplicates
        ? 'return=representation,resolution=ignore-duplicates'
        : 'return=representation',
    }),
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`ops.${table} insert failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  return Array.isArray(out) ? out[0] || null : out || null;
}

export async function opsPatch(table, idFilter, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${idFilter}`, {
    method: 'PATCH',
    headers: srHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`ops.${table} update failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// ─── Config ───

export async function loadApInboxSettings() {
  let raw = null;
  try {
    const rows = await opsGet(`expense_settings?key=eq.ap_inbox&select=value&limit=1`);
    raw = rows?.[0]?.value ?? null;
  } catch { /* fall through to defaults */ }
  const v = raw && typeof raw === 'object' ? raw : {};
  const list = (x) => (Array.isArray(x) ? x.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : []);
  const emailMap = (x) => {
    const out = {};
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      for (const [k, val] of Object.entries(x)) {
        const key = String(k).trim().toLowerCase();
        const email = String(val || '').trim().toLowerCase();
        if (key && email.includes('@')) out[key] = email;
      }
    }
    return out;
  };
  return {
    enabled: v.enabled !== false,
    inbox: String(v.inbox || DEFAULT_INBOX).toLowerCase(),
    notify: Array.isArray(v.notify) ? v.notify.map(String).filter(Boolean) : [],
    allow_senders: list(v.allow_senders),
    block_senders: list(v.block_senders),
    ack_sender: v.ack_sender !== false,
    // OFF by default (Sky, 2026-08-23). Routing still happens — the bill is
    // owned by, notified to, and visible to the person it belongs to — but it
    // lands ready to post rather than waiting on a click that, for the common
    // case of a sender owning their own bill, only they were going to make.
    // Turn it on to make posting wait for an explicit approval.
    require_approval: v.require_approval === true,
    // Rung 1 override: point one person's emailed bills at somebody else.
    // This is the escape hatch for real separation of duties without a
    // rebuild — see resolveBillRouting.
    sender_routes: emailMap(v.sender_routes),
    // Rungs 3 and 4, for mail from outside the company.
    vendor_routes: emailMap(v.vendor_routes),
    department_approvers: emailMap(v.department_approvers),
    default_approver: String(v.default_approver || '').trim().toLowerCase() || null,
  };
}

/**
 * Sender policy. Deliberately OPEN by default: bills@ exists so vendors can
 * invoice us directly, so an empty allow list means "accept anyone". That is
 * the opposite of the Order Desk, where every sender is our own staff and a
 * closed list is the safety property. Here the safety property is that
 * nothing this inbox produces can reach QuickBooks without a human click, so
 * the worst a stranger can do is put a draft in a queue.
 */
export function senderAllowed(fromEmail, settings) {
  const from = String(fromEmail || '').toLowerCase();
  if (!from) return { ok: false, reason: 'no sender address' };
  const matches = (patterns) =>
    patterns.some((p) => (p.startsWith('@') || !p.includes('@') ? from.endsWith(p.replace(/^@/, '@')) || from.split('@')[1] === p : from === p));
  if (settings.block_senders.length && matches(settings.block_senders)) {
    return { ok: false, reason: `sender ${from} is on the block list` };
  }
  if (settings.allow_senders.length && !matches(settings.allow_senders)) {
    return { ok: false, reason: `sender ${from} is not on the allow list` };
  }
  return { ok: true };
}

// Auto-replies, bounces and calendar noise must never become a bill draft.
export function looksAutomated({ from, subject, headers }) {
  const f = String(from || '').toLowerCase();
  const s = String(subject || '').toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/.test(f.split('@')[0] || '')) return true;
  if (/^(automatic reply|out of office|undeliverable|delivery status notification|returned mail|read:)/.test(s)) return true;
  // Header names are case-INSENSITIVE and providers disagree on casing
  // ("Auto-Submitted" vs "auto-submitted"), so normalise the whole bag once
  // rather than guessing a spelling — guessing silently lets every
  // out-of-office through as a bill.
  const raw = headers && typeof headers === 'object' ? headers : {};
  const h = {};
  for (const [k, v] of Object.entries(raw)) h[String(k).toLowerCase()] = v;
  const get = (k) => String(h[k] ?? '').toLowerCase();
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (get('x-autoreply') || get('x-autorespond') || get('precedence') === 'bulk') return true;
  return false;
}

// ─── Address helpers ───

/** "Name <a@b.com>" | "a@b.com" | { email } → bare lowercase address. */
export function addr(value) {
  if (!value) return '';
  if (typeof value === 'object') return addr(value.email || value.address || '');
  const m = String(value).match(/<([^>]+)>/);
  return (m ? m[1] : String(value)).trim().toLowerCase();
}

export function displayName(value) {
  if (!value) return null;
  if (typeof value === 'object') return value.name || null;
  const m = String(value).match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
}

export function recipientsOf(payload) {
  const out = [];
  for (const field of ['to', 'cc', 'bcc']) {
    const v = payload?.[field];
    if (Array.isArray(v)) out.push(...v.map(addr));
    else if (v) out.push(addr(v));
  }
  return out.filter(Boolean);
}

export function dedupeEmails(list) {
  const seen = new Set();
  return (list || [])
    .map((e) => String(e || '').trim())
    .filter((e) => {
      const k = e.toLowerCase();
      if (!e || !k.includes('@') || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// ─── Svix signature verification (Resend webhook auth) ───
//
// RESEND_AP_INBOX_SECRET is read FIRST and either var may hold a
// comma-separated LIST. Resend mints a SEPARATE signing secret per webhook
// endpoint, shown once at creation and never retrievable again — so a new
// route cannot share an existing route's secret, and rotation is only
// possible if more than one secret can be accepted at a time.

export function inboundSecrets() {
  const raw = process.env.RESEND_AP_INBOX_SECRET || process.env.RESEND_INBOUND_SECRET || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function verifyOne(headers, rawBody, secret) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  return signature.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export function verifyInbound(headers, rawBody, queryStringSecret) {
  const secrets = inboundSecrets();
  if (!secrets.length) return { ok: false, status: 503, error: 'RESEND_AP_INBOX_SECRET not configured' };
  // A shared ?secret= baked into the webhook URL is also accepted, matching
  // how the vendor-email-intake webhook was registered.
  if (queryStringSecret && secrets.includes(queryStringSecret)) return { ok: true };
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = v;
  if (secrets.some((s) => verifyOne(lower, rawBody, s))) return { ok: true };
  return { ok: false, status: 401, error: 'bad signature' };
}

// ─── Submitter resolution ───
//
// ops.expense_requests.submitted_by is NOT NULL. Attribute an emailed bill to
// the PERSON who sent it whenever they are a real internal login — that is
// what makes it show up as theirs in Brixpense — and fall back through the
// same ladder the SF sweep uses so a vendor's own email can still land.

// Does this login actually have Brixpense access? The Supabase project is
// SHARED — brix-order customers, distributor partners and melt users all have
// logins here. Matching a sender on "is a login" alone would hand a customer's
// emailed invoice a staff owner and a spot in an approval queue. Mirrors the
// gateway's grantsAccess() for the 'billing' bucket, same as
// expense-cc-match's cardholder list.
const BILLING_ROLES = new Set(['superadmin', 'admin', 'finance']);

export function hasBrixpenseAccess(user) {
  const md = user?.user_metadata || {};
  if (md.role === 'superadmin') return true;
  const mods = Array.isArray(md.modules) ? md.modules : null;
  if (mods) return mods.includes('billing');
  return BILLING_ROLES.has(md.role);
}

/** An internal Brixpense user by email, or null. Never a customer login. */
export async function findInternalUser(email) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted || !key) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(wanted)}&per_page=20`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const users = Array.isArray(data) ? data : data?.users || [];
    const hit = users.find((u) => String(u.email || '').toLowerCase() === wanted);
    if (!hit?.id || !hasBrixpenseAccess(hit)) return null;
    return {
      id: hit.id,
      email: hit.email,
      name: hit.user_metadata?.name || hit.user_metadata?.full_name || hit.email,
    };
  } catch {
    return null;
  }
}

/**
 * Who owns an emailed bill, and therefore whose approval queue it lands in.
 *
 * The ladder, in order — first match wins, and every answer carries the reason
 * so the queue can say WHY a bill went where it went:
 *
 *   1. sender_routes[sender]     an explicit override. Point Joel's bills at
 *                                Anthony here when you want a real second pair
 *                                of eyes rather than a self-review.
 *   2. the sender themselves     when they are an internal Brixpense login.
 *                                Their bill, their queue.
 *   3. vendor_routes             mail from outside: match the OCR'd vendor to
 *                                whoever owns that spend.
 *   4. department_approvers      still outside: the department implied by the
 *                                OCR'd GL account label.
 *   5. default_approver          the catch-all, so an invoice can't sit unowned.
 *   6. unassigned                nothing matched — it stays a draft in the AP
 *                                Inbox for staff to triage by hand. The floor
 *                                is a visible pile, never a silent drop.
 *
 * ⚠ Rung 2 means the sender approves their own bill. That is a REVIEW gate —
 * it forces a human to look at the OCR before it can become a QBO transaction
 * — and deliberately not separation of duties. Rung 1 is how you get that.
 */
export function resolveBillRouting({ fromEmail, internalUser, ocrVendor, ocrAccountLabel, settings }) {
  const from = String(fromEmail || '').trim().toLowerCase();

  const override = from && settings.sender_routes[from];
  if (override) {
    return { owner_email: override, assigned: true, self_review: override === from,
             reason: `sender_routes override for ${from}` };
  }

  if (internalUser?.email) {
    const email = String(internalUser.email).toLowerCase();
    return { owner_email: email, assigned: true, self_review: true,
             reason: `${email} sent it and is an internal Brixpense user` };
  }

  const vendor = String(ocrVendor || '').trim().toLowerCase();
  if (vendor) {
    for (const [pattern, approver] of Object.entries(settings.vendor_routes)) {
      if (vendor.includes(pattern) || pattern.includes(vendor)) {
        return { owner_email: approver, assigned: true, self_review: false,
                 reason: `vendor "${ocrVendor}" matches the vendor route "${pattern}"` };
      }
    }
  }

  const account = String(ocrAccountLabel || '').trim().toLowerCase();
  if (account) {
    for (const [dept, approver] of Object.entries(settings.department_approvers)) {
      if (account.includes(dept)) {
        return { owner_email: approver, assigned: true, self_review: false,
                 reason: `GL account "${ocrAccountLabel}" maps to the ${dept} approver` };
      }
    }
  }

  if (settings.default_approver) {
    return { owner_email: settings.default_approver, assigned: true, self_review: false,
             reason: 'no rule matched — routed to the default approver' };
  }

  return { owner_email: null, assigned: false, self_review: false,
           reason: 'nobody matched — held in the AP Inbox for triage' };
}

export async function resolveSubmitter(fromEmail) {
  const internal = await findInternalUser(fromEmail);
  if (internal) return { ...internal, matched_sender: true };

  const envId = process.env.AP_INBOX_SUBMITTER_ID;
  if (envId) {
    return { id: envId, email: process.env.AP_INBOX_SUBMITTER_EMAIL || null, name: 'AP Inbox (system)', matched_sender: false };
  }

  for (const q of [
    `expense_requests?tag=eq.${encodeURIComponent(AP_TAG)}&select=submitted_by,submitter_email&order=created_at.desc&limit=1`,
    `expense_requests?tag=eq.Service%20Fusion&select=submitted_by,submitter_email&order=created_at.desc&limit=1`,
    `expense_requests?select=submitted_by,submitter_email&order=created_at.desc&limit=1`,
  ]) {
    try {
      const rows = await opsGet(q);
      if (rows?.[0]?.submitted_by) {
        return { id: rows[0].submitted_by, email: rows[0].submitter_email, name: 'AP Inbox (system)', matched_sender: false };
      }
    } catch { /* try the next */ }
  }
  return null;
}

// ─── Attachment storage ───

export const ATTACH_BUCKET = 'expense-attachments';

export async function uploadAttachment({ base64, mediaType, filename, intakeId }) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !base64) return null;
  const bytes = Buffer.from(base64, 'base64');
  const path = `ap-inbox/${intakeId}/${filename}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${ATTACH_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': mediaType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`attachment upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { storage_path: path, file_name: filename, file_type: mediaType, file_size: bytes.length };
}
