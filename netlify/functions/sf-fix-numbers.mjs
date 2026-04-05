// Fix SF job numbers to match ResQ codes + scan for existing matches
// GET  ?action=fix   — update 16 mapped jobs' numbers (fast)
// GET  ?action=scan  — scan SF jobs for pre-existing R{code} matches
// POST              — do both: fix numbers + scan + save

import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const action = qs.action || (event.httpMethod === 'POST' ? 'all' : 'fix');
  const results = { action, fixes: [], existingMatches: [], errors: [] };

  try {
    const { getStore: createStore } = await import('@netlify/blobs');
    const store = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    const mappingRaw = await store.get('wo-mapping');
    const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};

    // --- Fix job numbers on mapped jobs ---
    if (action === 'fix' || action === 'all') {
      for (const [resqId, m] of Object.entries(mapping)) {
        const correctNumber = m.resqCode.startsWith('R') ? m.resqCode : `R${m.resqCode}`;

        if (String(m.sfJobNumber) === correctNumber) {
          results.fixes.push({ code: m.resqCode, status: 'ok' });
          continue;
        }

        try {
          await sfRequest('PATCH', `/jobs/${m.sfJobId}`, { number: correctNumber });
          m.sfJobNumber = correctNumber;
          results.fixes.push({ code: m.resqCode, sfId: m.sfJobId, was: m.sfJobNumber, now: correctNumber, status: 'fixed' });
        } catch (e) {
          results.errors.push(`${m.resqCode}: ${e.message.substring(0, 150)}`);
        }
      }

      await store.set('wo-mapping', JSON.stringify(mapping));
    }

    // --- Scan SF jobs for pre-existing R{code} matches ---
    if (action === 'scan' || action === 'all') {
      const mappedSfIds = new Set(Object.values(mapping).map(m => String(m.sfJobId)));
      let page = 1;
      let scanned = 0;

      while (page <= 10) { // limit pages to avoid timeout
        try {
          const res = await sfRequest('GET', `/jobs?per-page=100&page=${page}`);
          const jobs = res.items || res.data || [];
          if (jobs.length === 0) break;

          scanned += jobs.length;
          for (const job of jobs) {
            const num = String(job.number || '').trim();
            const po = String(job.po_number || '').trim();
            const rMatch = num.match(/^R\d{5,}$/) || po.match(/^R\d{5,}$/);
            if (rMatch && !mappedSfIds.has(String(job.id))) {
              results.existingMatches.push({
                sfJobId: job.id,
                number: num,
                po: po,
                status: job.status,
                customer: job.customer_name,
                desc: (job.description || '').substring(0, 80),
              });
            }
          }
          page++;
        } catch (e) {
          results.errors.push(`Page ${page}: ${e.message.substring(0, 150)}`);
          break;
        }
      }
      results.jobsScanned = scanned;
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
