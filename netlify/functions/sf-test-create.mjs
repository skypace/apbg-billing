// Temporary: test SF job creation with different field names
import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const results = {};

  // Try different field names for customer
  // Paginate ALL customers to find melt/starbird/resq
  const targets = ['melt', 'starbird', 'resq'];
  const found = [];
  let page = 1;
  let totalScanned = 0;

  while (page <= 50) { // safety limit
    try {
      const res = await sfRequest('GET', `/customers?per-page=100&page=${page}`);
      const items = res.items || res.data || [];
      if (items.length === 0) break;

      totalScanned += items.length;
      for (const c of items) {
        const n = (c.customer_name || '').toLowerCase();
        if (targets.some(t => n.includes(t))) {
          found.push({ id: c.id, name: c.customer_name });
        }
      }
      page++;
    } catch (e) {
      results.paginationError = { page, error: e.message.substring(0, 200) };
      break;
    }
  }

  results.totalScanned = totalScanned;
  results.pagesScanned = page - 1;
  results.matchingCustomers = found;

  const fieldTests = [];

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
