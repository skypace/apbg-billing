// ResQ ↔ Service Fusion Bidirectional Sync
// POST /.netlify/functions/resq-sf-sync — runs a full sync cycle
// GET  /.netlify/functions/resq-sf-sync — returns sync status/mapping

import { resqLogin, resqGql } from './resq-helpers.mjs';
import { sfRequest } from './sf-helpers.mjs';

// --- Constants ---
const BRIX_VENDOR_KEYWORDS = ['brix'];  // Match vendor name containing "brix"

// SF customer names — must match exactly what's in Service Fusion
const SF_CUSTOMERS = {
  starbird: 'STARBIRD CHICKEN: RESQ',
  melt: 'THE MELT - RESQ',
};

// Facility keywords → SF customer mapping
const FACILITY_MAP = [
  { keywords: ['starbird', 'star bird'], sfCustomer: 'starbird' },
  { keywords: ['melt', 'homeroom'], sfCustomer: 'melt' },
];

// Simple in-memory mapping store (persisted via Netlify Blobs if available)
let mappingCache = null;

export async function handler(event) {
  if (event.httpMethod === 'GET') {
    return await handleGet();
  }
  if (event.httpMethod === 'POST') {
    return await handlePost();
  }
  return { statusCode: 405, body: 'GET or POST only' };
}

// --- GET: Return sync status ---
async function handleGet() {
  try {
    const mapping = await loadMapping();
    const lastRun = await loadBlob('last-sync');
    const lastErrors = await loadBlob('last-errors');

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
  const log = {
    started: new Date().toISOString(),
    steps: [],
    errors: [],
    created: 0,
    updated: 0,
  };

  try {
    // 1. Login to ResQ
    log.steps.push('Logging into ResQ...');
    const session = await resqLogin();
    log.steps.push('ResQ login OK');

    // 2. Verify SF connection (this will refresh token if needed)
    log.steps.push('Checking SF connection...');
    try {
      await sfRequest('GET', '/me');
      log.steps.push('SF connection OK');
    } catch (e) {
      log.errors.push('SF connection failed: ' + e.message);
      throw new Error('SF not connected. Go to /setup.html to reconnect.');
    }

    // 3. Load existing mapping
    const mapping = await loadMapping();
    log.steps.push(`Loaded ${Object.keys(mapping).length} existing mappings`);

    // 4. Fetch ResQ work orders (Starbird + Melt only, Brix vendor)
    log.steps.push('Fetching ResQ work orders...');
    const resqWOs = await fetchSyncableWOs(session);
    log.steps.push(`Found ${resqWOs.length} syncable ResQ WOs`);

    // 5. Resolve SF customer IDs
    const sfCustomerIds = await resolveSfCustomerIds();
    const custDebug = sfCustomerIds._debug || [];
    delete sfCustomerIds._debug;
    for (const d of custDebug) log.steps.push(`[SF] ${d}`);
    log.steps.push(`SF customers resolved: ${JSON.stringify(sfCustomerIds)}`);

    // 6. Process each ResQ WO
    for (const wo of resqWOs) {
      const resqId = wo.id;

      if (mapping[resqId]) {
        // Already mapped — check SF status changes and push back to ResQ
        await syncSfToResq(session, wo, mapping[resqId], mapping, log);
        continue;
      }

      // New WO — classify facility and create SF job
      const sfCustomerKey = classifyFacility(wo.facility);
      if (!sfCustomerKey) {
        log.steps.push(`Skip WO ${wo.code}: facility "${wo.facility}" not Starbird/Melt`);
        continue;
      }

      const customerId = sfCustomerIds[sfCustomerKey];
      if (!customerId) {
        log.errors.push(`No SF customer "${SF_CUSTOMERS[sfCustomerKey]}" found. Create it in Service Fusion first.`);
        continue;
      }

      // Check if this WO already exists in SF (manually created as R{code})
      const resqRef = `R${wo.code}`;
      try {
        const existing = await findExistingSfJob(resqRef, customerId);
        if (existing) {
          // Found existing SF job — map it, don't create a duplicate
          mapping[resqId] = {
            sfJobId: existing.id,
            sfJobNumber: existing.number || existing.job_number || existing.id,
            resqCode: wo.code,
            resqStatus: wo.status,
            sfStatus: existing.status || existing.job_status || 'Unknown',
            facility: wo.facility,
            customer: sfCustomerKey,
            title: wo.title,
            createdAt: new Date().toISOString(),
            lastSyncAt: new Date().toISOString(),
            linkedExisting: true,
          };
          log.steps.push(`✓ Linked existing SF job #${existing.id} (${resqRef}) to ResQ ${wo.code}`);
          log.created++;
          continue;
        }
      } catch (e) {
        log.steps.push(`Could not search SF for ${resqRef}: ${e.message}`);
      }

      // No existing job found — create a new one with R{code} naming
      try {
        const sfJob = await createSfJob(wo, customerId, sfCustomerKey);
        mapping[resqId] = {
          sfJobId: sfJob.id,
          sfJobNumber: sfJob.number || sfJob.job_number || sfJob.id,
          resqCode: wo.code,
          resqStatus: wo.status,
          sfStatus: 'Unscheduled',
          facility: wo.facility,
          customer: sfCustomerKey,
          title: wo.title,
          createdAt: new Date().toISOString(),
          lastSyncAt: new Date().toISOString(),
        };
        log.created++;
        log.steps.push(`✓ Created SF job #${sfJob.id} (${resqRef}) for ResQ ${wo.code} (${wo.facility})`);
      } catch (e) {
        log.errors.push(`Failed to create SF job for ResQ ${wo.code}: ${e.message}`);
      }
    }

    // 7. Save mapping + run log
    await saveMapping(mapping);
    log.completed = new Date().toISOString();
    log.mappingCount = Object.keys(mapping).length;
    await saveBlob('last-sync', JSON.stringify(log));
    if (log.errors.length) {
      await saveBlob('last-errors', JSON.stringify(log.errors));
    }

    return json(log);

  } catch (e) {
    log.errors.push(e.message);
    log.completed = new Date().toISOString();
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch(x) {}
    return json(log, 500);
  }
}

// --- SF → ResQ Status Sync ---
async function syncSfToResq(session, resqWO, mapEntry, mapping, log) {
  try {
    // Fetch current SF job
    let sfJob;
    try {
      sfJob = await sfRequest('GET', `/jobs/${mapEntry.sfJobId}`);
    } catch (e) {
      log.errors.push(`Can't read SF job ${mapEntry.sfJobId}: ${e.message}`);
      return;
    }

    const sfStatus = sfJob.status || sfJob.job_status || '';
    const sfStatusLower = sfStatus.toLowerCase();

    // No change?
    if (sfStatus === mapEntry.sfStatus) return;

    log.steps.push(`SF job ${mapEntry.sfJobId} status: "${mapEntry.sfStatus}" → "${sfStatus}"`);

    // --- Scheduled ---
    if (sfStatusLower.includes('scheduled') && !sfStatusLower.includes('un')) {
      if (!mapEntry.sfStatus?.toLowerCase().includes('scheduled') || mapEntry.sfStatus?.toLowerCase().includes('un')) {
        try {
          await resqGql(session, `mutation($input: VendorChangeWorkOrderStateInput!) {
            vendorChangeWorkOrderState(input: $input) { workOrder { id status } }
          }`, {
            input: {
              workOrderId: resqWO.id,
              state: 'SCHEDULED',
              ...(sfJob.scheduled_start ? { scheduledForStart: sfJob.scheduled_start } : {}),
              ...(sfJob.scheduled_end ? { scheduledForEnd: sfJob.scheduled_end } : {}),
            },
          });
          log.steps.push(`→ ResQ ${resqWO.code} updated to SCHEDULED`);
          log.updated++;
        } catch (e) {
          log.errors.push(`ResQ schedule update for ${resqWO.code}: ${e.message}`);
        }
      }
    }

    // --- Completed ---
    if (sfStatusLower.includes('complet')) {
      if (!mapEntry.sfStatus?.toLowerCase().includes('complet')) {
        try {
          // Try moving to NEEDS_INVOICE (normal completion flow)
          await resqGql(session, `mutation($input: VendorChangeWorkOrderStateInput!) {
            vendorChangeWorkOrderState(input: $input) { workOrder { id status } }
          }`, {
            input: { workOrderId: resqWO.id, state: 'NEEDS_INVOICE' },
          });
          log.steps.push(`→ ResQ ${resqWO.code} updated to NEEDS_INVOICE (completed)`);
          log.updated++;
        } catch (e) {
          // Fallback: force completion
          try {
            await resqGql(session, `mutation($input: ForceWorkOrderCompletionInput!) {
              forceWorkOrderCompletion(input: $input) { workOrder { id status } }
            }`, {
              input: { workOrderId: resqWO.id },
            });
            log.steps.push(`→ ResQ ${resqWO.code} force-completed`);
            log.updated++;
          } catch (e2) {
            log.errors.push(`ResQ completion for ${resqWO.code}: ${e.message} / ${e2.message}`);
          }
        }
      }
    }

    // --- Invoiced ---
    if (sfStatusLower.includes('invoic')) {
      if (!mapEntry.sfStatus?.toLowerCase().includes('invoic')) {
        try {
          await resqGql(session, `mutation($input: SubmitVendorInvoiceInput!) {
            submitVendorInvoice(input: $input) { workOrder { id status } }
          }`, {
            input: { workOrderId: resqWO.id },
          });
          log.steps.push(`→ ResQ ${resqWO.code} invoice submitted`);
          log.updated++;
        } catch (e) {
          log.errors.push(`ResQ invoice for ${resqWO.code}: ${e.message}`);
        }
      }
    }

    // Update mapping
    mapEntry.sfStatus = sfStatus;
    mapEntry.resqStatus = resqWO.status;
    mapEntry.lastSyncAt = new Date().toISOString();

  } catch (e) {
    log.errors.push(`Status sync for ${resqWO.code}: ${e.message}`);
  }
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
      // Must be Brix vendor
      const v = (e.node.vendor?.name || e.node.executingVendor?.name || '').toLowerCase();
      if (!BRIX_VENDOR_KEYWORDS.some(k => v.includes(k))) return false;
      // Must be Starbird or Melt/Homeroom facility
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

// Search SF for an existing job matching R{resqCode} in job number, PO, name, or description
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
  } catch (e) {
    // Search might not support this query format, fall through
  }
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
    resqWO.isUrgent ? '⚠️ URGENT' : '',
  ].filter(Boolean).join('\n');

  return await sfRequest('POST', '/jobs', {
    customer_id: customerId,
    description,
    status: 'Unscheduled',
    contact_name: resqWO.facility,
    po_number: resqRef,
  });
}

async function resolveSfCustomerIds() {
  const ids = {};
  const debug = [];

  // Fetch all customers (SF API may not support q= search well)
  // Try multiple approaches to find RESQ customers
  let allCustomers = [];

  // SF q= param doesn't filter — need to paginate through all customers
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    try {
      const r = await sfRequest('GET', `/customers?per-page=500&page=${page}`);
      const c = r.items || r.data || (Array.isArray(r) ? r : []);
      if (c.length === 0) {
        hasMore = false;
      } else {
        allCustomers.push(...c);
        debug.push(`Page ${page}: ${c.length} customers`);
        // Stop if we got fewer than requested (last page)
        if (c.length < 500) hasMore = false;
        page++;
        // Safety: don't fetch more than 10 pages (5000 customers)
        if (page > 10) hasMore = false;
      }
    } catch (e) {
      debug.push(`Page ${page} failed: ${e.message}`);
      hasMore = false;
    }
  }

  // Deduplicate by id
  const seen = new Set();
  allCustomers = allCustomers.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  debug.push(`Total unique customers found: ${allCustomers.length}`);

  // Log all customer names containing RESQ, MELT, or STARBIRD
  const relevant = allCustomers.filter(c => {
    const n = (c.customer_name || c.name || '').toUpperCase();
    return n.includes('RESQ') || n.includes('MELT') || n.includes('STARBIRD');
  });
  debug.push(`Relevant customers: ${relevant.map(c => `"${c.customer_name || c.name}" (id:${c.id})`).join(', ') || 'NONE'}`);

  // Now match
  for (const [key, name] of Object.entries(SF_CUSTOMERS)) {
    const nameUpper = name.toUpperCase();

    // Exact match
    let match = allCustomers.find(c =>
      (c.customer_name || c.name || '').toUpperCase() === nameUpper
    );

    // Contains match
    if (!match) {
      match = allCustomers.find(c =>
        (c.customer_name || c.name || '').toUpperCase().includes(nameUpper)
      );
    }

    // Fuzzy: RESQ + MELT or RESQ + STARBIRD
    if (!match) {
      match = allCustomers.find(c => {
        const cn = (c.customer_name || c.name || '').toUpperCase();
        return cn.includes('RESQ') && (
          (key === 'melt' && cn.includes('MELT')) ||
          (key === 'starbird' && cn.includes('STARBIRD'))
        );
      });
    }

    if (match) {
      ids[key] = match.id;
      debug.push(`Matched ${key}: "${match.customer_name || match.name}" (id:${match.id})`);
    }
  }

  // Store debug info in the log
  ids._debug = debug;
  return ids;
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

// --- Response helpers ---
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
