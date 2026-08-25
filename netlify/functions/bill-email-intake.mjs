// bill-email-intake — Resend inbound webhook for the AP bill inbox.
//
//   bills@alamedapointbg.com  →  this function  →  bill-email-process-background
//                             →  OCR'd Brixpense bill draft in the AP queue
//
// This endpoint does as little as possible: verify the signature, decide
// whether the email is ours, write the intake row, hand off. Everything slow
// (Resend attachment reads, Claude OCR, QBO vendor matching) happens in the
// background function so Resend gets a fast 200 and never retries a webhook
// that is actually still working.
//
// NOTE ON FAN-OUT: Resend fires email.received for the WHOLE domain, so every
// webhook on alamedapointbg.com — vendor-email-intake, the brix-order routes,
// the melt ones — sees this mail too and ignores it by recipient. The same
// coexistence the vendor routes already rely on. It also means the per-
// endpoint signing secret is the only thing cryptographically separating the
// channels, which is why RESEND_AP_INBOX_SECRET is its own variable.
//
// Env:
//   RESEND_AP_INBOX_SECRET    — this webhook's Svix signing secret (required;
//                               falls back to RESEND_INBOUND_SECRET, and
//                               either may hold a comma-separated list)
//   RESEND_INBOUND_API_KEY    — FULL-ACCESS Resend key used to READ inbound
//                               mail. A send-only key 401s every read.
//   SUPABASE_SERVICE_ROLE_KEY — intake rows + attachment storage
//   ANTHROPIC_API_KEY         — bill OCR (in the background function)
//   AP_INBOX_SUBMITTER_ID     — optional fallback submitter uuid

import { corsHeaders } from './qbo-helpers.mjs';
import {
  addr, displayName, recipientsOf, loadApInboxSettings, senderAllowed,
  looksAutomated, verifyInbound, opsInsert, opsGet,
} from './lib/ap-inbox.mjs';

const ok = (body) => ({ statusCode: 200, headers: corsHeaders(), body: JSON.stringify(body) });

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'POST only' }) };
  }

  const raw = event.body || '';
  const auth = verifyInbound(event.headers || {}, raw, event.queryStringParameters?.secret);
  if (!auth.ok) {
    // 503 (no secret configured) vs 401 (bad signature) is the diagnostic the
    // setup checker reads — do not collapse them into one status.
    return { statusCode: auth.status, headers: corsHeaders(), body: JSON.stringify({ error: auth.error }) };
  }

  let payload;
  try {
    const parsed = JSON.parse(raw);
    payload = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'bad JSON' }) };
  }

  const settings = await loadApInboxSettings();
  const toList = recipientsOf(payload);
  if (!toList.includes(settings.inbox)) {
    // Not our mail — the domain-wide fan-out means this is the normal case.
    return ok({ ok: true, ignored: 'not the AP inbox' });
  }
  if (!settings.enabled) return ok({ ok: true, ignored: 'AP inbox disabled' });

  const fromEmail = addr(payload.from);
  const subject = String(payload.subject || '').slice(0, 500);
  const resendEmailId = String(payload.email_id || payload.id || '') || null;

  if (looksAutomated({ from: fromEmail, subject, headers: payload.headers })) {
    return ok({ ok: true, ignored: 'automated mail' });
  }

  // Dedup on the Resend email id BEFORE doing anything else, so a webhook
  // retry can never produce a second bill draft for one email.
  if (resendEmailId) {
    try {
      const existing = await opsGet(
        `bill_email_intake?resend_email_id=eq.${encodeURIComponent(resendEmailId)}&select=id,status&limit=1`,
      );
      if (existing?.[0]) return ok({ ok: true, ignored: 'duplicate', intake_id: existing[0].id });
    } catch { /* a failed dedup read must not drop the email */ }
  }

  const gate = senderAllowed(fromEmail, settings);

  let intake;
  try {
    intake = await opsInsert('bill_email_intake', {
      resend_email_id: resendEmailId,
      message_id: String(payload.message_id || payload.messageId || '') || null,
      inbox: settings.inbox,
      from_email: fromEmail || null,
      from_name: displayName(payload.from),
      subject: subject || null,
      received_at: payload.created_at || new Date().toISOString(),
      raw_text: (payload.text || '').slice(0, 20000) || null,
      attachment_count: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
      status: gate.ok ? 'received' : 'sender_rejected',
      status_detail: gate.ok ? null : gate.reason,
    }, { ignoreDuplicates: true });
  } catch (e) {
    // Let Resend retry — dedup makes that safe.
    console.error('[bill-email-intake] intake insert failed:', e?.message || e);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'intake write failed' }) };
  }

  if (!intake) return ok({ ok: true, ignored: 'duplicate' });
  if (!gate.ok) return ok({ ok: true, intake_id: intake.id, status: 'sender_rejected' });

  // Hand off. Netlify background functions return 202 immediately; a failed
  // kick leaves the row at `received`, which the queue shows and can re-run.
  const base = process.env.URL || process.env.DEPLOY_URL || 'https://apbg-billing.netlify.app';
  try {
    await fetch(`${base}/.netlify/functions/bill-email-process-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ap-inbox-secret': process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      },
      body: JSON.stringify({ intake_id: intake.id }),
    });
  } catch (e) {
    console.warn('[bill-email-intake] background kick failed:', e?.message || e);
  }

  return ok({ ok: true, intake_id: intake.id });
}
