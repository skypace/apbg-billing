// Fix: try to set job numbers + scan for existing R{code} jobs
// GET ?action=test    — test if number can be set at creation
// GET ?action=scan    — scan ALL SF jobs for R{code} matches
// GET ?action=scanall — scan more pages

import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const action = qs.action || 'test';
  const results = { action, errors: [] };

  try {
    const { getStore: createStore } = await import('@netlify/blobs');
    const store = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });

    if (action === 'test') {
      // Test: create a job with number in the payload
      try {
        const job = await sfRequest('POST', '/jobs', {
          customer_name: 'THE MELT RESQ',
          description: 'NUMBER TEST - delete me',
          status: 'Unscheduled',
          number: 'RTEST001',
          po_number: 'RTEST001',
        });
        results.testCreate = {
          success: true,
          jobId: job.id,
          number: job.number,
          po: job.po_number,
          numberSet: job.number === 'RTEST001',
        };
      } catch (e) {
        results.testCreate = { error: e.message.substring(0, 300) };
      }
    }

    if (action === 'scan' || action === 'scanall') {
      const mappingRaw = await store.get('wo-mapping');
      const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};
      const mappedSfIds = new Set(Object.values(mapping).map(m => String(m.sfJobId)));
      const maxPages = action === 'scanall' ? 30 : 10;

      const startPage = parseInt(qs.page || '1');
      results.existingMatches = [];
      let page = startPage;
      let scanned = 0;

      while (page < startPage + maxPages) {
        try {
          const res = await sfRequest('GET', `/jobs?per-page=100&page=${page}`);
          const jobs = res.items || res.data || [];
          if (jobs.length === 0) { results.endOfJobs = true; break; }

          scanned += jobs.length;
          for (const job of jobs) {
            const num = String(job.number || '').trim();
            const po = String(job.po_number || '').trim();
            const desc = (job.description || '').toLowerCase();
            // Match R followed by 5+ digits in number, PO, or description
            const hasR = num.match(/^R\d{5,}/) || po.match(/^R\d{5,}/) || desc.match(/r\d{6,}/);
            if (hasR && !mappedSfIds.has(String(job.id))) {
              results.existingMatches.push({
                sfJobId: job.id,
                number: num,
                po: po,
                status: job.status,
                customer: job.customer_name,
                desc: (job.description || '').substring(0, 100),
              });
            }
          }
          page++;
        } catch (e) {
          results.errors.push(`Page ${page}: ${e.message.substring(0, 150)}`);
          break;
        }
      }
      results.pagesScanned = page - startPage;
      results.jobsScanned = scanned;
      results.lastPage = page;
    }

  } catch (e) {
    results.errors.push(`Fatal: ${e.message}`);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(results, null, 2),
  };
}
