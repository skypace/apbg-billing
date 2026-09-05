import { _sbToken } from './supabase';

/**
 * The transfer process — pull ticket, Service Fusion ticket, the emails, and
 * the one-time receive link. Backed by netlify/functions/transfer-workflow.mjs.
 *
 * The steps are paperwork, NOT the ledger: `status` still says where the stock
 * is, and the only step that moves any is `schedule`, which ships the load
 * through the ordinary ship RPC.
 */
const FN = '/margin/.netlify/functions/transfer-workflow';

export type WorkflowStatus = 'none' | 'requested' | 'built' | 'scheduled';

export interface TransferWorkflow {
  id: string;
  bol_number: string;
  status: string;
  workflow_status: WorkflowStatus;
  sf_job_id: string | null;
  sf_job_number: string | null;
  sf_job_status: string | null;
  sf_error: string | null;
  requested_at: string | null;
  built_at: string | null;
  scheduled_at: string | null;
  receive_link_sent_at: string | null;
  receive_token_used_at: string | null;
  receive_token_expires_at: string | null;
}

export interface SendResult { to: string; ok: boolean; error: string | null }

async function bearer(): Promise<string> {
  const t = await _sbToken();
  if (!t) throw new Error('Not signed in');
  return 'Bearer ' + t;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { Authorization: await bearer(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(j.error || `Failed (${res.status})`);
  return j as T;
}

export async function fetchWorkflow(transferId: string): Promise<TransferWorkflow | null> {
  // ⚠ An admin-gated GET needs the bearer set explicitly — the app's fetch
  //   interceptor attaches it to non-GET only, which is what left the QBO Item
  //   Loader rendering zero rows on healthy credentials.
  const res = await fetch(`${FN}?id=${encodeURIComponent(transferId)}`, {
    headers: { Authorization: await bearer() },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { transfer?: TransferWorkflow };
  return j.transfer ?? null;
}

/** Raise it: Service Fusion ticket, pull ticket to the office, heads-up to the branch. */
export function requestTransfer(transferId: string) {
  return call<{ sf_job_number: string | null; sf_error: string | null; sf_warning: string | null; emails: SendResult[] }>(
    { action: 'request', transfer_id: transferId });
}

/** The ticket is complete — tell the office to schedule the delivery. */
export function markBuilt(transferId: string) {
  return call<{ emails: SendResult[] }>({ action: 'mark_built', transfer_id: transferId });
}

/** Shipping and BOL entered: ships the load and sends the one-time receive link. */
export function scheduleTransfer(transferId: string, args: {
  ship_date: string;
  carrier?: string | null;
  tracking_number?: string | null;
  pro_number?: string | null;
  freight_terms?: string | null;
  total_pallets?: number | string | null;
  total_weight_lbs?: number | string | null;
  special_instructions?: string | null;
  shipper_signature_name?: string | null;
}) {
  return call<{ emails: SendResult[] }>({ action: 'schedule', transfer_id: transferId, ...args });
}

/**
 * A new link. ⚠ The old one dies in the same write — only the hash of a token
 * is stored, so re-sending the original is impossible by construction, which is
 * the honest behaviour anyway: a link that needs re-sending has usually gone
 * astray.
 */
export function resendReceiveLink(transferId: string, to?: string) {
  return call<{ emails: SendResult[]; note: string }>(
    { action: 'resend_receive_link', transfer_id: transferId, ...(to ? { to } : {}) });
}

/** "2 of 3 emails went out" — or which address did not. */
export function describeSends(sends: SendResult[] | undefined): string {
  if (!sends || !sends.length) return 'No emails were sent.';
  const bad = sends.filter((s) => !s.ok);
  if (!bad.length) return `Emailed ${sends.map((s) => s.to).join(', ')}.`;
  return `${sends.length - bad.length} of ${sends.length} emails sent. Failed: ${bad.map((s) => `${s.to} (${s.error ?? 'unknown'})`).join('; ')}`;
}
