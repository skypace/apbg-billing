// distributor-notify.mjs — the sub-distributor program's messenger.
//
// Every 15 minutes (or on-demand from a staff session): scans the
// sub-distributor tables for events nobody has been told about and emails the
// right side, deduping through ops.sub_distributor_notifications
// (UNIQUE(event_type, ref_id) — every event notifies exactly once; a failed
// send is recorded and retried on the next tick).
//
//   order_submitted        → STAFF   (a partner placed a restock order)
//   order_fulfilled        → PARTNER (order accepted; BOL created)
//   transfer_shipped       → PARTNER (shipment on the way — BOL, carrier, ETA fields)
//   transfer_discrepancy   → STAFF   (partner received short — shortfall sits in TRANSIT)
//   agreement_sent         → PARTNER (review & e-sign link into the portal)
//   agreement_signed       → STAFF + PARTNER (signed confirmation, audit line)
//
// Recipients: partner = sub_distributors.contact_email ∪ active
// sub_distributor_users emails; staff = DISTRIBUTOR_ALERT_TO (default
// service@brixbev.com). Scans are capped to rows from the last 30 days so a
// fresh deploy can never blast history.
//
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY/SENDGRID_API_KEY,
//      DISTRIBUTOR_ALERT_TO (optional staff recipient override).

import { requireScheduledOrAuth } from './lib/auth.mjs';
import { ops } from './lib/vendor-onboard-lib.mjs';
import { sendEmail } from './email-helpers.mjs';

const STAFF_TO = process.env.DISTRIBUTOR_ALERT_TO || 'service@brixbev.com';
const PORTAL_URL = 'https://alamedapointbg.com/distributor';
const REFRACTOR_URL = 'https://alamedapointbg.com/margin/#distributors';
const SINCE_DAYS = 30;

const sinceIso = () =>
  new Date(Date.now() - SINCE_DAYS * 86400e3).toISOString();

// ── shared chrome ────────────────────────────────────────────────────────────
function wrap(title, bodyHtml, cta) {
  return `<!doctype html><body style="margin:0;background:#0F172A;font-family:'DM Sans',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#1F4E79;border-radius:12px 12px 0 0;padding:18px 22px;color:#fff;font-size:18px;font-weight:700">
      °bx &nbsp;Brix Beverage <span style="opacity:.7;font-weight:400">· Sub-Distributors</span>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:22px;color:#1e293b;font-size:14px;line-height:1.55">
      <h2 style="margin:0 0 12px;font-size:17px;color:#0F172A">${title}</h2>
      ${bodyHtml}
      ${cta ? `<p style="margin:20px 0 4px"><a href="${cta.href}" style="background:#3B82F6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${cta.label}</a></p>` : ''}
      <p style="margin:18px 0 0;color:#64748b;font-size:12px">Sent automatically by the Brix sub-distributor system.</p>
    </div>
  </div></body>`;
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtQty = (n) => Number(n) % 1 === 0 ? String(Number(n)) : String(n);

// ── data helpers ─────────────────────────────────────────────────────────────
async function distributorMap() {
  const subs = await ops('GET', 'sub_distributors?select=id,code,name,contact_email,inventory_location_id');
  const users = await ops('GET', 'sub_distributor_users?select=sub_distributor_id,email&is_active=eq.true');
  const map = new Map();
  for (const s of subs || []) {
    const emails = new Set();
    if (s.contact_email) emails.add(s.contact_email.toLowerCase());
    for (const u of users || []) {
      if (u.sub_distributor_id === s.id && u.email) emails.add(u.email.toLowerCase());
    }
    map.set(s.id, { ...s, emails: [...emails] });
  }
  return map;
}

async function itemNames(ids) {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return {};
  const rows = await ops(
    'GET',
    `qbo_items?select=qbo_item_id,name&qbo_item_id=in.(${uniq.map((i) => `"${i}"`).join(',')})`
  );
  return Object.fromEntries((rows || []).map((r) => [r.qbo_item_id, r.name]));
}

async function alreadySent(eventType, ids) {
  if (!ids.length) return new Set();
  const rows = await ops(
    'GET',
    `sub_distributor_notifications?select=ref_id,status&event_type=eq.${eventType}&ref_id=in.(${ids.join(',')})`
  );
  return new Set((rows || []).filter((r) => r.status === 'sent').map((r) => r.ref_id));
}

async function recordSend(eventType, refId, subId, recipients, sendResult) {
  await ops(
    'POST',
    'sub_distributor_notifications?on_conflict=event_type,ref_id',
    {
      event_type: eventType,
      ref_id: refId,
      sub_distributor_id: subId || null,
      recipients: recipients.join(', '),
      status: sendResult.ok ? 'sent' : 'failed',
      error: sendResult.ok ? null : String(sendResult.error || 'send failed').slice(0, 400),
      sent_at: new Date().toISOString(),
    },
    { Prefer: 'resolution=merge-duplicates' }
  );
}

async function deliver({ eventType, refId, subId, to, subject, html, result }) {
  const recipients = [...new Set(to)].filter(Boolean);
  if (!recipients.length) {
    await recordSend(eventType, refId, subId, [], { ok: false, error: 'no recipients on file' });
    result.skipped_no_recipients++;
    return;
  }
  let out;
  try {
    await sendEmail({ to: recipients, subject, html });
    out = { ok: true };
    result.sent++;
  } catch (e) {
    out = { ok: false, error: e.message || e };
    result.failed++;
  }
  await recordSend(eventType, refId, subId, recipients, out);
}

// ── the scan ─────────────────────────────────────────────────────────────────
async function runScan() {
  const result = { sent: 0, failed: 0, skipped_no_recipients: 0, events: {} };
  const subs = await distributorMap();
  const locToSub = new Map(
    [...subs.values()].filter((s) => s.inventory_location_id).map((s) => [s.inventory_location_id, s])
  );

  // 1. order_submitted → staff
  {
    const orders = await ops(
      'GET',
      `sub_distributor_orders?select=id,sub_distributor_id,order_number,requested_date,notes,submitted_by_email,submitted_at&status=eq.submitted&submitted_at=gte.${sinceIso()}`
    );
    const done = await alreadySent('order_submitted', (orders || []).map((o) => o.id));
    for (const o of orders || []) {
      if (done.has(o.id)) continue;
      const sub = subs.get(o.sub_distributor_id);
      const lines = await ops('GET', `sub_distributor_order_lines?select=qbo_item_id,qty&order_id=eq.${o.id}`);
      const names = await itemNames((lines || []).map((l) => l.qbo_item_id));
      const rows = (lines || [])
        .map((l) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(names[l.qbo_item_id] || l.qbo_item_id)}</td><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtQty(l.qty)}</td></tr>`)
        .join('');
      await deliver({
        eventType: 'order_submitted', refId: o.id, subId: o.sub_distributor_id,
        to: [STAFF_TO],
        subject: `Restock order ${o.order_number} — ${sub?.name || 'sub-distributor'}`,
        html: wrap(
          `New restock order from ${esc(sub?.name || 'a sub-distributor')}`,
          `<p><b>${esc(o.order_number)}</b> · submitted by ${esc(o.submitted_by_email || 'portal user')}${o.requested_date ? ` · requested for ${esc(o.requested_date)}` : ''}</p>
           <table style="border-collapse:collapse;width:100%">${rows}</table>
           ${o.notes ? `<p style="color:#475569">Notes: ${esc(o.notes)}</p>` : ''}
           <p>Fulfill it from Refractor → Sub-Distributors → Orders (creates the BOL transfer).</p>`,
          { href: REFRACTOR_URL, label: 'Open Refractor →' }
        ),
        result,
      });
      result.events.order_submitted = (result.events.order_submitted || 0) + 1;
    }
  }

  // 2. order_fulfilled → partner
  {
    const orders = await ops(
      'GET',
      `sub_distributor_orders?select=id,sub_distributor_id,order_number,transfer_id,decided_at&status=eq.fulfilled&transfer_id=not.is.null&decided_at=gte.${sinceIso()}`
    );
    const done = await alreadySent('order_fulfilled', (orders || []).map((o) => o.id));
    for (const o of orders || []) {
      if (done.has(o.id)) continue;
      const sub = subs.get(o.sub_distributor_id);
      const [tr] = (await ops('GET', `inventory_transfers?select=bol_number&id=eq.${o.transfer_id}`)) || [];
      await deliver({
        eventType: 'order_fulfilled', refId: o.id, subId: o.sub_distributor_id,
        to: sub?.emails || [],
        subject: `Order ${o.order_number} accepted — BOL ${tr?.bol_number || ''}`,
        html: wrap(
          'Your restock order was accepted',
          `<p>Order <b>${esc(o.order_number)}</b> has been accepted and a shipment is being prepared${tr?.bol_number ? ` under BOL <b>${esc(tr.bol_number)}</b>` : ''}. You'll get another email when it ships.</p>`,
          { href: `${PORTAL_URL}/orders`, label: 'View your orders →' }
        ),
        result,
      });
      result.events.order_fulfilled = (result.events.order_fulfilled || 0) + 1;
    }
  }

  // 3. transfer_shipped → partner (any in-transit BOL headed to a distributor location)
  {
    const locIds = [...locToSub.keys()];
    if (locIds.length) {
      const transfers = await ops(
        'GET',
        `inventory_transfers?select=id,bol_number,to_location_id,carrier,tracking_number,ship_date&status=eq.in_transit&to_location_id=in.(${locIds.join(',')})&created_at=gte.${sinceIso()}`
      );
      const done = await alreadySent('transfer_shipped', (transfers || []).map((t) => t.id));
      for (const t of transfers || []) {
        if (done.has(t.id)) continue;
        const sub = locToSub.get(t.to_location_id);
        await deliver({
          eventType: 'transfer_shipped', refId: t.id, subId: sub?.id,
          to: sub?.emails || [],
          subject: `Shipment on the way — BOL ${t.bol_number}`,
          html: wrap(
            'A Brix shipment is on the way',
            `<p><b>BOL ${esc(t.bol_number)}</b>${t.ship_date ? ` · shipped ${esc(t.ship_date)}` : ''}${t.carrier ? ` · ${esc(t.carrier)}` : ''}${t.tracking_number ? ` · tracking ${esc(t.tracking_number)}` : ''}</p>
             <p>When it arrives, open the portal, count each line, and confirm receipt — shortages are flagged to Brix automatically.</p>`,
            { href: `${PORTAL_URL}/shipments`, label: 'View & receive →' }
          ),
          result,
        });
        result.events.transfer_shipped = (result.events.transfer_shipped || 0) + 1;
      }

      // 4. transfer_discrepancy → staff
      const short = await ops(
        'GET',
        `inventory_transfers?select=id,bol_number,to_location_id,received_date,receiver_signature_name,receiver_notes&status=eq.received&has_discrepancy=eq.true&to_location_id=in.(${locIds.join(',')})&created_at=gte.${sinceIso()}`
      );
      const doneShort = await alreadySent('transfer_discrepancy', (short || []).map((t) => t.id));
      for (const t of short || []) {
        if (doneShort.has(t.id)) continue;
        const sub = locToSub.get(t.to_location_id);
        const lines = await ops(
          'GET',
          `inventory_transfer_lines?select=qbo_item_id,qty,qty_received&transfer_id=eq.${t.id}`
        );
        const names = await itemNames((lines || []).map((l) => l.qbo_item_id));
        const rows = (lines || [])
          .filter((l) => Number(l.qty_received) !== Number(l.qty))
          .map((l) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(names[l.qbo_item_id] || l.qbo_item_id)}</td><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtQty(l.qty_received)} of ${fmtQty(l.qty)}</td></tr>`)
          .join('');
        await deliver({
          eventType: 'transfer_discrepancy', refId: t.id, subId: sub?.id,
          to: [STAFF_TO],
          subject: `⚠ Short receipt — BOL ${t.bol_number} at ${sub?.name || 'distributor'}`,
          html: wrap(
            `Short receipt at ${esc(sub?.name || 'a distributor')}`,
            `<p><b>BOL ${esc(t.bol_number)}</b> was received ${esc(t.received_date || '')} by ${esc(t.receiver_signature_name || 'the partner')} with a count mismatch. The shortfall is still sitting in TRANSIT and needs a decision (re-ship, adjust, or claim against the carrier).</p>
             <table style="border-collapse:collapse;width:100%">${rows}</table>
             ${t.receiver_notes ? `<p style="color:#475569">Receiver notes: ${esc(t.receiver_notes)}</p>` : ''}`,
            { href: REFRACTOR_URL, label: 'Open Refractor →' }
          ),
          result,
        });
        result.events.transfer_discrepancy = (result.events.transfer_discrepancy || 0) + 1;
      }
    }
  }

  // 5. agreement_sent → partner (with sign link)   6. agreement_signed → both
  {
    const ags = await ops(
      'GET',
      `sub_distributor_agreements?select=id,sub_distributor_id,version,title,model,per_case_delivery_fee,scope,status,sent_at,signed_at,signer_name,signer_email,updated_at&status=in.(sent,signed)&updated_at=gte.${sinceIso()}`
    );
    const sent = (ags || []).filter((a) => a.status === 'sent');
    const signed = (ags || []).filter((a) => a.status === 'signed');
    const doneSent = await alreadySent('agreement_sent', sent.map((a) => a.id));
    const doneSigned = await alreadySent('agreement_signed', signed.map((a) => a.id));

    for (const a of sent) {
      if (doneSent.has(a.id)) continue;
      const sub = subs.get(a.sub_distributor_id);
      await deliver({
        eventType: 'agreement_sent', refId: a.id, subId: a.sub_distributor_id,
        to: sub?.emails || [],
        subject: `Agreement ready to sign — ${a.title || 'Distribution agreement'} v${a.version}`,
        html: wrap(
          'An agreement is ready for your signature',
          `<p><b>${esc(a.title || 'Distribution agreement')}</b> (v${a.version}, ${a.model === 'consignment' ? 'consignment' : 'sell-in'}${a.per_case_delivery_fee != null ? `, $${a.per_case_delivery_fee}/case delivery fee` : ''}).</p>
           ${a.scope ? `<p style="color:#475569"><b>Scope:</b> ${esc(a.scope)}</p>` : ''}
           <p>Review the full terms and sign electronically in the portal.</p>`,
          { href: `${PORTAL_URL}/agreements`, label: 'Review & sign →' }
        ),
        result,
      });
      result.events.agreement_sent = (result.events.agreement_sent || 0) + 1;
    }

    for (const a of signed) {
      if (doneSigned.has(a.id)) continue;
      const sub = subs.get(a.sub_distributor_id);
      await deliver({
        eventType: 'agreement_signed', refId: a.id, subId: a.sub_distributor_id,
        to: [STAFF_TO, ...(sub?.emails || [])],
        subject: `Agreement signed — ${sub?.name || ''} ${a.title || ''} v${a.version}`,
        html: wrap(
          'Agreement signed',
          `<p><b>${esc(a.title || 'Distribution agreement')}</b> v${a.version} for <b>${esc(sub?.name || '')}</b> was signed by ${esc(a.signer_name || '')} (${esc(a.signer_email || '')}) on ${esc((a.signed_at || '').slice(0, 10))}.</p>
           <p style="color:#475569">The signed record (typed name, signature image, IP, browser) is stored on the agreement.</p>`,
          { href: `${PORTAL_URL}/agreements`, label: 'View agreement →' }
        ),
        result,
      });
      result.events.agreement_signed = (result.events.agreement_signed || 0) + 1;
    }
  }

  return result;
}

// Every run — quiet or not — logs to ops.sync_log so the distributor_notify
// check in ops.fn_sync_health_extra() can go yellow/red when the scan stops
// running (the silent-outage rule: no pipeline without a watcher).
async function logRun(status, result, errMsg) {
  try {
    await ops('POST', 'sync_log', {
      source: 'distributor',
      sync_type: 'distributor_notify',
      status,
      error_message: errMsg ? String(errMsg).slice(0, 400) : null,
      metadata: result || null,
      completed_at: new Date().toISOString(),
    });
  } catch { /* health check's staleness rule catches a run that cannot even log */ }
}

export default async function handler(req, context) {
  const gate = await requireScheduledOrAuth(req, context);
  if (!gate.ok) return gate.response;
  try {
    const result = await runScan();
    await logRun(result.failed > 0 ? 'error' : 'success', result,
      result.failed > 0 ? `${result.failed} send(s) failed — will retry next tick` : null);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[distributor-notify]', e);
    await logRun('error', null, e.message || e);
    return new Response(JSON.stringify({ error: String(e.message || e).slice(0, 400) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const config = {
  schedule: '*/15 * * * *',
};
