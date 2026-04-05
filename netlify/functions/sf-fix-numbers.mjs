// Find recent SF jobs with R{code} numbers and link to ResQ WOs
// Tries multiple sort/filter approaches to find jobs from last 3 weeks

import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const results = { approaches: [], matches: [], errors: [] };

  // Quick lookup by job ID
  if (qs.jobId) {
    try {
      const job = await sfRequest('GET', `/jobs/${qs.jobId}`);
      return json(job);
    } catch (e) {
      return json({ error: e.message });
    }
  }

  try {
    // Try different API parameters to get recent jobs
    const approaches = [
      { name: 'sort desc', url: '/jobs?per-page=100&sort=-created_at' },
      { name: 'order desc', url: '/jobs?per-page=100&order_by=created_at&order=desc' },
      { name: 'sort id desc', url: '/jobs?per-page=100&sort=-id' },
      { name: 'created after', url: '/jobs?per-page=100&created_after=2026-03-15' },
      { name: 'date filter', url: '/jobs?per-page=100&filter[created_at][gte]=2026-03-15' },
      { name: 'start_date', url: '/jobs?per-page=100&start_date=2026-03-15' },
    ];

    for (const approach of approaches) {
      try {
        const res = await sfRequest('GET', approach.url);
        const jobs = res.items || res.data || [];
        if (jobs.length === 0) {
          results.approaches.push({ name: approach.name, count: 0 });
          continue;
        }

        // Check first and last job dates/IDs to see if sort worked
        const first = jobs[0];
        const last = jobs[jobs.length - 1];
        const info = {
          name: approach.name,
          count: jobs.length,
          firstId: first.id,
          firstCreated: first.created_at,
          firstNumber: first.number,
          lastId: last.id,
          lastCreated: last.created_at,
          lastNumber: last.number,
        };

        // Check if any jobs have R{digits} numbers
        const rJobs = jobs.filter(j => {
          const num = String(j.number || '').trim();
          return /^R\d{5,}/.test(num);
        });
        info.rJobsCount = rJobs.length;
        if (rJobs.length > 0) {
          info.rJobs = rJobs.map(j => ({
            id: j.id,
            number: j.number,
            po: j.po_number,
            customer: j.customer_name,
            status: j.status,
            created: j.created_at,
            desc: (j.description || '').substring(0, 80),
          }));
        }

        results.approaches.push(info);

        // If this approach found R-jobs, add to matches
        if (rJobs.length > 0) {
          for (const j of rJobs) {
            results.matches.push({
              sfJobId: j.id,
              number: String(j.number || '').trim(),
              po: j.po_number,
              customer: j.customer_name,
              status: j.status,
              created: j.created_at,
              desc: (j.description || '').substring(0, 80),
            });
          }
          break; // Found what we need
        }
      } catch (e) {
        results.approaches.push({ name: approach.name, error: e.message.substring(0, 150) });
      }
    }

  } catch (e) {
    results.errors.push(e.message);
  }

  return json(results);
}

function json(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data, null, 2),
  };
}
