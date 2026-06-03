// Phase 2 data access for the ResQ <-> SF sync state tables:
//   ops.resq_sf_links  — one row per ResQ WO <-> SF job link (mirrors the
//                        wo-mapping Netlify Blob)
//   ops.sync_events    — append-only audit trail
//
// The worker DUAL-WRITES into these at the end of each run; the Blob is still
// the authoritative read source. All writes are non-fatal — a failure here
// must never break the live sync. Service-role key required for writes.

import { SUPABASE_URL } from '../supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function writeHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'ops',
    'Content-Profile': 'ops',
    Prefer: 'return=minimal,resolution=merge-duplicates',
  };
}

// Map a wo-mapping entry to a resq_sf_links row.
export function mapEntryToLinkRow(resqWoId, e) {
  const s = (v) => (v == null ? null : String(v));
  return {
    resq_wo_id: String(resqWoId),
    resq_code: e.resqCode || null,
    sf_job_id: s(e.sfJobId),
    sf_job_number: s(e.sfJobNumber),
    resq_status: e.resqStatus || null,
    sf_status: e.sfStatus || null,
    facility: e.facility || null,
    customer_qbo_id: s(e.customerQboId),
    customer_name: e.customerName || null,
    title: e.title || null,
    reconciled: !!e.reconciled,
    sf_deleted: !!e.sfDeleted,
    photos_sent: !!e.photosSent,
    invoice_submitted: !!e.invoiceSubmitted,
    visit_completed: !!e.visitCompleted,
    linked_existing: !!e.linkedExisting,
    replaced_sf_job_id: s(e.replacedSfJobId),
    raw: e,
    last_sync_at: e.lastSyncAt || null,
  };
}

// Upsert all links in one request (PostgREST array upsert on resq_wo_id).
// Backfills the table from the current mapping and keeps it current.
export async function bulkUpsertLinks(rows) {
  // No service-role key on apbg-billing → the Phase 2 mirror stays dormant
  // (sync still runs fine off the Blob). Skip cleanly rather than error every run.
  if (!SERVICE_KEY) return 0;
  if (!rows || !rows.length) return 0;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/resq_sf_links?on_conflict=resq_wo_id`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`links upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}

// Append audit events in one request.
export async function bulkInsertEvents(events) {
  if (!SERVICE_KEY) return 0;
  if (!events || !events.length) return 0;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sync_events`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify(events),
  });
  if (!res.ok) throw new Error(`events insert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return events.length;
}

// Build a compact event from a per-WO processing result, or null for no-ops.
export function eventFromResult(wo, mapEntry, r, defaultDirection) {
  const action = r?.created ? 'created' : (r?.updated ? 'updated' : ((r?.errors?.length) ? 'error' : null));
  if (!action) return null;
  return {
    resq_wo_id: String(wo.id),
    resq_code: wo.code || null,
    sf_job_id: mapEntry?.sfJobId != null ? String(mapEntry.sfJobId) : null,
    direction: action === 'created' ? 'resq->sf' : defaultDirection,
    action,
    ok: action !== 'error',
    // Keep enough of the message to carry a full ResQ/SF validation error
    // (incl. extensions.fields.__all__) into the audit trail — 300 chars cut
    // the actual reason off mid-JSON.
    message: String((r.errors && r.errors[0]) || (r.steps && r.steps[r.steps.length - 1]) || '').slice(0, 2000),
  };
}
