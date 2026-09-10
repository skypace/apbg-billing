import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// Melt Equipment Portal — Welcome Email
//
// Pipeline: Dashboard → this function → Resend API
// (Matches the same Resend pipeline that sends payment receipts,
//  approval emails, and equipment request notifications.)
//
// Sender:   alerts@alamedapointbg.com  (verified in the Resend account
//           used by the melt-dashboard Netlify site)
// Reply-To: meltrequests@alamedapointbg.com
//
// Required Supabase Edge Function secret:
//   RESEND_API_KEY   (reuse the same key the melt-dashboard site uses)
//
// Invoke:
//   POST /functions/v1/send-melt-welcome
//   Authorization: Bearer <service_role_key>
//   Body: { email, first_name, username, temp_password,
//           portal_url?, user_guide_url?, auth_user_id?, triggered_by? }
// ============================================================

const FROM_ADDRESS  = "The Melt Equipment Portal <alerts@alamedapointbg.com>";
const REPLY_TO      = "meltrequests@alamedapointbg.com";
const DEFAULT_PORTAL_URL      = "https://melt-dashboard.netlify.app";
const DEFAULT_USER_GUIDE_URL  = "https://melt-dashboard.netlify.app/guide";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SVC   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SVC);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Vars {
  firstName: string;
  username: string;
  password: string;
  portalUrl: string;
  userGuideUrl: string;
}

function renderHtml(v: Vars): string {
  return WELCOME_HTML
    .replaceAll("{{FIRST_NAME}}",     escapeHtml(v.firstName))
    .replaceAll("{{USERNAME}}",       escapeHtml(v.username))
    .replaceAll("{{PASSWORD}}",       escapeHtml(v.password))
    .replaceAll("{{PORTAL_URL}}",     escapeHtml(v.portalUrl))
    .replaceAll("{{USER_GUIDE_URL}}", escapeHtml(v.userGuideUrl));
}

function renderText(v: Vars): string {
  return [
    `Hi ${v.firstName},`,
    ``,
    `Your account for The Melt Equipment Portal — hosted by Alameda Point Beverage Group — is ready.`,
    ``,
    `Log in: ${v.portalUrl}`,
    `User guide: ${v.userGuideUrl}`,
    ``,
    `Username: ${v.username}`,
    `Password: ${v.password}`,
    `(You'll be prompted to change your password on first login.)`,
    ``,
    `What you can do in the portal:`,
    `  - Submit equipment requests, check rentals, request moves between stores`,
    `  - Browse Alameda Equipment Storage inventory and request releases`,
    `  - Track POs & shipments with live carrier data, ETAs, and BOLs`,
    `  - View store openings, install dates, and grand opening timelines`,
    `  - Review installed equipment by store with serials and warranties`,
    `  - Access job drawings, equipment layouts, and spec sheets`,
    `  - Follow Melt installs + RESQ jobs assigned to Alameda Soda`,
    `  - Review and digitally approve store orders against contract pricing`,
    `  - View invoices, review job costs, and manage your payment plan`,
    ``,
    `Need help? meltrequests@alamedapointbg.com`,
    ``,
    `— Alameda Point Beverage Group`,
  ].join("\n");
}

async function sendViaResend(toEmail: string, html: string, text: string): Promise<{ id: string | null; error: string | null }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:     FROM_ADDRESS,
        to:       [toEmail],
        reply_to: REPLY_TO,
        subject:  "Welcome to The Melt Equipment Portal",
        html,
        text,
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) return { id: null, error: `Resend ${res.status}: ${JSON.stringify(result)}` };
    return { id: result?.id ?? null, error: null };
  } catch (err) {
    return { id: null, error: (err as Error).message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  if (!RESEND_API_KEY) {
    return json(500, { error: "RESEND_API_KEY not configured as Supabase edge function secret." });
  }

  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON payload" }); }

  const recipientEmail = String(body.email ?? "").trim();
  const username       = String(body.username ?? body.email ?? "").trim();
  const tempPassword   = String(body.temp_password ?? body.password ?? "").trim();
  const firstName      = String(body.first_name ?? body.name ?? "there").trim();
  const portalUrl      = String(body.portal_url ?? DEFAULT_PORTAL_URL).trim();
  const userGuideUrl   = String(body.user_guide_url ?? DEFAULT_USER_GUIDE_URL).trim();
  const authUserId     = body.auth_user_id ?? null;
  const triggeredBy    = String(body.triggered_by ?? "dashboard").trim();

  if (!recipientEmail) return json(400, { error: "email is required" });
  if (!tempPassword)   return json(400, { error: "temp_password is required" });

  const { data: logRow, error: logErr } = await supabase
    .from("melt_welcome_sends")
    .insert({
      auth_user_id:     authUserId,
      recipient_email:  recipientEmail,
      recipient_name:   firstName,
      username:         username,
      portal_url:       portalUrl,
      user_guide_url:   userGuideUrl,
      from_address:     "alerts@alamedapointbg.com",
      reply_to:         REPLY_TO,
      status:           "pending",
      triggered_by:     triggeredBy,
      request_meta:     { portal_url: portalUrl, user_guide_url: userGuideUrl, provider: "resend" },
    })
    .select("id")
    .single();
  if (logErr) console.error("Failed to log welcome send:", logErr);

  const html = renderHtml({ firstName, username, password: tempPassword, portalUrl, userGuideUrl });
  const text = renderText({ firstName, username, password: tempPassword, portalUrl, userGuideUrl });

  const result = await sendViaResend(recipientEmail, html, text);

  if (logRow?.id) {
    await supabase
      .from("melt_welcome_sends")
      .update({
        status:         result.error ? "failed" : "sent",
        ses_message_id: result.id,       // reused field; holds Resend message id
        error_message:  result.error,
      })
      .eq("id", logRow.id);
  }

  if (result.error) {
    console.error("Resend send failed:", result.error);
    return json(500, { ok: false, error: result.error, log_id: logRow?.id });
  }

  return json(200, {
    ok: true,
    recipient: recipientEmail,
    resend_id: result.id,
    log_id: logRow?.id,
  });
});

const WELCOME_HTML = `<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"UTF-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
<title>Welcome to The Melt Equipment Portal</title>
</head>
<body style=\"margin:0; padding:0; background-color:#f4f1ec; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#2b2a29;\">
  <div style=\"display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;\">Your access to The Melt Equipment Portal is ready — log in to manage equipment, shipments, and store setup.</div>
  <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background-color:#f4f1ec;\">
    <tr><td align=\"center\" style=\"padding:32px 16px;\">
      <table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:600px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.06);\">
        <tr><td style=\"background-color:#ff6b35; padding:32px 32px 28px 32px; text-align:left;\"><div style=\"color:#ffffff; font-size:13px; letter-spacing:1.5px; text-transform:uppercase; font-weight:700; margin-bottom:8px;\">The Melt &nbsp;×&nbsp; Alameda Point Beverage Group</div><div style=\"color:#ffffff; font-size:28px; font-weight:800; line-height:1.2; letter-spacing:-0.5px;\">Welcome to the Melt<br>Equipment Portal</div></td></tr>
        <tr><td style=\"height:6px; background: linear-gradient(90deg, #ff6b35 0%, #ffb347 50%, #ffd56b 100%); font-size:0; line-height:0;\">&nbsp;</td></tr>
        <tr><td style=\"padding:32px 32px 8px 32px;\"><p style=\"margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#2b2a29;\">Hi <strong>{{FIRST_NAME}}</strong>,</p><p style=\"margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#2b2a29;\">Your account for <strong>The Melt Equipment Portal</strong> — hosted by Alameda Point Beverage Group — has been set up. This portal is your command center for tracking equipment orders, shipments, installs, and service activity across all Melt locations.</p></td></tr>
        <tr><td style=\"padding:8px 32px 24px 32px;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background-color:#fff5ef; border:1px solid #ffd5bf; border-radius:10px;\"><tr><td style=\"padding:20px 24px;\"><div style=\"font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#ff6b35; margin-bottom:12px;\">Your Login Credentials</div><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td style=\"padding:6px 0; font-size:14px; color:#6b6663; width:110px;\">Username</td><td style=\"padding:6px 0; font-size:15px; color:#2b2a29; font-family: 'SF Mono', Menlo, Consolas, monospace; font-weight:600;\">{{USERNAME}}</td></tr><tr><td style=\"padding:6px 0; font-size:14px; color:#6b6663;\">Password</td><td style=\"padding:6px 0; font-size:15px; color:#2b2a29; font-family: 'SF Mono', Menlo, Consolas, monospace; font-weight:600;\">{{PASSWORD}}</td></tr></table><p style=\"margin:14px 0 0 0; font-size:12px; line-height:1.5; color:#8a6a55;\">You'll be prompted to change your password on first login.</p></td></tr></table></td></tr>
        <tr><td style=\"padding:0 32px 24px 32px;\" align=\"center\"><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td style=\"padding:0 6px 10px 0;\"><a href=\"{{PORTAL_URL}}\" style=\"display:inline-block; background-color:#ff6b35; color:#ffffff; padding:14px 28px; text-decoration:none; border-radius:8px; font-size:15px; font-weight:700; letter-spacing:0.3px;\">Log In to Portal →</a></td><td style=\"padding:0 0 10px 6px;\"><a href=\"{{USER_GUIDE_URL}}\" style=\"display:inline-block; background-color:#ffffff; color:#ff6b35; padding:13px 26px; text-decoration:none; border-radius:8px; font-size:15px; font-weight:700; letter-spacing:0.3px; border:2px solid #ff6b35;\">User Guide</a></td></tr></table></td></tr>
        <tr><td style=\"padding:0 32px;\"><div style=\"height:1px; background-color:#eee4d9; font-size:0; line-height:0;\">&nbsp;</div></td></tr>
        <tr><td style=\"padding:28px 32px 8px 32px;\"><div style=\"font-size:12px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:#ff6b35; margin-bottom:12px;\">What You Can Do in the Portal</div><div style=\"font-size:18px; font-weight:700; color:#2b2a29; margin-bottom:18px; line-height:1.3;\">Everything equipment, in one place.</div></td></tr>
        <tr><td style=\"padding:0 32px 16px 32px;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">
          <tr><td style=\"padding:10px 0; vertical-align:top; width:40px;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">🔧</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Equipment Requests &amp; Store Moves</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Submit service, replacement, or add-on requests. Check active rentals and request equipment moves between stores. Tickets flow directly to dispatch.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">🏭</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Alameda Equipment Storage</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Browse available inventory at our Alameda storage location, check what's in stock, and request releases for upcoming store needs.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">📦</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Track POs &amp; Shipments</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Real-time visibility into purchase orders, carrier tracking, ETAs, and BOL documents for every inbound shipment.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">🏪</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Store Openings &amp; Timelines</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Construction start dates, install windows, grand openings, and progress tracking across the entire new-store pipeline.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">🧰</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Installed Equipment by Store</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Complete asset list per location — model, serial, warranty status, and install date at your fingertips.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">📐</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Job Drawings &amp; Equipment Specs</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">View and download kitchen drawings, equipment layouts, cut sheets, and manufacturer spec documents for any piece of equipment.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">📊</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Jobs &amp; RESQ Work Orders</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Follow every Melt install from procurement through punch list — plus review RESQ jobs dispatched to Alameda Soda, with photos, files, and live status updates.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">📋</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Store Order Review &amp; Approval</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Review line-item pricing against your contract before invoicing, then digitally sign and approve — all in one place.</div></td></tr>
          <tr><td style=\"padding:10px 0; vertical-align:top;\"><div style=\"width:32px; height:32px; background-color:#fff5ef; border-radius:8px; text-align:center; line-height:32px; font-size:16px; color:#ff6b35;\">💰</div></td><td style=\"padding:10px 0 10px 12px; vertical-align:top;\"><div style=\"font-size:15px; font-weight:700; color:#2b2a29; margin-bottom:2px;\">Invoices, Job Costs &amp; Payment Plan</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">View and print invoices, review job costs line-by-line, and manage your account payment plan — balances, milestones, and payment history all visible.</div></td></tr>
        </table></td></tr>
        <tr><td style=\"padding:16px 32px 32px 32px;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background-color:#f4f1ec; border-radius:10px;\"><tr><td style=\"padding:18px 20px;\"><div style=\"font-size:14px; font-weight:700; color:#2b2a29; margin-bottom:4px;\">Need help?</div><div style=\"font-size:14px; color:#6b6663; line-height:1.5;\">Reach us at <a href=\"mailto:meltrequests@alamedapointbg.com\" style=\"color:#ff6b35; text-decoration:none; font-weight:600;\">meltrequests@alamedapointbg.com</a> or reply to this email and we'll get right back to you.</div></td></tr></table></td></tr>
        <tr><td style=\"background-color:#2b2a29; padding:22px 32px; text-align:center;\"><div style=\"color:#ffffff; font-size:13px; font-weight:700; letter-spacing:0.5px; margin-bottom:4px;\">Alameda Point Beverage Group</div><div style=\"color:#a8a29e; font-size:12px; line-height:1.5;\">Operating The Melt Equipment Program on behalf of Fish Six / The Melt</div><div style=\"color:#6b6663; font-size:11px; margin-top:10px;\">© 2026 Alameda Point Beverage Group, Inc. All rights reserved.</div></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
