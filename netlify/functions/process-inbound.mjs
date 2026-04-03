import { corsHeaders } from './qbo-helpers.mjs';
import { createToken } from './token-helpers.mjs';
import { sendEmail, approvalEmailHtml, APPROVAL_EMAIL, SITE_URL } from './email-helpers.mjs';

// This function receives inbound emails via webhook from your email service
// (SendGrid Inbound Parse, Mailgun Routes, or custom forwarding)
//
// Expected POST body (JSON):
// {
//   "from": "sender@example.com",
//   "subject": "Invoice 55973",
//   "text": "...",
//   "attachments": [{ "filename": "inv.pdf", "content": "base64...", "contentType": "application/pdf" }]
// }
//
// Also accepts SendGrid Inbound Parse multipart format

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    let from, subject, attachmentData, attachmentType, bodyText;

    const contentType = event.headers['content-type'] || '';

    if (contentType.includes('application/json')) {
      // ── JSON format (custom forwarder or direct POST) ──
      const body = JSON.parse(event.body);
      from = body.from || 'unknown';
      subject = body.subject || 'Vendor Bill';
      bodyText = body.text || body.body || '';

      if (body.attachments && body.attachments.length > 0) {
        const att = body.attachments[0];
        attachmentData = att.content; // base64
        attachmentType = att.contentType || att.content_type || 'application/pdf';
      } else if (body.fileData) {
        // Direct upload format (from web form)
        attachmentData = body.fileData;
        attachmentType = body.mediaType || 'application/pdf';
        from = body.submittedBy || from;
      }
    } else if (contentType.includes('multipart/form-data')) {
      // ── SendGrid / Mailgun multipart format ──
      // Parse the basic fields from the encoded body
      const params = new URLSearchParams(event.body);
      from = params.get('from') || params.get('sender') || 'unknown';
      subject = params.get('subject') || 'Vendor Bill';
      bodyText = params.get('text') || '';

      // Attachments in multipart come as separate fields
      // SendGrid: attachment1, attachment2, etc.
      // For simplicity, we'll handle the JSON envelope format
      const attachInfo = params.get('attachment-info');
      if (attachInfo) {
        // SendGrid format — attachment content is in separate fields
        // The actual parsing depends on the multipart structure
        // For production, use a proper multipart parser
      }
    }

    if (!attachmentData) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'No bill attachment found in the email' }),
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
