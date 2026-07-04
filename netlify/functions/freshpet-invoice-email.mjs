// Branded "your invoice is ready" email for Freshpet PM billing.
// Mirrors brix-order's _lib/email-invoice-new.ts — navy #1F4E79 header,
// Brix logo band, summary grid, balance-due strip, Alameda Soda footer.
// Pure render function: returns { subject, html, text }.

const BRIX_LOGO_URL =
  'https://static.wixstatic.com/media/9b6a1d_c3a0d34a16d84fcaa2cf9c2b56db0549~mv2.png/v1/fill/w_424,h_196,al_c,q_85/Brix%20Full%20Logo.png';
const ALAMEDA_SODA_LOGO_URL =
  'https://alamedasoda.com/cdn/shop/files/Alameda_Soda_Main_Logo_Red_2024.png?v=1718372225&width=360';

const NAVY = '#1F4E79';
const NAVY_DARK = '#163A5C';
const INK = '#0F172A';
const MUTED = '#64748B';
const BORDER = '#E2E8F0';
const SURFACE = '#FFFFFF';
const SURFACE_ALT = '#F8FAFC';

function fmtUsd(n) {
  return Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' }); }
  catch { return String(iso); }
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// d: { recipientName, customerName, docNumber, invoiceDate, dueDate, totalAmount,
//      balance, invoiceUrl (optional), visitCount, periodLabel, pdfAttached }
export function renderFreshpetInvoiceEmail(d) {
  const greeting = d.recipientName ? `Hi ${esc(d.recipientName)},` : 'Hi there,';
  const subject = `Invoice #${d.docNumber} from Brix Beverage · ${fmtUsd(d.balance)} due`;
  const visitLine = d.visitCount
    ? `${d.visitCount} completed preventive-maintenance visit${d.visitCount === 1 ? '' : 's'}${d.periodLabel ? ` (${esc(d.periodLabel)})` : ''}`
    : 'completed preventive-maintenance service';

  const ctaBlock = d.invoiceUrl
    ? `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:8px 0 4px 0;">
         <a href="${esc(d.invoiceUrl)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:14px 28px;border-radius:10px;letter-spacing:0.01em;">View &amp; pay invoice →</a>
       </td></tr></table>`
    : `<div style="text-align:center;padding:6px 0;font-size:13px;color:${MUTED};">Your invoice PDF is attached to this email.</div>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${SURFACE_ALT};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:${INK};">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
      <div style="background:${NAVY};height:6px;line-height:6px;font-size:0;">&nbsp;</div>
      <div style="padding:24px 24px 18px;text-align:center;border-bottom:1px solid ${BORDER};">
        <img src="${esc(BRIX_LOGO_URL)}" width="180" height="83" alt="Brix Beverage" style="display:inline-block;border:0;outline:none;text-decoration:none;max-width:100%;height:auto;" />
      </div>
      <div style="padding:28px 24px;">
        <h1 style="margin:0 0 6px 0;font-size:24px;font-weight:600;color:${INK};letter-spacing:-0.01em;">Your invoice is ready</h1>
        <p style="margin:0 0 20px 0;font-size:14px;line-height:1.55;color:${MUTED};">
          ${greeting}<br>
          A new invoice has been issued to <strong style="color:${INK};">${esc(d.customerName)}</strong> for ${visitLine}. A detailed visit report is attached.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;background:${SURFACE_ALT};border-radius:10px;border:1px solid ${BORDER};">
          <tr>
            <td style="padding:14px 16px;width:50%;border-right:1px solid ${BORDER};">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:${MUTED};font-weight:600;">Invoice #</div>
              <div style="margin-top:4px;font-family:'JetBrains Mono',Menlo,monospace;font-size:14px;color:${INK};font-weight:600;">${esc(d.docNumber)}</div>
            </td>
            <td style="padding:14px 16px;width:50%;">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:${MUTED};font-weight:600;">Invoice date</div>
              <div style="margin-top:4px;font-size:13px;color:${INK};">${esc(fmtDate(d.invoiceDate))}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 16px;border-top:1px solid ${BORDER};border-right:1px solid ${BORDER};">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:${MUTED};font-weight:600;">Due date</div>
              <div style="margin-top:4px;font-size:13px;color:${INK};">${esc(fmtDate(d.dueDate))}</div>
            </td>
            <td style="padding:14px 16px;border-top:1px solid ${BORDER};">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:${MUTED};font-weight:600;">Amount</div>
              <div style="margin-top:4px;font-family:'JetBrains Mono',Menlo,monospace;font-size:14px;color:${INK};font-weight:600;">${fmtUsd(d.totalAmount)}</div>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
          <tr><td style="padding:14px 16px;border-top:2px solid ${BORDER};border-bottom:2px solid ${BORDER};">
            <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="font-size:14px;font-weight:600;color:${INK};">Balance due</td>
              <td style="text-align:right;font-family:'JetBrains Mono',Menlo,monospace;font-size:20px;font-weight:600;color:${NAVY};">${fmtUsd(d.balance)}</td>
            </tr></table>
          </td></tr>
        </table>
        ${ctaBlock}
        <p style="margin:24px 0 0 0;font-size:12px;color:${MUTED};line-height:1.5;">Questions about this invoice? Just reply to this email — it goes to your Brix Beverage rep.</p>
      </div>
    </div>
    <div style="text-align:center;padding:22px 16px 8px;">
      <div style="margin-bottom:14px;">
        <a href="https://www.alamedasoda.com" style="text-decoration:none;">
          <img src="${esc(ALAMEDA_SODA_LOGO_URL)}" width="100" alt="Alameda Soda" style="display:inline-block;border:0;outline:none;text-decoration:none;max-width:100%;height:auto;" />
        </a>
      </div>
      <div style="font-size:11px;color:${MUTED};line-height:1.7;">
        <strong style="color:${INK};">Brix Beverage</strong><br>
        1951 Monarch St. #200, Alameda CA 94501<br>
        <a href="tel:+18003725098" style="color:${MUTED};text-decoration:none;">1-800-372-5098</a><br>
        <a href="https://www.brixbev.com" style="color:${NAVY_DARK};text-decoration:none;">www.brixbev.com</a>
        &nbsp;·&nbsp;
        <a href="https://www.alamedasoda.com" style="color:${NAVY_DARK};text-decoration:none;">www.alamedasoda.com</a>
      </div>
    </div>
  </div>
</body></html>`;

  const text = [
    `Your invoice is ready - #${d.docNumber}`, '',
    greeting,
    `A new invoice has been issued to ${d.customerName} for ${d.visitCount || ''} completed preventive-maintenance visit(s)${d.periodLabel ? ` (${d.periodLabel})` : ''}. A detailed visit report is attached.`, '',
    `Invoice #:    ${d.docNumber}`,
    `Invoice date: ${fmtDate(d.invoiceDate)}`,
    `Due date:     ${fmtDate(d.dueDate)}`,
    `Amount:       ${fmtUsd(d.totalAmount)}`,
    `Balance due:  ${fmtUsd(d.balance)}`, '',
    d.invoiceUrl ? `View & pay invoice: ${d.invoiceUrl}` : 'Your invoice PDF is attached to this email.', '',
    'Questions? Reply to this email - it goes to your Brix rep.', '',
    'Brix Beverage', '1951 Monarch St. #200, Alameda CA 94501', '1-800-372-5098',
    'www.brixbev.com  ·  www.alamedasoda.com',
  ].join('\n');

  return { subject, html, text };
}
