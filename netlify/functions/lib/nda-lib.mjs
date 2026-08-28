// nda-lib.mjs — shared plumbing for electronic NDAs.
//
// Used by nda-admin.mjs (staff: send, track, log, template) and nda-sign.mjs
// (the public token-gated signing page). One definition of a token, one way of
// filing an executed agreement, one email look.
//
// Token model, lifted from the vendor-onboarding flow: 32 random bytes,
// base64url; only the sha256 HASH is stored, so the raw token exists solely
// inside the emailed link and a database read can never mint a signing link.

import { createHash, randomBytes } from 'node:crypto';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase-helpers.mjs';
import { SITE_URL } from '../email-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;

export const BUCKET = 'compliance-docs';
export const SIGN_PAGE = `${SITE_URL}/nda`;
export const DEFAULT_TTL_DAYS = 30;

/** Service-role PostgREST call against the ops schema. */
export async function ops(method, path, body, extra = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const hashToken = (raw) => createHash('sha256').update(String(raw)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const linkFor = (raw) => `${SIGN_PAGE}?t=${raw}`;
export const SEND_PAGE = `${SITE_URL}/nda-send`;
export const senderLinkFor = (raw) => `${SEND_PAGE}?k=${raw}`;

export const ENTITY_TYPES = [
  'corporation', 'limited liability company', 'limited partnership',
  'general partnership', 'sole proprietorship', 'other',
];
export const SERVICE_OPTIONS = [
  'co-packing', 'contract manufacturing', 'blending', 'filling',
  'laboratory testing', 'analytical services', 'product development',
  'ingredient supply', 'other',
];

export const clean = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── delegated sender links ──────────────────────────────────────────────────
//
// A sender link is a CREDENTIAL: whoever holds it can send Brix-branded email.
// These four helpers are the whole guard rail, kept pure and kept here so the
// send endpoint and the issuing endpoint cannot drift apart on what "usable"
// means. tests/nda.test.mjs pins each one.

export const LINK_TTL_DAYS = 90;
export const LINK_MAX_PER_DAY = 5;

/** Clamp an issuer's expiry choice. A link with no end date is a key nobody
 *  ever takes back, so there is no unlimited option — only 1..365 days. */
export const clampLinkTtl = (days) =>
  Math.min(Math.max(parseInt(days, 10) || LINK_TTL_DAYS, 1), 365);

/** Clamp the rolling-24h send limit. Same reasoning: a cap of "none" cannot be
 *  chosen by accident, and 50 is already far more NDAs than a day's work. */
export const clampLinkRate = (n) =>
  Math.min(Math.max(parseInt(n, 10) || LINK_MAX_PER_DAY, 1), 50);

/**
 * Is this link usable right now? Returns null when it is, or { error, status }.
 *
 * Revocation and expiry are checked HERE rather than in a database filter so
 * the holder gets an honest sentence — "ask the office for a new one" — instead
 * of the same "not valid" a stranger poking at the endpoint sees. The malformed
 * case above them deliberately reads identically to a wrong token: a probe
 * learns nothing about which tokens exist.
 */
export function linkUnusable(link, now = Date.now()) {
  if (!link) return { error: 'This link is not valid.', status: 404 };
  if (link.revoked_at) {
    return { error: 'This link has been switched off. Ask the office for a new one.', status: 410 };
  }
  if (new Date(link.expires_at).getTime() < now) {
    return { error: 'This link has expired. Ask the office for a new one.', status: 410 };
  }
  return null;
}

/**
 * The services an outgoing agreement carries.
 *
 * Only values from SERVICE_OPTIONS survive — the list is printed into an
 * executed legal document, so a delegate must not be able to write free text
 * into it. An empty or absent choice falls back to the defaults the issuer set,
 * which is what makes a rep's send one field long.
 */
export function pickServices(requested, link) {
  const allowed = (v) => (Array.isArray(v)
    ? v.map((s) => clean(s, 60)).filter((s) => SERVICE_OPTIONS.includes(s)).slice(0, 12)
    : []);
  const chosen = allowed(requested);
  return chosen.length ? chosen : allowed(link?.default_services);
}

/** Today's date in Pacific as YYYY-MM-DD — the effective date must be the day
 *  the signer experienced, not whatever day it is in the Lambda's UTC clock. */
export function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Best-effort client IP from the platform headers. */
export function clientIp(req) {
  const h = req.headers;
  const get = (k) => (typeof h?.get === 'function' ? h.get(k) : (h || {})[k]) || '';
  const fwd = get('x-nf-client-connection-ip') || get('x-forwarded-for') || get('client-ip');
  return String(fwd).split(',')[0].trim().slice(0, 60);
}

/**
 * Validate a raw signing token. Returns { agreement } or { error, status }.
 * A SIGNED agreement is NOT an error — the recipient is entitled to come back
 * and re-read or re-download what they signed, so it resolves normally and the
 * caller decides what to show.
 */
export async function validateToken(raw) {
  if (!raw || typeof raw !== 'string' || raw.length < 20 || raw.length > 100) {
    return { error: 'This signing link is not valid.', status: 400 };
  }
  const rows = await ops('GET', `nda_agreements?select=*&token_hash=eq.${hashToken(raw)}&limit=1`);
  const a = rows && rows[0];
  if (!a) return { error: 'This signing link is not valid.', status: 404 };
  if (a.status === 'revoked') {
    return { error: 'This agreement has been withdrawn. Please contact us if you think that is a mistake.', status: 410 };
  }
  if (a.status !== 'signed' && new Date(a.expires_at).getTime() < Date.now()) {
    return { error: 'This signing link has expired. Ask us for a fresh one and we will send it right over.', status: 410 };
  }
  return { agreement: a };
}

/** Load the Exhibit A log for an agreement (oldest first, as a log reads). */
export async function loadLog(agreementId) {
  return (await ops('GET',
    `nda_disclosure_log?select=*&agreement_id=eq.${agreementId}&order=disclosed_on.asc,created_at.asc`)) || [];
}

export async function uploadPdf(path, bytes) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`PDF upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return path;
}

/**
 * Make sure the counterparty exists in the compliance vault's party list, so
 * the executed NDA files against the same party as their COI and W-9 rather
 * than floating loose. Matches on name before creating — a duplicate party
 * splits a vendor's paperwork across two records, which is the failure the
 * vault exists to prevent.
 */
export async function ensureParty(a) {
  if (a.insured_party_id) return a.insured_party_id;
  const name = a.recipient_legal_name || a.recipient_company;
  const found = await ops('GET',
    `insured_parties?select=id,name&name=ilike.${encodeURIComponent(name.replace(/[%_,()]/g, ' ').trim())}&limit=1`);
  if (found && found[0]) return found[0].id;
  const created = await ops('POST', 'insured_parties', {
    name,
    party_type: a.party_type_hint || 'vendor',
    contact_name: a.signer_name || a.recipient_contact || null,
    contact_email: a.signer_email || a.recipient_email || null,
    notes: `Created when NDA ${a.agreement_number} was executed`,
  }, { Prefer: 'return=representation' });
  return created[0].id;
}

/** File the executed PDF in the compliance vault. Returns the document id. */
export async function fileInVault(a, storagePath) {
  const rows = await ops('POST', 'compliance_documents', {
    category: 'legal',
    doc_type: 'NDA',
    party_id: a.insured_party_id,
    issuer: 'Alameda Point Beverage Group, Inc.',
    reference_number: a.agreement_number,
    issue_date: a.effective_date,
    // Deliberately NO expiration_date. This NDA survives five years past
    // termination and, for trade secrets, in perpetuity — an expiry date here
    // would put it on the compliance expiry digest as if it lapsed, which is
    // both wrong and the sort of wrong that gets a real obligation ignored.
    storage_path: storagePath,
    file_name: `${a.agreement_number}.pdf`,
    notes: [
      `Executed electronically ${a.signed_at}`,
      `Signed by ${a.signer_name || ''}${a.signer_title ? ', ' + a.signer_title : ''} for ${a.recipient_legal_name || a.recipient_company}`,
      a.purpose_scope ? `Purpose: ${a.purpose_scope}` : '',
      `Template ${a.template_code} v${a.template_version}`,
    ].filter(Boolean).join('\n'),
  }, { Prefer: 'return=representation' });
  return rows[0].id;
}

// ── Email ───────────────────────────────────────────────────────────────────
const shell = (kicker, heading, sub, inner) => `<div style="font-family:'DM Sans',-apple-system,Segoe UI,Arial,sans-serif;background:#F5F7FA;padding:24px 12px">
  <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #E4E9F0;border-radius:14px;overflow:hidden">
    <div style="background:#1F4E79;padding:18px 22px;color:#fff">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9FD0E8;font-weight:700">${esc(kicker)}</div>
      <div style="font-size:21px;font-weight:800;margin-top:4px">${esc(heading)}</div>
      ${sub ? `<div style="font-size:13px;color:#C9E2F0;margin-top:2px">${esc(sub)}</div>` : ''}
    </div>
    <div style="height:4px;background:#F4B400"></div>
    <div style="padding:20px 22px;font-size:14px;color:#0F172A;line-height:1.55">${inner}</div>
  </div></div>`;

const btn = (href, label) => `<p style="margin:0 0 16px"><a href="${esc(href)}" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:8px">${esc(label)}</a></p>`;

/** The invitation to sign. */
export function inviteEmail({ a, link, note, ttlDays }) {
  const inner = `
    <p style="margin:0 0 12px">Hello${a.recipient_contact ? ' ' + esc(a.recipient_contact) : ''},</p>
    <p style="margin:0 0 12px">Before we share formulations, specifications or samples with
      <b>${esc(a.recipient_company)}</b>, we ask for a signed confidentiality agreement. You can read
      and sign it online — it takes about three minutes and there is nothing to print or scan.</p>
    ${note ? `<p style="margin:0 0 14px;padding:12px 14px;background:#F1F6FB;border-left:3px solid #1F4E79;border-radius:0 8px 8px 0;color:#22405C">${esc(note)}</p>` : ''}
    ${btn(link, 'Read and sign the agreement →')}
    <p style="margin:0 0 8px;color:#374151;font-size:13px">You will fill in your company's legal name and
      address, tell us who is signing, and sign on screen. A complete PDF of the signed agreement is
      emailed to you the moment you finish, and you can download it on the spot.</p>
    <p style="margin:0;color:#64748B;font-size:12px">This link is personal to ${esc(a.recipient_company)}
      and expires in ${esc(ttlDays)} days. Reference ${esc(a.agreement_number)}.</p>`;
  return shell('Alameda Point Beverage Group · Brix Beverage',
    'Please review and sign our NDA', a.recipient_company, inner);
}

/** Sent to the recipient once executed, with the PDF attached. */
export function executedEmailRecipient({ a }) {
  const inner = `
    <p style="margin:0 0 12px">Thank you — the confidentiality agreement between
      <b>Alameda Point Beverage Group, Inc.</b> and <b>${esc(a.recipient_legal_name || a.recipient_company)}</b>
      is now fully executed.</p>
    <p style="margin:0 0 12px">A complete PDF copy is attached for your records. It includes both
      signatures and a page recording how your electronic signature was captured.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 14px">
      <tr><td style="padding:5px 0;color:#64748B">Reference</td><td style="padding:5px 0;font-weight:700">${esc(a.agreement_number)}</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Effective date</td><td style="padding:5px 0;font-weight:700">${esc(a.effective_date || '')}</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Signed by</td><td style="padding:5px 0;font-weight:700">${esc(a.signer_name || '')}${a.signer_title ? ', ' + esc(a.signer_title) : ''}</td></tr>
    </table>
    <p style="margin:0;color:#64748B;font-size:12px">If you would like a paper copy, reply to this email
      and we will post one to you.</p>`;
  return shell('Alameda Point Beverage Group', 'Your signed NDA', a.agreement_number, inner);
}

/** Sent to staff once executed, with the PDF attached. */
export function executedEmailStaff({ a }) {
  const inner = `
    <p style="margin:0 0 12px"><b>${esc(a.recipient_legal_name || a.recipient_company)}</b> has signed
      ${esc(a.agreement_number)}. The executed PDF is attached and filed in the compliance vault.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 14px">
      <tr><td style="padding:5px 0;color:#64748B">Signer</td><td style="padding:5px 0;font-weight:700">${esc(a.signer_name || '')}${a.signer_title ? ', ' + esc(a.signer_title) : ''} &lt;${esc(a.signer_email || a.recipient_email)}&gt;</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Entity</td><td style="padding:5px 0">${esc([a.recipient_state, a.recipient_entity_type].filter(Boolean).join(' '))}</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Address</td><td style="padding:5px 0">${esc(a.recipient_address || '')}</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Purpose</td><td style="padding:5px 0">${esc(a.purpose_scope || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Services</td><td style="padding:5px 0">${esc((a.services || []).join(', ') || '—')}</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Signed at</td><td style="padding:5px 0">${esc(a.signed_at || '')} · IP ${esc(a.signer_ip || '—')}</td></tr>
    </table>
    <p style="margin:0;color:#64748B;font-size:12px">Log each formulation, spec sheet and sample you send
      them on the agreement's Exhibit A in Compliance &amp; Safety → NDAs. That log is what makes
      "they had our formula" provable later.</p>`;
  return shell('Compliance & Safety', 'NDA signed', a.recipient_company, inner);
}

/** Handing a delegated sender link to the person who will use it. The copy is
 *  blunt about what the link is, because the holder is the only person who can
 *  keep it from being pasted somewhere it should not be. */
export function senderLinkEmail({ link, url, ttlDays }) {
  const inner = `
    <p style="margin:0 0 12px">Hello ${esc(link.person_name)},</p>
    <p style="margin:0 0 12px">Here is your personal link for sending our confidentiality agreement.
      Open it, type the company and the email of whoever will sign, and press send — no login needed.</p>
    ${btn(url, 'Open your sending page →')}
    <p style="margin:0 0 12px;padding:12px 14px;background:#FFF7ED;border-left:3px solid #C2410C;border-radius:0 8px 8px 0;color:#7C2D12">
      <b>Treat this link like a key.</b> Anyone who has it can send email in our name. Don't forward it,
      don't paste it into a group chat, and tell the office straight away if you lose the device it's on —
      we can switch it off in seconds.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 14px">
      <tr><td style="padding:5px 0;color:#64748B">Good for</td><td style="padding:5px 0;font-weight:700">${esc(ttlDays)} days</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Limit</td><td style="padding:5px 0;font-weight:700">${esc(link.max_per_day)} NDAs per 24 hours</td></tr>
      <tr><td style="padding:5px 0;color:#64748B">Signed for us by</td><td style="padding:5px 0;font-weight:700">${esc(link.company_signer_name)}${link.company_signer_title ? ', ' + esc(link.company_signer_title) : ''}</td></tr>
    </table>
    <p style="margin:0;color:#64748B;font-size:12px">You'll get a copy of every NDA sent through this link,
      and the signed PDF when it comes back.</p>`;
  return shell('Alameda Point Beverage Group · Brix Beverage',
    'Your NDA sending link', esc(link.label), inner);
}

export function declinedEmailStaff({ a, reason }) {
  return shell('Compliance & Safety', 'NDA declined', a.recipient_company, `
    <p style="margin:0 0 12px"><b>${esc(a.recipient_company)}</b> declined ${esc(a.agreement_number)}.</p>
    <p style="margin:0 0 12px;padding:12px 14px;background:#FEF3F2;border-left:3px solid #B42318;border-radius:0 8px 8px 0">
      ${esc(reason || 'No reason given.')}</p>
    <p style="margin:0;color:#64748B;font-size:12px">Nothing confidential should go to them until this is resolved.</p>`);
}
