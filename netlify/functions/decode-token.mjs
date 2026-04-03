import { corsHeaders } from './qbo-helpers.mjs';
import { verifyToken } from './token-helpers.mjs';

// Called by the approval page to decode the bill data from the URL token
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  try {
    const token = event.queryStringParameters?.token;
    if (!token) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'No token provided' }) };
    }

    const data = verifyToken(decodeURIComponent(token));

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ success: true, billData: data }),
    };
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Invalid or expired approval link: ' + err.message }),
    };
  }
}
