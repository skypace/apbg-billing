// Fix PO numbers on mapped jobs + lookup individual jobs
// GET ?action=fixpo  — fix RR→R on PO numbers of mapped jobs
// GET ?jobId=X       — fetch a specific SF job
// GET ?action=recent — fetch last 3 pages looking for RESQ customer jobs

import { sfRequest } from './sf-helpers.mjs';

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const results = { errors: [] };

  // Quick mode: fetch specific job
  if (qs.jobId) {
    try {
      const job = await sfRequest('GET', `/jobs/${qs.jobId}`);
      return json(job);
    } catch (e) {
      return json({ error: e.message });
    }
  }

  const action = qs.action || 'fixpo';

  try {
    const { getStore: createStore } = await import('@netlify/blobs');
    const store = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    const mappingRaw = await store.get('wo-mapping');
    const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};

    if (action === 'fixpo') {
      // Fix PO numbers: RR0957597 → R0957597
      results.fixes = [];
      for (const [resqId, m] of Object.entries(mapping)) {
        const correctPO = m.resqCode.startsWith('R') ? m.resqCode : `R${m.resqCode}`;
        try {
          // Fetch current job to see PO
          const job = await sfRequest('GET', `/jobs/${m.sfJobId}`);
          const currentPO = job.po_number || '';

          if (currentPO === correctPO) {
            results.fixes.push({ code: m.resqCode, po: currentPO, status: 'ok' });
            continue;
          }

          // Update PO via POST (since PUT/PATCH not supported)
          // Actually, let's check if the PO can be updated by creating a note
          // SF API might not support updating existing jobs at all
          results.fixes.push({
            code: m.resqCode,
            sfId: m.sfJobId,
            currentPO,
            correctPO,
            number: job.number,
            status: 'needs_manual_fix',
          });
        } catch (e) {
          results.errors.push(`${m.resqCode}: ${e.message.substring(0, 100)}`);
        }
      }
      results.summary = `${results.fixes.filter(f => f.status === 'ok').length} ok, ${results.fixes.filter(f => f.status === 'needs_manual_fix').length} need fixing`;
    }

    if (action === 'recent') {
      // Look at last few pages (newest jobs) for RESQ customers
      // Try high page numbers where our new jobs would be
      results.recentJobs = [];
      // Our job IDs are ~1086691967, jobs per page is 50
      // Estimate page: 1086691967/50 ≈ page 21733934 — way too high
      // Instead, just try the last few pages backward
      for (const pageNum of [1, 21000000, 10000000, 5000000]) {
        try {
          const res = await sfRequest('GET', `/jobs?per-page=50&page=${pageNum}`);
          const jobs = res.items || res.data || [];
          results.recentJobs.push({
            page: pageNum,
            count: jobs.length,
            firstId: jobs[0]?.id,
            lastId: jobs[jobs.length - 1]?.id,
            firstCustomer: jobs[0]?.customer_name,
          });
        } catch (e) {
          results.recentJobs.push({ page: pageNum, error: e.message.substring(0, 100) });
        }
      }
    }

    if (action === 'listmapped') {
      // Show all mapped jobs with their current SF data
      results.jobs = [];
      for (const [resqId, m] of Object.entries(mapping)) {
        results.jobs.push({
          resqCode: m.resqCode,
          sfJobId: m.sfJobId,
          sfNumber: m.sfJobNumber,
          facility: m.facility,
          customer: m.customer,
          resqStatus: m.resqStatus,
          sfStatus: m.sfStatus,
        });
      }
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
