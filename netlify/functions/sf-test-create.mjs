// Temporary: test SF job creation with different field names
import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const results = {};

  // Try different field names for customer
  // First: search for customers matching 'melt' and 'starbird'
  try {
    const allCusts = await sfRequest('GET', '/customers?per-page=500');
    const items = allCusts.items || allCusts.data || (Array.isArray(allCusts) ? allCusts : []);
    const relevant = items.filter(c => {
      const n = (c.customer_name || c.name || '').toLowerCase();
      return n.includes('melt') || n.includes('starbird') || n.includes('resq');
    });
    results.matchingCustomers = relevant.map(c => ({
      id: c.id,
      name: c.customer_name || c.name,
      parent: c.parent_customer || c.parent_customer_name || null,
    }));
  } catch (e) {
    results.customerSearch = { error: e.message.substring(0, 200) };
  }

  const fieldTests = [
    // No job creation tests for now — just finding customer names
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
