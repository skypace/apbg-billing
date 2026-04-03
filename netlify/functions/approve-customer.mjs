import { qboRequest, corsHeaders } from './qbo-helpers.mjs';
import { verifyToken } from './token-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { createSFCustomer } from './sf-helpers.mjs';

const ONBOARD_EMAILS = ['service@brixbev.com', 'invoicing@brixbev.com'];

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const payload = JSON.parse(event.body);
    const {
      displayName, companyName, firstName, lastName,
      phone, email, addressLine1, city, state, zip,
      taxId, resaleCert, paymentMethod, businessType, notes,
    } = payload;

    if (!displayName) return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Display name is required' }) };

    // ── Build QBO Customer payload ──
    const customerPayload = {
      DisplayName: displayName,
      CompanyName: companyName || displayName,
      PrintOnCheckName: companyName || displayName,
    };

    if (firstName) customerPayload.GivenName = firstName;
    if (lastName) customerPayload.FamilyName = lastName;
    if (phone) customerPayload.PrimaryPhone = { FreeFormNumber: phone };
    if (email) customerPayload.PrimaryEmailAddr = { Address: email };

    if (addressLine1) {
      customerPayload.BillAddr = {
        Line1: addressLine1,
        City: city || '',
        CountrySubDivisionCode: state || '',
        PostalCode: zip || '',
      };
      customerPayload.ShipAddr = { ...customerPayload.BillAddr };
    }

    // Build notes with tax/business info
    const noteLines = [];
    if (businessType) noteLines.push(`Business Type: ${businessType}`);
    if (taxId) noteLines.push(`Fed Tax ID: ${taxId}`);
    if (resaleCert) noteLines.push(`CA Resale Cert: ${resaleCert}`);
    if (paymentMethod) noteLines.push(`Payment Method: ${paymentMethod}`);
    if (notes) noteLines.push(notes);
    if (noteLines.length) customerPayload.Notes = noteLines.join(' | ');

    // Set payment terms based on payment method
    // QBO standard terms: 1=Due on receipt, 2=Net 10, 3=Net 15, 4=Net 30, 5=Net 60
    if (paymentMethod) {
      const pm = paymentMethod.toLowerCase();
      if (pm.includes('cod') || pm.includes('receipt')) {
        customerPayload.SalesTermRef = { value: '1' }; // Due on receipt
      } else if (pm.includes('net 30') || pm.includes('net30')) {
        customerPayload.SalesTermRef = { value: '4' }; // Net 30
      } else if (pm.includes('net 15') || pm.includes('net15')) {
        customerPayload.SalesTermRef = { value: '3' }; // Net 15
      }
    }

    // ── Create in QBO ──
    const result = await qboRequest('POST', '/customer', customerPayload);
    const created = result.Customer;

    // ── 2. Create in Service Fusion (if configured) ──
    let sfCustomer = null;
    if (process.env.SF_REFRESH_TOKEN) {
      try {
        sfCustomer = await createSFCustomer({
          customerName: displayName,
          firstName, lastName, phone, email,
          address: addressLine1, city, state, zip,
        });
      } catch (sfErr) {
        console.warn('Service Fusion customer creation failed (non-fatal):', sfErr.message);
      }
    }

    // ── 3. Send confirmation emails ──
    if (process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY) {
      const sfLine = sfCustomer
        ? `<tr><td style="color:#065F46;padding:4px 0;">Service Fusion</td><td style="font-family:monospace;">ID: ${sfCustomer.id || 'Created'}</td></tr>`
        : (process.env.SF_REFRESH_TOKEN ? `<tr><td style="color:#991B1B;padding:4px 0;">Service Fusion</td><td>Failed — check logs</td></tr>` : '');
      const confirmHtml = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#065F46;padding:24px 28px;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;font-size:20px;margin:0;">✓ Customer Created${sfCustomer ? ' in QBO + Service Fusion' : ' in QuickBooks'}</h1>
        </div>
        <div style="padding:24px 28px;border:1px solid #e2e6ed;border-top:0;border-radius:0 0 8px 8px;">
          <div style="background:#D1FAE5;border-radius:6px;padding:16px 20px;">
            <table style="width:100%;font-size:14px;">
              <tr><td style="color:#065F46;font-weight:700;font-size:18px;" colspan="2">${created.DisplayName}</td></tr>
              <tr><td style="color:#065F46;padding:4px 0;">QBO ID</td><td style="font-family:monospace;">${created.Id}</td></tr>
              ${sfLine}
              <tr><td style="color:#065F46;padding:4px 0;">Company</td><td>${created.CompanyName || '—'}</td></tr>
              <tr><td style="color:#065F46;padding:4px 0;">Phone</td><td>${phone || '—'}</td></tr>
              <tr><td style="color:#065F46;padding:4px 0;">Email</td><td>${email || '—'}</td></tr>
              <tr><td style="color:#065F46;padding:4px 0;">Address</td><td>${[addressLine1, city, state, zip].filter(Boolean).join(', ') || '—'}</td></tr>
              ${taxId ? `<tr><td style="color:#065F46;padding:4px 0;">Tax ID</td><td>${taxId}</td></tr>` : ''}
              ${paymentMethod ? `<tr><td style="color:#065F46;padding:4px 0;">Payment</td><td>${paymentMethod}</td></tr>` : ''}
            </table>
          </div>
        </div>
      </div>`;

      for (const to of ONBOARD_EMAILS) {
        try {
          await sendEmail({
            to,
            subject: `✓ New Customer Created: ${created.DisplayName} (QBO #${created.Id})`,
            html: confirmHtml,
          });
        } catch (e) {
          console.warn(`Confirm email to ${to} failed:`, e.message);
        }
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        customer: {
          id: created.Id,
          name: created.DisplayName,
          company: created.CompanyName,
        },
        serviceFusion: sfCustomer ? { id: sfCustomer.id, name: sfCustomer.customer_name } : null,
        message: sfCustomer
          ? `Customer "${created.DisplayName}" created in QBO (ID: ${created.Id}) and Service Fusion`
          : `Customer "${created.DisplayName}" created in QuickBooks (ID: ${created.Id})`,
      }),
    };
  } catch (err) {
    console.error('approve-customer error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}
