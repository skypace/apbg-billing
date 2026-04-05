// Find recent SF jobs with R{code} numbers — sort by newest first
// GET               — scan recent jobs for R{code} matches
// GET ?jobId=X      — fetch specific job
// GET ?action=link  — link found matches to ResQ mapping + remove duplicates

import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const qs = event.queryStringParameters || {};

  // Quick lookup
  if (qs.jobId) {
    try {
      const job = await sfRequest('GET', `/jobs/${qs.jobId}`);
      return json(job);
    } catch (e) {
      return json({ error: e.message });
    }
  }

  const action = qs.action || 'scan';
  const maxPages = parseInt(qs.pages || '10');
  const results = { action, matches: [], duplicates: [], errors: [] };

  try {
    const { getStore: createStore } = await import('@netlify/blobs');
    const store = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    const mappingRaw = await store.get('wo-mapping');
    const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};
    const mappedSfIds = new Set(Object.values(mapping).map(m => String(m.sfJobId)));

    // Build lookup: resqCode → mapping entry
    const codeToMapping = {};
    for (const [resqId, m] of Object.entries(mapping)) {
      codeToMapping[m.resqCode] = { resqId, ...m };
    }

    // Scan recent jobs sorted by created_at descending
    let page = 1;
    let scanned = 0;
    let oldestSeen = null;

    while (page <= maxPages) {
      try {
        const res = await sfRequest('GET', `/jobs?per-page=100&sort=-created_at&page=${page}`);
        const jobs = res.items || res.data || [];
        if (jobs.length === 0) break;

        scanned += jobs.length;
        oldestSeen = jobs[jobs.length - 1].created_at;

        for (const job of jobs) {
          const num = String(job.number || '').trim();
          // Look for R followed by 6-7 digits (ResQ WO format)
          if (!/^R\d{6,}$/.test(num)) continue;

          const resqCode = num; // e.g. R0957597
          const alreadyMapped = mappedSfIds.has(String(job.id));

          const entry = {
            sfJobId: job.id,
            number: num,
            resqCode,
            po: job.po_number || '',
            customer: job.customer_name,
            status: job.status,
            created: job.created_at,
            desc: (job.description || '').substring(0, 80),
          };

          if (alreadyMapped) {
            // This is one of our auto-created jobs (already in mapping)
            continue;
          }

          // Check if we also auto-created a job for the same ResQ code
          if (codeToMapping[resqCode]) {
            entry.duplicateOf = codeToMapping[resqCode].sfJobId;
            entry.duplicateNumber = codeToMapping[resqCode].sfJobNumber;
            results.duplicates.push(entry);
          }

          results.matches.push(entry);
        }
        page++;
      } catch (e) {
        results.errors.push(`Page ${page}: ${e.message.substring(0, 150)}`);
        break;
      }
    }

    results.scanned = scanned;
    results.pagesScanned = page - 1;
    results.oldestJobSeen = oldestSeen;

    // If action=link, update mapping to point to the ORIGINAL (manual) jobs
    // and mark the auto-created duplicates for cleanup
    if (action === 'link' && results.duplicates.length > 0) {
      results.linked = [];
      for (const dup of results.duplicates) {
        // Find the mapping entry for this resqCode
        const existing = codeToMapping[dup.resqCode];
        if (!existing) continue;

        // Update mapping: point to the ORIGINAL manual job, not our auto-created one
        const resqId = existing.resqId;
        mapping[resqId] = {
          ...mapping[resqId],
          sfJobId: dup.sfJobId,
          sfJobNumber: dup.number,
          sfStatus: dup.status || mapping[resqId].sfStatus,
          lastSyncAt: new Date().toISOString(),
          linkedExisting: true,
          replacedDuplicate: existing.sfJobId, // the auto-created one we're replacing
        };

        results.linked.push({
          resqCode: dup.resqCode,
          originalSfJob: dup.sfJobId,
          replacedSfJob: existing.sfJobId,
        });
      }

      await store.set('wo-mapping', JSON.stringify(mapping));
      results.mappingSaved = true;
    }

  } catch (e) {
    results.errors.push(`Fatal: ${e.message}`);
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
