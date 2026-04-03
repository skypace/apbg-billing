import { qboRequest, corsHeaders } from './qbo-helpers.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const { displayName, companyName, email, phone } = JSON.parse(event.body);

    if (!displayName) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'displayName is required' }),
      };
    }

    const vendorPayload = {
      DisplayName: displayName,
    };

    if (companyName) vendorPayload.CompanyName = companyName;
    if (email) vendorPayload.PrimaryEmailAddr = { Address: email };
    if (phone) vendorPayload.PrimaryPhone = { FreeFormNumber: phone };

    const result = await qboRequest('POST', '/vendor', vendorPayload);
    const vendor = result.Vendor;

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        vendor: {
          id: vendor.Id,
          name: vendor.DisplayName,
          company: vendor.CompanyName || vendor.DisplayName,
        },
      }),
    };
  } catch (err) {
    console.error('create-vendor error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}
