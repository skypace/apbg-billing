// Freshpet portal emails — invite/walkthrough + password reset.
//
// Used by freshpet-portal-users.mjs (admin-triggered invite + reset) and
// freshpet-password-reset.mjs (self-serve "Forgot password"). Branded to the
// Freshpet portal's cream/orange palette; sent through the shared
// email-helpers Resend pipeline (from alamedapointbg.com, the verified
// domain).
//
// Password links deliberately carry the GoTrue `hashed_token` to our OWN
// portal page (?type=recovery&token_hash=…) instead of GoTrue's action_link:
// the token is only redeemed by the page's JS via POST /auth/v1/verify, so a
// Safe-Links-style scanner GET can't consume it, and no redirect allowlist /
// Site URL config is involved. Same pattern as brix-order /set-password and
// the gateway's forgot-password (2026-08-17).

const AC = '#E56A15';   // Freshpet portal accent orange
const BG = '#FFF8F0';   // cream
const TX = '#2A2521';
const TX2 = '#786B5E';
const AM = '#CF8A17';   // amber (legacy note)

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shell(inner) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${BG};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TX}">
  <div style="max-width:640px;margin:0 auto;padding:28px 18px">
    <div style="background:#fff;border:1px solid #EEE0CF;border-radius:16px;overflow:hidden">
      <div style="background:${AC};padding:18px 26px">
        <div style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-.01em">🐾 Freshpet Service Portal</div>
        <div style="color:#FFE3CC;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:2px">Alameda Point Beverage Group · Brix Beverage</div>
      </div>
      <div style="padding:26px">${inner}</div>
    </div>
    <div style="text-align:center;color:${TX2};font-size:12px;margin-top:14px">
      Alameda Point Beverage Group · service@brixbev.com<br>
      You received this email because a service portal account was set up for this address.
    </div>
  </div>
</body></html>`;
}

function button(href, label, color) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${color || AC};color:#fff;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px;text-decoration:none">${esc(label)}</a>`;
}

// ── Invite + walkthrough ──
export function renderPortalInviteEmail({ name, portalUrl, setPasswordUrl, legacyLink }) {
  const hi = name ? `Hi ${esc(name)},` : 'Hi,';
  const steps = [
    ['PM service calls', 'Completed preventive-maintenance visits, grouped by invoice — the newest invoice opens automatically. Every invoice section shows the visit count, the total, and an <strong>Invoice PDF</strong> button.'],
    ['Open any visit', 'Click a visit card to see the full maintenance checklist, the technician, temperature/voltage readings, photos (tap any photo to zoom), the <strong>signed service report PDF</strong>, and the GPS location captured when the tech signed off.'],
    ['Quarterly Reactive', 'The second tab lists quarterly reactive invoices with each asset’s warranty status — under warranty vs. out-of-warranty billed.'],
    ['Find anything fast', 'Search by store, city, serial number, or technician; filter by invoice or month; group the view by invoice or by month.'],
  ];
  const stepsHtml = steps.map(([t, d], i) =>
    `<tr>
      <td style="vertical-align:top;padding:10px 12px 10px 0"><div style="width:26px;height:26px;border-radius:50%;background:${AC};color:#fff;font-weight:800;font-size:14px;text-align:center;line-height:26px">${i + 1}</div></td>
      <td style="vertical-align:top;padding:10px 0"><div style="font-weight:700;font-size:15px">${t}</div><div style="color:${TX2};font-size:13.5px;line-height:1.55;margin-top:2px">${d}</div></td>
    </tr>`).join('');

  const legacyHtml = `
    <div style="background:rgba(207,138,23,.10);border:1px solid ${AM};border-radius:12px;padding:16px 18px;margin:22px 0">
      <div style="font-weight:800;color:${AM};font-size:14px;margin-bottom:6px">📦 Records before June 1, 2026</div>
      <div style="color:${TX};font-size:13.5px;line-height:1.55">Service visits completed <strong>before 6/1/2026</strong> were handled on our previous system, so their photos and paperwork are not attached in the portal (those visits show a “Legacy” tag). The backup photos and signed paperwork for that period live in a shared folder:</div>
      ${legacyLink ? `<div style="margin-top:12px">${button(legacyLink, '📁 Open the pre-6/1/2026 archive', AM)}</div>`
                   : `<div style="color:${TX2};font-size:13px;margin-top:8px">Ask your Alameda Point Beverage Group contact for the archive folder link.</div>`}
    </div>`;

  const html = shell(`
    <div style="font-size:15px;line-height:1.6">${hi}</div>
    <div style="font-size:15px;line-height:1.6;margin-top:10px">Your Freshpet service portal account is ready. The portal is your live record of every completed service visit — photos, signed reports, and invoices — updated as our technicians complete work.</div>

    <div style="margin:22px 0;text-align:center">${button(setPasswordUrl, 'Set your password →')}</div>
    <div style="color:${TX2};font-size:12.5px;text-align:center;margin-top:-10px;margin-bottom:8px">This link is one-time and expires — if it stops working, use “Forgot password?” on the sign-in page to get a fresh one.</div>

    <div style="font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:${AC};margin:22px 0 8px;border-bottom:1px solid #EEE0CF;padding-bottom:6px">Signing in</div>
    <div style="font-size:13.5px;line-height:1.6;color:${TX}">
      Portal address: <a href="${esc(portalUrl)}" style="color:${AC};font-weight:700">${esc(portalUrl)}</a><br>
      • <strong>Email + password</strong> — works on its own for everyone; set yours with the button above.<br>
      • <strong>Sign in with Google</strong> — optional shortcut if this address is a Google account.<br>
      If Google sign-in ever gives you trouble, email + password always works by itself.
    </div>

    <div style="font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:${AC};margin:22px 0 4px;border-bottom:1px solid #EEE0CF;padding-bottom:6px">What you’ll find inside</div>
    <table style="border-collapse:collapse;width:100%">${stepsHtml}</table>

    ${legacyHtml}

    <div style="font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:${AC};margin:22px 0 8px;border-bottom:1px solid #EEE0CF;padding-bottom:6px">Managing your password</div>
    <div style="font-size:13.5px;line-height:1.6;color:${TX}">
      • Forgot it? Click <strong>“Forgot password?”</strong> on the sign-in page — a reset link comes straight to this address.<br>
      • Want to change it? Use <strong>“Set password”</strong> in the portal header once you’re signed in.
    </div>

    <div style="font-size:13.5px;line-height:1.6;color:${TX2};margin-top:22px">Questions? Just reply to this email or write to <a href="mailto:service@brixbev.com" style="color:${AC}">service@brixbev.com</a>.</div>
  `);

  const text = [
    `${name ? 'Hi ' + name + ',' : 'Hi,'}`,
    '',
    'Your Freshpet service portal account is ready — your live record of every completed service visit with photos, signed reports, and invoices.',
    '',
    `Set your password (one-time link): ${setPasswordUrl}`,
    '',
    `Sign in at: ${portalUrl}`,
    '- Email + password works on its own for everyone.',
    '- "Sign in with Google" is an optional shortcut. If Google gives you trouble, email + password always works by itself.',
    '',
    'WHAT YOU\'LL FIND INSIDE',
    '1. PM service calls — completed visits grouped by invoice, with an Invoice PDF button per invoice.',
    '2. Open any visit — full checklist, technician, readings, photos, the signed service report PDF, and the GPS-stamped sign-off location.',
    '3. Quarterly Reactive — quarterly reactive invoices with per-asset warranty status.',
    '4. Find anything fast — search by store/city/serial/tech, filter by invoice or month.',
    '',
    'RECORDS BEFORE JUNE 1, 2026',
    'Visits completed before 6/1/2026 were handled on our previous system, so their photos and paperwork are not attached in the portal (they show a "Legacy" tag).',
    legacyLink ? `Pre-6/1/2026 photos & paperwork archive: ${legacyLink}` : 'Ask your Alameda Point Beverage Group contact for the archive folder link.',
    '',
    'PASSWORD',
    '- Forgot it? Use "Forgot password?" on the sign-in page.',
    '- Change it any time with "Set password" in the portal header.',
    '',
    'Questions? Reply to this email or write to service@brixbev.com.',
  ].join('\n');

  return { html, text };
}

// ── Password reset ──
export function renderPortalResetEmail({ setPasswordUrl, portalUrl }) {
  const html = shell(`
    <div style="font-size:15px;line-height:1.6">A password reset was requested for your Freshpet service portal account.</div>
    <div style="margin:22px 0;text-align:center">${button(setPasswordUrl, 'Set a new password →')}</div>
    <div style="color:${TX2};font-size:13px;line-height:1.6">This link is one-time and expires. If it stops working, request a new one with “Forgot password?” on the sign-in page at <a href="${esc(portalUrl)}" style="color:${AC}">${esc(portalUrl)}</a>.</div>
    <div style="color:${TX2};font-size:13px;line-height:1.6;margin-top:14px">Didn’t request this? You can safely ignore this email — your password is unchanged.</div>
  `);
  const text = [
    'A password reset was requested for your Freshpet service portal account.',
    '',
    `Set a new password (one-time link): ${setPasswordUrl}`,
    '',
    `If the link stops working, request a new one with "Forgot password?" on the sign-in page: ${portalUrl}`,
    'Didn\'t request this? You can safely ignore this email — your password is unchanged.',
  ].join('\n');
  return { html, text };
}
