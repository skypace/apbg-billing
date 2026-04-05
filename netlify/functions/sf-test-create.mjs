// Temporary: test SF job creation with different field names
import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const results = {};

  // Try different field names for customer
  // 1. Get first page of customers to see sample + total
  try {
    const page1 = await sfRequest('GET', '/customers?per-page=50');
    const items = page1.items || page1.data || [];
    const meta = page1._meta || {};
    results.customerMeta = { total: meta.total, perPage: meta.per_page, pages: meta.last_page };
    results.sampleCustomer = items[0] ? { id: items[0].id, name: items[0].customer_name, keys: Object.keys(items[0]).slice(0, 15) } : null;
  } catch (e) {
    results.page1 = { error: e.message.substring(0, 200) };
  }

  // 2. Search for melt/starbird using q parameter
  for (const term of ['melt', 'starbird', 'RESQ']) {
    try {
      const res = await sfRequest('GET', `/customers?q=${encodeURIComponent(term)}&per-page=10`);
      const items = res.items || res.data || [];
      results[`search_${term}`] = items.map(c => ({ id: c.id, name: c.customer_name })).slice(0, 5);
    } catch (e) {
      results[`search_${term}`] = { error: e.message.substring(0, 200) };
    }
  }

  // 3. Try fetching customer by the IDs user gave
  for (const id of [408972, 408973]) {
    try {
      const c = await sfRequest('GET', `/customers/${id}`);
      results[`id_${id}`] = { name: c.customer_name };
    } catch (e) {
      results[`id_${id}`] = { error: '404 - not found' };
    }
  }

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
