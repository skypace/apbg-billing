// Email sending helper — wired for the APBG Resend account.
//
// IMPORTANT: brixbev.com is NOT verified in Resend. All outbound mail must
// route through alamedapointbg.com (or alamedapointbeveragegroup.com), the
// domains that ARE SPF/DKIM-verified in the APBG Resend tenant. This module
// uses alamedapointbg.com as the primary sender and falls back to the same
// domain if a per-call from override triggers a 403/domain error.
//
// Env vars:
//   RESEND_API_KEY    — required for Resend send
//   SENDGRID_API_KEY  — alternative provider; preferred if both set
//   EMAIL_FROM        — optional override of the default "from" address
//                       (must use a verified domain on whichever provider)
//   APPROVAL_EMAIL    — AP-tool default approver inbox
//   URL               — Netlify-provided site URL

function readEnv(name) {
  // Netlify Functions v2 prefers Netlify.env.get; fall back to process.env.
  if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
    return Netlify.env.get(name) || process.env[name];
  }
  return process.env[name];
}

// Where integration-health alerts go (health-watchdog, master-health-core).
//
// The name is historical: this also carried the AP tool's bill-approval email
// until that page was retired on 2026-09-03. Health alerts are now its only
// consumer — the name is left alone because it is a live Netlify env var.
//
// ⚠ The old fallback here was 'wgrandell@brixbev.com', an address that does not
// exist. It hard-bounced and Resend SUPPRESSED it on 2026-05-15, so from that
// day every AP bill-approval email, every approval confirmation, and every
// integration-health alert was accepted by Resend and silently dropped — for
// three and a half months, with nothing failing anywhere (found 2026-09-03).
//
// The default is now service@brixbev.com, which is what this system already
// says the answer is: ops.expense_settings.ap_inbox.notify — the notify list
// for the modern emailed-bill pipeline — is exactly that address, as is every
// other alert default in this repo. Set APPROVAL_EMAIL to override.
//
// ⚠ Never default this to an address nobody reads. The approve link in that
// email CREATES A BILL IN QUICKBOOKS, so a dead recipient does not merely lose
// a notification — it silently stops AP.
export const APPROVAL_EMAIL = readEnv('APPROVAL_EMAIL') || 'service@brixbev.com';

// Verified Resend sender on the APBG tenant. Same address Melt's
// send-order-approval falls back to — guaranteed to pass SPF/DKIM.
const DEFAULT_FROM   = 'BRIXpense <alerts@alamedapointbg.com>';
const FALLBACK_FROM  = 'APBG <alerts@alamedapointbg.com>';

export const EMAIL_FROM = readEnv('EMAIL_FROM') || DEFAULT_FROM;
export const SITE_URL   = readEnv('URL') || 'https://alamedapointbg.com';

// `attachments` (optional): [{ filename, content }] where content is base64
// (Resend format). Only wired through the Resend path.
export async function sendEmail({ to, subject, html, text, replyTo, from, attachments, cc }) {
  const sendgridKey = readEnv('SENDGRID_API_KEY');
  const resendKey   = readEnv('RESEND_API_KEY');

  // SendGrid first if its key exists (keeps AP-tool compat); else Resend.
  // NOTE: attachments are only supported on the Resend path today, so prefer
  // Resend when a caller passes attachments even if a SendGrid key exists.
  if (sendgridKey && !(attachments && attachments.length)) {
    return sendViaSendGrid({ to, subject, html, replyTo, from: from || EMAIL_FROM, sendgridKey });
  }
  if (resendKey) {
    return sendViaResendWithFallback({ to, subject, html, text, replyTo, from: from || EMAIL_FROM, resendKey, attachments, cc });
  }
  if (sendgridKey) {
    return sendViaSendGrid({ to, subject, html, replyTo, from: from || EMAIL_FROM, sendgridKey });
  }
  console.warn('No email service configured — skipping email send');
  return false;
}

async function sendViaResendWithFallback({ to, subject, html, text, replyTo, from, resendKey, attachments, cc }) {
  try {
    return await sendViaResend({ to, subject, html, text, replyTo, from, resendKey, attachments, cc });
  } catch (e) {
    const msg = String(e?.message || '');
    if (/domain|from|verified|403|unauthorized/i.test(msg)) {
      // Caller-specified or env-specified domain isn't verified in Resend.
      // Retry with the known-good APBG sender.
      console.warn(`Resend rejected from="${from}" (${msg}); retrying with ${FALLBACK_FROM}`);
      return await sendViaResend({ to, subject, html, text, replyTo, from: FALLBACK_FROM, resendKey, attachments, cc });
    }
    throw e;
  }
}

async function sendViaResend({ to, subject, html, text, replyTo, from, resendKey, attachments, cc }) {
  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (text) payload.text = text;
  // `cc` (optional): Resend path only, like attachments.
  if (cc && (Array.isArray(cc) ? cc.length : cc)) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (attachments && attachments.length) payload.attachments = attachments;
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend ${res.status}: ${err.substring(0, 300)}`);
  }
  return res.json();
}

async function sendViaSendGrid({ to, subject, html, replyTo, from, sendgridKey }) {
  const fromAddr = from.match(/<(.+)>/)?.[1] || from;
  const fromName = from.match(/^(.+?)\s*</)?.[1] || 'APBG';
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sendgridKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: (Array.isArray(to) ? to : [to]).map(e => ({ email: e })) }],
      from: { email: fromAddr, name: fromName },
      reply_to: replyTo ? { email: replyTo } : undefined,
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SendGrid error: ${res.status} ${err}`);
  }
  return true;
}

// ─── Email Templates (AP-tool flow, preserved verbatim) ───

export function approvalEmailHtml(billData, approveUrl) {
  const lines = (billData.lineItems || []).map(li =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;">${li.description || '—'}</td>
     <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:center;">${li.quantity || 1}</td>
     <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">$${(li.unitCost || 0).toFixed(2)}</td></tr>`
  ).join('');

  const total = (billData.lineItems || []).reduce((s, li) => s + (li.quantity || 1) * (li.unitCost || 0), 0);

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
    <div style="background:#1F4E79;padding:24px 28px;border-radius:8px 8px 0 0;">
      <h1 style="color:#fff;font-size:20px;margin:0;">New Vendor Bill — Review Required</h1>
      <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:6px 0 0;">APBG 3rd Party Billing Loader</p>
    </div>
    <div style="padding:24px 28px;border:1px solid #e2e6ed;border-top:0;border-radius:0 0 8px 8px;">
      <table style="width:100%;font-size:14px;margin-bottom:20px;">
        <tr><td style="color:#6b7280;padding:4px 0;">Vendor</td><td style="font-weight:600;">${billData.vendorName || 'Unknown'}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 0;">Bill #</td><td style="font-family:monospace;">${billData.billNumber || '—'}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 0;">Date</td><td>${billData.billDate || '—'}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 0;">Total</td><td style="font-weight:700;font-family:monospace;font-size:18px;">$${total.toFixed(2)}</td></tr>
        ${billData.notes ? `<tr><td style="color:#6b7280;padding:4px 0;">Notes</td><td style="font-size:12px;color:#6b7280;">${billData.notes}</td></tr>` : ''}
      </table>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead><tr style="background:#f4f6f9;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Description</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#6b7280;">Qty</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;">Unit Cost</th>
        </tr></thead>
        <tbody>${lines}</tbody>
      </table>

      <div style="text-align:center;margin:28px 0 16px;">
        <a href="${approveUrl}" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;padding:14px 40px;border-radius:6px;font-weight:600;font-size:15px;">
          Review & Approve →
        </a>
      </div>
      <p style="text-align:center;font-size:12px;color:#9ca3af;">Click above to set vendor, account, location, job number, and approve this bill.</p>
    </div>
  </div>`;
}

export function confirmationEmailHtml({ bill, invoice, margin, marginPct, matched }) {
  if (matched) {
    const invoiceLines = (invoice.lines || []).map(li =>
      `<tr><td style="padding:4px 8px;font-size:12px;border-bottom:1px solid #eee;">${li.description || '—'}</td>
       <td style="padding:4px 8px;font-size:12px;border-bottom:1px solid #eee;text-align:right;">$${(li.amount || 0).toFixed(2)}</td></tr>`
    ).join('');

    return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#065F46;padding:24px 28px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;font-size:20px;margin:0;">✓ Bill Created & Matched</h1>
      </div>
      <div style="padding:24px 28px;border:1px solid #e2e6ed;border-top:0;">
        <div style="background:#D1FAE5;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
          <table style="width:100%;font-size:14px;">
            <tr><td style="color:#065F46;font-weight:700;font-size:16px;" colspan="2">${bill.vendorName}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Bill Date</td><td style="font-family:monospace;">${bill.date || '—'}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Bill Amount</td><td style="font-family:monospace;font-weight:700;">$${bill.total.toFixed(2)}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Account</td><td>${bill.accountName || 'Service COGS'}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Job #</td><td style="font-family:monospace;font-weight:700;">${bill.jobNumber}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Location</td><td>${bill.locationName}</td></tr>
          </table>
        </div>

        <p style="font-size:13px;font-weight:600;color:#1F4E79;margin-bottom:8px;">MATCHED TO INVOICE</p>
        <div style="background:#DBEAFE;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
          <table style="width:100%;font-size:14px;">
            <tr><td style="color:#1E40AF;padding:2px 0;">Invoice #</td><td style="font-family:monospace;font-weight:700;">${invoice.number}</td></tr>
            <tr><td style="color:#1E40AF;padding:2px 0;">Customer</td><td>${invoice.customerName}</td></tr>
            <tr><td style="color:#1E40AF;padding:2px 0;">Invoice Total</td><td style="font-family:monospace;font-weight:700;">$${invoice.total.toFixed(2)}</td></tr>
          </table>
          ${invoiceLines ? `<table style="width:100%;border-collapse:collapse;margin-top:12px;">${invoiceLines}</table>` : ''}
        </div>

        <div style="background:#FEF3C7;border-radius:6px;padding:16px 20px;text-align:center;">
          <p style="font-size:12px;color:#92400E;margin:0;">MARGIN</p>
          <p style="font-size:28px;font-weight:700;color:#92400E;margin:4px 0;font-family:monospace;">
            ${marginPct.toFixed(1)}% — $${margin.toFixed(2)} profit
          </p>
        </div>
      </div>
    </div>`;
  } else {
    return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#991B1B;padding:24px 28px;border-radius:8px 8px 0 0;">
        <h1 style="color:#fff;font-size:20px;margin:0;">⚠ Bill Created — No Matching Invoice</h1>
      </div>
      <div style="padding:24px 28px;border:1px solid #e2e6ed;border-top:0;border-radius:0 0 8px 8px;">
        <div style="background:#D1FAE5;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
          <p style="font-size:13px;color:#065F46;margin:0 0 8px;font-weight:600;">BILL SUCCESSFULLY CREATED</p>
          <table style="width:100%;font-size:14px;">
            <tr><td style="color:#065F46;font-weight:700;font-size:16px;" colspan="2">${bill.vendorName}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Bill Amount</td><td style="font-family:monospace;font-weight:700;">$${bill.total.toFixed(2)}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Account</td><td>${bill.accountName || 'Service COGS'}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Job #</td><td style="font-family:monospace;font-weight:700;">${bill.jobNumber}</td></tr>
            <tr><td style="color:#065F46;padding:2px 0;">Location</td><td>${bill.locationName}</td></tr>
          </table>
        </div>

        <div style="background:#FEE2E2;border:2px solid #EF4444;border-radius:6px;padding:20px;text-align:center;">
          <p style="font-size:18px;font-weight:700;color:#991B1B;margin:0 0 8px;">
            WARNING — NO INVOICE ON FILE
          </p>
          <p style="font-size:13px;color:#991B1B;margin:0;">
            No invoice in QuickBooks contains Job # <strong>${bill.jobNumber}</strong>.<br>
            Please submit this job for invoicing outside of this system.
          </p>
        </div>
      </div>
    </div>`;
  }
}
