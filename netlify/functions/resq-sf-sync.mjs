// ResQ ↔ Service Fusion Sync — thin dispatcher
// GET  → returns sync status/mapping from blobs (fast)
// POST → kicks off background function, returns 202 immediately

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  const qs = event.queryStringParameters || {};
  if (qs.lookup) return handleLookup(qs.lookup);
  if (qs.sfPhotos) return handleSfPhotos(qs.sfPhotos);
  if (qs.resetFlags) return handleResetFlags(qs.resetFlags);
  if (qs.deleteMapping) return handleDeleteMapping(qs.deleteMapping);
  if (qs.uploadPhoto) return handleUploadPhoto(event, qs.uploadPhoto);
  if (qs.visitPhotos) return handleVisitPhotos(event, qs.visitPhotos);
  if (qs.introspect) return handleIntrospect(qs.introspect);
  if (qs.dedupeReport) return handleDedupeReport();
  if (qs.cancelSfJob) return handleCancelSfJob(qs.cancelSfJob, qs.resqCode);
  if (qs.relink) return handleRelink(qs.relink, qs.toSfJobId);
  if (qs.dismissIssue) return handleDismissIssue(qs.dismissIssue);
  if (event.httpMethod === 'GET') return handleGet();
  if (event.httpMethod === 'POST') return handlePost();
  return { statusCode: 405, body: 'GET or POST only' };
}

// --- Lookup: Query ResQ for a specific WO code ---
async function handleLookup(code) {
  try {
    const { resqLogin, resqGql } = await import('./resq-helpers.mjs');
    const session = await resqLogin();
    // Search by code filter if available, otherwise scan recent WOs
    const data = await resqGql(session, `query($code: String) {
      workOrders(first: 500, orderBy: "-raised_on", code: $code) {
        edges { node {
          id code title status statusDescription
          facility { id name }
          vendor { id name }
          executingVendor { id name }
          latestVisit { id outcome notes startedAt endedAt }
          inProgressVisit { id outcome notes startedAt }
          appointment { id startsAt endsAt }
          upcomingAppointment { id startsAt endsAt }
          invoiceSets { id code vendorInvoices { id dueAtDate } recordOfWorks { id vendorReferenceNumber createdAt notes vendorNotes pdfUrl lineItems { itemType quantity rate description } } }
        } }
      }
    }`, { code });
    const edges = data.data?.workOrders?.edges || [];
    const match = edges.find(e => e.node.code === code);
    if (match) {
      return json({ found: true, wo: match.node });
    }
    // Try without filter (code param may not be supported)
    if (edges.length === 0) {
      const data2 = await resqGql(session, `{
        workOrders(first: 500, orderBy: "-raised_on") {
          edges { node { id code title status facility { name } vendor { name } executingVendor { name } } }
        }
      }`);
      const edges2 = data2.data?.workOrders?.edges || [];
      const match2 = edges2.find(e => e.node.code === code);
      if (match2) return json({ found: true, wo: match2.node });
      return json({ found: false, code, totalScanned: edges2.length, oldest: edges2[edges2.length-1]?.node?.code });
    }
    return json({ found: false, code, totalScanned: edges.length, oldest: edges[edges.length-1]?.node?.code });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- SF Photos Debug: Check what photos/documents are on an SF job ---
async function handleSfPhotos(jobId) {
  try {
    const { sfRequest, getSFAccessToken } = await import('./sf-helpers.mjs');
    const job = await sfRequest('GET', `/jobs/${jobId}?expand=pictures,documents,signatures,visits,visits.techs_assigned,notes`);

    const token = await getSFAccessToken();
    const SF_API = 'https://api.servicefusion.com/v1';
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'Accept': '*/*' };

    // Helper: test a URL and return detailed result
    async function testUrl(url, opts = {}) {
      try {
        const hdrs = opts.noAuth ? (opts.headers || {}) : { ...authHeaders, ...(opts.headers || {}) };
        const r = await fetch(url, { ...opts, headers: hdrs });
        const ct = r.headers.get('content-type') || '';
        const cl = r.headers.get('content-length') || '';
        const loc = r.headers.get('location') || '';
        let bodySnippet = '';
        // Read body snippet for non-binary responses or small responses
        if (r.status !== 200 || ct.includes('text') || ct.includes('html') || ct.includes('json')) {
          bodySnippet = (await r.text()).substring(0, 300);
        } else {
          // Binary success - read size
          const buf = await r.arrayBuffer();
          bodySnippet = `[binary ${buf.byteLength} bytes]`;
        }
        return { status: r.status, contentType: ct, contentLength: cl, location: loc || undefined, body: bodySnippet };
      } catch (e) {
        return { error: e.message.substring(0, 100) };
      }
    }

    // Test all pictures AND documents
    const allFiles = [...(job.pictures || []), ...(job.documents || [])];
    const fileTests = [];

    for (const p of allFiles) {
      const loc = p.file_location || '';
      const tests = {};

      // --- API-based download tests ---

      // 1. customer-documents/{id}/download (if customer_doc_id exists)
      if (p.customer_doc_id) {
        tests['api_custdoc_download'] = await testUrl(`${SF_API}/customer-documents/${p.customer_doc_id}/download`);
        tests['api_custdoc_metadata'] = await testUrl(`${SF_API}/customer-documents/${p.customer_doc_id}`);
        // Also try with redirect: manual to see if it 302s
        tests['api_custdoc_download_nofollow'] = await testUrl(`${SF_API}/customer-documents/${p.customer_doc_id}/download`, { redirect: 'manual' });
      }

      // 2. pictures/{id} endpoints (if id exists)
      if (p.id) {
        tests['api_pictures_meta'] = await testUrl(`${SF_API}/pictures/${p.id}`);
        tests['api_pictures_download'] = await testUrl(`${SF_API}/pictures/${p.id}/download`);
        tests['api_job_pictures_download'] = await testUrl(`${SF_API}/job-pictures/${p.id}/download`);
        tests['api_job_pictures_meta'] = await testUrl(`${SF_API}/job-pictures/${p.id}`);
      }

      // 3. Try using the file_location as a path on various SF endpoints
      if (loc) {
        tests['api_files_loc'] = await testUrl(`${SF_API}/files/${encodeURIComponent(loc)}`);
        tests['webapp_download'] = await testUrl(`https://app.servicefusion.com/web/download-file?file=${encodeURIComponent(loc)}`);
      }

      // 4. S3 direct (ap-northeast-1 confirmed from previous 301 body)
      if (loc && !loc.startsWith('http')) {
        tests['s3_apne1_noauth'] = await testUrl(`https://sf-uploads.s3-ap-northeast-1.amazonaws.com/${loc}`, { noAuth: true });
        tests['s3_apne1_noauth_redirect'] = await testUrl(`https://sf-uploads.s3-ap-northeast-1.amazonaws.com/${loc}`, { noAuth: true, redirect: 'manual' });
        // Try other S3 region/prefix combos without auth
        tests['s3_vhost_noauth'] = await testUrl(`https://sf-uploads.s3.amazonaws.com/${loc}`, { noAuth: true, redirect: 'manual' });
        tests['s3_us1_noauth'] = await testUrl(`https://sf-uploads.s3.us-east-1.amazonaws.com/${loc}`, { noAuth: true, redirect: 'manual' });
      }

      fileTests.push({
        name: p.name,
        file_location: loc,
        doc_type: p.doc_type,
        id: p.id,
        customer_doc_id: p.customer_doc_id,
        allFields: p,
        downloadTests: tests,
      });
    }

    return json({
      jobId, status: job.status,
      pictureCount: (job.pictures || []).length,
      documentCount: (job.documents || []).length,
      fileTests,
      signatures: job.signatures || [],
      visits: (job.visits || []).map(v => ({ id: v.id, status: v.status, started: v.started_at, ended: v.ended_at })),
      notes: job.notes || [],
      allKeys: Object.keys(job),
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Introspect: Query ResQ schema for available mutations/types ---
async function handleIntrospect(what) {
  try {
    const { resqLogin, resqGql } = await import('./resq-helpers.mjs');
    const session = await resqLogin();

    if (what === 'mutations') {
      const data = await resqGql(session, `{
        __schema {
          mutationType {
            fields { name description args { name type { name kind ofType { name } } } }
          }
        }
      }`);
      const mutations = data.data?.__schema?.mutationType?.fields || [];
      // Filter to invoice/vendor related
      const relevant = mutations.filter(m =>
        m.name.toLowerCase().includes('invoice') ||
        m.name.toLowerCase().includes('vendor') ||
        m.name.toLowerCase().includes('attach') ||
        m.name.toLowerCase().includes('submit') ||
        m.name.toLowerCase().includes('complete')
      );
      return json({ total: mutations.length, relevant, allNames: mutations.map(m => m.name).sort() });
    }

    if (what.startsWith('type:')) {
      const typeName = what.slice(5);
      const data = await resqGql(session, `{ __type(name: "${typeName}") { name kind fields { name type { name kind ofType { name kind ofType { name } } } } inputFields { name type { name kind ofType { name kind ofType { name } } } } enumValues { name description } } }`);
      return json(data.data?.__type || { error: 'Type not found' });
    }

    if (what.startsWith('try:')) {
      // Try a mutation with minimal input to see if we get auth error or type error
      const mutName = what.slice(4);
      try {
        const r = await resqGql(session, `mutation { ${mutName}(input: {}) { __typename } }`);
        return json({ mutation: mutName, result: r });
      } catch (e) {
        return json({ mutation: mutName, error: e.message.substring(0, 500) });
      }
    }

    return json({ usage: '?introspect=mutations' });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Upload Photo: POST with ?uploadPhoto=resqWoId, body = { files: [{ name, base64, contentType }] } ---
async function handleUploadPhoto(event, resqWoId) {
  if (event.httpMethod !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const { resqLogin, resqGql } = await import('./resq-helpers.mjs');
    const body = JSON.parse(event.body || '{}');
    const files = body.files || [];
    if (!files.length) return json({ error: 'No files provided. Send { files: [{ name, base64, contentType }] }' }, 400);

    const session = await resqLogin();
    const results = [];

    for (const f of files) {
      try {
        await resqGql(session, `mutation($attachToId: ID!, $file: String!, $fileContentType: String!, $label: String) {
          addAttachment(attachToId: $attachToId, file: $file, fileContentType: $fileContentType, label: $label) {
            __typename
          }
        }`, {
          attachToId: resqWoId,
          file: f.base64,
          fileContentType: f.contentType || 'image/jpeg',
          label: f.name || 'Photo',
        });
        results.push({ name: f.name, ok: true });
      } catch (e) {
        results.push({ name: f.name, ok: false, error: e.message.substring(0, 200) });
      }
    }

    // Mark photosSent in mapping if all succeeded
    const allOk = results.every(r => r.ok);
    if (allOk) {
      try {
        const store = await getStore();
        if (store) {
          const raw = await store.get('wo-mapping');
          const mapping = raw ? JSON.parse(raw) : {};
          for (const [k, v] of Object.entries(mapping)) {
            if (k === resqWoId || v.resqCode === resqWoId) {
              v.photosSent = true;
              v.lastSyncAt = new Date().toISOString();
            }
          }
          await store.set('wo-mapping', JSON.stringify(mapping));
        }
      } catch (e) {}
    }

    return json({ uploaded: results.filter(r => r.ok).length, total: files.length, results });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Visit Photos: Upload before/after images to a ResQ visit ---
// POST with ?visitPhotos=resqWoId, body = { type: 'before'|'after', files: [{ name, base64, contentType }] }
async function handleVisitPhotos(event, resqWoId) {
  if (event.httpMethod !== 'POST') return json({ error: 'POST required' }, 405);
  try {
    const { resqLogin, resqGql } = await import('./resq-helpers.mjs');
    const body = JSON.parse(event.body || '{}');
    const files = body.files || [];
    const photoType = body.type || 'after'; // 'before' or 'after'
    if (!files.length) return json({ error: 'No files. Send { type: "before"|"after", files: [{ name, base64, contentType }] }' }, 400);

    const session = await resqLogin();

    // Get the visit ID from the WO — try by code first, then scan
    // resqWoId could be a base64 WO ID or a code like R0960134
    const isCode = /^R?\d+$/.test(resqWoId);
    let visitId;
    if (isCode) {
      const code = resqWoId.startsWith('R') ? resqWoId : `R${resqWoId}`;
      const woData = await resqGql(session, `{
        workOrders(first: 1, code: "${code}") {
          edges { node { latestVisit { id outcome } inProgressVisit { id outcome } } }
        }
      }`);
      const woNode = woData.data?.workOrders?.edges?.[0]?.node;
      visitId = woNode?.inProgressVisit?.id || woNode?.latestVisit?.id;
    } else {
      // Try to find by scanning recent WOs
      const woData = await resqGql(session, `{
        workOrders(first: 100, orderBy: "-raised_on") {
          edges { node { id latestVisit { id outcome } inProgressVisit { id outcome } } }
        }
      }`);
      const match = woData.data?.workOrders?.edges?.find(e => e.node.id === resqWoId);
      visitId = match?.node?.inProgressVisit?.id || match?.node?.latestVisit?.id;
    }
    if (!visitId) return json({ error: 'No visit found on this work order' }, 404);

    // Build image array — ResQ expects data URLs
    const images = files.map(f => {
      const ct = f.contentType || 'image/jpeg';
      return `data:${ct};base64,${f.base64}`;
    });

    const mutation = photoType === 'before' ? 'addBeforeImagesToVisit' : 'addAfterImagesToVisit';
    const inputType = photoType === 'before' ? 'AddBeforeImagesToVisitInput' : 'AddAfterImagesToVisitInput';

    const result = await resqGql(session, `mutation($input: ${inputType}!) {
      ${mutation}(input: $input) { __typename }
    }`, { input: {
      visit: visitId,
      images,
    }});

    // Mark photosSent in mapping
    try {
      const store = await getStore();
      if (store) {
        const raw = await store.get('wo-mapping');
        const mapping = raw ? JSON.parse(raw) : {};
        for (const [k, v] of Object.entries(mapping)) {
          if (k === resqWoId || v.resqCode === resqWoId) {
            v.photosSent = true;
            v.lastSyncAt = new Date().toISOString();
          }
        }
        await store.set('wo-mapping', JSON.stringify(mapping));
      }
    } catch (e) {}

    return json({ ok: true, mutation, visitId, imagesUploaded: files.length });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Reset Flags: Clear photosSent/invoiceSubmitted for a WO code ---
async function handleResetFlags(code) {
  try {
    const store = await getStore();
    if (!store) return json({ error: 'Blob store not available' }, 500);
    const raw = await store.get('wo-mapping');
    const mapping = raw ? JSON.parse(raw) : {};
    let found = false;
    for (const [k, v] of Object.entries(mapping)) {
      if (v.resqCode === code || code === 'all') {
        delete v.photosSent;
        delete v.invoiceSubmitted;
        delete v.visitCompleted;
        found = true;
      }
    }
    if (found) {
      await store.set('wo-mapping', JSON.stringify(mapping));
      return json({ reset: true, code });
    }
    return json({ reset: false, code, message: 'Not found in mapping' });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Delete Mapping: Remove a WO entry from wo-mapping entirely ---
async function handleDeleteMapping(code) {
  try {
    const store = await getStore();
    if (!store) return json({ error: 'Blob store not available' }, 500);
    const raw = await store.get('wo-mapping');
    const mapping = raw ? JSON.parse(raw) : {};
    const removed = [];
    for (const [k, v] of Object.entries(mapping)) {
      if (v.resqCode === code || k === code) {
        removed.push({ key: k, resqCode: v.resqCode, sfJobId: v.sfJobId });
        delete mapping[k];
      }
    }
    if (removed.length === 0) {
      return json({ deleted: false, code, message: 'Not found in mapping' }, 404);
    }
    await store.set('wo-mapping', JSON.stringify(mapping));
    return json({ deleted: true, code, removed });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- GET: Return sync status from blobs ---
async function handleGet() {
  try {
    const store = await getStore();
    if (!store) return json({ error: 'Blob store not available' }, 500);

    const [mappingRaw, lastRunRaw, lastErrorsRaw, dedupeRaw] = await Promise.all([
      store.get('wo-mapping').catch(() => null),
      store.get('last-sync').catch(() => null),
      store.get('last-errors').catch(() => null),
      store.get('dedupe-report').catch(() => null),
    ]);

    const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};
    const dedupe = dedupeRaw ? JSON.parse(dedupeRaw) : { totalIssues: 0, items: [] };
    return json({
      lastSync: lastRunRaw ? JSON.parse(lastRunRaw) : null,
      lastErrors: lastErrorsRaw ? JSON.parse(lastErrorsRaw) : [],
      mappingCount: Object.keys(mapping).length,
      mappings: mapping,
      dedupeReport: dedupe,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Dedupe Report: full list of WOs that need manual review ---
async function handleDedupeReport() {
  try {
    const store = await getStore();
    if (!store) return json({ error: 'Blob store not available' }, 500);
    const raw = await store.get('dedupe-report').catch(() => null);
    if (!raw) return json({ generated: null, totalIssues: 0, items: [] });
    return json(JSON.parse(raw));
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Cancel SF Job: PUT /jobs/{id} with status=Cancelled ---
async function handleCancelSfJob(jobId, resqCode) {
  if (!jobId) return json({ error: 'jobId required' }, 400);
  try {
    const { sfRequest } = await import('./sf-helpers.mjs');
    await sfRequest('PUT', `/jobs/${jobId}`, { status: 'Cancelled' });

    // Drop the cancelled job from the dedupe report so it disappears from the UI immediately.
    const store = await getStore();
    if (store) {
      try {
        const raw = await store.get('dedupe-report');
        if (raw) {
          const r = JSON.parse(raw);
          for (const item of (r.items || [])) {
            if (item.sfJobs) item.sfJobs = item.sfJobs.filter(j => String(j.id) !== String(jobId));
          }
          // Remove items that lose their last SF job, OR whose duplicate set drops below 2.
          r.items = (r.items || []).filter(i => {
            if (i.reason === 'duplicates_no_progressed') {
              return (i.sfJobs?.length || 0) > 1;
            }
            if (i.reason === 'cancel_failed' && String(i.sfJobId) === String(jobId)) {
              return false;
            }
            return true;
          });
          r.totalIssues = r.items.length;
          r.byReason = r.items.reduce((acc, x) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {});
          await store.set('dedupe-report', JSON.stringify(r));
        }
      } catch (e) { /* non-fatal */ }
    }

    return json({ ok: true, jobId, status: 'Cancelled', resqCode });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Relink: point a mapping at a different SF job ---
async function handleRelink(resqCode, toSfJobId) {
  if (!resqCode || !toSfJobId) return json({ error: 'resqCode and toSfJobId required' }, 400);
  try {
    const store = await getStore();
    if (!store) return json({ error: 'Blob store not available' }, 500);
    const raw = await store.get('wo-mapping');
    const mapping = raw ? JSON.parse(raw) : {};
    let found = null;
    for (const [k, v] of Object.entries(mapping)) {
      if (v.resqCode === resqCode || k === resqCode) {
        v.replacedSfJobId = v.sfJobId;
        v.sfJobId = toSfJobId;
        v.relinkedAt = new Date().toISOString();
        v.lastSyncAt = new Date().toISOString();
        v.reconciled = true;
        delete v.sfDeleted;
        found = v;
      }
    }
    if (!found) return json({ error: 'No mapping found for ' + resqCode }, 404);
    await store.set('wo-mapping', JSON.stringify(mapping));

    // Drop this WO from the dedupe report — user has resolved it.
    try {
      const reportRaw = await store.get('dedupe-report');
      if (reportRaw) {
        const r = JSON.parse(reportRaw);
        r.items = (r.items || []).filter(i => i.resqCode !== resqCode);
        r.totalIssues = r.items.length;
        r.byReason = r.items.reduce((acc, x) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {});
        await store.set('dedupe-report', JSON.stringify(r));
      }
    } catch (e) { /* non-fatal */ }

    return json({ ok: true, resqCode, sfJobId: toSfJobId });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Dismiss: remove a WO from the report without taking action ---
async function handleDismissIssue(resqCode) {
  if (!resqCode) return json({ error: 'resqCode required' }, 400);
  try {
    const store = await getStore();
    if (!store) return json({ error: 'Blob store not available' }, 500);
    const raw = await store.get('dedupe-report').catch(() => null);
    if (!raw) return json({ ok: true, dismissed: 0 });
    const r = JSON.parse(raw);
    const before = (r.items || []).length;
    r.items = (r.items || []).filter(i => i.resqCode !== resqCode);
    r.totalIssues = r.items.length;
    r.byReason = r.items.reduce((acc, x) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {});
    await store.set('dedupe-report', JSON.stringify(r));

    // Also mark the mapping as reconciled so the next sync doesn't re-flag it.
    try {
      const mappingRaw = await store.get('wo-mapping');
      if (mappingRaw) {
        const mapping = JSON.parse(mappingRaw);
        for (const [k, v] of Object.entries(mapping)) {
          if (v.resqCode === resqCode) {
            v.reconciled = true;
            v.dismissedAt = new Date().toISOString();
          }
        }
        await store.set('wo-mapping', JSON.stringify(mapping));
      }
    } catch (e) { /* non-fatal */ }

    return json({ ok: true, dismissed: before - r.totalIssues });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- POST: Write "running" marker, invoke background function ---
async function handlePost() {
  try {
    // Write a "running" marker so the dashboard shows sync in progress
    const store = await getStore();
    if (store) {
      const marker = JSON.stringify({
        started: new Date().toISOString(),
        steps: ['Sync started... (running in background)'],
        errors: [],
        created: 0,
        updated: 0,
        running: true,
      });
      await store.set('last-sync', marker);
    }

    // Call the background function via HTTP — MUST await to ensure it fires
    // Netlify background functions (name ending in -background) return 202 immediately
    // and continue running for up to 15 minutes
    const siteUrl = process.env.URL || 'https://apbg-billing.netlify.app';
    const bgUrl = `${siteUrl}/.netlify/functions/resq-sf-sync-background`;
    let bgStatus = 'unknown';
    try {
      const bgRes = await fetch(bgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'manual', ts: Date.now() }),
      });
      bgStatus = `${bgRes.status}`;
    } catch (e) {
      bgStatus = `error: ${e.message}`;
    }

    return json({
      status: 'started',
      bgStatus,
      message: 'Sync running in background. Refresh in ~30 seconds to see results.',
    }, 202);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- Blob Storage ---
let blobStore = null;

async function getStore() {
  if (blobStore) return blobStore;
  try {
    const { getStore: createStore } = await import('@netlify/blobs');
    blobStore = createStore({
      name: 'resq-sf-sync',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    return blobStore;
  } catch (e) {
    return null;
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(data),
  };
}
