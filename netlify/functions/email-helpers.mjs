// Email sending helper
// Supports SendGrid (SENDGRID_API_KEY) or Resend (RESEND_API_KEY)
// Set EMAIL_FROM in env vars (default: billing@brixbev.com)
// Set APPROVAL_EMAIL in env vars (who gets approval emails — default: Whitney)

export const APPROVAL_EMAIL = process.env.APPROVAL_EMAIL || 'wgrandell@brixbev.com';
export const EMAIL_FROM = process.env.EMAIL_FROM || 'Pacer Billing <billing@brixbev.com>';
export const SITE_URL = process.env.URL || 'https://pacer-billing.netlify.app';

export async function sendEmail({ to, subject, html, replyTo }) {
  // Try SendGrid first, then Resend
  if (process.env.SENDGRID_API_KEY) {
    return sendViaSendGrid({ to, subject, html, replyTo });
  }
  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ to, subject, html, replyTo });
  }
  console.warn('No email service configured — skipping email send');
  return false;
}

async function sendViaSendGrid({ to, subject, html, replyTo }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: EMAIL_FROM.match(/<(.+)>/)?.[1] || EMAIL_FROM, name: EMAIL_FROM.match(/^(.+?)\s*</)?.[1] || 'Pacer Billing' },
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

async function sendViaResend({ to, subject, html, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      reply_to: replyTo,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${res.status} ${err}`);
  }
  return true;
}

// ─── Email Templates ───

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
    // ── SUCCESS: Bill matched to invoice ──
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
    // ── WARNING: No matching invoice ──
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
