// The one-time receive link.
//
// Sky: "…kicks off another email with all details, pallets, etc with a link to
// receive the product when it gets to the transfer location, that link will be
// one time link."
//
// ⚠ THIS IS A SEPARATE FUNCTION ON PURPOSE, and the separation is STRUCTURAL
//   rather than a role check. It contains no code to list transfers, create
//   one, void one, change a quantity, or read any transfer other than the one
//   its token names. Whoever holds a link can do exactly one thing with it:
//   mark THAT load received. No mistake in a gate here can expose another
//   branch's paperwork, because the ability is not in the file. Same posture as
//   the NDA signing link and the visitor kiosk.
//
// ⚠ SINGLE USE IS A CONDITIONAL UPDATE, not a check-then-write. Two people
//   clicking the same link at the same moment would both pass a read-then-act
//   test; only one can win `receive_token_used_at is null` in a WHERE clause.
//   The token is spent BEFORE the stock moves, so the worst case is a spent
//   link and an unmoved transfer (visible, fixable) rather than a load received
//   twice.
//
// ⚠ An unknown token and an expired one answer the SAME way. A public endpoint
//   that distinguishes them tells a prober which tokens exist.

import { sendEmail } from './email-helpers.mjs';
import { buildTransferDoc, sbGet, sbPatch, sbRpc } from './lib/transfer-docs.mjs';
import { hashToken, emailReceived, receivingRecipients } from './lib/transfer-workflow.mjs';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
function json(body, status = 200) {
  return { statusCode: status, headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

const DEAD = 'That link is not usable. It may have already been used, or it may have expired — ask the office for a new one.';

/** Resolve a token to its transfer, or null. Never says which failure it was. */
async function resolve(token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const rows = await sbGet(
    `inventory_transfers?select=id,bol_number,status,receive_token_expires_at,receive_token_used_at&receive_token_hash=eq.${encodeURIComponent(hashToken(token))}&limit=1`);
  const t = rows[0];
  if (!t) return null;
  if (t.receive_token_used_at) return null;
  if (t.receive_token_expires_at && new Date(t.receive_token_expires_at) < new Date()) return null;
  return t;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'not configured' }, 500);

  try {
    // ── What is on the truck? A read, and it consumes nothing.
    if (event.httpMethod === 'GET') {
      const token = (event.queryStringParameters || {}).t;
      const t = await resolve(token);
      if (!t) return json({ error: DEAD }, 404);
      if (t.status !== 'in_transit') {
        return json({ error: t.status === 'received' ? 'This transfer has already been received.' : DEAD }, 409);
      }
      const doc = await buildTransferDoc(t.id);
      // Only what a receiving dock needs. No costs, no other transfers.
      return json({
        ok: true,
        transfer: {
          bol_number: doc.payload.bolNumber,
          from: doc.fromLoc?.name || null,
          to: doc.toLoc?.name || null,
          ship_date: doc.payload.shipDate,
          carrier: doc.payload.carrier,
          pro: doc.payload.pro,
          tracking: doc.payload.tracking,
          pallets: doc.payload.pallets,
          weight: doc.payload.weight,
          special_instructions: doc.payload.specialInstructions,
          lines: doc.payload.lines.map((l) => ({
            item: l.itemNo, description: l.description, qty: l.qty, lot: l.lot,
          })),
        },
      });
    }

    if (event.httpMethod !== 'POST') return json({ error: 'method not allowed' }, 405);

    const body = JSON.parse(event.body || '{}');
    const token = body.token;
    const name = String(body.receiver_name || '').trim().slice(0, 120);
    const note = body.note ? String(body.note).trim().slice(0, 1000) : null;
    const when = String(body.received_date || '').trim();
    if (!name) return json({ error: 'Put the name of the person receiving the load.' }, 400);
    if (when && !/^\d{4}-\d{2}-\d{2}$/.test(when)) return json({ error: 'The date must look like 2026-09-05.' }, 400);

    const t = await resolve(token);
    if (!t) return json({ error: DEAD }, 404);
    if (t.status !== 'in_transit') {
      return json({ error: t.status === 'received' ? 'This transfer has already been received.' : DEAD }, 409);
    }

    // Spend the token FIRST, and only if it is still unspent. Whoever wins this
    // update owns the receive; a loser gets the same dead-link answer as a
    // stranger and nothing has moved for them.
    const claimed = await sbPatch(
      'inventory_transfers',
      `id=eq.${t.id}&receive_token_used_at=is.null&status=eq.in_transit`,
      { receive_token_used_at: new Date().toISOString(), received_note: note },
    );
    if (!claimed.length) return json({ error: DEAD }, 409);

    // Now the stock. This is the ordinary receive RPC — nothing here writes a
    // movement of its own.
    try {
      await sbRpc('fn_receive_transfer', {
        p_transfer_id: t.id,
        p_received_date: when || null,
        p_receiver_signature_name: name,
      });
    } catch (e) {
      // The token is spent but the load did not land. Say so plainly rather
      // than leaving a receiver staring at a dead link with no explanation.
      const why = String(e.message || e).slice(0, 300);
      console.error('[transfer-receive] receive failed after claiming token:', why);
      return json({
        error: `We could not complete the receive: ${why}. Nothing was double-counted — call the office and they will finish it.`,
      }, 502);
    }

    const doc = await buildTransferDoc(t.id);
    const [s] = await sbGet('transfer_workflow_settings?select=*&id=eq.true&limit=1');
    const to = [...new Set([s?.ops_email, ...receivingRecipients(doc.toLoc, s || { ops_email: null })].filter(Boolean))];
    const msg = emailReceived({ doc, receiverName: name, note });
    for (const addr of to) {
      try {
        await sendEmail({ to: addr, from: doc.payload.from, replyTo: doc.payload.company.email,
                          subject: msg.subject, html: msg.html, text: msg.text });
      } catch (e) { console.warn('[transfer-receive] notify failed:', e.message); }
    }

    return json({ ok: true, bol_number: doc.payload.bolNumber, received_by: name });
  } catch (e) {
    console.error('[transfer-receive]', e);
    return json({ error: 'Something went wrong. Call the office and they will finish it.' }, 500);
  }
}
