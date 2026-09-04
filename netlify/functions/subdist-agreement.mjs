// /api/subdist-agreement — build, preview, send and track a sub-distribution
// agreement. Staff only.
//
// The shape is the NDA's, for the same reasons, and the two rules that carry
// the weight are worth restating rather than inheriting silently:
//
//   1. THE SIGNED TEXT IS SNAPSHOTTED ONTO THE AGREEMENT, not referenced.
//      Templates stay editable — publish 1.1 without a deploy — but editing one
//      must never change what somebody already signed. A signature pointing at
//      mutable text is not evidence of anything. `body_source`, `deal_terms`
//      and the company signature image are all copied onto the row at build
//      time, and a database TRIGGER freezes them once status='signed'.
//
//   2. THE COMPANY BLOCK IS PRE-EXECUTED at send time by the staff member
//      sending it. This is our paper on our terms; the assent being collected
//      is theirs. A genuine two-step countersignature would be a different
//      flow, not a blank block.
//
// ⚠ The Fee and Territory Schedule is the one place the per-partner numbers
// live — territory, accounts, fees, payment term, notice addresses and the
// insurance limits §23 obliges them to carry. A blank Schedule renders as
// "no fees have been entered", never as silence.

import { requireAuth } from './lib/auth.mjs';
import { sendEmail, SITE_URL } from './email-helpers.mjs';
import {
  ops, SHIPPED, DEFAULT_CODE, activeTemplate, hashToken, mintToken,
  clampTtl, clean, companySignatory, linkUnusable,
} from './lib/distributor/subdist-agreement-lib.mjs';
import { renderSubdistHtml, dealTerms } from './lib/distributor/subdist-doc.mjs';
import { renderSubdistPdf } from './lib/distributor/subdist-pdf.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (s, d) => new Response(JSON.stringify(d), { status: s, headers: CORS });

export const SIGN_PAGE = `${SITE_URL}/distributor-agreement`;
export const signLinkFor = (raw) => `${SIGN_PAGE}?t=${raw}`;
const FROM = process.env.NDA_EMAIL_FROM
  || 'Alameda Point Beverage Group <legal@alamedapointbg.com>';

const UUID = /^[0-9a-f-]{36}$/i;
const AGREEMENT_SELECT = '*';

/** Columns a DRAFT may be edited through. Anything not listed here is set by
 *  the build or by signing — an allow-list, so a widened client can never
 *  reach the snapshot or the signature. */
const EDITABLE = new Set([
  'effective_date', 'expiry_date', 'scope', 'notes', 'sent_to',
  'counterparty_legal_name', 'counterparty_entity_type', 'counterparty_state',
  'counterparty_address', 'signer_name', 'signer_email', 'signer_title',
]);

async function loadAgreement(id) {
  const rows = await ops('GET', `sub_distributor_agreements?select=${AGREEMENT_SELECT}&id=eq.${id}&limit=1`);
  return rows?.[0] || null;
}
async function loadDistributor(id) {
  const rows = await ops('GET', `sub_distributors?select=*&id=eq.${id}&limit=1`);
  return rows?.[0] || null;
}

function inviteEmail({ dist, agreement, url, ttlDays, resent }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#16191d">
    <div style="padding:20px 0;border-bottom:2px solid #1f4e79">
      <img src="https://alamedapointbg.com/logos/brix-round.png" alt="Brix Beverage" height="44" style="vertical-align:middle">
      <img src="https://alamedapointbg.com/logos/alameda-seal.png" alt="Alameda Soda Co." height="44" style="vertical-align:middle;margin-left:10px">
    </div>
    <h1 style="font-size:20px;margin:24px 0 8px">${resent ? 'Your distribution agreement, again' : 'Your distribution agreement'}</h1>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px">
      ${esc(dist.name)} — here is the sub-distribution agreement${agreement.agreement_number
        ? ` (${esc(agreement.agreement_number)})` : ''} for you to read and sign.
      It covers the consignment stock we place with you, delivery and service on our systems,
      how you are paid each month, and what we ask of you around the brand.</p>
    <p style="margin:22px 0">
      <a href="${esc(url)}" style="display:inline-block;background:#1f4e79;color:#fff;text-decoration:none;
        padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600">Read and sign the agreement</a></p>
    <p style="font-size:13px;color:#5a636c;line-height:1.5;margin:0 0 10px">
      The link is personal to you and expires in ${ttlDays} days. You will get a PDF of the
      executed agreement by email as soon as you sign, and you can download it from the page
      at the same time.</p>
    <p style="font-size:13px;color:#5a636c;line-height:1.5;margin:0">
      Questions on any clause? Reply to this email before you sign — we would rather change
      the wording than have you sign something you are unsure about.</p>
  </div>`;
}

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const auth = await requireAuth(req, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON body' }); }
  const action = String(body.action || '');
  const actorEmail = auth.user?.email || null;

  try {
    // ── templates ─────────────────────────────────────────────────────────
    if (action === 'templates') {
      // Touching each shipped code seeds it on a fresh environment, so the
      // list is never empty on a database that has simply never sent one.
      for (const code of Object.keys(SHIPPED)) await activeTemplate(code).catch(() => null);
      const rows = await ops('GET',
        'subdist_agreement_templates?select=id,code,version,title,subtitle,active,notes,created_at&order=code,created_at.desc') || [];
      return json(200, { ok: true, templates: rows });
    }

    if (action === 'template_save') {
      const code = clean(body.code, 60) || DEFAULT_CODE;
      const version = clean(body.version, 20);
      const body_source = String(body.body_source || '');
      if (!version) return json(400, { error: 'A version is required.' });
      if (body_source.length < 200) return json(400, { error: 'That body looks too short to be an agreement.' });
      // ⚠ Never overwrite a version in place: somebody may be reading it
      // mid-sentence on a live signing link. Publish a new version instead.
      const exists = await ops('GET',
        `subdist_agreement_templates?select=id&code=eq.${encodeURIComponent(code)}`
        + `&version=eq.${encodeURIComponent(version)}&limit=1`);
      if (exists?.[0]) {
        return json(409, { error: `Version ${version} already exists. Publish a new version number.` });
      }
      await ops('PATCH', `subdist_agreement_templates?code=eq.${encodeURIComponent(code)}&active=is.true`,
        { active: false });
      const row = await ops('POST', 'subdist_agreement_templates', {
        code, version, title: clean(body.title, 200) || 'SUB-DISTRIBUTION AGREEMENT',
        subtitle: clean(body.subtitle, 200), body_source,
        notes: clean(body.notes, 1000), active: true,
      }, { Prefer: 'return=representation' });
      return json(200, { ok: true, template: Array.isArray(row) ? row[0] : row });
    }

    // ── list ──────────────────────────────────────────────────────────────
    if (action === 'list') {
      const distId = clean(body.sub_distributor_id, 40);
      if (distId && !UUID.test(distId)) return json(400, { error: 'sub_distributor_id must be a uuid' });
      const filter = distId ? `&sub_distributor_id=eq.${distId}` : '';
      const rows = await ops('GET',
        `sub_distributor_agreements?select=${AGREEMENT_SELECT}${filter}&order=created_at.desc&limit=100`) || [];
      // The token hash is not the client's business, and neither is a
      // signature image on a list screen.
      for (const r of rows) { delete r.token_hash; }
      return json(200, { ok: true, agreements: rows });
    }

    if (action === 'get') {
      const id = clean(body.id, 40);
      if (!UUID.test(id || '')) return json(400, { error: 'id must be a uuid' });
      const a = await loadAgreement(id);
      if (!a) return json(404, { error: 'Not found.' });
      const dist = await loadDistributor(a.sub_distributor_id);
      delete a.token_hash;
      return json(200, { ok: true, agreement: a, distributor: dist, terms: dealTerms(a, dist || {}) });
    }

    // ── build ─────────────────────────────────────────────────────────────
    // Snapshot the template onto a new draft. Everything that decides how the
    // document READS is copied now, so a later template edit cannot reach it.
    if (action === 'build') {
      const distId = clean(body.sub_distributor_id, 40);
      if (!UUID.test(distId || '')) return json(400, { error: 'sub_distributor_id must be a uuid' });
      const dist = await loadDistributor(distId);
      if (!dist) return json(404, { error: 'Sub-distributor not found.' });

      const tpl = await activeTemplate(clean(body.template_code, 60) || DEFAULT_CODE);
      const sig = await companySignatory(clean(body.company_signatory_id, 40));

      const numRows = await ops('POST', 'rpc/fn_next_subdist_agreement_number', {});
      const agreementNumber = typeof numRows === 'string' ? numRows : numRows?.[0] ?? null;

      const versionRows = await ops('GET',
        `sub_distributor_agreements?select=version&sub_distributor_id=eq.${distId}&order=version.desc&limit=1`);
      const version = Number(versionRows?.[0]?.version || 0) + 1;

      const terms = (body.deal_terms && typeof body.deal_terms === 'object') ? body.deal_terms : {};
      const created = await ops('POST', 'sub_distributor_agreements', {
        sub_distributor_id: distId,
        version,
        agreement_number: agreementNumber,
        status: 'draft',
        model: clean(terms.model, 40) || dist.model || 'consignment',
        per_case_delivery_fee: terms.per_case_fee ?? dist.per_case_delivery_fee ?? null,
        template_id: tpl.id,
        template_code: tpl.code,
        template_version: tpl.version,
        title: tpl.title,
        subtitle: tpl.subtitle,
        body_source: tpl.body_source,          // ← the snapshot
        deal_terms: terms,
        effective_date: clean(body.effective_date, 20),
        expiry_date: clean(body.expiry_date, 20),
        scope: clean(body.scope, 2000),
        counterparty_legal_name: clean(body.counterparty_legal_name, 200) || dist.name,
        counterparty_entity_type: clean(body.counterparty_entity_type, 100),
        counterparty_state: clean(body.counterparty_state, 60),
        counterparty_address: clean(body.counterparty_address, 300),
        signer_name: clean(body.signer_name, 120) || dist.contact_name,
        signer_email: clean(body.signer_email, 200) || dist.contact_email,
        signer_title: clean(body.signer_title, 120),
        company_signatory_id: sig?.id ?? null,
        company_signer_name: sig?.name ?? null,
        company_signer_title: sig?.title ?? null,
        notes: clean(body.notes, 1000),
        created_by: auth.user?.id ?? null,
      }, { Prefer: 'return=representation' });
      const a = Array.isArray(created) ? created[0] : created;
      delete a.token_hash;
      return json(200, { ok: true, agreement: a });
    }

    // ── update (draft only) ───────────────────────────────────────────────
    if (action === 'update') {
      const id = clean(body.id, 40);
      if (!UUID.test(id || '')) return json(400, { error: 'id must be a uuid' });
      const a = await loadAgreement(id);
      if (!a) return json(404, { error: 'Not found.' });
      if (a.status !== 'draft') {
        return json(409, {
          error: `This agreement is ${a.status}. Build a new version rather than editing one that has gone out.`,
        });
      }
      const patch = {};
      for (const [k, v] of Object.entries(body.patch || {})) {
        if (!EDITABLE.has(k)) return json(400, { error: `"${k}" is not editable here.` });
        patch[k] = v === '' ? null : v;
      }
      if (body.deal_terms && typeof body.deal_terms === 'object') patch.deal_terms = body.deal_terms;
      if (!Object.keys(patch).length) return json(400, { error: 'Nothing to change.' });
      const updated = await ops('PATCH', `sub_distributor_agreements?id=eq.${id}`, patch,
        { Prefer: 'return=representation' });
      const row = Array.isArray(updated) ? updated[0] : updated;
      delete row.token_hash;
      return json(200, { ok: true, agreement: row });
    }

    // ── preview ───────────────────────────────────────────────────────────
    // Renders the document exactly as the signer will see it, writing nothing.
    if (action === 'preview') {
      const id = clean(body.id, 40);
      if (!UUID.test(id || '')) return json(400, { error: 'id must be a uuid' });
      const a = await loadAgreement(id);
      if (!a) return json(404, { error: 'Not found.' });
      const dist = await loadDistributor(a.sub_distributor_id);
      const sig = a.company_signature_data ? null : await companySignatory(a.company_signatory_id);
      const html = renderSubdistHtml(a, {
        distributor: dist || {},
        companySignature: sig?.signature_data || null,
      });
      return json(200, { ok: true, html, title: a.title, subtitle: a.subtitle });
    }

    // ── pdf ───────────────────────────────────────────────────────────────
    // The same renderer the signer's copy comes from, so what you check on
    // paper is what they get. A DRAFT renders too, stamped DRAFT on every
    // page — checking the Schedule before it goes out is the whole point.
    if (action === 'pdf') {
      const id = clean(body.id, 40);
      if (!UUID.test(id || '')) return json(400, { error: 'id must be a uuid' });
      const a = await loadAgreement(id);
      if (!a) return json(404, { error: 'Not found.' });
      const dist = await loadDistributor(a.sub_distributor_id);
      const sig = a.company_signature_data ? null : await companySignatory(a.company_signatory_id);
      const bytes = await renderSubdistPdf(a, {
        distributor: dist || {}, companySignature: sig?.signature_data || null,
      });
      return json(200, {
        ok: true,
        file_name: `${a.agreement_number || 'agreement'}.pdf`,
        pdf_base64: Buffer.from(bytes).toString('base64'),
      });
    }

    // ── send / resend ─────────────────────────────────────────────────────
    if (action === 'send' || action === 'resend') {
      const id = clean(body.id, 40);
      if (!UUID.test(id || '')) return json(400, { error: 'id must be a uuid' });
      const a = await loadAgreement(id);
      if (!a) return json(404, { error: 'Not found.' });
      if (a.status === 'signed') {
        return json(409, { error: 'That agreement is already signed. Build a new version instead.' });
      }
      if (action === 'send' && a.status !== 'draft') {
        return json(409, { error: `That agreement is already ${a.status}. Use "Send again" to re-issue the link.` });
      }
      const to = clean(body.to, 200) || a.signer_email;
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return json(400, { error: 'A valid signer email is required before this can go out.' });
      }
      const dist = await loadDistributor(a.sub_distributor_id);
      if (!dist) return json(404, { error: 'Sub-distributor not found.' });

      // The company block is executed NOW, with the signature read fresh, so a
      // re-drawn signature reaches the next agreement instead of stranding a
      // stale image on every future one.
      const sig = await companySignatory(a.company_signatory_id);
      const ttlDays = clampTtl(body.expires_days);
      const raw = mintToken();

      const patch = {
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_to: to,
        sent_by: actorEmail,
        signer_email: to,
        token_hash: hashToken(raw),          // ← old token dies in the same write
        expires_at: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
        company_signatory_id: sig?.id ?? a.company_signatory_id ?? null,
        company_signer_name: sig?.name ?? a.company_signer_name ?? null,
        company_signer_title: sig?.title ?? a.company_signer_title ?? null,
        company_signature_data: sig?.signature_data ?? a.company_signature_data ?? null,
        company_signed_at: new Date().toISOString(),
      };
      if (action === 'resend') patch.resent_count = Number(a.resent_count || 0) + 1;

      const updated = await ops('PATCH', `sub_distributor_agreements?id=eq.${id}`, patch,
        { Prefer: 'return=representation' });
      const row = Array.isArray(updated) ? updated[0] : updated;
      const url = signLinkFor(raw);

      let emailed = false; let emailError = null;
      if (body.send_email !== false) {
        try {
          await sendEmail({
            from: FROM,
            to,
            subject: `${dist.name} — sub-distribution agreement to sign`,
            html: inviteEmail({ dist, agreement: row, url, ttlDays, resent: action === 'resend' }),
            replyTo: actorEmail || undefined,
          });
          emailed = true;
        } catch (e) { emailError = e.message; }
      }
      delete row.token_hash;
      // The raw token is returned ONCE. It exists nowhere else — only the
      // sha256 is stored — so a lost link is re-issued, never recovered.
      return json(200, { ok: true, agreement: row, url, emailed, email_error: emailError });
    }

    // ── revoke ────────────────────────────────────────────────────────────
    if (action === 'revoke') {
      const id = clean(body.id, 40);
      if (!UUID.test(id || '')) return json(400, { error: 'id must be a uuid' });
      const a = await loadAgreement(id);
      if (!a) return json(404, { error: 'Not found.' });
      // An executed agreement is terminated in writing under §25, not by a
      // button — the same rule the NDA follows.
      if (a.status === 'signed') {
        return json(409, {
          error: 'That agreement is executed. It is terminated in writing under Section 25, not revoked here.',
        });
      }
      const updated = await ops('PATCH', `sub_distributor_agreements?id=eq.${id}`, {
        status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: actorEmail,
        token_hash: null,
      }, { Prefer: 'return=representation' });
      const row = Array.isArray(updated) ? updated[0] : updated;
      delete row.token_hash;
      return json(200, { ok: true, agreement: row });
    }

    return json(400, { error: `Unknown action "${action}"` });
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
}

export default handle;
export { linkUnusable };
