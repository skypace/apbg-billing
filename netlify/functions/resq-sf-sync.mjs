// ResQ ↔ Service Fusion Bidirectional Sync
// POST /.netlify/functions/resq-sf-sync — runs a full sync cycle
// GET  /.netlify/functions/resq-sf-sync — returns sync status/mapping
// v3 — parallelized for speed, hardcoded customer IDs

import { resqLogin, resqGql } from './resq-helpers.mjs';
import { sfRequest } from './sf-helpers.mjs';

// --- Constants ---
const BRIX_VENDOR_KEYWORDS = ['brix'];

// SF customer IDs — hardcoded (SF search API is unreliable)
const SF_CUSTOMERS = {
  starbird: { name: 'STARBIRD CHICKEN: RESQ', id: 408973 },
  melt: { name: 'THE MELT - RESQ', id: 408972 },
};

// Facility keywords → SF customer mapping
const FACILITY_MAP = [
  { keywords: ['starbird', 'star bird'], sfCustomer: 'starbird' },
  { keywords: ['melt', 'homeroom'], sfCustomer: 'melt' },
];

let mappingCache = null;

export async function handler(event) {
  if (event.httpMethod === 'GET') return handleGet();
  if (event.httpMethod === 'POST') return handlePost();
  return { statusCode: 405, body: 'GET or POST only' };
}

// --- GET: Return sync status ---
async function handleGet() {
  try {
    const [mapping, lastRun, lastErrors] = await Promise.all([
      loadMapping(),
      loadBlob('last-sync'),
      loadBlob('last-errors'),
    ]);
    return json({
      lastSync: lastRun ? JSON.parse(lastRun) : null,
      lastErrors: lastErrors ? JSON.parse(lastErrors) : [],
      mappingCount: Object.keys(mapping).length,
      mappings: mapping,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --- POST: Run full sync cycle ---
async function handlePost() {
  const log = { started: new Date().toISOString(), steps: [], errors: [], created: 0, updated: 0 };

  try {
    // 1. Login to ResQ + warm SF token IN PARALLEL
    log.steps.push('Connecting to ResQ + SF...');
    const [session] = await Promise.all([
      resqLogin(),
      sfRequest('GET', '/me').catch(e => { throw new Error('SF not connected: ' + e.message); }),
    ]);
    log.steps.push('ResQ + SF connected');

    // 2. Load mapping + fetch ResQ WOs IN PARALLEL
    const [mapping, resqWOs] = await Promise.all([
      loadMapping(),
      fetchSyncableWOs(session),
    ]);
    log.steps.push(`${Object.keys(mapping).length} mappings, ${resqWOs.length} syncable WOs`);

    // 3. Customer IDs (hardcoded, instant)
    const sfCustomerIds = { melt: SF_CUSTOMERS.melt.id, starbird: SF_CUSTOMERS.starbird.id };

    // 4. Split WOs into already-mapped vs new
    const mapped = [];
    const unmapped = [];
    for (const wo of resqWOs) {
      if (mapping[wo.id]) {
        mapped.push(wo);
      } else {
        unmapped.push(wo);
      }
    }

    // 5. Process MAPPED WOs in parallel (status sync SF→ResQ)
    if (mapped.length > 0) {
      const mapResults = await parallelBatch(mapped, 4, async (wo) => {
        return syncSfToResq(session, wo, mapping[wo.id], mapping);
      });
      for (const r of mapResults) {
        if (r.steps) log.steps.push(...r.steps);
        if (r.errors) log.errors.push(...r.errors);
        log.updated += r.updated || 0;
      }
    }

    // 6. Process UNMAPPED WOs in parallel (find or create SF jobs)
    if (unmapped.length > 0) {
      const newResults = await parallelBatch(unmapped, 4, async (wo) => {
        return processNewWO(wo, mapping, sfCustomerIds);
      });
      for (const r of newResults) {
        if (r.steps) log.steps.push(...r.steps);
        if (r.errors) log.errors.push(...r.errors);
        log.created += r.created || 0;
      }
    }

    // 7. Save mapping + log IN PARALLEL
    log.completed = new Date().toISOString();
    log.mappingCount = Object.keys(mapping).length;
    await Promise.all([
      saveMapping(mapping),
      saveBlob('last-sync', JSON.stringify(log)),
      log.errors.length ? saveBlob('last-errors', JSON.stringify(log.errors)) : Promise.resolve(),
    ]);

    return json(log);

  } catch (e) {
    log.errors.push(e.message);
    log.completed = new Date().toISOString();
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch (x) {}
    return json(log, 500);
  }
}

// --- Process a single new (unmapped) WO ---
async function processNewWO(wo, mapping, sfCustomerIds) {
  const result = { steps: [], errors: [], created: 0 };
  const sfCustomerKey = classifyFacility(wo.facility);
  if (!sfCustomerKey) {
    result.steps.push(`Skip ${wo.code}: "${wo.facility}" not Starbird/Melt`);
    return result;
  }

  const customerId = sfCustomerIds[sfCustomerKey];
  if (!customerId) {
    result.errors.push(`No SF customer ID for "${sfCustomerKey}".`);
    return result;
  }

  const resqRef = `R${wo.code}`;

  // Try to find existing SF job
  try {
    const existing = await findExistingSfJob(resqRef, customerId);
    if (existing) {
      mapping[wo.id] = {
        sfJobId: existing.id,
        sfJobNumber: existing.number || existing.job_number || existing.id,
        resqCode: wo.code, resqStatus: wo.status,
        sfStatus: existing.status || existing.job_status || 'Unknown',
        facility: wo.facility, customer: sfCustomerKey, title: wo.title,
        createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(),
        linkedExisting: true,
      };
      result.steps.push(`✓ Linked SF #${existing.id} (${resqRef}) → ResQ ${wo.code}`);
      result.created++;
      return result;
    }
  } catch (e) {
    result.steps.push(`Search failed for ${resqRef}: ${e.message}`);
  }

  // Create new SF job
  try {
    const sfJob = await createSfJob(wo, customerId, sfCustomerKey);
    mapping[wo.id] = {
      sfJobId: sfJob.id,
      sfJobNumber: sfJob.number || sfJob.job_number || sfJob.id,
      resqCode: wo.code, resqStatus: wo.status, sfStatus: 'Unscheduled',
      facility: wo.facility, customer: sfCustomerKey, title: wo.title,
      createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(),
    };
    result.created++;
    result.steps.push(`✓ Created SF #${sfJob.id} (${resqRef}) for ${wo.code} (${wo.facility})`);
  } catch (e) {
    result.errors.push(`Create SF job for ${wo.code}: ${e.message}`);
  }
  return result;
}

// --- SF → ResQ Status Sync (single WO) ---
async function syncSfToResq(session, resqWO, mapEntry, mapping) {
  const result = { steps: [], errors: [], updated: 0 };
  try {
    let sfJob;
    try {
      sfJob = await sfRequest('GET', `/jobs/${mapEntry.sfJobId}`);
    } catch (e) {
      result.errors.push(`Can't read SF job ${mapEntry.sfJobId}: ${e.message}`);
      return result;
    }

    const sfStatus = sfJob.status || sfJob.job_status || '';
    if (sfStatus === mapEntry.sfStatus) return result; // no change

    result.steps.push(`SF ${mapEntry.sfJobId}: "${mapEntry.sfStatus}" → "${sfStatus}"`);
    const sfLower = sfStatus.toLowerCase();

    // Scheduled
    if (sfLower.includes('scheduled') && !sfLower.includes('un')) {
      if (!mapEntry.sfStatus?.toLowerCase().includes('scheduled') || mapEntry.sfStatus?.toLowerCase().includes('un')) {
        try {
          await resqGql(session, `mutation($input: VendorChangeWorkOrderStateInput!) {
            vendorChangeWorkOrderState(input: $input) { workOrder { id status } }
          }`, { input: {
            workOrderId: resqWO.id, state: 'SCHEDULED',
            ...(sfJob.scheduled_start ? { scheduledForStart: sfJob.scheduled_start } : {}),
            ...(sfJob.scheduled_end ? { scheduledForEnd: sfJob.scheduled_end } : {}),
          }});
          result.steps.push(`→ ResQ ${resqWO.code} SCHEDULED`);
          result.updated++;
        } catch (e) { result.errors.push(`ResQ schedule ${resqWO.code}: ${e.message}`); }
      }
    }

    // Completed
    if (sfLower.includes('complet') && !mapEntry.sfStatus?.toLowerCase().includes('complet')) {
      try {
        await resqGql(session, `mutation($input: VendorChangeWorkOrderStateInput!) {
          vendorChangeWorkOrderState(input: $input) { workOrder { id status } }
        }`, { input: { workOrderId: resqWO.id, state: 'NEEDS_INVOICE' } });
        result.steps.push(`→ ResQ ${resqWO.code} NEEDS_INVOICE`);
        result.updated++;
      } catch (e) {
        try {
          await resqGql(session, `mutation($input: ForceWorkOrderCompletionInput!) {
            forceWorkOrderCompletion(input: $input) { workOrder { id status } }
          }`, { input: { workOrderId: resqWO.id } });
          result.steps.push(`→ ResQ ${resqWO.code} force-completed`);
          result.updated++;
        } catch (e2) { result.errors.push(`ResQ complete ${resqWO.code}: ${e.message}`); }
      }
    }

    // Invoiced
    if (sfLower.includes('invoic') && !mapEntry.sfStatus?.toLowerCase().includes('invoic')) {
      try {
        await resqGql(session, `mutation($input: SubmitVendorInvoiceInput!) {
          submitVendorInvoice(input: $input) { workOrder { id status } }
        }`, { input: { workOrderId: resqWO.id } });
        result.steps.push(`→ ResQ ${resqWO.code} invoiced`);
        result.updated++;
      } catch (e) { result.errors.push(`ResQ invoice ${resqWO.code}: ${e.message}`); }
    }

    mapEntry.sfStatus = sfStatus;
    mapEntry.resqStatus = resqWO.status;
    mapEntry.lastSyncAt = new Date().toISOString();
  } catch (e) {
    result.errors.push(`Sync ${resqWO.code}: ${e.message}`);
  }
  return result;
}

// --- Parallel batch helper: run fn on items, N at a time ---
async function parallelBatch(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// --- Fetch syncable ResQ WOs ---
async function fetchSyncableWOs(session) {
  const data = await resqGql(session, `{
    workOrders(first: 200, orderBy: "-raised_on") {
      edges { node {
        id code title description status statusDescription
        raisedOn completedOn scheduledForStart scheduledForEnd
        spend vendorTotal isUrgent isCallback onHold serviceCategory
        facility { id name }
        equipment { id name }
        vendor { id name }
        executingVendor { id name }
      } }
    }
  }`);

  const edges = data.data?.workOrders?.edges || [];

  return edges
    .filter(e => {
      const v = (e.node.vendor?.name || e.node.executingVendor?.name || '').toLowerCase();
      if (!BRIX_VENDOR_KEYWORDS.some(k => v.includes(k))) return false;
      const f = (e.node.facility?.name || '').toLowerCase();
      return FACILITY_MAP.some(fm => fm.keywords.some(k => f.includes(k)));
    })
    .map(e => {
      const n = e.node;
      return {
        id: n.id, code: n.code, title: n.title || '', description: n.description || '',
        status: n.status, statusDescription: n.statusDescription || '',
        raisedOn: n.raisedOn, completedOn: n.completedOn,
        scheduledStart: n.scheduledForStart, scheduledEnd: n.scheduledForEnd,
        spend: n.spend ? parseFloat(n.spend) : null,
        vendorTotal: n.vendorTotal ? parseFloat(n.vendorTotal) : null,
        isUrgent: n.isUrgent, isCallback: n.isCallback, onHold: n.onHold,
        serviceCategory: n.serviceCategory,
        facility: n.facility?.name || '', facilityId: n.facility?.id || '',
        equipment: n.equipment?.name || '',
      };
    });
}

// --- SF Helpers ---
async function findExistingSfJob(resqRef, customerId) {
  try {
    const result = await sfRequest('GET', `/jobs?q=${encodeURIComponent(resqRef)}&per-page=20`);
    const jobs = result.items || result.data || (Array.isArray(result) ? result : []);
    for (const job of jobs) {
      const jobNum = (job.number || job.job_number || '').toString().trim();
      const po = (job.po_number || '').trim();
      const desc = (job.description || '').toLowerCase();
      const name = (job.name || job.job_name || '').trim();
      if (jobNum === resqRef || po === resqRef || name === resqRef || desc.includes(resqRef.toLowerCase())) {
        return job;
      }
    }
  } catch (e) {}
  return null;
}

async function createSfJob(resqWO, customerId, customerKey) {
  const resqRef = `R${resqWO.code}`;
  const description = [
    `ResQ WO: ${resqRef}`,
    resqWO.title,
    resqWO.description,
    `Facility: ${resqWO.facility}`,
    resqWO.equipment ? `Equipment: ${resqWO.equipment}` : '',
    resqWO.isUrgent ? 'URGENT' : '',
  ].filter(Boolean).join('\n');

  return sfRequest('POST', '/jobs', {
    customer_id: customerId,
    description,
    status: 'Unscheduled',
    contact_name: resqWO.facility,
    po_number: resqRef,
  });
}

function classifyFacility(facilityName) {
  const f = (facilityName || '').toLowerCase();
  for (const fm of FACILITY_MAP) {
    if (fm.keywords.some(k => f.includes(k))) return fm.sfCustomer;
  }
  return null;
}

// --- Blob Storage (Netlify Blobs) ---
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

async function loadMapping() {
  if (mappingCache) return mappingCache;
  try {
    const store = await getStore();
    if (!store) return {};
    const data = await store.get('wo-mapping');
    mappingCache = data ? JSON.parse(data) : {};
    return mappingCache;
  } catch (e) {
    return {};
  }
}

async function saveMapping(mapping) {
  mappingCache = mapping;
  try {
    const store = await getStore();
    if (store) await store.set('wo-mapping', JSON.stringify(mapping));
  } catch (e) {}
}

async function loadBlob(key) {
  try {
    const store = await getStore();
    if (!store) return null;
    return await store.get(key);
  } catch (e) {
    return null;
  }
}

async function saveBlob(key, value) {
  try {
    const store = await getStore();
    if (store) await store.set(key, value);
  } catch (e) {}
}

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(data),
  };
}
