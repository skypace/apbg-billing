import { corsHeaders } from './qbo-helpers.mjs';
import { createToken } from './token-helpers.mjs';
import { sendEmail, SITE_URL } from './email-helpers.mjs';

// Approval recipients for customer/vendor onboarding
const ONBOARD_EMAILS = ['service@brixbev.com', 'invoicing@brixbev.com'];

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const body = JSON.parse(event.body);

    // ── Parse QuestionScout webhook payload ──
    // QuestionScout sends fields as nested objects with type, label, value
    // We extract by matching known field labels
    const fields = flattenFields(body);
    
    const customer = {
      firstName: findField(fields, ['first name', 'what\'s your first name', 'frst name']),
      lastName: findField(fields, ['last name', 'what\'s your last name']),
      phone: findField(fields, ['phone number please', 'phone number', 'phone']),
      email: findField(fields, ['email address']),
      establishmentName: findField(fields, ['establishment', 'name of your establishment', 'what\'s the name of your establishment']),
      legalName: findField(fields, ['legal business name', 'what\'s the legal business name']),
      billingContactName: findField(fields, ['name of billing contact', 'billing contact']),
      billingPhone: findField(fields, ['billing.*phone', 'phone number']),  
      billingEmail: findField(fields, ['billing.*email', 'email address']),
      addressLine1: findField(fields, ['business address line 1', 'address line 1', 'address']),
      city: findField(fields, ['city']),
      state: findField(fields, ['state']),
      zip: findField(fields, ['zip code']),
      sameAddress: findField(fields, ['same as billing', 'business address the same']),
      businessType: findField(fields, ['how is the business organized', 'business organized']),
      taxId: findField(fields, ['fed tax id', 'tax id']),
      resaleCert: findField(fields, ['resale cert', 'resale certificate']),
      paymentMethod: findField(fields, ['how would you like to pay', 'pay for services']),
      ccOnFile: findField(fields, ['pay by credit card', 'credit card on file']),
      ccUseFor: findField(fields, ['use credit card to pay for', 'credit card to pay']),
      willPlaceOrders: findField(fields, ['placing the orders', 'placing orders']),
      submittedAt: new Date().toISOString(),
    };

    // Use establishment name as primary, fall back to legal name
    const displayName = customer.establishmentName || customer.legalName || 
      `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unknown';

    // ── Create approval token (NO credit card data) ──
    const tokenData = { ...customer, displayName, type: 'customer' };
    const token = createToken(tokenData);
    const approveUrl = `${SITE_URL}/customer-approve.html?token=${encodeURIComponent(token)}`;

    // ── Send approval emails ──
    const emailHtml = approvalEmailHtml(customer, displayName, approveUrl);
    
    for (const to of ONBOARD_EMAILS) {
      try {
        await sendEmail({
          to,
          subject: `🆕 New Customer Application: ${displayName} — Review Required`,
          html: emailHtml,
        });
      } catch (e) {
        console.warn(`Failed to send to ${to}:`, e.message);
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        message: `Customer application received for ${displayName}. Approval emails sent.`,
        approveUrl,
      }),
    };
  } catch (err) {
    console.error('onboard-customer error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}

// ── Parse QuestionScout webhook fields ──
function flattenFields(body) {
  const results = [];

  function walk(obj) {
    if (!obj) return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    if (typeof obj === 'object') {
      // QuestionScout field object
      if (obj.label || obj.title || obj.name) {
        const label = (obj.label || obj.title || obj.name || '').toLowerCase().trim();
        const value = obj.value !== undefined ? obj.value : obj.answer;
        if (label && value !== undefined && value !== null) {
          results.push({ label, value: String(value).trim() });
        }
      }
      // Recurse into children, fields, data, responses, etc.
      for (const key of Object.keys(obj)) {
        if (['childrens', 'children', 'fields', 'data', 'responses', 'sections', 'answers'].includes(key)) {
          walk(obj[key]);
        }
      }
      // Also check if the object itself has nested field-like structures
      if (obj.type && obj.value !== undefined) {
        const label = (obj.label || obj.title || obj.name || obj.type || '').toLowerCase().trim();
        if (label) {
          results.push({ label, value: String(obj.value).trim() });
        }
      }
    }
  }

  walk(body);

  // Also handle flat key-value pairs (in case QuestionScout sends simplified format)
  if (typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, val] of Object.entries(body)) {
      if (typeof val === 'string' || typeof val === 'number') {
        results.push({ label: key.toLowerCase().replace(/_/g, ' ').trim(), value: String(val).trim() });
      }
    }
  }

  return results;
}

function findField(fields, patterns) {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'), 'i');
    const match = fields.find(f => regex.test(f.label));
    if (match && match.value) return match.value;
  }
  // Also try simple substring match
  for (const pattern of patterns) {
    const simple = pattern.replace(/[.*]/g, '').toLowerCase();
    const match = fields.find(f => f.label.includes(simple));
    if (match && match.value) return match.value;
  }
  return '';
}

// ── Approval email template ──
function approvalEmailHtml(c, displayName, approveUrl) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#1F4E79;padding:24px 28px;border-radius:8px 8px 0 0;">
      <h1 style="color:#fff;font-size:20px;margin:0;">New Customer Application</h1>
      <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:6px 0 0;">APBG Billing — Customer Onboarding</p>
    </div>
    <div style="padding:24px 28px;border:1px solid #e2e6ed;border-top:0;border-radius:0 0 8px 8px;">
      <h2 style="font-size:1.2rem;color:#1F4E79;margin:0 0 16px;">${displayName}</h2>
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        ${row('Contact', `${c.firstName || ''} ${c.lastName || ''}`.trim())}
        ${row('Phone', c.phone)}
        ${row('Email', c.email)}
        ${row('Legal Name', c.legalName)}
        ${row('Address', [c.addressLine1, c.city, c.state, c.zip].filter(Boolean).join(', '))}
        ${row('Business Type', c.businessType)}
        ${row('Fed Tax ID', c.taxId)}
        ${row('Resale Cert', c.resaleCert)}
        ${row('Payment Method', c.paymentMethod)}
        ${row('CC on File', c.ccOnFile || 'No')}
        ${c.ccUseFor ? row('CC Used For', c.ccUseFor) : ''}
        ${row('Will Place Orders', c.willPlaceOrders)}
        ${row('Billing Contact', c.billingContactName)}
      </table>

      <div style="text-align:center;margin:28px 0 16px;">
        <a href="${approveUrl}" style="display:inline-block;background:#1F4E79;color:#fff;text-decoration:none;padding:14px 40px;border-radius:6px;font-weight:600;font-size:15px;">
          Review & Approve →
        </a>
      </div>
      <p style="text-align:center;font-size:12px;color:#9ca3af;">Click above to review and create this customer in QuickBooks.</p>
    </div>
  </div>`;
}

function row(label, value) {
  if (!value) return '';
  return `<tr><td style="color:#6b7280;padding:6px 0;vertical-align:top;width:140px;">${label}</td><td style="font-weight:500;padding:6px 0;">${value}</td></tr>`;
}
