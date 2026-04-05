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
  if (qs.uploadPhoto) return handleUploadPhoto(event, qs.uploadPhoto);
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
          id code title status
          facility { name }
          vendor { name }
          executingVendor { name }
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

// --- GET: Return sync status from blobs ---
async function handleGet() {
  try {
    const store = await getStore();
    if (!store) return json({ error: 'Blob store not available' }, 500);

    const [mappingRaw, lastRunRaw, lastErrorsRaw] = await Promise.all([
      store.get('wo-mapping').catch(() => null),
      store.get('last-sync').catch(() => null),
      store.get('last-errors').catch(() => null),
    ]);

    const mapping = mappingRaw ? JSON.parse(mappingRaw) : {};
    return json({
      lastSync: lastRunRaw ? JSON.parse(lastRunRaw) : null,
      lastErrors: lastErrorsRaw ? JSON.parse(lastErrorsRaw) : [],
      mappingCount: Object.keys(mapping).length,
      mappings: mapping,
    });
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
