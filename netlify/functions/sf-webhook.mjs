// sf-webhook — on-demand single-job ResQ <-> SF sync (Phase 3).
//
// Internal trigger only (SF has no outbound webhook and we are NOT using
// Zapier). Call it from our own code, a scheduled job, or by hand to sync ONE
// work order immediately instead of waiting for the 5-min cron. The dashboard
// "force-sync" button uses the authed resq-sf-sync?syncOne path instead.
//
//   POST { resq_code: "R12345" }      — sync that WO now
//   POST { sf_job_id: "1088..." }     — resolve the WO via the SF job's po_number, then sync
//   GET  ?resq_code=R12345            — same, convenience for quick manual hits
//
// Auth: shared secret via ?secret= or X-Webhook-Secret header
// (SF_WEBHOOK_SECRET, falling back to INBOUND_EMAIL_SECRET). If neither env var
// is set the endpoint warns and processes anyway (it only triggers a sync, no
// destructive surface) — set a secret in production.

import { syncSingleByCode } from './resq-sf-sync-background.mjs';
import { sfRequest } from './sf-helpers.mjs';

const SECRET = process.env.SF_WEBHOOK_SECRET || process.env.INBOUND_EMAIL_SECRET || '';

function json(body, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, body: '' };

  const qs = event.queryStringParameters || {};
  const h = event.headers || {};
  const provided = qs.secret || h['x-webhook-secret'] || h['X-Webhook-Secret'] || '';
  if (SECRET) {
    if (provided !== SECRET) return json({ error: 'bad or missing secret' }, 401);
  } else {
    console.warn('[sf-webhook] No SF_WEBHOOK_SECRET / INBOUND_EMAIL_SECRET set — endpoint is open.');
  }

  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch { /* tolerate non-JSON */ } }

  let resqCode = body.resq_code || body.resqCode || qs.resq_code || null;
  const sfJobId = body.sf_job_id || body.sfJobId || body.job_id || body.id || qs.sf_job_id || null;

  // If only an SF job id was given, read its po_number (we store R<code> there).
  if (!resqCode && sfJobId) {
    try {
      const job = await sfRequest('GET', `/jobs/${encodeURIComponent(sfJobId)}`);
      const po = String(job.po_number || '').trim();
      if (po) resqCode = po;
      else return json({ error: `SF job ${sfJobId} has no po_number to map to a ResQ WO` }, 422);
    } catch (e) {
      return json({ error: `SF job ${sfJobId} lookup failed: ${e.message}` }, 502);
    }
  }

  if (!resqCode) return json({ error: 'resq_code or sf_job_id required' }, 400);

  try {
    const result = await syncSingleByCode(resqCode);
    const ok = result.errors.length === 0;
    return json({ ok, ...result }, ok ? 200 : 207);
  } catch (e) {
    console.error('sf-webhook error:', e);
    return json({ error: e.message }, 500);
  }
}
