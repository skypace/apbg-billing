import { qboQuery, corsHeaders } from './qbo-helpers.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  try {
    let all = [];
    let start = 1;
    while (true) {
      const result = await qboQuery(
        `SELECT Id, DisplayName FROM Customer WHERE Active = true ORDERBY DisplayName STARTPOSITION ${start} MAXRESULTS 500`
      );
      const batch = result.QueryResponse?.Customer || [];
      all = all.concat(batch);
      if (batch.length < 500) break;
      start += 500;
    }
    const customers = all.map(c => {
      const n = c.DisplayName || '';
      let brand = '';
      if (n.toUpperCase().includes('MELT')) brand = 'The Melt';
      else if (n.toUpperCase().includes('STARBIRD')) brand = 'Starbird';
      return { id: c.Id, name: c.DisplayName, brand };
    });
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ customers }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
}
