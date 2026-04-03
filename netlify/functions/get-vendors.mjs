import { qboQuery, corsHeaders } from './qbo-helpers.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  try {
    const result = await qboQuery(
      "SELECT Id, DisplayName, CompanyName FROM Vendor WHERE Active = true ORDERBY DisplayName MAXRESULTS 500"
    );

    const vendors = (result.QueryResponse?.Vendor || []).map(v => ({
      id: v.Id,
      name: v.DisplayName,
      company: v.CompanyName || v.DisplayName,
    }));

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ vendors }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}
