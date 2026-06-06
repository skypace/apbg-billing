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
import { requireAuth } from './lib/auth.mjs';
import { loadSyncCustomers, classifySyncCustomer, allFacilityKeywords, sfNameFor, stemFor } from './lib/sync-customers.mjs';
import { mapEntryToLinkRow, bulkUpsertLinks, bulkInsertEvents, eventFromResult } from './lib/resq-sf-links.mjs';

const BRIX_VENDOR_KEYWORDS = ['brix'];

// System submitter for SF-sourced expenses landed by the cron (no operator in
// scope). ops.expense_requests.submitted_by is NOT NULL → attribute to the ops
// owner's auth user (skypace@brixbev.com). The 🔒 Close button still attributes
// to whoever clicked it.
const SF_EXPENSE_SUBMITTER = {
  id: '2da634b7-623d-4f73-b667-cf87975fcdb6',
  email: 'skypace@brixbev.com',
  user_metadata: { name: 'Service Fusion (system)' },
};

// One-off backfill allowlist: SF job ids that were invoiced before the
// expense-on-invoice landing existed and whose expense we still want pulled in.
// (Going-forward jobs land automatically at the invoice transition.)
const SF_EXPENSE_BACKFILL = new Set(['1086695007']);

// Customer identity (ResQ facility <-> SF customer <-> QBO customer) now lives
// in ops.sync_customers, loaded once per run and threaded through the worker.
// See netlify/functions/lib/sync-customers.mjs + migration 20260602a.

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

// Sync lock — prevents overlapping sync runs from creating duplicate SF jobs.
// Cron fires every 5min; manual POST can also fire; lock TTL must cover a normal run.
const SYNC_LOCK_KEY = 'sync-lock';
const SYNC_LOCK_TTL_MS = 10 * 60 * 1000; // 10 min

export async function handler(event) {
  // Auth: a superadmin JWT, the in-process cron flag (_internalCron, honored by
  // requireAuth), OR a matching CRON_SECRET — the latter lets Supabase pg_cron
  // POST this endpoint directly (a more reliable scheduler than Netlify's, which
  // silently stopped firing resq-sf-sync-cron). Set CRON_SECRET in Netlify env.
  const qs = event.queryStringParameters || {};
  const hdrs = event.headers || {};
  const providedKey = qs.cronKey || hdrs['x-cron-key'] || hdrs['X-Cron-Key'] || '';
  const cronOk = !!(providedKey && process.env.CRON_SECRET && providedKey === process.env.CRON_SECRET);
  if (!cronOk) {
    const auth = await requireAuth(event);
    if (!auth.ok) return auth.response;
  }

  const log = { started: new Date().toISOString(), steps: [], errors: [], created: 0, updated: 0 };
  const dedupeReport = [];
  const syncEvents = []; // Phase 2: audit trail dual-written to ops.sync_events

  const saveProgress = async () => {
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch (x) {}
  };

  // Acquire global sync lock to prevent overlapping runs from racing on SF job creation.
  const lockAcquired = await acquireSyncLock();
  if (!lockAcquired) {
    log.steps.push('Skipped: another sync run is in progress (lock held)');
    log.completed = new Date().toISOString();
    log.skipped = true;
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch (x) {}
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

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

    // 3. Load mapping + the linked-customer identity map + fetch WOs
    const mapping = await loadMapping();
    log.steps.push(`Loaded ${Object.keys(mapping).length} mappings`);

    const syncCustomers = await loadSyncCustomers();
    log.steps.push(`Loaded ${syncCustomers.length} linked customers: ${syncCustomers.map(c => c.qbo_customer_name).join(', ') || '(none)'}`);

    log.steps.push('Fetching ResQ WOs...');
    await saveProgress();
    const resqWOs = await fetchSyncableWOs(session, syncCustomers);
    log.steps.push(`Found ${resqWOs.length} syncable WOs`);
    await saveProgress();

    // 4. Process each WO
    log.steps.push('Processing WOs...');
    await saveProgress();

    for (let i = 0; i < resqWOs.length; i++) {
      const wo = resqWOs[i];

      try {
        if (mapping[wo.id]) {
          // Skip deleted SF jobs — they 404 every time and bloat errors
          if (mapping[wo.id].sfDeleted) {
            continue;
          }
          // Already mapped — bidirectional status sync
          // 30s timeout — photo/invoice transfers can take longer
          const r = await withTimeout(syncBidirectional(session, wo, mapping[wo.id]), 30000, `sync ${wo.code}`);
          if (r.steps.length) log.steps.push(...r.steps);
          if (r.errors.length) log.errors.push(...r.errors);
          if (r.report?.length) dedupeReport.push(...r.report);
          log.updated += r.updated || 0;
          const ev = eventFromResult(wo, mapping[wo.id], r, 'sf->resq');
          if (ev) syncEvents.push(ev);
        } else {
          // New WO — skip if already done (awaiting payment, closed, etc.)
          const resqStatus = (wo.status || '').toUpperCase();
          if (RESQ_DONE_STATUSES.includes(resqStatus)) {
            log.steps.push(`Skip ${wo.code}: already ${wo.status}`);
            continue;
          }

          const r = await withTimeout(processNewWO(wo, mapping, syncCustomers), 15000, `process ${wo.code}`);
          if (r.steps.length) log.steps.push(...r.steps);
          if (r.errors.length) log.errors.push(...r.errors);
          if (r.report?.length) dedupeReport.push(...r.report);
          log.created += r.created || 0;
          const ev = eventFromResult(wo, mapping[wo.id], r, 'resq->sf');
          if (ev) syncEvents.push(ev);
        }
      } catch (e) {
        log.errors.push(`WO ${wo.code} failed: ${e.message}`);
        syncEvents.push({ resq_wo_id: String(wo.id), resq_code: wo.code || null, sf_job_id: mapping[wo.id]?.sfJobId != null ? String(mapping[wo.id].sfJobId) : null, direction: 'system', action: 'error', ok: false, message: String(e.message || '').slice(0, 300) });
      }

      // Persist mapping after every WO so concurrent runs (and crash recovery)
      // see fresh entries — closes the race window where two runs could both
      // see a missing entry and create duplicate SF jobs.
      await saveMapping(mapping);

      // Save progress every 4 WOs
      if ((i + 1) % 4 === 0) await saveProgress();
    }

    // 5. Save final results — truncate errors to prevent massive blobs
    log.completed = new Date().toISOString();
    log.mappingCount = Object.keys(mapping).length;
    log.errors = log.errors.map(e => typeof e === 'string' && e.length > 300 ? e.substring(0, 300) + '...' : e);
    log.dedupeReportCount = dedupeReport.length;

    const reportBlob = {
      generated: new Date().toISOString(),
      totalIssues: dedupeReport.length,
      byReason: dedupeReport.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
      items: dedupeReport,
    };

    // Phase 2 dual-write: mirror the full mapping into ops.resq_sf_links and
    // append this run's events to ops.sync_events. The Blob above stays the
    // authoritative read source; this is additive and strictly non-fatal so a
    // Supabase blip can never break the live sync.
    try {
      const linkRows = Object.entries(mapping).map(([id, e]) => mapEntryToLinkRow(id, e));
      const linkCount = await bulkUpsertLinks(linkRows);
      const evCount = await bulkInsertEvents(syncEvents);
      log.steps.push(`Dual-write → ops: ${linkCount} links, ${evCount} events`);
    } catch (e) {
      log.errors.push(`Dual-write to ops failed (non-fatal): ${e.message.substring(0, 200)}`);
    }

    await Promise.all([
      saveMapping(mapping),
      saveBlob('last-sync', JSON.stringify(log)),
      log.errors.length ? saveBlob('last-errors', JSON.stringify(log.errors)) : saveBlob('last-errors', '[]'),
      saveBlob('dedupe-report', JSON.stringify(reportBlob)),
    ]);

    console.log(`[SYNC] Done: ${log.created} created, ${log.updated} updated, ${log.errors.length} errors, ${dedupeReport.length} review items`);

  } catch (e) {
    log.errors.push(e.message);
    log.completed = new Date().toISOString();
    try { await saveBlob('last-sync', JSON.stringify(log)); } catch (x) {}
    console.error('[SYNC] Failed:', e.message);
  } finally {
    await releaseSyncLock();
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

// --- Sync lock ---
async function acquireSyncLock() {
  const store = await getStore();
  if (!store) return true; // best-effort: proceed if blobs unavailable
  try {
    const raw = await store.get(SYNC_LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw);
      if (lock && lock.ts && (Date.now() - lock.ts) < SYNC_LOCK_TTL_MS) {
        return false;
      }
    }
    await store.set(SYNC_LOCK_KEY, JSON.stringify({ ts: Date.now() }));
    return true;
  } catch (e) {
    return true;
  }
}

async function releaseSyncLock() {
  const store = await getStore();
  if (!store) return;
  try { await store.delete(SYNC_LOCK_KEY); } catch (e) {}
}

// --- Timeout wrapper ---
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

// --- Process new unmapped WO ---
async function processNewWO(wo, mapping, syncCustomers) {
  const result = { steps: [], errors: [], created: 0, report: [] };
  const cust = classifySyncCustomer(wo.facility, syncCustomers);
  if (!cust) {
    const names = syncCustomers.map(c => c.qbo_customer_name).join(' / ') || 'no linked customers';
    result.steps.push(`Skip ${wo.code}: "${wo.facility}" matches no linked customer (${names})`);
    return result;
  }

  const sfCustomerKey = stemFor(cust) || cust.qbo_customer_id;
  const customerName = sfNameFor(cust);
  if (!customerName) {
    result.errors.push(`No SF/QBO customer name on linked customer ${cust.qbo_customer_id}.`);
    return result;
  }

  const resqRef = wo.code.startsWith('R') ? wo.code : `R${wo.code}`;

  // Safety net: before creating, check SF for any existing job with this po_number.
  // Catches: prior crashed runs, parallel sync races, and SF returning a job
  // creation success that our code mis-handled.
  try {
    const allMatches = await findSfJobsByPoNumber(resqRef);
    // Ignore Cancelled jobs — they're already handled and shouldn't be linked to or counted as duplicates.
    const existing = allMatches.filter(j => !isSfCancelled(j.status));
    if (existing.length > 0) {
      const best = pickBestSfJob(existing, null);

      if (best) {
        // A progressed match exists — link to it and cancel Unscheduled duplicates.
        for (const j of existing) {
          if (String(j.id) === String(best.id)) continue;
          if (isSfUnscheduled(j.status)) {
            const c = await cancelSfJob(j.id);
            if (c.ok) result.steps.push(`🧹 Cancelled duplicate Unscheduled SF #${j.id} for ${wo.code}`);
            else {
              result.errors.push(`Cancel SF #${j.id} for ${wo.code}: ${c.error}`);
              result.report?.push({ resqCode: wo.code, reason: 'cancel_failed', sfJobId: j.id, status: j.status, error: c.error });
            }
          }
        }
        mapping[wo.id] = {
          sfJobId: best.id,
          sfJobNumber: best.number || best.job_number || best.id,
          resqCode: wo.code, resqStatus: wo.status,
          sfStatus: best.status || 'Unscheduled',
          facility: wo.facility, customer: sfCustomerKey, customerQboId: cust.qbo_customer_id, customerName, title: wo.title,
          createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(),
          linkedExisting: true, reconciled: true,
        };
        result.steps.push(`🔗 Linked existing progressed SF #${best.id} (${best.status}) for ${wo.code}`);
        return result;
      }

      // No progressed match. Pick one of the existing jobs to link to (so we
      // don't create yet another), but flag for manual review if there are
      // multiple matches or a non-trivial status mix.
      const fallback = existing.find(j => isSfUnscheduled(j.status)) || existing[0];
      mapping[wo.id] = {
        sfJobId: fallback.id,
        sfJobNumber: fallback.number || fallback.job_number || fallback.id,
        resqCode: wo.code, resqStatus: wo.status,
        sfStatus: fallback.status || 'Unscheduled',
        facility: wo.facility, customer: sfCustomerKey, customerQboId: cust.qbo_customer_id, customerName, title: wo.title,
        createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(),
        linkedExisting: true, reconciled: true,
      };
      result.steps.push(`🔗 Linked existing SF #${fallback.id} (${fallback.status}) for ${wo.code} (no progressed match)`);
      if (existing.length > 1) {
        result.report?.push({
          resqCode: wo.code,
          reason: 'duplicates_no_progressed',
          message: `${existing.length} SF jobs match po_number=${resqRef}, none in a progressed status. Manual review needed to consolidate.`,
          linkedTo: fallback.id,
          sfJobs: existing.map(j => ({ id: j.id, number: j.number || j.job_number || null, status: j.status, created_at: j.created_at || null })),
        });
      }
      return result;
    }
  } catch (e) {
    // Lookup failure is non-fatal — log and proceed to create. Better to risk a
    // duplicate than skip the WO entirely.
    result.steps.push(`po_number lookup failed for ${wo.code}: ${e.message.substring(0, 150)}`);
  }

  // Create new SF job
  try {
    // Resolve the configured SF customer name against a real SF customer record
    // BEFORE creating. SF's POST /jobs requires customer_name to match exactly;
    // a punctuation/spacing drift (e.g. "STARBIRD CHICKEN: RESQ" vs the actual
    // record) makes every create throw and the WO never maps — ResQ then drifts
    // away from SF. Self-heal small mismatches; otherwise fail loudly so the
    // operator can correct the SF record / the ops.sync_customers row.
    // Prefer the linked SF customer id — create the job by id directly, which
    // bypasses the /customers lookup that's been returning 401. Falls back to
    // name resolution only when no id is linked.
    // Resolve the SF customer by NAME (auth works now; SF's by-id GET proved
    // unreliable). Exact match on the configured name, then a stem search
    // (e.g. "melt"/"starbird" + "resq") that self-heals punctuation drift.
    // HARD-CODED SF customer names — the exact values that match the live
    // Service Fusion records. Bypasses all lookup for the two live RESQ
    // customers. (Starbird's SF record has NO colon — "STARBIRD CHICKEN RESQ";
    // the colon variant 422'd on POST /jobs as "Customer Name can not be found".)
    const HARDCODED_SF_CUSTOMER = {
      melt: 'THE MELT RESQ',
      starbird: 'STARBIRD CHICKEN RESQ',
    };
    const resolvedName = HARDCODED_SF_CUSTOMER[String(sfCustomerKey).toLowerCase()]
      || await resolveSfCustomerName(customerName, sfCustomerKey, cust.sf_customer_id);
    if (!resolvedName) {
      result.errors.push(`SF customer not found for ${wo.code}: "${customerName}" (stem "${sfCustomerKey}", id ${cust.sf_customer_id || 'none'}) didn't match a Service Fusion customer.`);
      result.report?.push({ resqCode: wo.code, reason: 'sf_customer_not_found', message: `No SF customer matches "${customerName}" (stem "${sfCustomerKey}").`, facility: wo.facility });
      return result;
    }
    const sfJob = await createSfJob(wo, resolvedName);

    // Determine initial SF status based on ResQ status
    const resqStatus = (wo.status || '').toUpperCase();
    const targetSfStatus = RESQ_TO_SF_STATUS[resqStatus] || 'Unscheduled';

    mapping[wo.id] = {
      sfJobId: sfJob.id,
      sfJobNumber: sfJob.number || sfJob.job_number || sfJob.id,
      resqCode: wo.code, resqStatus: wo.status, sfStatus: targetSfStatus,
      facility: wo.facility, customer: sfCustomerKey, customerQboId: cust.qbo_customer_id, customerName, title: wo.title,
      createdAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(),
      reconciled: true,
    };
    result.created++;
    result.steps.push(`✓ Created SF #${sfJob.id} (${resqRef}) for ${wo.code} (${wo.facility})`);
  } catch (e) {
    result.errors.push(`Create SF job for ${wo.code}: ${e.message.substring(0, 300)}`);
  }
  return result;
}

// --- Bidirectional Status Sync ---
async function syncBidirectional(session, resqWO, mapEntry) {
  const result = { steps: [], errors: [], updated: 0, report: [] };

  try {
    // One-shot duplicate reconciliation for entries created before the
    // duplicate-prevention fix. Runs once per WO (gated by mapEntry.reconciled).
    if (!mapEntry.reconciled) {
      try {
        const resqRef = resqWO.code.startsWith('R') ? resqWO.code : `R${resqWO.code}`;
        const allMatches = await findSfJobsByPoNumber(resqRef);
        // Skip Cancelled jobs — already handled, not duplicates.
        const matches = allMatches.filter(j => !isSfCancelled(j.status));
        if (matches.length > 1) {
          const best = pickBestSfJob(matches, mapEntry.sfJobId);
          if (best) {
            // Progressed match exists — re-link mapping to it and cancel any Unscheduled duplicates.
            if (String(best.id) !== String(mapEntry.sfJobId)) {
              result.steps.push(`🔗 Re-linked ${resqWO.code}: SF #${mapEntry.sfJobId} → SF #${best.id} (${best.status})`);
              mapEntry.replacedSfJobId = mapEntry.sfJobId;
              mapEntry.sfJobId = best.id;
              mapEntry.sfJobNumber = best.number || best.job_number || best.id;
              mapEntry.sfStatus = best.status;
              mapEntry.relinkedAt = new Date().toISOString();
            }
            for (const j of matches) {
              if (String(j.id) === String(best.id)) continue;
              if (isSfUnscheduled(j.status)) {
                const c = await cancelSfJob(j.id);
                if (c.ok) result.steps.push(`🧹 Cancelled duplicate Unscheduled SF #${j.id} for ${resqWO.code}`);
                else {
                  result.errors.push(`Cancel duplicate SF #${j.id} for ${resqWO.code}: ${c.error}`);
                  result.report?.push({ resqCode: resqWO.code, reason: 'cancel_failed', sfJobId: j.id, status: j.status, error: c.error });
                }
              }
            }
          } else {
            // Multiple matches but none progressed — flag for manual review.
            result.report?.push({
              resqCode: resqWO.code,
              reason: 'duplicates_no_progressed',
              message: `${matches.length} SF jobs match po_number=${resqRef}, none in a progressed status. Manual review needed.`,
              currentlyLinked: mapEntry.sfJobId,
              sfJobs: matches.map(j => ({ id: j.id, number: j.number || j.job_number || null, status: j.status, created_at: j.created_at || null })),
            });
          }
        } else if (allMatches.length === 0 && mapEntry.sfJobId) {
          // No SF job at all has this po_number. Mapping points to a job that's
          // been deleted, or the po_number was changed manually.
          result.report?.push({
            resqCode: resqWO.code,
            reason: 'no_sf_match',
            message: `Mapping points to SF #${mapEntry.sfJobId} but no SF job has po_number=${resqRef}. Possibly deleted or never created.`,
            currentlyLinked: mapEntry.sfJobId,
          });
        }
        mapEntry.reconciled = true;
      } catch (e) {
        result.errors.push(`Reconcile ${resqWO.code}: ${e.message.substring(0, 200)}`);
      }
    }

    // Fetch current SF job status
    let sfJob;
    try {
      sfJob = await sfRequest('GET', `/jobs/${mapEntry.sfJobId}`);
    } catch (e) {
      const errMsg = e.message.length > 200 ? e.message.substring(0, 200) + '...' : e.message;
      // If SF returns 404, the job was deleted — mark it dead so we stop retrying
      if (e.message.includes('404')) {
        mapEntry.sfDeleted = true;
        mapEntry.lastSyncAt = new Date().toISOString();
        result.errors.push(`SF job ${mapEntry.sfJobId} deleted (404) — marked dead, will skip`);
      } else {
        result.errors.push(`Can't read SF job ${mapEntry.sfJobId}: ${errMsg}`);
      }
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
    // SF scheduled (but NOT "unscheduled") while ResQ is still NOT_YET_SCHEDULED:
    // advance the ResQ WO so it leaves NOT_YET_SCHEDULED (lands at
    // NOT_YET_COMPLETED). Restored from the pre-2026-04-05 status push (removed
    // in d23c9d3) — without it a WO scheduled in SF never gets an
    // appointment/visit, so the completion + photo steps have nothing to attach.
    const sfIsScheduled = sfLower.includes('scheduled') && !sfLower.includes('un');
    const resqNeedsSchedule = sfIsScheduled && resqStatus === 'NOT_YET_SCHEDULED';
    // Re-check photos every pass while the job is completed-but-not-invoiced,
    // so photos added after the first push still flow (dedup is by file_location).
    const needsPhotoTransfer = sfIsCompleted && !mapEntry.invoiceSubmitted;
    const needsInvoiceSubmit = sfIsInvoiced && !mapEntry.invoiceSubmitted;
    // Land the SF job's expenses in Brixpense at the invoice transition
    // (needsInvoiceSubmit) — NOT for every already-invoiced WO, which would
    // mass-backfill historical jobs. SF_EXPENSE_BACKFILL is an explicit one-off
    // allowlist for specific jobs that were invoiced before this landed (e.g.
    // 1086695007, whose expense was lost). Idempotent via expenseLandedId.
    // When a WO is done (completed or invoiced), land its SF expense RECEIPTS
    // into Brixpense as reviewable DRAFTS — scanned (vendor/amount from the
    // receipt image), receipt attached, NOTHING posted to QBO. landSfJobExpense
    // dedups by sf_expense_id + gates to the start date, so this is idempotent
    // and won't mass-backfill ancient jobs. expenseLandedId guards re-runs.
    const needsExpenseLanding = (sfIsInvoiced || sfIsCompleted) && !mapEntry.expenseLandedId;
    // "Provide Update" — complete the visit in ResQ when SF is completed
    // Also trigger if WO is COMPLETED (visit done but needs to transition to NEEDS_INVOICE)
    const needsVisitComplete = sfIsCompleted && !mapEntry.visitCompleted
      && ['SCHEDULED', 'VISIT_SCHEDULED', 'NOT_YET_COMPLETED', 'COMPLETED'].includes(resqStatus);

    if (!sfChanged && !resqChanged && !resqNeedsSchedule && !needsPhotoTransfer && !needsInvoiceSubmit && !needsExpenseLanding && !needsVisitComplete) return result;

    if (sfChanged) {
      result.steps.push(`SF ${mapEntry.sfJobId}: "${mapEntry.sfStatus}" → "${sfStatus}"`);
    }
    if (resqChanged) {
      result.steps.push(`ResQ ${resqWO.code}: "${prevResqStatus}" → "${resqStatus}"`);
    }

    // --- SF Scheduled → advance the ResQ WO out of NOT_YET_SCHEDULED ---
    // Try the ResQ state machine's scheduling target states in order; the first
    // that takes moves the WO to NOT_YET_COMPLETED so it has an appointment/visit
    // for the completion + photo steps below. Non-fatal: log and move on.
    if (resqNeedsSchedule) {
      let scheduled = false;
      const schedErrors = [];
      for (const ts of ['SCHEDULING', 'APPOINTMENT', 'SITE_VISIT', 'DISPATCH']) {
        try {
          await resqGql(session, `mutation($input: VendorChangeWorkOrderStateInput!) {
            vendorChangeWorkOrderState(input: $input) { workOrder { id status } }
          }`, { input: { workOrderId: resqWO.id, targetState: ts } });
          result.steps.push(`→ ResQ ${resqWO.code} scheduled (${ts})`);
          result.updated++;
          scheduled = true;
          break;
        } catch (e) {
          // Keep the FULL ResQ error per target state (incl. extensions.fields
          // with the valid enum values, if ResQ returns them) so we can see
          // exactly what it wants instead of a swallowed "all failed".
          schedErrors.push(`${ts}: ${e.message.substring(0, 300)}`);
        }
      }
      if (!scheduled) result.errors.push(`ResQ schedule ${resqWO.code}: ${schedErrors.join(' | ')}`);
    }

    // --- Provide Update: Complete the visit in ResQ (+ attach photos) ---
    // Now that we know ResQ's Image input shape ({ url }), attach the SF photos
    // AS PART OF completing the visit (endVisit images) — the authorized moment,
    // since ResQ blocks after-image edits once a visit is closed. Relay first.
    if (needsVisitComplete) {
      try {
        const relayed = await relaySfPhotos(mapEntry.sfJobId, mapEntry.photosSentKeys || []);
        if (relayed.errors.length) result.errors.push(`📸 ${resqWO.code} relay: ${relayed.errors[0]}`);
        const updateResult = await provideUpdateToResq(session, resqWO, mapEntry.sfJobId, relayed.imageUrls);
        if (updateResult.steps.length) result.steps.push(...updateResult.steps);
        if (updateResult.errors.length) result.errors.push(...updateResult.errors);
        if (updateResult.completed) {
          mapEntry.visitCompleted = true;
          result.updated++;
          if (updateResult.imagesAttached > 0) {
            result.steps.push(`📸 ${updateResult.imagesAttached} photo(s) attached at completion → ResQ ${resqWO.code}`);
            mapEntry.photosSentKeys = [...(mapEntry.photosSentKeys || []), ...relayed.relayedKeys];
            mapEntry.photosSent = true;
          }
        }
      } catch (e) {
        result.errors.push(`Visit complete ${resqWO.code}: ${e.message.substring(0, 200)}`);
      }
    }

    // --- Transfer photos from SF → ResQ (on Completed or Invoiced) ---
    if (needsPhotoTransfer) {
      try {
        const photoResult = await transferSfPhotosToResq(session, mapEntry.sfJobId, resqWO, mapEntry.photosSentKeys || []);
        if (photoResult.count > 0) {
          result.steps.push(`📸 ${photoResult.count} new photo(s) → ResQ ${resqWO.code}`);
          mapEntry.photosSentKeys = [...(mapEntry.photosSentKeys || []), ...photoResult.sentKeys];
          mapEntry.photosSent = true;
          result.updated++;
        } else if (photoResult.errors.length) {
          // Relay/push failed — surface it; keys not recorded so it retries.
          result.errors.push(`📸 ${resqWO.code} photo push: ${photoResult.errors[0]}`);
        }
        // else: no NEW photos since last pass — no-op, no log spam.
      } catch (e) {
        result.errors.push(`Photos ${resqWO.code}: ${e.message.substring(0, 200)}`);
      }
    }

    // --- Build invoice from SF line items + submit to ResQ (on Invoiced) ---
    if (needsInvoiceSubmit) {
      try {
        const invResult = await buildAndSubmitInvoice(session, mapEntry.sfJobId, resqWO);
        if (invResult.steps.length) result.steps.push(...invResult.steps);
        if (invResult.errors.length) result.errors.push(...invResult.errors);
        result.updated += invResult.updated || 0;
        // Only mark submitted if it actually succeeded
        if (invResult.updated > 0) {
          mapEntry.invoiceSubmitted = true;
        }
      } catch (e) { result.errors.push(`ResQ invoice ${resqWO.code}: ${e.message.substring(0, 200)}`); }
    }

    // --- Land the SF job's expenses in Brixpense (once invoiced, idempotent) ---
    // Cron-context landing uses the system submitter (no operator in scope).
    // The 🔒 Close button still lands with the actual operator; whichever runs
    // first sets expenseLandedId and the other skips.
    if (needsExpenseLanding) {
      try {
        const { landSfJobExpense } = await import('./lib/sf-expense.mjs');
        const r = await landSfJobExpense({ sfJobId: mapEntry.sfJobId, resqCode: resqWO.code, submitter: SF_EXPENSE_SUBMITTER });
        if (r.ok) {
          mapEntry.expenseLandedId = true;
          result.updated++;
          result.steps.push(`💵 SF receipts → Brixpense ${resqWO.code} (${r.landed} draft(s), ${r.attached} receipt(s))`);
        } else if (r.empty) {
          mapEntry.expenseLandedId = 'none'; // no receipts to land — don't retry every run
          if (r.error) result.steps.push(`📎 ${resqWO.code}: ${String(r.error).slice(0, 160)}`);
        } else {
          result.errors.push(`SF expense land ${resqWO.code}: ${r.error}`);
        }
      } catch (e) { result.errors.push(`SF expense land ${resqWO.code}: ${e.message.substring(0, 200)}`); }
    }

    // Update mapping with current states
    mapEntry.sfStatus = sfStatus;
    mapEntry.resqStatus = resqWO.status;
    mapEntry.lastSyncAt = new Date().toISOString();

  } catch (e) {
    result.errors.push(`Sync ${resqWO.code}: ${e.message.substring(0, 200)}`);
  }
  return result;
}

// --- Fetch syncable ResQ WOs ---
async function fetchSyncableWOs(session, syncCustomers) {
  const facilityKeywords = allFacilityKeywords(syncCustomers);
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
      // Brix can sit in EITHER the primary vendor slot or the executing-vendor
      // slot. Starbird WOs are frequently held by a property-management vendor
      // and dispatched to Brix as executingVendor — the old `||` short-circuit
      // only checked executingVendor when vendor was absent, so those WOs were
      // silently dropped and ResQ drifted out of sync with SF. Check both.
      const v = `${e.node.vendor?.name || ''} ${e.node.executingVendor?.name || ''}`.toLowerCase();
      if (!BRIX_VENDOR_KEYWORDS.some(k => v.includes(k))) return false;
      const f = (e.node.facility?.name || '').toLowerCase();
      return facilityKeywords.some(k => f.includes(k));
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

// --- SF Duplicate-prevention Helpers ---

// Find all SF jobs whose po_number matches the ResQ ref. Used to:
//   1. Avoid creating a 2nd SF job when one already exists (race-safety)
//   2. Reconcile pre-existing duplicates: re-link mapping to the progressed
//      job and cancel the unscheduled one(s).
async function findSfJobsByPoNumber(poNumber) {
  if (!poNumber) return [];
  // Try filter first (cheaper). Fall back to scanning recent jobs if filter unsupported.
  try {
    const res = await sfRequest('GET', `/jobs?filters[po_number]=${encodeURIComponent(poNumber)}&per-page=50`);
    const items = res.items || res.data || [];
    if (items.length) {
      // Some SF deployments ignore the filter and return all jobs; double-check po_number client-side.
      const exact = items.filter(j => String(j.po_number || '').trim() === String(poNumber).trim());
      if (exact.length) return exact;
    }
  } catch (e) { /* fall through to scan */ }

  // Fallback: scan a few pages of recent jobs and match po_number client-side.
  const matches = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const res = await sfRequest('GET', `/jobs?per-page=100&sort=-created_at&page=${page}`);
      const jobs = res.items || res.data || [];
      if (jobs.length === 0) break;
      for (const j of jobs) {
        if (String(j.po_number || '').trim() === String(poNumber).trim()) matches.push(j);
      }
    } catch (e) { break; }
  }
  return matches;
}

function isSfUnscheduled(status) {
  return (status || '').toLowerCase().includes('unschedul');
}

// Cancelled jobs are treated as "already handled" — never re-flagged as
// duplicates and never re-linked to. This means cancelling a duplicate via
// the UI immediately removes it from the next sync's report.
function isSfCancelled(status) {
  return (status || '').toLowerCase().includes('cancel');
}

// Whitelist of statuses that mean "actively progressed" — only these qualify
// as a re-link target, and only their presence justifies cancelling an
// Unscheduled duplicate. Cancelled / On Hold / unknown statuses are treated
// like Unscheduled: never linked to, and never trigger auto-cancel.
function isSfProgressed(status) {
  const s = (status || '').toLowerCase().trim();
  if (!s) return false;
  if (s.includes('unschedul')) return false;
  if (s.includes('cancel')) return false;
  if (s.includes('hold')) return false;
  return s.includes('schedul') ||   // Scheduled- Service / Re-scheduled / etc.
         s.includes('assign') ||    // Assigned / Re-assigned
         s.includes('dispatch') ||  // Dispatched
         s.includes('progress') ||  // In Progress
         s.includes('site') ||      // On Site
         s.includes('complet') ||   // Completed- Service
         s.includes('invoic');      // Invoiced
}

// Pick which SF job a duplicate set should collapse to.
// Only ever returns a *progressed* job. Returns null when no progressed match
// exists, signalling "leave alone — needs manual review".
function pickBestSfJob(jobs, currentLinkedId) {
  if (!jobs.length) return null;
  const progressed = jobs.filter(j => isSfProgressed(j.status));
  if (progressed.length === 0) return null;
  if (progressed.length === 1) return progressed[0];

  // Prefer the currently-linked job if it's already progressed.
  if (currentLinkedId) {
    const cur = progressed.find(j => String(j.id) === String(currentLinkedId));
    if (cur) return cur;
  }
  const order = ['invoic', 'complet', 'progress', 'site', 'dispatch', 'assign', 'schedul'];
  for (const stage of order) {
    const m = progressed.find(j => (j.status || '').toLowerCase().includes(stage));
    if (m) return m;
  }
  return progressed[0];
}

// Cancel an SF job (soft — set status to Cancelled, preserve history).
async function cancelSfJob(jobId) {
  try {
    await sfRequest('PUT', `/jobs/${jobId}`, { status: 'Cancelled' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.message || '').substring(0, 200) };
  }
}

// Resolve the configured SF customer name to a real SF customer record name.
// Returns the exact SF `customer_name` to use, or null when no confident match
// exists (caller then fails loudly instead of creating a job SF will reject).
//   1. Exact match (case/whitespace-insensitive) on the configured name.
//   2. Stem search — exactly one RESQ sync customer containing the brand stem
//      (e.g. "starbird") self-heals punctuation/spacing drift.
// Conservative on purpose: never guesses between multiple candidates.
async function resolveSfCustomerName(configuredName, stem, sfCustomerId) {
  // 0. Linked SF id — match it inside a name/stem search. The list search
  //    returns customer ids and works; the by-id GET endpoint does not.
  if (sfCustomerId) {
    for (const q of [stem, configuredName].filter(Boolean)) {
      try {
        const res = await sfRequest('GET', `/customers?filters[customer_name]=${encodeURIComponent(q)}&per-page=50`);
        const items = res.items || res.data || (Array.isArray(res) ? res : []);
        const hit = items.find(c => String(c.id ?? c.customer_id ?? '') === String(sfCustomerId));
        if (hit && hit.customer_name) return hit.customer_name;
      } catch (e) { /* fall through to name search */ }
    }
  }

  const want = String(configuredName || '').trim().toLowerCase();
  if (!want) return null;

  // 1. Exact (case/space-insensitive) match on the configured name.
  try {
    const res = await sfRequest('GET', `/customers?filters[customer_name]=${encodeURIComponent(configuredName)}&per-page=25`);
    const items = res.items || res.data || (Array.isArray(res) ? res : []);
    const exact = items.find(c => String(c.customer_name || '').trim().toLowerCase() === want);
    if (exact) return exact.customer_name;
  } catch (e) { /* fall through to stem search */ }

  // 2. Stem search — find the single RESQ sync customer for this brand.
  const s = String(stem || '').trim().toLowerCase();
  if (s) {
    try {
      const res = await sfRequest('GET', `/customers?filters[customer_name]=${encodeURIComponent(stem)}&per-page=50`);
      const items = res.items || res.data || (Array.isArray(res) ? res : []);
      const resq = items.filter(c => {
        const n = String(c.customer_name || '').toLowerCase();
        return n.includes(s) && n.includes('resq');
      });
      if (resq.length === 1) return resq[0].customer_name;
    } catch (e) { /* fall through */ }
  }
  return null;
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

  // SF's POST /jobs only accepts customer_name (customer_id is rejected 422).
  return sfRequest('POST', '/jobs', {
    customer_name: customerName,
    description,
    status: 'Unscheduled',
    priority: resqWO.isUrgent ? 'Urgent' : 'Normal',
    po_number: resqRef,
  });
}

// --- Transfer SF Photos → ResQ ---
// Lists the SF job's pictures, relays each through the public resq-photo-relay
// bucket (short URL — ResQ stores the ref in varchar(100)), and attaches them
// as after-images to the WO's visit. Runs after visit-complete, before invoice.
// Lists a SF job's pictures and relays the NEW ones (not already sent, keyed by
// SF file_location) to short public URLs. Returns { imageUrls, relayedKeys,
// errors }. Used both to attach photos during visit completion (the authorized
// path — ResQ rejects after-images on an already-closed visit) and for the
// post-completion after-image fallback below.
async function relaySfPhotos(sfJobId, alreadySent = []) {
  const out = { imageUrls: [], relayedKeys: [], errors: [] };
  const { listJobPictures, pictureToPublicUrl } = await import('./lib/sf-assets.mjs');
  let pics;
  try {
    pics = await listJobPictures(sfJobId);
  } catch (e) {
    out.errors.push(`List SF photos ${sfJobId}: ${e.message.substring(0, 200)}`);
    return out;
  }
  if (!pics.length) return out;
  const sentSet = new Set(alreadySent);
  const newPics = pics.filter((p) => p.file_location && !sentSet.has(p.file_location));
  for (let i = 0; i < newPics.length; i++) {
    const r = await pictureToPublicUrl(newPics[i], sfJobId, `${Date.now()}-${i}`);
    if (r.ok) { out.imageUrls.push(r.url); out.relayedKeys.push(newPics[i].file_location); }
    else out.errors.push(r.error);
  }
  return out;
}

async function transferSfPhotosToResq(session, sfJobId, resqWO, alreadySent = []) {
  const result = { count: 0, sentKeys: [], errors: [] };

  const relay = await relaySfPhotos(sfJobId, alreadySent);
  result.errors.push(...relay.errors);
  if (!relay.imageUrls.length) return result;
  const imageUrls = relay.imageUrls;
  const relayedKeys = relay.relayedKeys;

  // Resolve the WO's visit (completed by provideUpdateToResq just before).
  let visitId;
  try {
    const woData = await resqGql(session, `{
      workOrders(first: 1, code: "${resqWO.code}") {
        edges { node { latestVisit { id } inProgressVisit { id } } }
      }
    }`);
    const node = woData.data?.workOrders?.edges?.[0]?.node;
    visitId = node?.inProgressVisit?.id || node?.latestVisit?.id;
  } catch (e) {
    result.errors.push(`Get visit for photos ${resqWO.code}: ${e.message.substring(0, 200)}`);
    return result;
  }
  if (!visitId) {
    result.errors.push(`No ResQ visit on ${resqWO.code} to attach ${imageUrls.length} photo(s)`);
    return result;
  }

  // Vendor session first, then the facility account. The Brix vendor identity
  // isn't authorized to add after-images (ResQ returns AuthorizationError —
  // every push since the feature launched failed this way), so fall back to the
  // facility login, exactly as submitRecordOfWork / createOriginalVendorInvoice
  // already do for the same vendor-authorization gap.
  const addImagesMutation = `mutation($input: AddAfterImagesToVisitInput!) {
    addAfterImagesToVisit(input: $input) { __typename }
  }`;
  // ResQ's Image input is { url: String } (confirmed via schema introspection) —
  // wrap each relayed URL; bare strings gave "Expected type 'Image' to be a mapping".
  const addImagesVars = { input: { visit: visitId, images: imageUrls.map((u) => ({ url: u })) } };
  const pushErrors = [];
  for (const label of ['vendor', 'facility']) {
    try {
      const sess = label === 'vendor' ? session : await resqLogin({ facility: true });
      await resqGql(sess, addImagesMutation, addImagesVars);
      result.count = imageUrls.length;
      result.sentKeys = relayedKeys;
      return result;
    } catch (e) {
      pushErrors.push(`${label}: ${e.message.substring(0, 300)}`);
    }
  }
  result.errors.push(`addAfterImages ${resqWO.code}: ${pushErrors.join(' | ')}`);
  return result;
}

// --- Provide Update: Complete the visit in ResQ ---
// When SF marks a job "Completed-Service", we end the visit in ResQ
// so it transitions to NEEDS_INVOICE.
// Flow: query WO for appointment + visit → startVisit (if needed) → endVisit
async function provideUpdateToResq(session, resqWO, sfJobId, images = []) {
  const result = { steps: [], errors: [], completed: false, imagesAttached: 0 };

  // 1. Fetch the SF job for completion notes
  let sfJob;
  try {
    sfJob = await sfRequest('GET', `/jobs/${sfJobId}?expand=notes,visits`);
  } catch (e) {
    result.errors.push(`Fetch SF job ${sfJobId} for update: ${e.message.substring(0, 200)}`);
    return result;
  }

  // Build notes from SF job
  const sfNotes = (sfJob.notes || []).map(n => n.body || n.text || '').filter(Boolean).join('\n');
  const completionNotes = sfNotes || sfJob.description || `Completed via Service Fusion job #${sfJobId}`;

  // 2. Get visit + appointment from the ResQ WO
  let visitId, appointmentId;
  try {
    const woData = await resqGql(session, `{
      workOrders(first: 1, code: "${resqWO.code}") {
        edges { node {
          id
          latestVisit { id outcome }
          inProgressVisit { id outcome }
          appointment { id }
          upcomingAppointment { id }
        } }
      }
    }`);
    const woNode = woData.data?.workOrders?.edges?.[0]?.node;
    const inProgress = woNode?.inProgressVisit;
    const latest = woNode?.latestVisit;
    visitId = inProgress?.id || latest?.id;
    appointmentId = woNode?.appointment?.id || woNode?.upcomingAppointment?.id;

    // If latest visit is already COMPLETED, nothing to do
    if (latest?.outcome === 'COMPLETED' && !inProgress) {
      result.steps.push(`${resqWO.code} visit already completed`);
      result.completed = true;
      return result;
    }
  } catch (e) {
    result.errors.push(`Get visit for ${resqWO.code}: ${e.message.substring(0, 200)}`);
    return result;
  }

  // 3. If no visit exists, start one using the appointment
  if (!visitId) {
    if (!appointmentId) {
      result.errors.push(`No visit or appointment on ${resqWO.code} — cannot complete`);
      return result;
    }

    result.steps.push(`No visit on ${resqWO.code}, starting via appointment...`);
    try {
      const startRes = await resqGql(session, `mutation($input: StartVisitMutationInput!) {
        startVisit(input: $input) {
          visit { id }
        }
      }`, { input: {
        appointmentId,
        facilityManagerName: 'On-site Manager',
        images: [],
      }});
      visitId = startRes.data?.startVisit?.visit?.id;
      if (!visitId) throw new Error('No visit ID returned from startVisit');
      result.steps.push(`→ ${resqWO.code} visit started`);
    } catch (e) {
      // Fallback: try vendorChangeWorkOrderState
      result.steps.push(`startVisit failed: ${e.message.substring(0, 100)}`);
      try {
        await resqGql(session, `mutation($input: VendorChangeWorkOrderStateInput!) {
          vendorChangeWorkOrderState(input: $input) { __typename }
        }`, { input: { workOrderId: resqWO.id, completed: true } });
        result.steps.push(`→ ${resqWO.code} marked completed via state change`);
        result.completed = true;
        return result;
      } catch (e2) {
        result.errors.push(`Start visit ${resqWO.code}: startVisit failed (${e.message.substring(0, 100)}), state change also failed (${e2.message.substring(0, 100)})`);
        return result;
      }
    }
  }

  // 4. End the visit. Normal path uses outcome COMPLETED (the value ResQ has
  //    accepted for every WO that already has a started visit). ResQ rejects
  //    that outcome on some visits (e.g. one we just started this pass) with a
  //    "malformed/unprocessable arguments" ValidationError, so retry once with
  //    RESOLVED before falling back to captureVisitNotes. The retry only runs
  //    after the normal attempt fails, so it can't regress the happy path.
  const cleanNotes = completionNotes.substring(0, 2000);
  // ResQ Image input is { url: String } — wrap the relayed URL strings. Attach
  // photos AS PART OF completing the visit (we're authorized to endVisit; ResQ
  // blocks after-image edits on an already-closed visit).
  const imageObjs = (images || []).map((u) => ({ url: u }));
  const endErrors = [];
  for (const outcome of ['COMPLETED', 'RESOLVED']) {
    try {
      await resqGql(session, `mutation($input: EndVisitInput!) {
        endVisit(input: $input) { __typename }
      }`, { input: {
        visit: visitId,
        outcome,
        notes: cleanNotes,
        recommendations: '',
        images: imageObjs,
      }});
      if (images.length) result.imagesAttached = images.length;
      result.steps.push(`✓ ${resqWO.code} visit completed (${outcome})${images.length ? ` +${images.length} photo(s)` : ''}`);
      result.completed = true;
      return result;
    } catch (e) {
      // Keep the full ResQ error (incl. extensions.fields.__all__) — the old
      // substring(0,200) cut it off right before the actual reason.
      endErrors.push(`outcome=${outcome}: ${e.message.substring(0, 600)}`);
      result.steps.push(`endVisit (${outcome}) failed for ${resqWO.code}`);
    }
  }

  // Fallback: capture notes without ending the visit.
  try {
    await resqGql(session, `mutation($input: CaptureVisitNotesInput!) {
      captureVisitNotes(input: $input) { __typename }
    }`, { input: {
      visit: visitId,
      notes: cleanNotes,
      recommendations: '',
      images: imageObjs,
    }});
    if (images.length) result.imagesAttached = images.length;
    result.steps.push(`→ ${resqWO.code} visit notes captured (fallback)`);
    result.completed = true;
  } catch (e2) {
    result.errors.push(`Complete visit ${resqWO.code}: endVisit [${endErrors.join(' | ')}], captureVisitNotes (${e2.message.substring(0, 600)})`);
  }

  return result;
}

// --- Build Invoice from SF Line Items → Submit to ResQ ---
// Full 5-mutation flow: CreateRecordOfWork → SaveRecordOfWork → SubmitRecordOfWork
//   → CreateOriginalVendorInvoice → PMC_CreateUpdatePayoutOffer
async function buildAndSubmitInvoice(session, sfJobId, resqWO) {
  const result = { steps: [], errors: [], updated: 0 };

  // Fetch SF job with invoices + line items expanded
  let sfJob;
  try {
    sfJob = await sfRequest('GET', `/jobs/${sfJobId}?expand=invoices,products,services,labor_charges,expenses,other_charges`);
  } catch (e) {
    result.errors.push(`Fetch SF invoice data for ${sfJobId}: ${e.message.substring(0, 200)}`);
    return result;
  }

  // Get the SF invoice number
  const sfInvoices = sfJob.invoices || [];
  const sfInvoice = sfInvoices[sfInvoices.length - 1];
  const invoiceNumber = sfInvoice?.number ? String(sfInvoice.number) : '';
  const refNumber = invoiceNumber || (resqWO.code.startsWith('R') ? resqWO.code : `R${resqWO.code}`);

  // Build ResQ line items from SF data (using correct ResQ field names)
  const lineItems = [];
  let order = 0;

  // Products → ITEM_TYPE_PART
  for (const p of (sfJob.products || [])) {
    lineItems.push({
      order: order++, itemType: 'ITEM_TYPE_PART',
      quantity: String(p.multiplier || 1), rate: String(p.rate || 0),
      description: p.description || p.name || 'Part',
      partName: p.name || null, partManufacturer: null, partNumber: null,
      promotionType: null, ratePercentage: null,
      discount: '0.0', revShare: '0.0000',
      warranty: false, overtime: false, taxRateIds: [],
    });
  }

  // Services → ITEM_TYPE_SERVICE_CHARGE
  for (const s of (sfJob.services || [])) {
    lineItems.push({
      order: order++, itemType: 'ITEM_TYPE_SERVICE_CHARGE',
      quantity: String(s.multiplier || 1), rate: String(s.rate || 0),
      description: s.description || s.name || 'Service',
      partName: null, partManufacturer: null, partNumber: null,
      promotionType: null, ratePercentage: null,
      discount: '0.0', revShare: '0.0000',
      warranty: false, overtime: false, taxRateIds: [],
    });
  }

  // Labor charges → ITEM_TYPE_LABOUR
  for (const l of (sfJob.labor_charges || [])) {
    const hours = l.labor_time ? parseFloat(l.labor_time) : 0;
    if (hours > 0 || l.labor_time_cost) {
      lineItems.push({
        order: order++, itemType: 'ITEM_TYPE_LABOUR',
        quantity: String(hours || 1), rate: String(l.labor_time_rate || 0),
        description: `Labor${l.user ? ' - ' + l.user : ''}${l.labor_date ? ' (' + l.labor_date + ')' : ''}`,
        partName: null, partManufacturer: null, partNumber: null,
        promotionType: null, ratePercentage: null,
        discount: '0.0', revShare: '0.0000',
        warranty: false, overtime: false, taxRateIds: [],
      });
    }
    const driveHours = l.drive_time ? parseFloat(l.drive_time) : 0;
    if (driveHours > 0 && l.is_drive_time_billed) {
      lineItems.push({
        order: order++, itemType: 'ITEM_TYPE_TRAVEL',
        quantity: String(driveHours), rate: String(l.drive_time_rate || 0),
        description: `Drive time${l.user ? ' - ' + l.user : ''}`,
        partName: null, partManufacturer: null, partNumber: null,
        promotionType: null, ratePercentage: null,
        discount: '0.0', revShare: '0.0000',
        warranty: false, overtime: false, taxRateIds: [],
      });
    }
  }

  // Expenses → ITEM_TYPE_OTHER
  for (const ex of (sfJob.expenses || [])) {
    if (ex.is_billable && ex.amount) {
      lineItems.push({
        order: order++, itemType: 'ITEM_TYPE_OTHER',
        quantity: '1', rate: String(ex.amount),
        description: ex.notes || ex.category || 'Expense',
        partName: null, partManufacturer: null, partNumber: null,
        promotionType: null, ratePercentage: null,
        discount: '0.0', revShare: '0.0000',
        warranty: false, overtime: false, taxRateIds: [],
      });
    }
  }

  // Other charges → ITEM_TYPE_OTHER
  for (const oc of (sfJob.other_charges || [])) {
    lineItems.push({
      order: order++, itemType: 'ITEM_TYPE_OTHER',
      quantity: String(oc.multiplier || 1), rate: String(oc.rate || 0),
      description: oc.description || oc.name || 'Other charge',
      partName: null, partManufacturer: null, partNumber: null,
      promotionType: null, ratePercentage: null,
      discount: '0.0', revShare: '0.0000',
      warranty: false, overtime: false, taxRateIds: [],
    });
  }

  const totalAmount = lineItems.reduce((sum, li) => sum + (parseFloat(li.rate) * parseFloat(li.quantity)), 0);
  const notes = `SF Job #${sfJobId}${invoiceNumber ? ', Invoice #' + invoiceNumber : ''}`;

  // Step 0: Get the invoiceSet ID + check for existing records of work
  let invoiceSetId;
  let existingRowId;
  try {
    const woData = await resqGql(session, `{
      workOrders(first: 1, code: "${resqWO.code}") {
        edges { node {
          invoiceSets { id code recordOfWorks { id vendorReferenceNumber lineItems { itemType } } }
          vendor { id }
        } }
      }
    }`);
    const woNode = woData.data?.workOrders?.edges?.[0]?.node;
    const sets = woNode?.invoiceSets || [];
    if (sets.length > 0) {
      invoiceSetId = sets[0].id;
      // Reuse existing ROW if one has line items or use the latest one
      const rows = sets[0].recordOfWorks || [];
      const withItems = rows.find(r => r.lineItems?.length > 0);
      if (withItems) existingRowId = withItems.id;
    }
    var vendorId = woNode?.vendor?.id;
  } catch (e) {
    result.errors.push(`Get invoiceSet for ${resqWO.code}: ${e.message.substring(0, 200)}`);
    return result;
  }

  if (!invoiceSetId) {
    result.errors.push(`No invoiceSet found on ${resqWO.code} — WO may not be in NEEDS_INVOICE state`);
    return result;
  }

  // Step 1: Create Record of Work (or reuse existing)
  let recordOfWorkId = existingRowId;
  if (recordOfWorkId) {
    result.steps.push(`→ ${resqWO.code} reusing existing record of work`);
  } else {
    try {
      const r1 = await resqGql(session, `mutation($input: CreateRecordOfWorkMutationInput!) {
        createRecordOfWork(input: $input) {
          recordOfWork { id }
        }
      }`, { input: {
        invoiceSetId,
        vendorReferenceNumber: refNumber,
      }});
      recordOfWorkId = r1.data?.createRecordOfWork?.recordOfWork?.id;
      if (!recordOfWorkId) throw new Error('No recordOfWorkId returned');
      result.steps.push(`→ ${resqWO.code} record of work created`);
    } catch (e) {
      result.errors.push(`Create ROW ${resqWO.code}: ${e.message.substring(0, 200)}`);
      return result;
    }
  }

  // Step 2: Save line items to the record
  try {
    await resqGql(session, `mutation($arguments: SaveRecordOfWorkArguments!) {
      saveRecordOfWork(arguments: $arguments) { __typename }
    }`, { arguments: {
      recordOfWorkId,
      vendorReferenceNumber: refNumber,
      lineItems: lineItems.length > 0 ? lineItems : [{
        order: 0, itemType: 'ITEM_TYPE_SERVICE_CHARGE',
        quantity: '1', rate: String(sfJob.total || 0),
        description: 'Service', partName: null, partManufacturer: null,
        partNumber: null, promotionType: null, ratePercentage: null,
        discount: '0.0', revShare: '0.0000',
        warranty: false, overtime: false, taxRateIds: [],
      }],
      notes,
      vendorNotes: notes,
      overrideNotes: '',
    }});
    result.steps.push(`→ ${resqWO.code} ${lineItems.length} line items saved`);
  } catch (e) {
    result.errors.push(`Save ROW ${resqWO.code}: ${e.message.substring(0, 200)}`);
    return result;
  }

  // Steps 3-5 may need vendor OR facility permissions — try vendor first, then facility
  // Step 3: Submit the record of work
  let submitted = false;
  for (const [label, sess] of [['vendor', session]]) {
    try {
      await resqGql(sess, `mutation($input: SubmitRecordOfWorkInput!) {
        submitRecordOfWork(input: $input) { __typename }
      }`, { input: { recordOfWorkId } });
      result.steps.push(`→ ${resqWO.code} record submitted (${label})`);
      submitted = true;
      break;
    } catch (e) {
      result.steps.push(`Submit ROW (${label}) ${resqWO.code}: ${e.message.substring(0, 300)}`);
    }
  }
  // Also try with facility account if vendor didn't work
  if (!submitted) {
    try {
      const facSession = await resqLogin({ facility: true });
      const r3 = await resqGql(facSession, `mutation($input: SubmitRecordOfWorkInput!) {
        submitRecordOfWork(input: $input) { __typename }
      }`, { input: { recordOfWorkId } });
      result.steps.push(`→ ${resqWO.code} record submitted (facility)`);
      submitted = true;
    } catch (e) {
      result.errors.push(`Submit ROW ${resqWO.code}: vendor + facility both failed. Last: ${e.message.substring(0, 300)}`);
      return result;
    }
  }

  // Step 4: Create the vendor invoice (try vendor, then facility)
  let invoiceCreated = false;
  for (const [label, sess] of [['vendor', session]]) {
    try {
      await resqGql(sess, `mutation($input: CreateOriginalVendorInvoiceMutationInput!) {
        createOriginalVendorInvoice(input: $input) { __typename }
      }`, { input: { invoiceSetId } });
      result.steps.push(`→ ${resqWO.code} vendor invoice created (${label})`);
      invoiceCreated = true;
      break;
    } catch (e) {
      result.steps.push(`Create invoice (${label}) ${resqWO.code}: ${e.message.substring(0, 150)}`);
    }
  }
  if (!invoiceCreated) {
    try {
      const facSession = await resqLogin({ facility: true });
      await resqGql(facSession, `mutation($input: CreateOriginalVendorInvoiceMutationInput!) {
        createOriginalVendorInvoice(input: $input) { __typename }
      }`, { input: { invoiceSetId } });
      result.steps.push(`→ ${resqWO.code} vendor invoice created (facility)`);
    } catch (e) {
      result.steps.push(`Create invoice failed both accounts ${resqWO.code}: ${e.message.substring(0, 100)}`);
    }
  }

  // Step 5: Set payout offer (Standard)
  if (vendorId) {
    try {
      await resqGql(session, `mutation($input: CreateUpdatePayoutOfferMutationInput!) {
        createUpdatePayoutOffer(input: $input) { __typename }
      }`, { input: {
        vendorId,
        effectiveOffer: 'RWZmZWN0aXZlT2ZmZXJOb2RlOk9mZmVyXzQ=', // Standard Payout
        effectiveOfferType: 'Offer',
        payoutRelationship: 'INVOICE_SET',
        invoiceSetId,
        facilityId: resqWO.facilityId || null,
        offResqFacilityId: null,
      }});
      result.steps.push(`→ ${resqWO.code} payout set to Standard`);
    } catch (e) {
      // Non-fatal
      result.steps.push(`Note: payout offer failed for ${resqWO.code}`);
    }
  }

  result.steps.push(`✓ ResQ ${resqWO.code} invoice complete (ref: ${refNumber}, ${lineItems.length} items, $${totalAmount.toFixed(2)})`);
  result.updated++;

  return result;
}

// --- Generate Invoice HTML ---
function generateInvoiceHtml({ resqCode, sfJobId, invoiceNumber, customerName, description, lineItems, totalAmount, date }) {
  const rows = lineItems.map(li => {
    const qty = parseFloat(li.quantity) || 1;
    const price = parseFloat(li.price) || 0;
    const total = qty * price;
    const typeLabel = {
      'ITEM_TYPE_PART': 'Part',
      'ITEM_TYPE_LABOUR': 'Labor',
      'ITEM_TYPE_SERVICE_CHARGE': 'Service',
      'ITEM_TYPE_TRAVEL': 'Travel',
      'ITEM_TYPE_OTHER': 'Other',
    }[li.itemType] || li.itemType;
    return `<tr><td>${typeLabel}</td><td>${li.description}</td><td style="text-align:right">${qty}</td><td style="text-align:right">$${price.toFixed(2)}</td><td style="text-align:right">$${total.toFixed(2)}</td></tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Invoice ${invoiceNumber}</title>
<style>
body{font-family:Arial,sans-serif;margin:40px;color:#333}
h1{color:#1F4E79;margin-bottom:4px}
.meta{color:#666;font-size:0.9em;margin-bottom:20px}
table{width:100%;border-collapse:collapse;margin-top:16px}
th{background:#1F4E79;color:#fff;text-align:left;padding:8px 12px;font-size:0.85em}
td{padding:8px 12px;border-bottom:1px solid #E5E7EB;font-size:0.85em}
tr:nth-child(even) td{background:#F9FAFB}
.total-row td{font-weight:700;border-top:2px solid #1F4E79;font-size:0.95em}
.footer{margin-top:24px;font-size:0.8em;color:#999}
</style></head><body>
<h1>INVOICE</h1>
<div class="meta">
<strong>Invoice #:</strong> ${invoiceNumber}<br>
<strong>Date:</strong> ${date}<br>
<strong>ResQ WO:</strong> ${resqCode}<br>
<strong>SF Job:</strong> #${sfJobId}<br>
${customerName ? `<strong>Customer:</strong> ${customerName}<br>` : ''}
${description ? `<strong>Description:</strong> ${description.substring(0, 200)}<br>` : ''}
</div>
<table>
<thead><tr><th>Type</th><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
<tbody>
${rows}
<tr class="total-row"><td colspan="4" style="text-align:right">TOTAL</td><td style="text-align:right">$${totalAmount.toFixed(2)}</td></tr>
</tbody>
</table>
<div class="footer">Generated automatically from Service Fusion job #${sfJobId} | Brix Beverage Group</div>
</body></html>`;
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

// --- Single work-order sync (Phase 3: on-demand / webhook target) ---
// Runs the same bidirectional sync as the cron, but for exactly one ResQ WO,
// identified by its code. Reuses the proven create/dedup + status/invoice
// logic. Returns { steps, errors, created, updated }.
export async function syncSingleByCode(resqCode) {
  const out = { steps: [], errors: [], created: 0, updated: 0, resqCode };
  const code = String(resqCode || '').replace(/^R/i, '').trim();
  if (!code) { out.errors.push('resqCode required'); return out; }

  let session;
  try { session = await resqLogin(); }
  catch (e) { out.errors.push(`ResQ login: ${e.message}`); return out; }

  // Fetch this one WO with the same node shape fetchSyncableWOs uses.
  let n;
  try {
    const data = await resqGql(session, `query($code:String){ workOrders(first:5, code:$code){ edges { node {
      id code title description status statusDescription
      raisedOn completedOn scheduledForStart scheduledForEnd
      spend vendorTotal isUrgent isCallback onHold serviceCategory
      facility { id name } equipment { id name } vendor { id name } executingVendor { id name }
    } } } }`, { code });
    const edges = data.data?.workOrders?.edges || [];
    n = (edges.find(e => e.node.code === code) || edges[0])?.node;
  } catch (e) { out.errors.push(`ResQ lookup ${code}: ${e.message}`); return out; }
  if (!n) { out.errors.push(`ResQ WO ${code} not found`); return out; }

  const wo = {
    id: n.id, code: n.code, title: n.title || '', description: n.description || '',
    status: n.status, statusDescription: n.statusDescription || '',
    raisedOn: n.raisedOn, completedOn: n.completedOn,
    scheduledStart: n.scheduledForStart, scheduledEnd: n.scheduledForEnd,
    spend: n.spend ? parseFloat(n.spend) : null, vendorTotal: n.vendorTotal ? parseFloat(n.vendorTotal) : null,
    isUrgent: n.isUrgent, isCallback: n.isCallback, onHold: n.onHold, serviceCategory: n.serviceCategory,
    facility: n.facility?.name || '', facilityId: n.facility?.id || '', equipment: n.equipment?.name || '',
  };

  const mapping = await loadMapping();
  const syncCustomers = await loadSyncCustomers();

  try {
    let r;
    if (mapping[wo.id]) {
      if (mapping[wo.id].sfDeleted) { out.steps.push(`${wo.code}: linked SF job was deleted — skipped`); return out; }
      r = await syncBidirectional(session, wo, mapping[wo.id]);
      out.updated += r.updated || 0;
    } else {
      const st = (wo.status || '').toUpperCase();
      if (RESQ_DONE_STATUSES.includes(st)) { out.steps.push(`${wo.code}: already ${wo.status} — no SF job created`); return out; }
      r = await processNewWO(wo, mapping, syncCustomers);
      out.created += r.created || 0;
    }
    if (r.steps?.length) out.steps.push(...r.steps);
    if (r.errors?.length) out.errors.push(...r.errors);
    await saveMapping(mapping);
  } catch (e) {
    out.errors.push(`${wo.code}: ${e.message}`);
  }
  return out;
}

