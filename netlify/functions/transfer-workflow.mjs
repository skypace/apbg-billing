// The transfer process, driven by staff.
//
// Sky (2026-09-04) asked for a real process rather than a row that changes
// state: the order goes in, the office is told to build it with the pick
// ticket attached, Service Fusion gets a ticket whose number rides on that
// email, the receiving branch is warned, the tech completes the ticket, the
// office is told to schedule it, shipping and BOL details are entered, and the
// receiving branch gets everything plus a ONE-TIME link to receive.
//
// ORDER OF OPERATIONS, and why: the Service Fusion ticket is created FIRST,
// because its number belongs on the email — an email that says "SF ticket: not
// created" is honest, but one sent before the ticket exists could never carry
// the number at all. The database is stamped SECOND, so the transfer always
// knows which ticket is its own even if an email later fails. Emails are LAST
// and are best-effort: a Resend hiccup must not leave a transfer that Service
// Fusion has a ticket for but our database does not.
//
// ⚠ workflow_status is PAPERWORK. The only step here that moves stock is
//   `schedule`, and it moves it by calling the ordinary ship RPC — the same one
//   the Transfers screen calls. Nothing in this file writes an inventory
//   movement of its own.

import { requireAuth } from './lib/auth.mjs';
import { sendEmail } from './email-helpers.mjs';
import { renderPullTicketPdf, renderBillOfLadingPdf } from './lib/production-docs.mjs';
import {
  buildTransferDoc, sbGet, sbPatch, sbRpc, sbInsert, isUuid,
} from './lib/transfer-docs.mjs';
import {
  buildTransferSfJob, createTransferSfJob, mintReceiveToken, receiveUrl,
  emailRequestOps, emailRequestReceiving, emailBuilt, emailShipped,
  receivingRecipients,
} from './lib/transfer-workflow.mjs';

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://alamedapointbg.com';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
function json(body, status = 200) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function settings() {
  const rows = await sbGet('transfer_workflow_settings?select=*&id=eq.true&limit=1');
  if (!rows[0]) throw new Error('transfer_workflow_settings row missing');
  return rows[0];
}

// A send that fails is RECORDED, never thrown — the process has already moved
// and losing it to an email outage would be the worse failure. The reason
// rides back to the caller so the screen can say who was not reached.
async function mail({ to, cc, doc, msg, attachments }) {
  const results = [];
  for (const addr of [...new Set(to.filter(Boolean))]) {
    try {
      const r = await sendEmail({
        to: addr, from: doc.payload.from, replyTo: doc.payload.company.email,
        subject: msg.subject, html: msg.html, text: msg.text,
        ...(attachments ? { attachments } : {}),
        ...(cc && cc.length ? { cc } : {}),
      });
      results.push({ to: addr, ok: r !== false, error: r === false ? 'No email service configured' : null });
    } catch (e) {
      results.push({ to: addr, ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
  return results;
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);

  const auth = await requireAuth(event, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;

  try {
    if (event.httpMethod === 'GET') {
      const id = (event.queryStringParameters || {}).id;
      if (!isUuid(id)) return json({ error: 'id must be a uuid' }, 400);
      const [t] = await sbGet(`inventory_transfers?select=id,bol_number,status,workflow_status,sf_job_id,sf_job_number,sf_job_status,sf_error,requested_at,built_at,scheduled_at,receive_link_sent_at,receive_token_used_at,receive_token_expires_at&id=eq.${id}&limit=1`);
      if (!t) return json({ error: 'transfer not found' }, 404);
      return json({ ok: true, transfer: t, settings: await settings() });
    }

    if (event.httpMethod !== 'POST') return json({ error: 'method not allowed' }, 405);

    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || '');
    const id = body.transfer_id;
    if (!isUuid(id)) return json({ error: 'transfer_id must be a uuid' }, 400);

    const s = await settings();
    if (!s.enabled) return json({ error: 'the transfer workflow is switched off in settings' }, 409);

    const doc = await buildTransferDoc(id);
    const t = doc.transfer;
    if (t.status === 'void') return json({ error: `${t.bol_number} is void` }, 409);
    if (!doc.rows.length) return json({ error: `${t.bol_number} has no lines to build` }, 409);

    // ── 1. Raise it: SF ticket, then tell the office and the receiving branch.
    if (action === 'request') {
      if (t.workflow_status !== 'none') {
        return json({ error: `${t.bol_number} has already been requested (${t.workflow_status})` }, 409);
      }
      if (t.status !== 'draft') {
        return json({ error: `${t.bol_number} has already ${t.status === 'received' ? 'been received' : 'shipped'}` }, 409);
      }

      let sfJob = null, sfWarning = null, sfError = null;
      try {
        const r = await createTransferSfJob(buildTransferSfJob(s, doc));
        sfJob = r.job; sfWarning = r.warning;
      } catch (e) {
        // ⚠ A Service Fusion outage must not stop the transfer being raised.
        //   The office still gets the pull ticket and can make the ticket by
        //   hand; the reason is stamped on the row so nobody has to guess, and
        //   "Create the ticket" can be retried on its own.
        sfError = String(e.message || e).slice(0, 500);
        console.warn('[transfer-workflow] SF job failed:', sfError);
      }

      const sfJobNumber = sfJob?.number || sfJob?.job_number || sfJob?.id || null;
      await sbPatch('inventory_transfers', `id=eq.${id}`, {
        workflow_status: 'requested',
        sf_job_id: sfJob?.id ? String(sfJob.id) : null,
        sf_job_number: sfJobNumber ? String(sfJobNumber) : null,
        sf_job_status: sfJob?.status || null,
        sf_error: sfError,
        requested_at: new Date().toISOString(),
        requested_by: auth.user?.id || null,
        updated_at: new Date().toISOString(),
      });

      // The pull ticket rides on the office's email — Sky: "with all the
      // details and the pick ticket".
      const fresh = await buildTransferDoc(id);
      let pull = null;
      try { pull = await renderPullTicketPdf(fresh.payload); }
      catch (e) { console.warn('[transfer-workflow] pull ticket render failed:', e.message); }

      const opsMsg = emailRequestOps({
        doc: fresh, sfJobNumber, sfWarning,
        requestedBy: auth.user?.email || null,
      });
      const opsSends = await mail({
        to: [s.ops_email], cc: s.cc_emails || [], doc: fresh, msg: opsMsg,
        attachments: pull ? [{ filename: `PULL-${fresh.label}.pdf`, content: b64(pull) }] : undefined,
      });

      const recvTo = receivingRecipients(fresh.toLoc, s);
      const recvSends = await mail({
        to: recvTo, doc: fresh, msg: emailRequestReceiving({ doc: fresh, sfJobNumber }),
      });

      await logSends(fresh, 'request', [...opsSends, ...recvSends], auth);
      return json({
        ok: true, workflow_status: 'requested',
        sf_job_number: sfJobNumber, sf_error: sfError, sf_warning: sfWarning,
        emails: [...opsSends, ...recvSends],
      });
    }

    // ── 2. The ticket is done: tell the office to schedule it.
    if (action === 'mark_built') {
      if (t.workflow_status !== 'requested') {
        return json({ error: `${t.bol_number} is ${t.workflow_status}, not waiting to be built` }, 409);
      }
      await sbPatch('inventory_transfers', `id=eq.${id}`, {
        workflow_status: 'built', built_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      const fresh = await buildTransferDoc(id);
      const sends = await mail({
        to: [s.ops_email], cc: s.cc_emails || [], doc: fresh,
        msg: emailBuilt({ doc: fresh, sfJobNumber: t.sf_job_number }),
      });
      await logSends(fresh, 'built', sends, auth);
      return json({ ok: true, workflow_status: 'built', emails: sends });
    }

    // ── 3. Shipping and BOL entered: ship it, and send the one-time link.
    if (action === 'schedule') {
      if (t.status !== 'draft') {
        return json({ error: `${t.bol_number} has already ${t.status === 'received' ? 'been received' : 'shipped'}` }, 409);
      }
      const shipDate = String(body.ship_date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)) return json({ error: 'ship_date must be YYYY-MM-DD' }, 400);

      // The freight fields go on FIRST, so the BOL that ships carries them.
      const freight = {};
      for (const k of ['carrier', 'tracking_number', 'pro_number', 'freight_terms', 'special_instructions']) {
        if (body[k] !== undefined) freight[`p_${k}`] = body[k] === '' ? null : body[k];
      }
      for (const k of ['total_weight_lbs', 'total_pallets', 'declared_value_usd']) {
        if (body[k] !== undefined && body[k] !== '') freight[`p_${k}`] = Number(body[k]);
      }
      if (Object.keys(freight).length) {
        await sbRpc('fn_update_transfer_freight', {
          p_transfer_id: id,
          p_carrier: freight.p_carrier ?? null,
          p_tracking_number: freight.p_tracking_number ?? null,
          p_pro_number: freight.p_pro_number ?? null,
          p_freight_terms: freight.p_freight_terms ?? null,
          p_total_weight_lbs: freight.p_total_weight_lbs ?? null,
          p_total_pallets: freight.p_total_pallets ?? null,
          p_declared_value_usd: freight.p_declared_value_usd ?? null,
          p_special_instructions: freight.p_special_instructions ?? null,
          p_notes: null,
        }, auth.jwt);
      }

      // ⚠ This is the ONE step here that moves stock, and it does it through
      //   the ordinary ship RPC rather than writing movements itself.
      await sbRpc('fn_ship_transfer', {
        p_transfer_id: id,
        p_ship_date: shipDate,
        p_shipper_signature_name: body.shipper_signature_name || auth.user?.email || null,
      }, auth.jwt);

      const { token, hash, expiresAt } = mintReceiveToken(s.receive_link_days);
      await sbPatch('inventory_transfers', `id=eq.${id}`, {
        workflow_status: 'scheduled',
        scheduled_at: new Date().toISOString(),
        receive_token_hash: hash,
        receive_token_expires_at: expiresAt,
        receive_token_used_at: null,
        receive_link_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const fresh = await buildTransferDoc(id);
      let bol = null;
      try { bol = await renderBillOfLadingPdf(fresh.payload); }
      catch (e) { console.warn('[transfer-workflow] BOL render failed:', e.message); }

      const sends = await mail({
        to: receivingRecipients(fresh.toLoc, s), cc: [s.ops_email], doc: fresh,
        msg: emailShipped({ doc: fresh, url: receiveUrl(token, SITE_URL) }),
        attachments: bol ? [{ filename: `${fresh.label}.pdf`, content: b64(bol) }] : undefined,
      });
      await logSends(fresh, 'shipped', sends, auth);
      return json({ ok: true, workflow_status: 'scheduled', shipped: true, emails: sends });
    }

    // ── 4. The link went astray. A new one; the old one dies in the same write.
    if (action === 'resend_receive_link') {
      if (t.status !== 'in_transit') {
        return json({ error: `${t.bol_number} is ${t.status} — a receive link only applies to a load in transit` }, 409);
      }
      const { token, hash, expiresAt } = mintReceiveToken(s.receive_link_days);
      await sbPatch('inventory_transfers', `id=eq.${id}`, {
        receive_token_hash: hash, receive_token_expires_at: expiresAt,
        receive_token_used_at: null, receive_link_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const fresh = await buildTransferDoc(id);
      let bol = null;
      try { bol = await renderBillOfLadingPdf(fresh.payload); } catch { /* the link matters more than the attachment */ }
      const to = body.to ? String(body.to).split(/[,;]/).map((x) => x.trim()).filter(Boolean) : receivingRecipients(fresh.toLoc, s);
      const sends = await mail({
        to, doc: fresh, msg: emailShipped({ doc: fresh, url: receiveUrl(token, SITE_URL) }),
        attachments: bol ? [{ filename: `${fresh.label}.pdf`, content: b64(bol) }] : undefined,
      });
      await logSends(fresh, 'shipped', sends, auth);
      return json({ ok: true, emails: sends, note: 'A NEW link was sent — the previous one no longer works.' });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, e.status || 500);
  }
}

// Every notification lands in the same log the PO/BOL emails use, so "what did
// we send and did it arrive" has one answer per transfer.
async function logSends(doc, step, sends, auth) {
  for (const r of sends) {
    await sbInsert('production_doc_sends', {
      doc_kind: step === 'request' ? 'pull_ticket' : 'bol',
      ref_id: doc.transfer.id, ref_label: doc.label,
      recipients: [r.to], cc: [],
      subject: `transfer ${step} — ${doc.label}`,
      message: null, storage_path: null,
      sent_by: auth.user?.id || null, sent_by_email: auth.user?.email || null,
      status: r.ok ? 'sent' : 'failed', resend_id: null, error: r.error,
    }).catch((e) => console.warn('[transfer-workflow] log failed:', e.message));
  }
}
