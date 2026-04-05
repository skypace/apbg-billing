// Background worker for ResQ ↔ SF bidirectional sync
// Netlify background functions can run up to 15 minutes
//
// Status mapping:
//   ResQ → SF:
//     NOT_YET_SCHEDULED      → Unscheduled
//     SCHEDULED              → Scheduled- Service
//     NOT_YET_COMPLETED      → (no change, in progress)
//     COMPLETED/NEEDS_INVOICE → Completed- Service
//     AWAITING_PAYMENT       → Invoiced  (done — don't create new SF jobs)
//     CLOSED                 → Invoiced  (done — don't create new SF jobs)
//
//   SF → ResQ:
//     Scheduled*             → SCHEDULED
//     Completed*             → NEEDS_INVOICE + transfer photos from SF
//     Invoiced*              → build invoice with line items + submitVendorInvoice

import { resqLogin, resqGql } from './resq-helpers.mjs';
import { sfRequest } from './sf-helpers.mjs';

const BRIX_VENDOR_KEYWORDS = ['brix'];

const SF_CUSTOMERS = {
  starbird: { name: 'STARBIRD CHICKEN: RESQ' },
  melt: { name: 'THE MELT RESQ' },
  brix: { name: 'BRIX BEVERAGE: RESQ' },
};

const FACILITY_MAP = [
  { keywords: ['starbird', 'star bird'], sfCustomer: 'starbird' },
  { keywords: ['melt', 'homeroom'], sfCustomer: 'melt' },
  { keywords: ['brix', 'equipment storage'], sfCustomer: 'brix' },
];

// ResQ statuses that mean "done" — don't create new SF jobs for these
const RESQ_DONE_STATUSES = ['AWAITING_PAYMENT', 'CLOSED', 'CANCELLED'];

// ResQ status → SF status mapping (for ResQ→SF direction)
const RESQ_TO_SF_STATUS = {
  'NOT_YET_SCHEDULED': 'Unscheduled',
  'SCHEDULED': 'Scheduled- Service',
  'COMPLETED': 'Completed- Service',
  'NEEDS_INVOICE': 'Completed- Service',
  'AWAITING_PAYMENT': 'Invoiced',
  'CLOSED': 'Invoiced',
};

export async function handler(event) {
  const log = { started: new Date().toISOString(), steps: [], errors: [], created: 0, updated: 0 };

  const saveProgress = async () => {
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch (x) {}
  };

  try {
    // 1. Connect to ResQ
    log.steps.push('Logging into ResQ...');
    await saveProgress();
    const session = await resqLogin();
    log.steps.push('ResQ OK');

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

    // 3. Load mapping + fetch WOs
    const mapping = await loadMapping();
    log.steps.push(`Loaded ${Object.keys(mapping).length} mappings`);

    log.steps.push('Fetching ResQ WOs...');
    await saveProgress();
    const resqWOs = await fetchSyncableWOs(session);
    log.steps.push(`Found ${resqWOs.length} syncable WOs`);
    await saveProgress();

    const sfCustomerNames = { melt: SF_CUSTOMERS.melt.name, starbird: SF_CUSTOMERS.starbird.name, brix: SF_CUSTOMERS.brix.name };

    // 4. Process each WO
    log.steps.push('Processing WOs...');
    await saveProgress();

    for (let i = 0; i < resqWOs.length; i++) {
      const wo = resqWOs[i];

      try {
        if (mapping[wo.id]) {
          // Already mapped — bidirectional status sync
          // 30s timeout — photo/invoice transfers can take longer
          const r = await withTimeout(syncBidirectional(session, wo, mapping[wo.id]), 30000, `sync ${wo.code}`);
          if (r.steps.length) log.steps.push(...r.steps);
          if (r.errors.length) log.errors.push(...r.errors);
          log.updated += r.updated || 0;
        } else {
          // New WO — skip if already done (awaiting payment, closed, etc.)
          const resqStatus = (wo.status || '').toUpperCase();
          if (RESQ_DONE_STATUSES.includes(resqStatus)) {
            log.steps.push(`Skip ${wo.code}: already ${wo.status}`);
            continue;
          }

          const r = await withTimeout(processNewWO(wo, mapping, sfCustomerNames), 15000, `process ${wo.code}`);
          if (r.steps.length) log.steps.push(...r.steps);
          if (r.errors.length) log.errors.push(...r.errors);
          log.created += r.created || 0;
        }
      } catch (e) {
        log.errors.push(`WO ${wo.code} failed: ${e.message}`);
      }

      // Save progress every 4 WOs
      if ((i + 1) % 4 === 0) await saveProgress();
    }

    // 5. Save final results
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

  // Create new SF job
  try {
    const sfJob = await createSfJob(wo, customerName);

    // Determine initial SF status based on ResQ status
    const resqStatus = (wo.status || '').toUpperCase();
    const targetSfStatus = RESQ_TO_SF_STATUS[resqStatus] || 'Unscheduled';

    mapping[wo.id] = {
      sfJobId: sfJob.id,
      sfJobNumber: sfJob.number || sfJob.job_number || sfJob.id,
      resqCode: wo.code, resqStatus: wo.status, sfStatus: targetSfStatus,
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

// --- Bidirectional Status Sync ---
async function syncBidirectional(session, resqWO, mapEntry) {
  const result = { steps: [], errors: [], updated: 0 };

  try {
    // Fetch current SF job status
    let sfJob;
    try {
      sfJob = await sfRequest('GET', `/jobs/${mapEntry.sfJobId}`);
    } catch (e) {
      result.errors.push(`Can't read SF job ${mapEntry.sfJobId}: ${e.message}`);
      return result;
    }

    const sfStatus = sfJob.status || sfJob.job_status || '';
    const resqStatus = (resqWO.status || '').toUpperCase();
    const prevSfStatus = (mapEntry.sfStatus || '').toLowerCase();
    const prevResqStatus = (mapEntry.resqStatus || '').toUpperCase();

    const sfChanged = sfStatus !== mapEntry.sfStatus;
    const resqChanged = resqStatus !== prevResqStatus;
    const sfLower = sfStatus.toLowerCase();

    // What actions are needed based on current SF status?
    const sfIsCompleted = sfLower.includes('complet') || sfLower.includes('invoic'); // invoiced implies completed
    const sfIsInvoiced = sfLower.includes('invoic');
    const needsPhotoTransfer = sfIsCompleted && !mapEntry.photosSent;
    const needsInvoiceSubmit = sfIsInvoiced && !mapEntry.invoiceSubmitted;

    if (!sfChanged && !resqChanged && !needsPhotoTransfer && !needsInvoiceSubmit) return result;

    if (sfChanged) {
      result.steps.push(`SF ${mapEntry.sfJobId}: "${mapEntry.sfStatus}" → "${sfStatus}"`);
    }
    if (resqChanged) {
      result.steps.push(`ResQ ${resqWO.code}: "${prevResqStatus}" → "${resqStatus}"`);
    }

    // --- Transfer photos from SF → ResQ (on Completed or Invoiced) ---
    if (needsPhotoTransfer) {
      try {
        const photoResult = await transferSfPhotosToResq(session, mapEntry.sfJobId, resqWO.id);
        if (photoResult.count > 0) {
          result.steps.push(`📸 ${photoResult.count} photos sent to ResQ ${resqWO.code}`);
          mapEntry.photosSent = true;
          result.updated++;
        } else if (photoResult.errors.length) {
          // Photos exist but couldn't be auto-downloaded — don't mark as sent
          result.steps.push(`📸 ${resqWO.code}: manual upload needed via sync.html`);
          result.errors.push(...photoResult.errors);
        } else {
          // No photos on the SF job at all
          result.steps.push(`No photos on SF job for ${resqWO.code}`);
          mapEntry.photosSent = true; // nothing to send
        }
      } catch (e) {
        result.errors.push(`Photos ${resqWO.code}: ${e.message}`);
      }
    }

    // --- Build invoice from SF line items + submit to ResQ (on Invoiced) ---
    if (needsInvoiceSubmit) {
      try {
        const invResult = await buildAndSubmitInvoice(session, mapEntry.sfJobId, resqWO);
        if (invResult.steps.length) result.steps.push(...invResult.steps);
        if (invResult.errors.length) result.errors.push(...invResult.errors);
        result.updated += invResult.updated || 0;
        mapEntry.invoiceSubmitted = true;
      } catch (e) { result.errors.push(`ResQ invoice ${resqWO.code}: ${e.message}`); }
    }

    // Update mapping with current states
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
    workOrders(first: 500, orderBy: "-raised_on") {
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

// --- Transfer SF Photos → ResQ ---
// NOTE: SF API does not expose file download endpoints. S3 bucket (sf-uploads)
// is private. Photos must be uploaded manually via sync.html upload widget.
// This function checks if photos exist on the SF job and logs accordingly.
async function transferSfPhotosToResq(session, sfJobId, resqWoId) {
  const result = { count: 0, errors: [] };

  // Fetch SF job with pictures AND documents expanded
  let sfJob;
  try {
    sfJob = await sfRequest('GET', `/jobs/${sfJobId}?expand=pictures,documents`);
  } catch (e) {
    result.errors.push(`Fetch SF photos for ${sfJobId}: ${e.message}`);
    return result;
  }

  const allFiles = [...(sfJob.pictures || []), ...(sfJob.documents || [])];
  if (allFiles.length === 0) return result;

  // Photos exist but can't be auto-downloaded — flag for manual upload
  result.errors.push(`SF job ${sfJobId} has ${allFiles.length} photo(s) — use sync.html to upload manually to ResQ`);
  return result;
}

// --- Build Invoice from SF Line Items → Submit to ResQ ---
async function buildAndSubmitInvoice(session, sfJobId, resqWO) {
  const result = { steps: [], errors: [], updated: 0 };

  // Fetch SF job with invoices + line items expanded
  let sfJob;
  try {
    sfJob = await sfRequest('GET', `/jobs/${sfJobId}?expand=invoices,products,services,labor_charges,expenses,other_charges`);
  } catch (e) {
    result.errors.push(`Fetch SF invoice data for ${sfJobId}: ${e.message}`);
    return result;
  }

  // Get the SF invoice number (use the first/most recent invoice)
  const sfInvoices = sfJob.invoices || [];
  const sfInvoice = sfInvoices[sfInvoices.length - 1]; // most recent
  const invoiceNumber = sfInvoice?.number ? String(sfInvoice.number) : '';

  // Build ResQ line items from SF data
  const lineItems = [];
  let order = 0;

  // Products → ITEM_TYPE_PART
  for (const p of (sfJob.products || [])) {
    lineItems.push({
      order: order++,
      itemType: 'ITEM_TYPE_PART',
      quantity: String(p.multiplier || 1),
      description: p.description || p.name || 'Part',
      partName: p.name || '',
      price: String(p.rate || 0),
      discount: '0',
      taxRateIds: [],
    });
  }

  // Services → ITEM_TYPE_SERVICE_CHARGE
  for (const s of (sfJob.services || [])) {
    lineItems.push({
      order: order++,
      itemType: 'ITEM_TYPE_SERVICE_CHARGE',
      quantity: String(s.multiplier || 1),
      description: s.description || s.name || 'Service',
      price: String(s.rate || 0),
      discount: '0',
      taxRateIds: [],
    });
  }

  // Labor charges → ITEM_TYPE_LABOUR
  for (const l of (sfJob.labor_charges || [])) {
    const hours = l.labor_time ? parseFloat(l.labor_time) : 0;
    if (hours > 0 || l.labor_time_cost) {
      lineItems.push({
        order: order++,
        itemType: 'ITEM_TYPE_LABOUR',
        quantity: String(hours || 1),
        description: `Labor${l.user ? ' - ' + l.user : ''}${l.labor_date ? ' (' + l.labor_date + ')' : ''}`,
        price: String(l.labor_time_rate || 0),
        discount: '0',
        taxRateIds: [],
      });
    }
    // Drive time as travel
    const driveHours = l.drive_time ? parseFloat(l.drive_time) : 0;
    if (driveHours > 0 && l.is_drive_time_billed) {
      lineItems.push({
        order: order++,
        itemType: 'ITEM_TYPE_TRAVEL',
        quantity: String(driveHours),
        description: `Drive time${l.user ? ' - ' + l.user : ''}`,
        price: String(l.drive_time_rate || 0),
        discount: '0',
        taxRateIds: [],
      });
    }
  }

  // Expenses → ITEM_TYPE_OTHER
  for (const ex of (sfJob.expenses || [])) {
    if (ex.is_billable && ex.amount) {
      lineItems.push({
        order: order++,
        itemType: 'ITEM_TYPE_OTHER',
        quantity: '1',
        description: ex.notes || ex.category || 'Expense',
        price: String(ex.amount),
        discount: '0',
        taxRateIds: [],
      });
    }
  }

  // Other charges → ITEM_TYPE_OTHER
  for (const oc of (sfJob.other_charges || [])) {
    lineItems.push({
      order: order++,
      itemType: 'ITEM_TYPE_OTHER',
      quantity: String(oc.multiplier || 1),
      description: oc.description || oc.name || 'Other charge',
      price: String(oc.rate || 0),
      discount: '0',
      taxRateIds: [],
    });
  }

  const refNumber = invoiceNumber || (resqWO.code.startsWith('R') ? resqWO.code : `R${resqWO.code}`);

  // Build a summary of line items for the vendor notes
  const totalAmount = lineItems.reduce((sum, li) => sum + (parseFloat(li.price) * parseFloat(li.quantity)), 0);
  const lineItemSummary = lineItems.map(li => `${li.description}: ${li.quantity}x $${li.price}`).join('; ');

  // Submit the vendor invoice (marks WO as invoiced in ResQ)
  // Note: createPartneredInvoiceSubmissionFromBuilder requires facility permissions,
  // so we use submitVendorInvoice with line item details in the notes field.
  try {
    const notes = [
      `Invoice from SF job #${sfJobId}`,
      invoiceNumber ? `SF Invoice #${invoiceNumber}` : '',
      totalAmount ? `Total: $${totalAmount.toFixed(2)}` : '',
      lineItems.length ? `Line items (${lineItems.length}): ${lineItemSummary}` : '',
    ].filter(Boolean).join('\n');

    await resqGql(session, `mutation($arguments: SubmitVendorInvoiceMutationArguments!) {
      submitVendorInvoice(arguments: $arguments) { __typename }
    }`, { arguments: {
      workOrderId: resqWO.id,
      vendorNotes: notes,
      vendorReferenceNumber: refNumber,
      dispute: false,
    }});
    result.steps.push(`→ ResQ ${resqWO.code} invoice submitted (ref: ${refNumber}, ${lineItems.length} items, $${totalAmount.toFixed(2)})`);
    result.updated++;
  } catch (e) {
    result.errors.push(`Submit invoice ${resqWO.code}: ${e.message.substring(0, 300)}`);
  }

  return result;
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
