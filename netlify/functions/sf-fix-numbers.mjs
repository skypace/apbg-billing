// Scan SF jobs for pre-existing R{code} matches
// GET ?customer=melt     — scan THE MELT RESQ jobs
// GET ?customer=starbird — scan STARBIRD CHICKEN: RESQ jobs
// GET ?customer=all      — scan both (default)

import { sfRequest } from './sf-helpers.mjs';

const CUSTOMERS = {
  melt: 'THE MELT RESQ',
  starbird: 'STARBIRD CHICKEN: RESQ',
};

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const customerFilter = qs.customer || 'all';
  const results = { customerFilter, matches: [], mapped: [], errors: [] };

  // Quick mode: fetch specific job by ID
  if (qs.jobId) {
    try {
      const job = await sfRequest('GET', `/jobs/${qs.jobId}`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(job, null, 2),
      };
    } catch (e) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: e.message }),
      };
    }
  }

  try {
    // Load mapping
    const { getStore: createStore } = await import('@netlify/blobs');
    const store = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    const mappingRaw = await store.get('wo-mapping');
    const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};
    const mappedSfIds = new Set(Object.values(mapping).map(m => String(m.sfJobId)));
    results.mappedCount = mappedSfIds.size;

    // Scan jobs page by page, filter by customer name in results
    const targetNames = customerFilter === 'all'
      ? Object.values(CUSTOMERS)
      : [CUSTOMERS[customerFilter] || customerFilter];

    let page = 1;
    let scanned = 0;
    let found = 0;

    const maxPages = parseInt(qs.pages || '3');
    while (page <= maxPages) {
      try {
        const res = await sfRequest('GET', `/jobs?per-page=100&page=${page}`);
        const jobs = res.items || res.data || [];
        if (jobs.length === 0) { results.endOfJobs = true; break; }

        scanned += jobs.length;

        for (const job of jobs) {
          const custName = (job.customer_name || '').toUpperCase();
          // Only look at jobs for our target customers
          if (!targetNames.some(t => custName.includes(t.toUpperCase()))) continue;

          found++;
          const num = String(job.number || '').trim();
          const po = String(job.po_number || '').trim();
          const alreadyMapped = mappedSfIds.has(String(job.id));

          const entry = {
            sfJobId: job.id,
            number: num,
            po: po,
            status: job.status,
            customer: job.customer_name,
            desc: (job.description || '').substring(0, 80),
          };

          if (alreadyMapped) {
            results.mapped.push(entry);
          } else {
            results.matches.push(entry);
          }
        }
        page++;
      } catch (e) {
        results.errors.push(`Page ${page}: ${e.message.substring(0, 150)}`);
        break;
      }
    }

    results.pagesScanned = page - 1;
    results.jobsScanned = scanned;
    results.customerJobsFound = found;

  } catch (e) {
    results.errors.push(`Fatal: ${e.message}`);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(results, null, 2),
  };
}
