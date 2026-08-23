import { corsHeaders } from './qbo-helpers.mjs';
import { createToken } from './token-helpers.mjs';
import { sendEmail, approvalEmailHtml, APPROVAL_EMAIL, SITE_URL } from './email-helpers.mjs';

// process-inbound — the AP tool's PDF drop (public/index.html).
//
// Drop a vendor bill on /billing/, it is OCR'd by Claude and you land on
// approve.html with a signed token holding the extracted data.
//
// ⚠ THE EMAIL-WEBHOOK PATHS WERE REMOVED (2026-08-23). This function was
// originally written to also receive forwarded email — a SendGrid/Mailgun
// multipart body, or JSON with an `attachments[]` array — with no signature
// verification at all, which its own SECURITY TODO acknowledged. Nothing ever
// pointed at those paths (checked against all 10 live Resend webhooks), and
// emailed bills now go through bill-email-intake.mjs, which IS Svix-verified
// and lands a reviewable draft instead of minting an approval token. Keeping
// unverified intake code around for a caller that does not exist is pure
// attack surface: a stranger could POST a fabricated invoice and cause a real
// approval email carrying a real signed token.
//
// What is left is the ONE live caller: the browser upload from
// public/index.html ({ fileData, mediaType, submittedBy }).
//
// ⚠ STILL OPEN, and deliberately not changed here: that browser path is
// unauthenticated, because public/index.html carries no session (unlike
// approve/setup/control/dashboard, which all use auth.js). Adding a login to
// the AP tool's front door is a change to a daily driver and belongs to
// whoever owns that workflow, not to this pass. The payload cap below limits
// the damage a stranger can do to wasted OCR spend.

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('application/json')) {
      return {
        statusCode: 415,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Send JSON: { fileData, mediaType }' }),
      };
    }

    const body = JSON.parse(event.body || '{}');
    const attachmentData = body.fileData;
    const attachmentType = body.mediaType || 'application/pdf';
    const from = body.submittedBy || 'web-upload';
    const subject = body.subject || 'Vendor Bill';

    if (!attachmentData) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'No file to scan — drop a PDF or an image.' }),
      };
    }

    // A cap on what one unauthenticated request can cost us at the OCR
    // provider. Real vendor invoices are well under this; anything larger is
    // either a mistake or someone playing.
    if (String(attachmentData).length > 14_000_000) {   // ~10 MB decoded
      return {
        statusCode: 413,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'That file is too large to scan — 10 MB is the limit.' }),
      };
    }

    const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!ALLOWED.includes(attachmentType)) {
      return {
        statusCode: 415,
        headers: corsHeaders(),
        body: JSON.stringify({ error: `Can't scan a ${attachmentType} — send a PDF or an image.` }),
      };
    }

    // ── 1. Scan the bill with Claude ──
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
      };
    }

    const isPdf = attachmentType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: attachmentData } }
      : { type: 'image', source: { type: 'base64', media_type: attachmentType, data: attachmentData } };

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: `You extract structured data from vendor bills/invoices. Return ONLY valid JSON with no markdown, no backticks, no preamble. The JSON must have this exact structure:

{
  "vendorName": "string",
  "billNumber": "string or null",
  "billDate": "string or null (YYYY-MM-DD)",
  "dueDate": "string or null (YYYY-MM-DD)",
  "lineItems": [
    { "description": "string", "quantity": number, "unitCost": number, "category": "equipment" or "service" }
  ],
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "notes": "string or null — PO numbers, job references, work order numbers (ResQ or Service Fusion IDs)"
}

Rules:
- If a line item has no separate quantity, use 1
- If a line item shows only a total with no unit price, set unitCost to the total and quantity to 1
- Category: physical goods, parts, materials = "equipment". Labor, service, installation = "service"
- Extract ALL line items, don't combine them
- Look for any job numbers, work order numbers, PO numbers and include in notes
- Return ONLY the JSON`,
        messages: [
          { role: 'user', content: [contentBlock, { type: 'text', text: 'Extract all bill data from this document. Return only JSON.' }] },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error: ${claudeRes.status} ${err}`);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const extracted = JSON.parse(cleaned);

    // ── 2. Create approval token ──
    const billData = {
      ...extracted,
      sourceEmail: from,
      sourceSubject: subject,
      receivedAt: new Date().toISOString(),
    };

    const token = createToken(billData);
    const approveUrl = `${SITE_URL}/approve.html?token=${encodeURIComponent(token)}`;

    // ── 3. Send approval email (if email service configured) ──
    let emailSent = false;
    if (process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY) {
      try {
        const replyTo = typeof from === 'string' && from.includes('@') ? from : undefined;
        await sendEmail({
          to: APPROVAL_EMAIL,
          subject: `📄 New Bill: ${extracted.vendorName || 'Unknown Vendor'} — $${(extracted.total || 0).toFixed(2)} — Review Required`,
          html: approvalEmailHtml(billData, approveUrl),
          replyTo,
        });
        emailSent = true;
      } catch (emailErr) {
        console.warn('Email send failed (non-fatal):', emailErr.message);
      }
    }

    // ── 4. Return success ──
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        emailSent,
        message: emailSent
          ? `Bill scanned and approval email sent to ${APPROVAL_EMAIL}`
          : `Bill scanned — open the approval link to review`,
        extracted,
        approveUrl,
      }),
    };
  } catch (err) {
    console.error('process-inbound error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}
