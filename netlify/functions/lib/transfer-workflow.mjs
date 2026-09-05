// The transfer process: what each step says, and who it says it to.
//
// Sky's flow, in his words:
//   order goes in -> email service@brixbev.com to make the order, with all the
//   details and the pick ticket -> a Service Fusion ticket (UNSCHEDULED, the
//   sampling customer, "Product Transfer Ticket") whose number goes ON that
//   email -> the receiving branch is told too -> the tech works the ticket and
//   completes it -> an email comes back to schedule the delivery -> shipping
//   and BOL information is entered -> a final email with all details and
//   pallets, carrying a ONE-TIME link to receive the product.
//
// PURE-ish: this module builds payloads, text and tokens. It reads settings and
// talks to Service Fusion, but every database write stays in the handler, so
// the order of operations (record first, then tell people) is visible in one
// place rather than scattered through the emails.

import crypto from 'node:crypto';
import { sfRequest } from '../sf-helpers.mjs';
import { whatToBuild } from './transfer-docs.mjs';

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── The one-time receive link ────────────────────────────────────────────────
//
// ⚠ Only the sha256 is ever stored. The raw token exists once, in the email we
//   send. So a leaked backup, a widened grant or a support session reading this
//   table yields nothing usable — and re-sending the original link is
//   impossible by construction, which is the honest behaviour anyway: a link
//   that needs re-sending has usually gone astray. Resend mints a new one and
//   kills the old in the same write.
export function mintReceiveToken(days = 21) {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashToken(token),
    expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
  };
}
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * The receive link. It goes through the gateway's existing /billing/* proxy,
 * so this needs no new route on either side — and the branded domain is what a
 * receiving branch should be clicking, not a netlify.app address.
 */
export function receiveUrl(token, base = 'https://alamedapointbg.com') {
  return `${base.replace(/\/+$/, '')}/billing/transfer-receive.html?t=${encodeURIComponent(token)}`;
}

// ── Service Fusion ───────────────────────────────────────────────────────────

/**
 * The ticket the warehouse works. The description IS the instruction — Sky:
 * "The ticket tells them how many cases of what to build on the notes or tasks
 * section 20 cases of XXXXX" — so the lines are written out in plain words
 * rather than left in an attachment the tech cannot see from the app.
 */
export function buildTransferSfJob(settings, doc) {
  const p = doc.payload;
  const build = whatToBuild(p.lines);
  const description = [
    `PRODUCT TRANSFER — ${p.bolNumber}`,
    `Pull from: ${doc.fromLoc?.name || '?'}`,
    `Deliver to: ${doc.toLoc?.name || '?'}`,
    '',
    'BUILD THIS:',
    ...build.map((l) => `  - ${l}`),
    '',
    `Total: ${build.length} line(s), ${p.lines.reduce((t, l) => t + (Number(l.qty) || 0), 0)} unit(s)`,
    p.specialInstructions ? `\nSpecial instructions: ${p.specialInstructions}` : null,
    p.notes ? `\nNotes: ${p.notes}` : null,
    '',
    'Complete this ticket once the load is built and on the pallet. Completing it',
    'tells the office to schedule the delivery.',
  ].filter((l) => l !== null).join('\n');

  return {
    customer_name: settings.sf_customer_name,
    status: settings.sf_job_status || 'Unscheduled',
    ...(settings.sf_job_category ? { category: settings.sf_job_category } : {}),
    po_number: String(p.bolNumber).slice(0, 50),
    description: description.slice(0, 4000),
  };
}

// ⚠ Service Fusion only ATTACHES an EXISTING category and rejects an unknown
//   one with a 422 that kills the whole job. The ticket matters more than the
//   label, so a rejection drops only the field SF's own error names and retries
//   — the pattern vendor-email-intake proved. A dropped field comes back as a
//   warning so somebody fixes it in SF Settings rather than never hearing.
const DROPPABLE = ['category', 'po_number'];

// `post` is a seam, not indirection for its own sake: sfRequest acquires a
// live Service Fusion token before it ever reaches fetch, so the retry ladder
// below — the part that can actually be wrong — is untestable without one.
export async function createTransferSfJob(payload, post = (body) => sfRequest('POST', '/jobs', body)) {
  const body = { ...payload };
  const dropped = [];
  for (;;) {
    try {
      const job = await post(body);
      return {
        job,
        warning: dropped.length
          ? `Service Fusion rejected: ${dropped.join(', ')} — the ticket was created without them. Add the value in SF Settings (Job Categories) and set it on the ticket by hand.`
          : null,
      };
    } catch (e) {
      if (!/422/.test(e.message)) throw e;   // only field rejections retry
      const present = DROPPABLE.filter((f) => body[f] !== undefined);
      const named = present.find((f) => new RegExp(f.replace(/_/g, '[_ ]?'), 'i').test(e.message));
      const target = named || present[0];
      if (!target) throw e;
      delete body[target];
      dropped.push(target);
      console.warn(`[transfer-workflow] SF 422 → dropping "${target}": ${e.message}`);
    }
  }
}

/** Has the tech finished? SF has no webhooks, so this is a direct read. */
export function sfJobLooksComplete(job) {
  const s = String(job?.status || '').toLowerCase();
  return /complete|invoiced|closed|done/.test(s);
}

// ── Emails ───────────────────────────────────────────────────────────────────

function shell(title, accent, bodyHtml, footer) {
  return `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
  <div style="background:#0F172A;padding:18px 24px;border-bottom:3px solid ${esc(accent)}">
    <span style="color:#fff;font-size:16px;font-weight:700">${esc(title)}</span></div>
  <div style="padding:20px 24px;color:#0F172A;font-size:14px;line-height:1.55">${bodyHtml}</div>
  <div style="padding:12px 24px;background:#f8fafc;color:#64748b;font-size:12px">${esc(footer)}</div>
</div>`;
}

function facts(pairs) {
  const rows = pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap">${esc(k)}</td>
         <td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`).join('');
  return `<table style="border-collapse:collapse;margin:6px 0 14px">${rows}</table>`;
}

function buildList(lines) {
  return `<ul style="margin:6px 0 14px;padding-left:20px">${
    lines.map((l) => `<li style="margin:3px 0"><strong>${esc(l)}</strong></li>`).join('')}</ul>`;
}

/** 1 — to the office: make this transfer happen. The pull ticket is attached. */
export function emailRequestOps({ doc, sfJobNumber, sfWarning, requestedBy }) {
  const p = doc.payload;
  const body = [
    `<p>A product transfer has been raised and needs pulling and building.</p>`,
    facts([
      ['Transfer', p.bolNumber],
      ['Service Fusion ticket', sfJobNumber || 'not created — see below'],
      ['Pull from', doc.fromLoc?.name],
      ['Deliver to', doc.toLoc?.name],
      ['Issued', p.issued ? String(p.issued).slice(0, 10) : null],
      ['Raised by', requestedBy],
    ]),
    `<p style="margin-bottom:4px"><strong>What to build</strong></p>`,
    buildList(whatToBuild(p.lines)),
    p.specialInstructions ? `<p><strong>Special instructions:</strong> ${esc(p.specialInstructions)}</p>` : '',
    p.notes ? `<p><strong>Notes:</strong> ${esc(p.notes)}</p>` : '',
    `<p>The pull ticket is attached. Complete the Service Fusion ticket once the load is built — that is what tells us to schedule the delivery.</p>`,
    sfWarning ? `<p style="background:#fff7ed;border-left:4px solid #f59e0b;padding:10px;margin-top:14px">${esc(sfWarning)}</p>` : '',
  ].join('');
  return {
    subject: `Transfer ${p.bolNumber} — pull and build${sfJobNumber ? ` · SF #${sfJobNumber}` : ''}`,
    html: shell('Product transfer — pull and build', p.accent, body, 'Refractor · inventory transfers'),
    text: `Transfer ${p.bolNumber}\nSF ticket: ${sfJobNumber || 'not created'}\nFrom ${doc.fromLoc?.name} to ${doc.toLoc?.name}\n\nBuild:\n${whatToBuild(p.lines).map((l) => '  - ' + l).join('\n')}\n\nThe pull ticket is attached.`,
  };
}

/** 2 — to the receiving branch: this is coming to you. */
export function emailRequestReceiving({ doc, sfJobNumber }) {
  const p = doc.payload;
  const body = [
    `<p>A transfer is being built for you. Nothing to do yet — this is a heads-up so you can expect it.</p>`,
    facts([
      ['Transfer', p.bolNumber],
      ['Service Fusion ticket', sfJobNumber],
      ['Coming from', doc.fromLoc?.name],
      ['Coming to', doc.toLoc?.name],
    ]),
    `<p style="margin-bottom:4px"><strong>On the load</strong></p>`,
    buildList(whatToBuild(p.lines)),
    `<p>You will get a second email with the bill of lading and a link to receive it once it ships.</p>`,
  ].join('');
  return {
    subject: `Heads up — transfer ${p.bolNumber} is being built for ${doc.toLoc?.name || 'you'}`,
    html: shell('A transfer is coming to you', p.accent, body, 'Refractor · inventory transfers'),
    text: `Transfer ${p.bolNumber} is being built for ${doc.toLoc?.name}.\n\n${whatToBuild(p.lines).map((l) => '  - ' + l).join('\n')}\n\nYou will get the BOL and a receive link when it ships.`,
  };
}

/** 3 — the ticket is complete: schedule the delivery. */
export function emailBuilt({ doc, sfJobNumber }) {
  const p = doc.payload;
  const body = [
    `<p>The Service Fusion ticket is complete — the load is built and waiting.</p>`,
    facts([
      ['Transfer', p.bolNumber],
      ['Service Fusion ticket', sfJobNumber],
      ['At', doc.fromLoc?.name],
      ['Going to', doc.toLoc?.name],
    ]),
    buildList(whatToBuild(p.lines)),
    `<p><strong>Next: schedule the delivery and enter the shipping and BOL information</strong> in Refractor → Stock → Transfers. Entering it ships the transfer and sends the receiving branch its bill of lading and a one-time link to receive.</p>`,
  ].join('');
  return {
    subject: `Transfer ${p.bolNumber} is built — schedule the delivery`,
    html: shell('Built and waiting — schedule it', p.accent, body, 'Refractor · inventory transfers'),
    text: `Transfer ${p.bolNumber} is built and waiting at ${doc.fromLoc?.name}.\nSchedule the delivery and enter the shipping and BOL information in Refractor.`,
  };
}

/** 4 — it has shipped: here is everything, and here is the one-time link. */
export function emailShipped({ doc, url }) {
  const p = doc.payload;
  const totalUnits = p.lines.reduce((t, l) => t + (Number(l.qty) || 0), 0);
  const body = [
    `<p>This transfer is on its way to you. The bill of lading is attached.</p>`,
    facts([
      ['Transfer', p.bolNumber],
      ['From', doc.fromLoc?.name],
      ['To', doc.toLoc?.name],
      ['Carrier', p.carrier],
      ['PRO #', p.pro],
      ['Tracking', p.tracking],
      ['Ship date', p.shipDate],
      ['Pallets', p.pallets != null ? String(p.pallets) : null],
      ['Weight', p.weight != null ? `${p.weight} lbs` : null],
      ['Lines', `${p.lines.length} (${totalUnits} units)`],
    ]),
    buildList(whatToBuild(p.lines)),
    `<p style="margin-top:18px"><a href="${esc(url)}"
        style="display:inline-block;background:${esc(p.accent)};color:#fff;text-decoration:none;
               padding:12px 22px;border-radius:6px;font-weight:700">Receive this transfer</a></p>`,
    `<p style="color:#64748b;font-size:12px">Use that button when the load arrives and you have counted it.
       It works <strong>once</strong>, and it is the only thing it can do — it cannot see or change any other transfer.
       If it has already been used, ask the office for a new one.</p>`,
    p.specialInstructions ? `<p><strong>Special instructions:</strong> ${esc(p.specialInstructions)}</p>` : '',
  ].join('');
  return {
    subject: `Transfer ${p.bolNumber} has shipped to ${doc.toLoc?.name || 'you'} — receive it here`,
    html: shell('Your transfer has shipped', p.accent, body, 'Refractor · inventory transfers'),
    text: `Transfer ${p.bolNumber} has shipped from ${doc.fromLoc?.name} to ${doc.toLoc?.name}.\nCarrier ${p.carrier || '-'}, ${p.pallets ?? '-'} pallet(s).\n\n${whatToBuild(p.lines).map((l) => '  - ' + l).join('\n')}\n\nReceive it here (one time only): ${url}`,
  };
}

/** 5 — it landed. Told to both ends so nobody has to ask. */
export function emailReceived({ doc, receiverName, note }) {
  const p = doc.payload;
  const body = [
    `<p><strong>${esc(doc.toLoc?.name || 'The destination')}</strong> has received transfer <strong>${esc(p.bolNumber)}</strong>.</p>`,
    facts([
      ['Received by', receiverName],
      ['Received', p.shipDate ? null : null],
      ['From', doc.fromLoc?.name],
      ['To', doc.toLoc?.name],
      ['Lines', String(p.lines.length)],
    ]),
    buildList(whatToBuild(p.lines)),
    note ? `<p><strong>Note from the receiver:</strong> ${esc(note)}</p>` : '',
    `<p style="color:#64748b;font-size:12px">Stock has moved in the ledger. The receive link is now spent.</p>`,
  ].join('');
  return {
    subject: `Transfer ${p.bolNumber} received at ${doc.toLoc?.name || 'destination'}`,
    html: shell('Transfer received', p.accent, body, 'Refractor · inventory transfers'),
    text: `Transfer ${p.bolNumber} received at ${doc.toLoc?.name} by ${receiverName}.${note ? '\nNote: ' + note : ''}`,
  };
}

/** Who hears about a transfer into this location. Never silently nobody. */
export function receivingRecipients(toLoc, settings) {
  const own = String(toLoc?.contact_email || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return own.length ? own : [settings.ops_email];
}
