// Has the tech finished the ticket?
//
// Service Fusion has no webhooks — its notification email IS the event, and
// this repo's own rule is that its crons are the safety net, not the primary
// path. But a transfer sitting in `requested` is waiting on exactly one fact
// (is the SF ticket complete?) and nobody would think to look, so this asks.
//
// ⚠ DELIBERATELY MODEST, because of the documented 2026-06/07 outage: Service
//   Fusion rate-limits hard and the offenders were bulk scans. This reads ONE
//   job by id per transfer awaiting a build — normally none or one or two —
//   caps the batch, and runs every 30 minutes. It never lists jobs. If this
//   ever needs to be faster, make the SF status email drive it instead of
//   turning the dial up here.
//
// The "Mark built" button on the Transfers screen does the same thing on
// demand, so ops is never waiting on a cron.

import { requireScheduledOrAuth } from './lib/auth.mjs';
import { sfRequest } from './sf-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { buildTransferDoc, sbGet, sbPatch } from './lib/transfer-docs.mjs';
import { sfJobLooksComplete, emailBuilt } from './lib/transfer-workflow.mjs';

const MAX_PER_RUN = 15;

export const config = { schedule: '*/30 * * * *' };

export default async function handler(req) {
  const auth = await requireScheduledOrAuth(req, ['superadmin', 'admin']);
  if (auth && auth.ok === false) return auth.response;

  const out = { checked: 0, built: 0, skipped: 0, errors: [] };
  try {
    const [s] = await sbGet('transfer_workflow_settings?select=*&id=eq.true&limit=1');
    if (!s || !s.enabled) return json({ ok: true, note: 'workflow disabled', ...out });

    const waiting = await sbGet(
      `inventory_transfers?select=id,bol_number,sf_job_id,sf_job_number&workflow_status=eq.requested&sf_job_id=not.is.null&status=eq.draft&order=requested_at.asc&limit=${MAX_PER_RUN}`);

    for (const t of waiting) {
      out.checked++;
      let job;
      try {
        job = await sfRequest('GET', `/jobs/${encodeURIComponent(t.sf_job_id)}`);
      } catch (e) {
        // A read failure is not evidence the ticket is unfinished — record it
        // and leave the transfer alone rather than guessing either way.
        out.errors.push(`${t.bol_number}: ${String(e.message || e).slice(0, 200)}`);
        continue;
      }
      const status = job?.status || null;
      if (!sfJobLooksComplete(job)) {
        out.skipped++;
        if (status && status !== t.sf_job_status) {
          await sbPatch('inventory_transfers', `id=eq.${t.id}`, { sf_job_status: status }).catch(() => {});
        }
        continue;
      }

      await sbPatch('inventory_transfers', `id=eq.${t.id}`, {
        workflow_status: 'built', sf_job_status: status,
        built_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      out.built++;

      try {
        const doc = await buildTransferDoc(t.id);
        const msg = emailBuilt({ doc, sfJobNumber: t.sf_job_number });
        await sendEmail({
          to: s.ops_email, from: doc.payload.from, replyTo: doc.payload.company.email,
          subject: msg.subject, html: msg.html, text: msg.text,
          ...(s.cc_emails && s.cc_emails.length ? { cc: s.cc_emails } : {}),
        });
      } catch (e) {
        // The state has already advanced, which is the part that matters; a
        // failed email is recorded rather than rolling the transfer back.
        out.errors.push(`${t.bol_number}: built, but the email failed — ${String(e.message || e).slice(0, 200)}`);
      }
    }

    await logRun(out);
    return json({ ok: true, ...out });
  } catch (e) {
    out.errors.push(String(e.message || e).slice(0, 300));
    await logRun(out).catch(() => {});
    return json({ ok: false, ...out }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Every run leaves a row, success or not — a cron that only logs when it finds
// something reads identical to a cron that has stopped running.
async function logRun(out) {
  const { sbInsert } = await import('./lib/transfer-docs.mjs');
  // ⚠ The column is `sync_type`, not `operation`, and `source` carries a CHECK
  //   allow-list. A writer that gets either wrong is REJECTED silently — every
  //   log call is wrapped in a catch, correctly — and its health check then
  //   reads green as "has not logged yet" forever. That is the exact shape of
  //   the 2026-08-23 bug where three monitors could never have gone any other
  //   colour. Both values are checked against the live schema.
  await sbInsert('sync_log', {
    source: 'inventory', sync_type: 'transfer_sf_poll',
    status: out.errors.length ? 'error' : 'success',
    completed_at: new Date().toISOString(),
    records_synced: out.built,
    error_message: out.errors.length ? out.errors.join(' · ').slice(0, 500) : null,
    metadata: out,
  }).catch((e) => console.warn('[transfer-sf-poll] log failed:', e.message));
}
