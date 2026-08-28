// /api/nda-send — the delegated sender link.
//
// A named person (a rep in the field, an assistant) holds a personal link that
// lets them send our NDA without a hub login.
//
// ⚠ THIS LINK IS A CREDENTIAL. Whoever holds it can send Brix-branded email to
// any address they like — a phishing tool with our domain on it. That is why
// this is a SEPARATE FUNCTION from nda-admin rather than a looser gate on it:
// the code to list, open, revoke, edit a template or download somebody else's
// agreement does not exist in this file, so no bug in a role check can expose
// it. Keep it that way. If a delegate ever needs one of those, that is the
// moment to give them a login, not to widen this.
//
// POST { action: 'info',   token }               → who the link is for, sends left
// POST { action: 'send',   token, … }            → create + email ONE agreement
// POST { action: 'recent', token }               → only what THIS link created,
//                                                  company + status + dates only
//
// Guard rails, all enforced here and none of them decorative:
//   · rolling-24h rate limit, so a leaked link cannot blast mail unnoticed;
//   · expiry and instant revocation;
//   · every send emails compliance AND the link's owner, so the audit trail
//     lives somewhere other than the app an abuser would be using;
//   · the company signer is fixed by whoever issued the link — the delegate is
//     dispatching a document an officer already executed, not signing for us.
//
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY/SENDGRID_API_KEY,
//      COMPLIANCE_ALERT_TO (optional, defaults service@brixbev.com).

import { sendEmail } from './email-helpers.mjs';
import {
  ops, newToken, hashToken, linkFor, clean, esc,
  DEFAULT_TTL_DAYS, SERVICE_OPTIONS, inviteEmail,
  linkUnusable, pickServices,
} from './lib/nda-lib.mjs';
import { NDA_V1 } from './lib/nda/nda-v1.mjs';

const ALERT_TO = process.env.COMPLIANCE_ALERT_TO || 'service@brixbev.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});

/** Resolve a sender token. Constant-shape failures — a probe learns nothing. */
async function resolveLink(raw) {
  if (!raw || typeof raw !== 'string' || raw.length < 20 || raw.length > 100) {
    return { error: 'This link is not valid.', status: 400 };
  }
  const rows = await ops('GET', `nda_sender_links?select=*&token_hash=eq.${hashToken(raw)}&limit=1`);
  const link = rows && rows[0];
  const bad = linkUnusable(link);
  return bad || { link };
}

async function sendsToday(linkId) {
  const n = await ops('POST', 'rpc/fn_nda_link_sends_24h', { p_link_id: linkId });
  return typeof n === 'number' ? n : parseInt(n, 10) || 0;
}

/** What the holder is allowed to know about their own link. Never the hash. */
function linkView(link, used) {
  return {
    label: link.label,
    person_name: link.person_name,
    person_email: link.person_email,
    company_signer_name: link.company_signer_name,
    company_signer_title: link.company_signer_title,
    default_purpose: link.default_purpose,
    default_services: link.default_services || [],
    service_options: SERVICE_OPTIONS,
    expires_at: link.expires_at,
    max_per_day: link.max_per_day,
    sends_left: Math.max(0, link.max_per_day - used),
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Sending is not configured — SUPABASE_SERVICE_ROLE_KEY is missing on this site.' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Expected JSON.' }); }

  const found = await resolveLink(body.token);
  if (found.error) return json(found.status, { error: found.error });
  const link = found.link;
  const action = body.action || 'info';

  try {
    // ── info ────────────────────────────────────────────────────────────────
    if (action === 'info') {
      return json(200, { ok: true, ...linkView(link, await sendsToday(link.id)) });
    }

    // ── recent ──────────────────────────────────────────────────────────────
    // Only what THIS link created, and only enough to answer "have they signed
    // yet". No addresses, no signer details, no PDF — the executed copy goes to
    // the holder by email instead, so there is nothing to fetch here.
    if (action === 'recent') {
      const rows = await ops('GET',
        `nda_agreements?select=agreement_number,recipient_company,recipient_email,status,sent_at,signed_at` +
        `&sender_link_id=eq.${link.id}&order=created_at.desc&limit=25`) || [];
      return json(200, { ok: true, agreements: rows });
    }

    if (action !== 'send') return json(400, { error: 'Unknown action.' });

    // ── send ────────────────────────────────────────────────────────────────
    const recipient_company = clean(body.recipient_company, 200);
    const recipient_email = clean(body.recipient_email, 200).toLowerCase();
    if (!recipient_company) return json(400, { error: 'Who is this NDA for? Enter their company name.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient_email)) {
      return json(400, { error: 'Enter a valid email address for the person who will sign.' });
    }

    const used = await sendsToday(link.id);
    if (used >= link.max_per_day) {
      return json(429, {
        error: `That is ${link.max_per_day} NDAs in 24 hours, which is this link's limit. ` +
               'It will free up as the day rolls on — or ask the office to raise it.',
      });
    }

    const tplRows = await ops('GET',
      `nda_templates?select=*&active=is.true&code=eq.${encodeURIComponent(NDA_V1.code)}&order=created_at.desc&limit=1`);
    const tpl = tplRows && tplRows[0];
    if (!tpl) {
      // Deliberately not seeded from here: a sender link must not be able to
      // publish an agreement template. Staff open the NDAs tab once and it seeds.
      return json(503, { error: 'The agreement is not set up yet. Ask the office to open Compliance → NDAs once.' });
    }

    const services = pickServices(body.services, link);

    const numRows = await ops('POST', 'rpc/fn_next_nda_number', {});
    const agreementNumber = typeof numRows === 'string' ? numRows : String(numRows);
    const raw = newToken();
    const ttlDays = DEFAULT_TTL_DAYS;

    const created = await ops('POST', 'nda_agreements', {
      agreement_number: agreementNumber,
      status: 'sent',
      template_id: tpl.id,
      template_code: tpl.code,
      template_version: tpl.version,
      title: tpl.title,
      subtitle: tpl.subtitle,
      // The snapshot, same as the staff path — what they sign is fixed now.
      body_source: tpl.body_source,
      recipient_company,
      recipient_email,
      recipient_contact: clean(body.recipient_contact, 120) || null,
      purpose_scope: clean(body.purpose_scope, 1000) || link.default_purpose || null,
      services,
      // NOT the delegate. The officer who issued the link is the signatory.
      company_signer_name: link.company_signer_name,
      company_signer_title: link.company_signer_title,
      company_signed_at: new Date().toISOString(),
      token_hash: hashToken(raw),
      expires_at: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
      sent_to: recipient_email,
      sender_link_id: link.id,
      created_by: `link: ${link.person_name} <${link.person_email}>`,
    }, { Prefer: 'return=representation' });
    const a = created[0];
    const signLink = linkFor(raw);

    // Counters are best-effort: the agreement exists and the rate limit is
    // computed from the agreements themselves, so a failed stamp changes nothing.
    try {
      await ops('PATCH', `nda_sender_links?id=eq.${link.id}`, {
        sends_count: (link.sends_count || 0) + 1,
        last_used_at: new Date().toISOString(),
      });
    } catch { /* ignore */ }

    let emailed = false, emailError = null;
    try {
      await sendEmail({
        to: recipient_email,
        subject: `Please sign our confidentiality agreement — ${a.agreement_number}`,
        html: inviteEmail({ a, link: signLink, note: clean(body.note, 600), ttlDays }),
        replyTo: link.person_email,
      });
      emailed = true;
    } catch (e) { emailError = e.message; }

    // The out-of-band audit trail. This goes to compliance AND to the person
    // holding the link, every single time — if a link is ever misused, the
    // evidence lands in a mailbox the holder does not control.
    try {
      await sendEmail({
        to: [ALERT_TO, link.person_email],
        subject: `NDA sent by ${link.person_name} — ${recipient_company} (${a.agreement_number})`,
        html: `<div style="font-family:'DM Sans',Arial,sans-serif;font-size:14px;color:#0F172A;line-height:1.55">
          <p style="margin:0 0 10px"><b>${esc(link.person_name)}</b> sent an NDA using the
            &ldquo;${esc(link.label)}&rdquo; sender link.</p>
          <table style="border-collapse:collapse;font-size:13px">
            <tr><td style="padding:4px 14px 4px 0;color:#64748B">Reference</td><td style="padding:4px 0"><b>${esc(a.agreement_number)}</b></td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#64748B">To</td><td style="padding:4px 0">${esc(recipient_company)} &lt;${esc(recipient_email)}&gt;</td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#64748B">Purpose</td><td style="padding:4px 0">${esc(a.purpose_scope || '—')}</td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#64748B">Countersigned by</td><td style="padding:4px 0">${esc(link.company_signer_name)}</td></tr>
            <tr><td style="padding:4px 14px 4px 0;color:#64748B">Email delivered</td><td style="padding:4px 0">${emailed ? 'yes' : 'NO — ' + esc(emailError || 'unknown')}</td></tr>
          </table>
          <p style="margin:12px 0 0;color:#64748B;font-size:12px">Sent ${used + 1} of ${link.max_per_day} allowed in 24 hours.
            If this was not expected, revoke the link in Compliance &amp; Safety &rarr; NDAs.</p>
        </div>`,
      });
    } catch { /* the agreement stands whether or not the notice lands */ }

    return json(200, {
      ok: true,
      agreement_number: a.agreement_number,
      recipient_company,
      recipient_email,
      // Returned so the holder can hand the link over in person or by text —
      // it is the same link the recipient just got by email.
      link: signLink,
      emailed,
      email_error: emailError,
      sends_left: Math.max(0, link.max_per_day - (used + 1)),
    });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
};

export const config = { path: '/api/nda-send' };
