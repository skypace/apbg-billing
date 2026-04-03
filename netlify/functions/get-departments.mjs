import { qboQuery, corsHeaders } from './qbo-helpers.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  try {
    const result = await qboQuery(
      `SELECT Id, Name FROM Department WHERE Active = true ORDERBY Name MAXRESULTS 200`
    );
    const departments = (result.QueryResponse?.Department || []).map(d => ({
      id: d.Id,
      name: d.Name,
    }));
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ departments }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
}
