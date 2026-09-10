import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================================
// meltrequests@alamedapointbg.com → Whitney, Anthony, Sky
//
// Flow:  Resend Inbound → this webhook → Resend Send API
//        (also logs every inbound to melt_request_forwards)
// ============================================================

const FORWARD_RECIPIENTS = [
  { name: "Whitney Grandell", email: "whitney@alamedasoda.com" },
  { name: "Anthony V",        email: "anthonyv@brixbev.com"    },
  { name: "Sky Pace",         email: "skypace@brixbev.com"     },
];

const FROM_ADDRESS = "Melt Requests <meltrequests@alamedapointbg.com>";

const RESEND_API_KEY       = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SHARED_SECRET = Deno.env.get("INBOUND_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- helpers ----------

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Normalize the inbound payload. Resend's inbound webhook currently sends
// { type: 'email.received', data: { from, to, subject, text, html, attachments, ... } }.
// We stay flexible so a Cloudflare Email Worker or other forwarder can also POST here
// as long as it sends a similar shape.
function parseInbound(payload: any) {
  const data = payload?.data ?? payload ?? {};

  const fromRaw = data.from ?? data.sender ?? {};
  const fromEmail =
    typeof fromRaw === "string" ? fromRaw : (fromRaw.email ?? fromRaw.address ?? "");
  const fromName =
    typeof fromRaw === "string" ? "" : (fromRaw.name ?? "");

  let toAddress = "";
  const toRaw = data.to ?? data.recipient ?? [];
  if (Array.isArray(toRaw) && toRaw.length) {
    const first = toRaw[0];
    toAddress = typeof first === "string" ? first : (first.email ?? "");
  } else if (typeof toRaw === "string") {
    toAddress = toRaw;
  }

  return {
    fromEmail,
    fromName,
    toAddress,
    subject:       data.subject ?? "(no subject)",
    bodyText:      data.text ?? "",
    bodyHtml:      data.html ?? "",
    attachments:   Array.isArray(data.attachments) ? data.attachments : [],
    resendId:      data.id ?? payload?.id ?? null,
  };
}

function buildForwardedHtml(parsed: ReturnType<typeof parseInbound>): string {
  const senderDisplay = parsed.fromName
    ? `${parsed.fromName} &lt;${parsed.fromEmail}&gt;`
    : parsed.fromEmail;

  const header = `
    <div style="background:#fff5ef;border-left:4px solid #ff6b35;padding:12px 16px;margin-bottom:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#2b2a29;">
      <div><strong>Forwarded from meltrequests@alamedapointbg.com</strong></div>
      <div style="margin-top:6px;color:#6b6663;">From: ${senderDisplay}</div>
      <div style="color:#6b6663;">Subject: ${escapeHtml(parsed.subject)}</div>
      <div style="color:#6b6663;font-size:12px;margin-top:4px;">Reply directly to respond to the original sender.</div>
    </div>
  `;

  if (parsed.bodyHtml) return header + parsed.bodyHtml;

  const textAsHtml = escapeHtml(parsed.bodyText).replace(/\n/g, "<br>");
  return header + `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#2b2a29;">${textAsHtml}</div>`;
}

function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function forwardViaResend(
  parsed: ReturnType<typeof parseInbound>,
): Promise<{ id: string | null; error: string | null }> {
  const body = {
    from: FROM_ADDRESS,
    to: FORWARD_RECIPIENTS.map((r) => r.email),
    reply_to: parsed.fromEmail || undefined,
    subject: `[Melt Requests] ${parsed.subject}`,
    html: buildForwardedHtml(parsed),
    text: parsed.bodyText
      ? `---- Forwarded from meltrequests@alamedapointbg.com ----\nFrom: ${parsed.fromName ? parsed.fromName + " <" + parsed.fromEmail + ">" : parsed.fromEmail}\nSubject: ${parsed.subject}\n\n${parsed.bodyText}`
      : undefined,
    attachments: parsed.attachments?.length
      ? parsed.attachments.map((a: any) => ({
          filename: a.filename ?? a.name ?? "attachment",
          content:  a.content ?? a.data,
          content_type: a.content_type ?? a.contentType,
        }))
      : undefined,
  };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(body),
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { id: null, error: `Resend ${res.status}: ${JSON.stringify(result)}` };
    }
    return { id: result?.id ?? null, error: null };
  } catch (err) {
    return { id: null, error: (err as Error).message };
  }
}

// ---------- handler ----------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  // Shared-secret check (Resend can include a custom header, or you can pass
  // ?secret=... on the webhook URL)
  if (WEBHOOK_SHARED_SECRET) {
    const headerSecret = req.headers.get("x-webhook-secret");
    const url          = new URL(req.url);
    const querySecret  = url.searchParams.get("secret");
    if (headerSecret !== WEBHOOK_SHARED_SECRET && querySecret !== WEBHOOK_SHARED_SECRET) {
      return json(401, { error: "Unauthorized" });
    }
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON payload" });
  }

  const parsed = parseInbound(payload);

  // Log the inbound row first (pending) so we never lose an email even if forwarding fails.
  const { data: logRow, error: logErr } = await supabase
    .from("melt_request_forwards")
    .insert({
      from_email:        parsed.fromEmail,
      from_name:         parsed.fromName,
      to_address:        parsed.toAddress,
      subject:           parsed.subject,
      body_text:         parsed.bodyText,
      body_html:         parsed.bodyHtml,
      attachment_count:  parsed.attachments.length,
      resend_inbound_id: parsed.resendId,
      forwarded_to:      FORWARD_RECIPIENTS.map((r) => r.email),
      forward_status:    "pending",
      raw_payload:       payload,
    })
    .select("id")
    .single();

  if (logErr) {
    console.error("Failed to log inbound:", logErr);
  }

  const result = await forwardViaResend(parsed);

  if (logRow?.id) {
    await supabase
      .from("melt_request_forwards")
      .update({
        forward_status:     result.error ? "failed" : "forwarded",
        forward_resend_ids: result.id ? [result.id] : null,
        error_message:      result.error,
      })
      .eq("id", logRow.id);
  }

  if (result.error) {
    console.error("Forward failed:", result.error);
    return json(500, { ok: false, error: result.error, log_id: logRow?.id });
  }

  return json(200, {
    ok: true,
    forwarded_to: FORWARD_RECIPIENTS.map((r) => r.email),
    resend_id: result.id,
    log_id: logRow?.id,
  });
});
