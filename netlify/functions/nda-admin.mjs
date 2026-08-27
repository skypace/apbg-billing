// /api/nda-admin — the staff side of electronic NDAs.
//
// Send an NDA, watch it move, log what you disclosed under it, revoke it,
// and edit the template. Gated to staff (superadmin | admin), matching
// ops.fn_is_staff() and the RLS on the three nda_* tables — an NDA names a
// counterparty and the scope of work we are discussing with them, which is
// not for every login on this shared Supabase project.
//
// Actions
//   list                     → agreements + counts
//   get      { id }          → one agreement, its Exhibit A log, rendered HTML
//   create   { … }           → mint the link, optionally email it
//   resend   { id }          → NEW token, new expiry, re-email (the old link dies)
//   revoke   { id }          → kill the link; a signed agreement cannot be revoked
//   log_add / log_delete     → Exhibit A disclosure log
//   templates / template_save
//
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY/SENDGRID_API_KEY.

import { requireAuth } from './lib/auth.mjs';
import { sendEmail } from './email-helpers.mjs';
import {
  ops, newToken, hashToken, linkFor, loadLog, clean,
  DEFAULT_TTL_DAYS, ENTITY_TYPES, SERVICE_OPTIONS, inviteEmail,
} from './lib/nda-lib.mjs';
import { renderNdaHtml } from './lib/nda-doc.mjs';
import { NDA_V1 } from './lib/nda/nda-v1.mjs';

const STAFF = ['superadmin', 'admin'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});

const SAFE_COLS = 'id,agreement_number,status,template_code,template_version,title,subtitle,' +
  'recipient_company,recipient_email,recipient_contact,recipient_legal_name,recipient_entity_type,' +
  'recipient_state,recipient_address,signer_name,signer_title,signer_email,signer_phone,' +
  'purpose_scope,services,company_signer_name,company_signer_title,company_signed_at,' +
  'effective_date,signed_at,typed_name,signer_ip,signer_user_agent,consent_esign,' +
  'declined_at,decline_reason,revoked_at,revoked_by,expires_at,sent_at,sent_to,resent_count,' +
  'viewed_at,pdf_path,insured_party_id,document_id,notes,created_by,created_at';

/**
 * The active template for a code, seeding the shipped v1.0 text the first time
 * one is asked for. Templates are editable in the database so terms can be
 * revised without a deploy, but the approved wording lives in the repo — a
 * fresh environment must never be able to send an empty or improvised NDA.
 */
async function activeTemplate(code) {
  const want = code || NDA_V1.code;
  const rows = await ops('GET',
    `nda_templates?select=*&active=is.true&code=eq.${encodeURIComponent(want)}&order=created_at.desc&limit=1`);
  if (rows && rows[0]) return rows[0];
  if (want !== NDA_V1.code) return null;
  const seeded = await ops('POST', 'nda_templates', {
    code: NDA_V1.code,
    version: NDA_V1.version,
    title: NDA_V1.title,
    subtitle: NDA_V1.subtitle,
    body_source: NDA_V1.body_source,
    notes: NDA_V1.notes,
    active: true,
    created_by: 'system (shipped template)',
  }, { Prefer: 'return=representation,resolution=merge-duplicates' });
  return (seeded && seeded[0]) || null;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const auth = await requireAuth(req, STAFF);
  if (!auth.ok) return auth.response;
  const actor = auth.user?.email || 'staff';

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Expected JSON.' }); }
  const action = body.action || 'list';

  try {
    // ── list ────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const rows = await ops('GET', `nda_agreements?select=${SAFE_COLS}&order=created_at.desc&limit=300`) || [];
      const counts = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
      await activeTemplate().catch(() => null);   // first-run seed of the shipped text
      const templates = await ops('GET', 'nda_templates?select=id,code,version,title,subtitle,active&order=code,version') || [];
      return json(200, {
        ok: true, agreements: rows, counts, templates,
        entity_types: ENTITY_TYPES, service_options: SERVICE_OPTIONS,
      });
    }

    // ── get ─────────────────────────────────────────────────────────────────
    if (action === 'get') {
      const id = clean(body.id, 40);
      const rows = await ops('GET', `nda_agreements?select=*&id=eq.${id}&limit=1`);
      const a = rows && rows[0];
      if (!a) return json(404, { error: 'Not found.' });
      const log = await loadLog(a.id);
      const { token_hash, ...safe } = a;   // eslint-disable-line no-unused-vars
      return json(200, { ok: true, agreement: safe, log, html: renderNdaHtml(a, { log }) });
    }

    // ── create ──────────────────────────────────────────────────────────────
    if (action === 'create') {
      const recipient_company = clean(body.recipient_company, 200);
      const recipient_email = clean(body.recipient_email, 200).toLowerCase();
      if (!recipient_company) return json(400, { error: 'Who is this NDA for? Enter their company name.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient_email)) {
        return json(400, { error: 'Enter a valid email address for the person who will sign.' });
      }
      const tpl = await activeTemplate(clean(body.template_code, 60));
      if (!tpl) return json(400, { error: 'No active NDA template found. Add one under Template first.' });

      const companySigner = clean(body.company_signer_name, 120);
      if (!companySigner) return json(400, { error: 'Enter who is signing for Alameda Point Beverage Group.' });

      const services = Array.isArray(body.services)
        ? body.services.map((s) => clean(s, 60)).filter((s) => SERVICE_OPTIONS.includes(s)).slice(0, 12)
        : [];
      const ttlDays = Math.min(Math.max(parseInt(body.expires_days, 10) || DEFAULT_TTL_DAYS, 1), 120);

      const numRows = await ops('POST', 'rpc/fn_next_nda_number', {});
      const agreementNumber = typeof numRows === 'string' ? numRows : String(numRows);

      const raw = newToken();
      const created = await ops('POST', 'nda_agreements', {
        agreement_number: agreementNumber,
        status: 'sent',
        template_id: tpl.id,
        template_code: tpl.code,
        template_version: tpl.version,
        title: tpl.title,
        subtitle: tpl.subtitle,
        // THE SNAPSHOT. From here on this agreement renders from its own copy,
        // so editing the template later cannot change what this party signs.
        body_source: tpl.body_source,
        recipient_company,
        recipient_email,
        recipient_contact: clean(body.recipient_contact, 120) || null,
        purpose_scope: clean(body.purpose_scope, 1000) || null,
        services,
        company_signer_name: companySigner,
        company_signer_title: clean(body.company_signer_title, 120) || null,
        company_signed_at: new Date().toISOString(),
        token_hash: hashToken(raw),
        expires_at: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
        sent_to: recipient_email,
        insured_party_id: clean(body.party_id, 40) || null,
        created_by: actor,
      }, { Prefer: 'return=representation' });
      const a = created[0];
      const link = linkFor(raw);

      let emailed = false, emailError = null;
      if (body.send_email !== false) {
        try {
          await sendEmail({
            to: recipient_email,
            subject: `Please sign our confidentiality agreement — ${a.agreement_number}`,
            html: inviteEmail({ a, link, note: clean(body.note, 600), ttlDays }),
            replyTo: auth.user?.email || undefined,
          });
          emailed = true;
        } catch (e) { emailError = e.message; }
      }
      // The link is ALWAYS returned, emailed or not — if Resend is down the
      // right answer is to paste the link into a message yourself, not to have
      // no way of reaching the counterparty.
      return json(200, { ok: true, agreement: a, link, emailed, email_error: emailError });
    }

    // ── resend ──────────────────────────────────────────────────────────────
    if (action === 'resend') {
      const id = clean(body.id, 40);
      const rows = await ops('GET', `nda_agreements?select=*&id=eq.${id}&limit=1`);
      const a = rows && rows[0];
      if (!a) return json(404, { error: 'Not found.' });
      if (a.status === 'signed') return json(409, { error: 'That agreement is already signed.' });
      if (a.status === 'revoked') return json(409, { error: 'That agreement was revoked. Send a new one instead.' });

      // A fresh token, not the old one: a resend usually happens because the
      // first link went astray, and the old link should stop working.
      const raw = newToken();
      const ttlDays = Math.min(Math.max(parseInt(body.expires_days, 10) || DEFAULT_TTL_DAYS, 1), 120);
      const to = clean(body.recipient_email, 200).toLowerCase() || a.recipient_email;
      const updated = await ops('PATCH', `nda_agreements?id=eq.${a.id}`, {
        token_hash: hashToken(raw),
        expires_at: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
        sent_at: new Date().toISOString(),
        sent_to: to,
        recipient_email: to,
        resent_count: (a.resent_count || 0) + 1,
        status: a.status === 'declined' ? 'sent' : a.status,
      }, { Prefer: 'return=representation' });
      const link = linkFor(raw);
      let emailed = false, emailError = null;
      try {
        await sendEmail({
          to,
          subject: `Please sign our confidentiality agreement — ${a.agreement_number}`,
          html: inviteEmail({ a: updated[0], link, note: clean(body.note, 600), ttlDays }),
          replyTo: auth.user?.email || undefined,
        });
        emailed = true;
      } catch (e) { emailError = e.message; }
      return json(200, { ok: true, agreement: updated[0], link, emailed, email_error: emailError });
    }

    // ── revoke ──────────────────────────────────────────────────────────────
    if (action === 'revoke') {
      const id = clean(body.id, 40);
      const rows = await ops('GET', `nda_agreements?select=id,status,agreement_number&id=eq.${id}&limit=1`);
      const a = rows && rows[0];
      if (!a) return json(404, { error: 'Not found.' });
      if (a.status === 'signed') {
        return json(409, { error: 'A signed agreement cannot be revoked here — it is executed. Terminate it in writing under Section 14.' });
      }
      const updated = await ops('PATCH', `nda_agreements?id=eq.${a.id}`, {
        status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: actor,
      }, { Prefer: 'return=representation' });
      return json(200, { ok: true, agreement: updated[0] });
    }

    // ── Exhibit A disclosure log ────────────────────────────────────────────
    if (action === 'log_add') {
      const agreement_id = clean(body.agreement_id, 40);
      const description = clean(body.description, 500);
      if (!agreement_id || !description) return json(400, { error: 'Describe what you disclosed.' });
      const row = await ops('POST', 'nda_disclosure_log', {
        agreement_id,
        disclosed_on: clean(body.disclosed_on, 12) || undefined,
        description,
        format: clean(body.format, 60) || null,
        delivered_by: clean(body.delivered_by, 120) || actor,
        quantity: clean(body.quantity, 40) || null,
        created_by: actor,
      }, { Prefer: 'return=representation' });
      return json(200, { ok: true, entry: row[0] });
    }

    if (action === 'log_delete') {
      const id = clean(body.id, 40);
      await ops('DELETE', `nda_disclosure_log?id=eq.${id}`);
      return json(200, { ok: true });
    }

    // ── templates ───────────────────────────────────────────────────────────
    if (action === 'templates') {
      const rows = await ops('GET', 'nda_templates?select=*&order=code,created_at.desc') || [];
      return json(200, { ok: true, templates: rows });
    }

    if (action === 'template_save') {
      const code = clean(body.code, 60) || 'copack-nda';
      const version = clean(body.version, 20);
      const title = clean(body.title, 200);
      const source = typeof body.body_source === 'string' ? body.body_source.trim() : '';
      if (!version) return json(400, { error: 'Give the new version a number, e.g. 1.1.' });
      if (!title) return json(400, { error: 'The template needs a title.' });
      if (source.length < 500) return json(400, { error: 'That text looks too short to be the agreement.' });

      // A new VERSION, never an edit in place: agreements already sent point at
      // this row, and rewriting it under them would change the document a
      // pending signer is reading mid-sentence. (Signed ones are safe either
      // way — they carry their own snapshot.)
      const existing = await ops('GET',
        `nda_templates?select=id&code=eq.${encodeURIComponent(code)}&version=eq.${encodeURIComponent(version)}&limit=1`);
      if (existing && existing[0]) {
        return json(409, { error: `Version ${version} of ${code} already exists. Bump the version number.` });
      }
      await ops('PATCH', `nda_templates?code=eq.${encodeURIComponent(code)}&active=is.true`, { active: false });
      const row = await ops('POST', 'nda_templates', {
        code, version, title,
        subtitle: clean(body.subtitle, 200) || null,
        body_source: source,
        active: true,
        notes: clean(body.notes, 500) || null,
        created_by: actor,
      }, { Prefer: 'return=representation' });
      return json(200, { ok: true, template: row[0] });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 400) });
  }
};

export const config = { path: '/api/nda-admin' };
