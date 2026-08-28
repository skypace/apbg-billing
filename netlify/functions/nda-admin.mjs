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
//   link_create / link_list / link_revoke → delegated sender links (see below)
//
// A SENDER LINK lets a named person send our NDA without a hub login. It is a
// credential — whoever holds it can send Brix-branded email — so it is issued
// and revoked here, but USED through a separate function (nda-send.mjs) that
// contains no code for listing, opening or downloading anything.
//
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY/SENDGRID_API_KEY.

import { requireAuth } from './lib/auth.mjs';
import { sendEmail } from './email-helpers.mjs';
import {
  NDA_FROM, ops, newToken, hashToken, linkFor, senderLinkFor, loadLog, clean,
  DEFAULT_TTL_DAYS, ENTITY_TYPES, SERVICE_OPTIONS, inviteEmail, senderLinkEmail,
  clampLinkTtl, clampLinkRate, pickServices,
} from './lib/nda-lib.mjs';
import { renderNdaHtml } from './lib/nda-doc.mjs';
import { describeImageProblem } from './lib/nda-image.mjs';
import { NDA_V1, SHIPPED, FLAVOURS, DEFAULT_CODE } from './lib/nda/index.mjs';

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
  'viewed_at,pdf_path,insured_party_id,document_id,sender_link_id,notes,created_by,created_at';

/**
 * The active template for a code, seeding the shipped v1.0 text the first time
 * one is asked for. Templates are editable in the database so terms can be
 * revised without a deploy, but the approved wording lives in the repo — a
 * fresh environment must never be able to send an empty or improvised NDA.
 */
async function activeTemplate(code) {
  const want = code || DEFAULT_CODE;
  const rows = await ops('GET',
    `nda_templates?select=*&active=is.true&code=eq.${encodeURIComponent(want)}&order=created_at.desc&limit=1`);
  if (rows && rows[0]) return rows[0];
  const shipped = SHIPPED[want];
  if (!shipped) return null;
  const seeded = await ops('POST', 'nda_templates', {
    code: shipped.code,
    version: shipped.version,
    title: shipped.title,
    subtitle: shipped.subtitle,
    body_source: shipped.body_source,
    notes: shipped.notes,
    mutual: !!shipped.mutual,
    active: true,
    created_by: 'system (shipped template)',
  }, { Prefer: 'return=representation,resolution=merge-duplicates' });
  return (seeded && seeded[0]) || null;
}

/** Seed every shipped agreement, so the picker is never a list of one. */
async function seedAllTemplates() {
  for (const code of Object.keys(SHIPPED)) await activeTemplate(code).catch(() => null);
}

/**
 * Resolve who countersigns, and pick up their stored signature.
 *
 * The signature is SNAPSHOTTED onto the agreement by the caller, exactly like
 * body_source: re-drawing your signature later must not change a document
 * somebody has already signed.
 *
 * Falls back to a name with no signature rather than refusing — an agreement
 * with a typed company name is what we sent for months and is still valid; one
 * that never went out because a PNG was missing helps nobody.
 */
async function resolveSignatory({ id, email, name, title }) {
  let row = null;
  if (id) {
    const rows = await ops('GET', `nda_signatories?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    row = (rows && rows[0]) || null;
  }
  if (!row && email) {
    const rows = await ops('GET',
      `nda_signatories?select=*&active=is.true&email=eq.${encodeURIComponent(String(email).toLowerCase())}&limit=1`);
    row = (rows && rows[0]) || null;
  }
  return {
    id: row?.id || null,
    name: clean(name, 120) || row?.name || '',
    title: clean(title, 120) || row?.title || null,
    signature: row?.signature_data || null,
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const auth = await requireAuth(req, STAFF);
  if (!auth.ok) return auth.response;
  const actor = auth.user?.email || 'staff';
  const staffName = clean(auth.user?.user_metadata?.full_name || auth.user?.user_metadata?.name || '', 120);

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Expected JSON.' }); }
  const action = body.action || 'list';

  try {
    // ── list ────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const rows = await ops('GET', `nda_agreements?select=${SAFE_COLS}&order=created_at.desc&limit=300`) || [];
      const counts = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
      await seedAllTemplates();   // first-run seed of every shipped agreement
      const templates = await ops('GET', 'nda_templates?select=id,code,version,title,subtitle,active&order=code,version') || [];
      return json(200, {
        ok: true, agreements: rows, counts, templates,
        entity_types: ENTITY_TYPES, service_options: SERVICE_OPTIONS, flavours: FLAVOURS,
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

      const signatory = await resolveSignatory({
        id: clean(body.company_signatory_id, 40),
        email: body.company_signatory_id ? null : actor,
        name: body.company_signer_name,
        title: body.company_signer_title,
      });
      if (!signatory.name) return json(400, { error: 'Enter who is signing for Alameda Point Beverage Group.' });
      const companySigner = signatory.name;

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
        company_signer_title: signatory.title,
        company_signed_at: new Date().toISOString(),
        // Snapshot, same rule as body_source above.
        company_signature_data: signatory.signature,
        company_signatory_id: signatory.id,
        mutual: !!tpl.mutual,
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
            from: NDA_FROM,
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

    // ── Delegated sender links ──────────────────────────────────────────────
    if (action === 'link_list') {
      const rows = await ops('GET',
        'nda_sender_links?select=id,label,person_name,person_email,company_signer_name,' +
        'company_signer_title,default_purpose,default_services,expires_at,max_per_day,sends_count,' +
        'last_used_at,revoked_at,revoked_by,notes,created_by,created_at&order=created_at.desc&limit=100') || [];
      // Per-link 24h usage, so the panel shows what the rate limit currently sees.
      for (const r of rows) {
        if (r.revoked_at) { r.sends_24h = 0; continue; }
        try { r.sends_24h = await ops('POST', 'rpc/fn_nda_link_sends_24h', { p_link_id: r.id }); }
        catch { r.sends_24h = null; }
      }
      return json(200, { ok: true, links: rows, service_options: SERVICE_OPTIONS });
    }

    // ── signatories ─────────────────────────────────────────────────────────
    // Who signs for us, and their signature, drawn or uploaded once.
    if (action === 'signatories') {
      const rows = await ops('GET',
        'nda_signatories?select=*&order=active.desc,name&limit=100') || [];
      return json(200, { ok: true, signatories: rows, me: actor, my_name: staffName });
    }

    if (action === 'signatory_save') {
      const id = clean(body.id, 40);
      const name = clean(body.name, 120);
      if (!name) return json(400, { error: 'A signature needs the name it signs under.' });
      const sig = typeof body.signature_data === 'string' ? body.signature_data.trim() : '';
      // A data URL and nothing else. This ends up embedded in a PDF and in the
      // executed document — a remote URL would be a live dependency inside a
      // legal record, and something arbitrary would be an injection.
      if (sig && sig.length > 400_000) {
        return json(400, { error: 'That signature image is too large. Draw it on screen, or upload something under about 250 KB.' });
      }
      // Structural check, not just a prefix match: a malformed PNG stored here
      // would be embedded into every future agreement's PDF, and pdf-lib hangs
      // forever on some of them. Catch it at the one point a human can fix it.
      const sigProblem = describeImageProblem(sig || null);
      if (sigProblem) return json(400, { error: sigProblem });
      const patch = {
        name,
        title: clean(body.title, 120) || null,
        email: clean(body.email, 200).toLowerCase() || null,
        active: body.active === false ? false : true,
        notes: clean(body.notes, 500) || null,
      };
      // Absent means "leave it alone" — saving a title must not wipe a
      // signature. An explicit empty string clears it.
      if (body.signature_data !== undefined) patch.signature_data = sig || null;

      const saved = id
        ? await ops('PATCH', `nda_signatories?id=eq.${id}`, patch, { Prefer: 'return=representation' })
        : await ops('POST', 'nda_signatories', { ...patch, created_by: actor }, { Prefer: 'return=representation' });
      // Agreements already sent keep the signature they went out with — that is
      // the snapshot doing its job, not a bug to fix here.
      return json(200, { ok: true, signatory: saved[0] });
    }

    if (action === 'link_create') {
      // A name and an email are the whole of it. Everything else has a sane
      // default, because a form with eight boxes is a form nobody fills in —
      // and the two that ARE required are required for a reason: a link nobody
      // owns is a shared secret, and a shared secret gets pasted into a group
      // chat.
      const person_name = clean(body.person_name, 120);
      const person_email = clean(body.person_email, 200).toLowerCase();
      if (!person_name) return json(400, { error: 'Name the person this link belongs to.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(person_email)) {
        return json(400, { error: 'Enter their email — that is where the link goes, and every send is copied to them.' });
      }
      const label = clean(body.label, 120) || person_name;
      // Defaults to the staff member issuing it, from their PROFILE NAME only.
      // Never derived from an email address: this name is printed on executed
      // agreements as the officer who signed them, and "Skypace" is not a
      // signature. With no name on file the issuer is asked for one.
      const signatory = await resolveSignatory({
        id: clean(body.company_signatory_id, 40),
        email: body.company_signatory_id ? null : actor,
        name: body.company_signer_name,
        title: body.company_signer_title,
      });
      const company_signer_name = signatory.name || staffName;
      if (!company_signer_name) {
        return json(400, { error: 'Enter who these NDAs are countersigned by — it is printed on every one they send. The holder dispatches the document, they do not sign for us.' });
      }
      const ttlDays = clampLinkTtl(body.expires_days);
      const maxPerDay = clampLinkRate(body.max_per_day);
      const services = pickServices(body.default_services, null);

      const raw = newToken();
      const created = await ops('POST', 'nda_sender_links', {
        label, person_name, person_email,
        company_signer_name,
        company_signer_title: signatory.title,
        company_signatory_id: signatory.id,
        // Null = the delegate picks one-way or mutual; set = pinned to that one.
        template_code: SHIPPED[clean(body.template_code, 60)] ? clean(body.template_code, 60) : null,
        default_purpose: clean(body.default_purpose, 1000) || null,
        default_services: services,
        token_hash: hashToken(raw),
        expires_at: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
        max_per_day: maxPerDay,
        notes: clean(body.notes, 500) || null,
        created_by: actor,
      }, { Prefer: 'return=representation' });
      const sendLink = senderLinkFor(raw);

      let emailed = false, emailError = null;
      if (body.send_email !== false) {
        try {
          await sendEmail({
            from: NDA_FROM,
            to: person_email,
            subject: 'Your link for sending Brix NDAs',
            html: senderLinkEmail({ link: created[0], url: sendLink, ttlDays }),
            replyTo: auth.user?.email || undefined,
          });
          emailed = true;
        } catch (e) { emailError = e.message; }
      }
      // Always returned: shown once, stored only as a hash.
      return json(200, { ok: true, link: created[0], url: sendLink, emailed, email_error: emailError });
    }

    // ── link_resend ─────────────────────────────────────────────────────────
    // The raw token is shown once and stored only as a hash, so "send it to me
    // again" is impossible by design. This mints a NEW token and kills the old
    // one in the same write — which is the honest behaviour anyway: a link that
    // needs re-sending has usually gone astray, and the old copy should stop
    // working. The person, the signer and the limits all stay as they were.
    if (action === 'link_resend') {
      const id = clean(body.id, 40);
      const rows = await ops('GET', `nda_sender_links?select=*&id=eq.${id}&limit=1`);
      const l = rows && rows[0];
      if (!l) return json(404, { error: 'Not found.' });
      if (l.revoked_at) {
        return json(400, { error: 'That link is switched off. Issue a new one rather than reviving it.' });
      }
      const ttlDays = clampLinkTtl(body.expires_days);
      const raw = newToken();
      const updated = await ops('PATCH', `nda_sender_links?id=eq.${l.id}`, {
        token_hash: hashToken(raw),
        expires_at: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
      }, { Prefer: 'return=representation' });
      const sendLink = senderLinkFor(raw);

      let emailed = false, emailError = null;
      if (body.send_email !== false) {
        try {
          await sendEmail({
            from: NDA_FROM,
            to: l.person_email,
            subject: 'Your link for sending Brix NDAs',
            html: senderLinkEmail({ link: updated[0], url: sendLink, ttlDays, resent: true }),
            replyTo: auth.user?.email || undefined,
          });
          emailed = true;
        } catch (e) { emailError = e.message; }
      }
      return json(200, { ok: true, link: updated[0], url: sendLink, emailed, email_error: emailError, replaced: true });
    }

    if (action === 'link_revoke') {
      const id = clean(body.id, 40);
      const rows = await ops('GET', `nda_sender_links?select=id,label,revoked_at&id=eq.${id}&limit=1`);
      const l = rows && rows[0];
      if (!l) return json(404, { error: 'Not found.' });
      if (l.revoked_at) return json(200, { ok: true, already: true });
      const updated = await ops('PATCH', `nda_sender_links?id=eq.${l.id}`, {
        revoked_at: new Date().toISOString(), revoked_by: actor,
      }, { Prefer: 'return=representation' });
      // Agreements it already sent are untouched — they are real agreements,
      // and revoking the sender's link does not un-send them.
      return json(200, { ok: true, link: updated[0] });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 400) });
  }
};

export const config = { path: '/api/nda-admin' };
