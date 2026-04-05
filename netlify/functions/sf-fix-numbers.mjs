// One-time fix: update SF job numbers to match ResQ codes
// and scan for pre-existing SF jobs that match ResQ WO numbers
// GET /.netlify/functions/sf-fix-numbers — dry run (show what would change)
// POST /.netlify/functions/sf-fix-numbers — apply changes

import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const dryRun = event.httpMethod === 'GET';
  const results = { dryRun, fixes: [], existingMatches: [], errors: [] };

  try {
    // 1. Load current mapping
    const { getStore: createStore } = await import('@netlify/blobs');
    const store = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    const mappingRaw = await store.get('wo-mapping');
    const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};

    // 2. Fix job numbers on already-mapped jobs
    for (const [resqId, m] of Object.entries(mapping)) {
      const correctNumber = m.resqCode.startsWith('R') ? m.resqCode : `R${m.resqCode}`;

      // Check if SF job number already matches
      if (String(m.sfJobNumber) === correctNumber) {
        results.fixes.push({ resqCode: m.resqCode, sfJobId: m.sfJobId, status: 'already correct' });
        continue;
      }

      if (dryRun) {
        results.fixes.push({
          resqCode: m.resqCode,
          sfJobId: m.sfJobId,
          currentNumber: m.sfJobNumber,
          willSetTo: correctNumber,
          status: 'will fix',
        });
      } else {
        try {
          await sfRequest('PUT', `/jobs/${m.sfJobId}`, { number: correctNumber });
          m.sfJobNumber = correctNumber;
          results.fixes.push({ resqCode: m.resqCode, sfJobId: m.sfJobId, newNumber: correctNumber, status: 'fixed' });
        } catch (e) {
          results.errors.push(`Fix ${m.resqCode} (SF ${m.sfJobId}): ${e.message.substring(0, 200)}`);
        }
      }
    }

    // 3. Scan SF jobs for pre-existing ones matching ResQ codes
    // Get all ResQ codes from the mapping
    const mappedCodes = new Set(Object.values(mapping).map(m => m.resqCode));

    // Scan recent SF jobs (pages of 100)
    let page = 1;
    let scanned = 0;
    while (page <= 20) {
      try {
        const res = await sfRequest('GET', `/jobs?per-page=100&page=${page}`);
        const jobs = res.items || res.data || [];
        if (jobs.length === 0) break;

        scanned += jobs.length;
        for (const job of jobs) {
          const num = String(job.number || '').trim();
          const po = String(job.po_number || '').trim();
          // Check if this job has an R{code} pattern
          const rMatch = num.match(/^R(\d{5,})$/) || po.match(/^R(\d{5,})$/);
          if (rMatch) {
            const code = `R${rMatch[1]}`;
            // Is this already in our mapping?
            const alreadyMapped = [...Object.values(mapping)].some(m =>
              String(m.sfJobId) === String(job.id)
            );
            if (!alreadyMapped) {
              results.existingMatches.push({
                sfJobId: job.id,
                sfJobNumber: num,
                sfPO: po,
                sfStatus: job.status,
                sfCustomer: job.customer_name,
                resqCode: code,
                description: (job.description || '').substring(0, 100),
              });
            }
          }
        }
        page++;
      } catch (e) {
        results.errors.push(`Scan page ${page}: ${e.message.substring(0, 200)}`);
        break;
      }
    }
    results.jobsScanned = scanned;

    // 4. Save updated mapping if not dry run
    if (!dryRun && Object.keys(mapping).length > 0) {
      await store.set('wo-mapping', JSON.stringify(mapping));
      results.mappingSaved = true;
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
