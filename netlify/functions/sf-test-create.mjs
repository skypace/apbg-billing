// Temp: test SF job creation with correct customer names
import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const results = {};

  // Test creating a job for THE MELT RESQ
  try {
    const job = await sfRequest('POST', '/jobs', {
      customer_name: 'THE MELT RESQ',
      description: 'SYNC TEST - delete me',
      status: 'Unscheduled',
      po_number: 'RTEST999',
    });
    results.meltTest = { success: true, jobId: job.id, jobNumber: job.number, keys: Object.keys(job).slice(0, 10) };
  } catch (e) {
    results.meltTest = { success: false, error: e.message.substring(0, 400) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(results, null, 2),
  };
}
