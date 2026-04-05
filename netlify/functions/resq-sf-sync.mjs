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
    const { sfRequest } = await import('./sf-helpers.mjs');
    const job = await sfRequest('GET', `/jobs/${jobId}?expand=pictures,documents`);
    return json({
      jobId, status: job.status,
      pictures: (job.pictures || []).map(p => ({ name: p.name, file_location: p.file_location, doc_type: p.doc_type, comment: p.comment })),
      documents: (job.documents || []).map(d => ({ name: d.name, file_location: d.file_location, doc_type: d.doc_type, comment: d.comment })),
    });
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
