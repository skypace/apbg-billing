// Temporary: test SF job creation with different field names
import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const results = {};

  // Try different field names for customer
  const fieldTests = [
    { name: 'customer_name only', payload: { customer_name: 'THE MELT - RESQ', description: 'Test job - delete me', status: 'Unscheduled' } },
    { name: 'customer_name + po', payload: { customer_name: 'THE MELT - RESQ', description: 'Test job - delete me', status: 'Unscheduled', po_number: 'RTEST1' } },
  ];

  for (const test of fieldTests) {
    try {
      const res = await sfRequest('POST', '/jobs', test.payload);
      results[test.name] = { success: true, id: res.id, keys: Object.keys(res).slice(0, 15) };
    } catch (e) {
      results[test.name] = { success: false, error: e.message.substring(0, 300) };
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(results, null, 2),
  };
}
