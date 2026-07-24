// brixpense-email.mjs — shared branded email shell for Brixpense automation
// emails (SF expense autopost, card-receipt audit). Dark-navy glass header with
// the °bx mark + Brixpense wordmark, accent strip, content card, footer.
// accent: #22C55E success · #F59E0B attention · #3B82F6 info.

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
export function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function brixpenseEmail(accent, kicker, innerHtml) {
  return `<div style="margin:0;padding:24px 12px;background:#0B1220;font-family:'DM Sans',-apple-system,Segoe UI,Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;background:#0F172A;border:1px solid #1E293B;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.35)">
      <div style="padding:20px 24px;background:linear-gradient(135deg,#1F4E79 0%,#0F172A 100%);border-bottom:1px solid #1E293B">
        <table role="presentation" width="100%"><tr>
          <td style="vertical-align:middle">
            <span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background:#3B82F6;color:#fff;border-radius:9px;font-weight:800;font-size:15px;vertical-align:middle">°bx</span>
            <span style="color:#fff;font-weight:800;font-size:18px;letter-spacing:.2px;margin-left:10px;vertical-align:middle">Brixpense</span>
          </td>
          <td style="text-align:right;color:#93C5FD;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;vertical-align:middle">${esc(kicker)}</td>
        </tr></table>
      </div>
      <div style="height:4px;background:${accent}"></div>
      <div style="padding:22px 24px;color:#E2E8F0;font-size:14px;line-height:1.55">${innerHtml}</div>
      <div style="padding:14px 24px;border-top:1px solid #1E293B;color:#64748B;font-size:11px">
        Brixpense · Service Fusion → QuickBooks expense automation · Alameda Point Beverage Group
      </div>
    </div>
  </div>`;
}
export const kvRow = (k, v) => `<tr><td style="padding:4px 0;color:#94A3B8;width:150px;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;color:#F1F5F9">${v}</td></tr>`;
export const kvTable = (rows) => `<table role="presentation" style="border-collapse:collapse;width:100%;margin-top:6px">${rows}</table>`;
