// Temporary diagnostic: fetch a SF job to see field names
import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  try {
    // Get first page of jobs
    const jobs = await sfRequest('GET', '/jobs?per-page=5');

    // Also try to see what fields exist on a job
    const sample = Array.isArray(jobs) ? jobs[0] : (jobs.items || jobs.data || [])[0];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        type: typeof jobs,
        isArray: Array.isArray(jobs),
        topKeys: jobs ? Object.keys(jobs).slice(0, 10) : [],
        sampleJob: sample || null,
        sampleKeys: sample ? Object.keys(sample) : [],
      }, null, 2),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
}
