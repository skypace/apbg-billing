// ResQ ↔ Service Fusion Sync — thin dispatcher
// GET  → returns sync status/mapping from blobs (fast)
// POST → kicks off background function, returns 202 immediately

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod === 'GET') return handleGet();
  if (event.httpMethod === 'POST') return handlePost();
  return { statusCode: 405, body: 'GET or POST only' };
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

    // Call the background function via HTTP (Netlify routes -background functions)
    const siteUrl = process.env.URL || 'https://apbg-billing.netlify.app';
    fetch(`${siteUrl}/.netlify/functions/resq-sf-sync-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'manual', ts: Date.now() }),
    }).catch(() => {}); // fire-and-forget

    return json({
      status: 'started',
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
