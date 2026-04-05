// Background worker for ResQ ↔ SF sync
// Netlify background functions can run up to 15 minutes
// Called by resq-sf-sync.mjs POST handler

import { resqLogin, resqGql } from './resq-helpers.mjs';
import { sfRequest } from './sf-helpers.mjs';

const BRIX_VENDOR_KEYWORDS = ['brix'];

// SF customer names — must match EXACTLY what's in Service Fusion
// (SF API uses customer_name for job creation, not IDs)
const SF_CUSTOMERS = {
  starbird: { name: 'STARBIRD CHICKEN: RESQ' },
  melt: { name: 'THE MELT RESQ' },
};

const FACILITY_MAP = [
  { keywords: ['starbird', 'star bird'], sfCustomer: 'starbird' },
  { keywords: ['melt', 'homeroom'], sfCustomer: 'melt' },
];

export async function handler(event) {
  const log = { started: new Date().toISOString(), steps: [], errors: [], created: 0, updated: 0 };

  // Helper to save progress after each major step
  const saveProgress = async () => {
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch (x) {}
  };

  try {
    // 1. Connect to ResQ
    log.steps.push('Logging into ResQ...');
    await saveProgress();
    let session;
    try {
      session = await resqLogin();
      log.steps.push('ResQ OK');
    } catch (e) {
      log.errors.push('ResQ login failed: ' + e.message);
      throw e;
    }

    // 2. Verify SF
    log.steps.push('Checking SF...');
    await saveProgress();
    try {
      await sfRequest('GET', '/me');
      log.steps.push('SF OK');
    } catch (e) {
      log.errors.push('SF failed: ' + e.message);
      throw new Error('SF not connected: ' + e.message);
    }

    // 3. Load mapping
    const mapping = await loadMapping();
    log.steps.push(`Loaded ${Object.keys(mapping).length} mappings`);

    // 4. Fetch ResQ WOs
    log.steps.push('Fetching ResQ WOs...');
    await saveProgress();
    const resqWOs = await fetchSyncableWOs(session);
    log.steps.push(`Found ${resqWOs.length} syncable WOs`);
    await saveProgress();

    const sfCustomerNames = { melt: SF_CUSTOMERS.melt.name, starbird: SF_CUSTOMERS.starbird.name };

    // 5. Process each WO one at a time, saving progress
    log.steps.push(`Starting WO processing...`);
    await saveProgress();

    for (let i = 0; i < resqWOs.length; i++) {
      const wo = resqWOs[i];
      log.steps.push(`[${i + 1}/${resqWOs.length}] ${wo.code} — ${wo.facility}`);
      await saveProgress(); // save before each WO so we can see where it hangs

      try {
        if (mapping[wo.id]) {
          const r = await withTimeout(syncSfToResq(session, wo, mapping[wo.id]), 15000, `sync ${wo.code}`);
          if (r.steps.length) log.steps.push(...r.steps);
          if (r.errors.length) log.errors.push(...r.errors);
          log.updated += r.updated || 0;
        } else {
          const r = await withTimeout(processNewWO(wo, mapping, sfCustomerNames), 15000, `process ${wo.code}`);
          if (r.steps.length) log.steps.push(...r.steps);
          if (r.errors.length) log.errors.push(...r.errors);
          log.created += r.created || 0;
        }
      } catch (e) {
        log.errors.push(`WO ${wo.code} failed: ${e.message}`);
      }
    }

    // 6. Save final results
    log.completed = new Date().toISOString();
    log.mappingCount = Object.keys(mapping).length;
    await Promise.all([
      saveMapping(mapping),
      saveBlob('last-sync', JSON.stringify(log)),
      log.errors.length ? saveBlob('last-errors', JSON.stringify(log.errors)) : saveBlob('last-errors', '[]'),
    ]);

    console.log(`[SYNC] Done: ${log.created} created, ${log.updated} updated, ${log.errors.length} errors`);

  } catch (e) {
    log.errors.push(e.message);
    log.completed = new Date().toISOString();
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch (x) {}
    console.error('[SYNC] Failed:', e.message);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

// --- Timeout wrapper ---
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

// --- Process new unmapped WO ---
async function processNewWO(wo, mapping, sfCustomerNames) {
  const result = { steps: [], errors: [], created: 0 };
  const sfCustomerKey = classifyFacility(wo.facility);
  if (!sfCustomerKey) {
    result.steps.push(`Skip ${wo.code}: "${wo.facility}" not Starbird/Melt`);
    return result;
  }

  const customerName = sfCustomerNames[sfCustomerKey];
  if (!customerName) {
    result.errors.push(`No SF customer name for "${sfCustomerKey}".`);
    return result;
  }

  const resqRef = wo.code.startsWith('R') ? wo.code : `R${wo.code}`;

  // TODO: findExistingSfJob disabled — SF search API is broken/hangs
  // Existing R{code} jobs will be discovered later via job listing

  // Create new SF job
  try {
    const sfJob = await createSfJob(wo, customerName);
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

// --- SF → ResQ Status Sync ---
async function syncSfToResq(session, resqWO, mapEntry) {
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
    if (sfStatus === mapEntry.sfStatus) return result;

    result.steps.push(`SF ${mapEntry.sfJobId}: "${mapEntry.sfStatus}" → "${sfStatus}"`);
    const sfLower = sfStatus.toLowerCase();

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

  return (data.data?.workOrders?.edges || [])
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
async function findExistingSfJob(resqRef) {
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

async function createSfJob(resqWO, customerName) {
  const resqRef = resqWO.code.startsWith('R') ? resqWO.code : `R${resqWO.code}`;
  const description = [
    `ResQ WO: ${resqRef}`,
    resqWO.title,
    resqWO.description,
    `Facility: ${resqWO.facility}`,
    resqWO.equipment ? `Equipment: ${resqWO.equipment}` : '',
    resqWO.isUrgent ? 'URGENT' : '',
  ].filter(Boolean).join('\n');

  return sfRequest('POST', '/jobs', {
    customer_name: customerName,
    description,
    status: 'Unscheduled',
    priority: resqWO.isUrgent ? 'Urgent' : 'Normal',
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

async function loadMapping() {
  try {
    const store = await getStore();
    if (!store) return {};
    const data = await store.get('wo-mapping');
    return data ? JSON.parse(data) : {};
  } catch (e) {
    return {};
  }
}

async function saveMapping(mapping) {
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
