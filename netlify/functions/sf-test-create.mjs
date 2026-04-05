// Temporary: test SF job creation with different field names
import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const results = {};

  // Try different field names for customer
  // Look up customers by known IDs
  for (const [label, id] of [['melt', 408972], ['starbird', 408973]]) {
    try {
      const c = await sfRequest('GET', `/customers/${id}`);
      results[label] = {
        id: c.id,
        customer_name: c.customer_name,
        keys: Object.keys(c).slice(0, 20),
      };
    } catch (e) {
      results[label] = { error: e.message.substring(0, 200) };
    }
  }

  // Now try creating a job with the exact name from the API
  const meltName = results.melt?.customer_name;
  if (meltName) {
    try {
      const job = await sfRequest('POST', '/jobs', {
        customer_name: meltName,
        description: 'SYNC TEST — delete me',
        status: 'Unscheduled',
        po_number: 'RTEST999',
      });
      results.createTest = { success: true, jobId: job.id, jobNumber: job.number };
    } catch (e) {
      results.createTest = { success: false, error: e.message.substring(0, 300) };
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
