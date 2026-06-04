// Scheduled: ResQ ↔ SF sync every 5 minutes
// Calls the background worker directly (same process, no HTTP)

import { handler as bgHandler } from './resq-sf-sync-background.mjs';
import { requireScheduled } from './lib/auth.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

// Heartbeat: log EVERY invocation to ops.sync_log BEFORE the gate, so we can
// tell whether the Netlify scheduler is firing this function at all, and what
// scheduled-context fields it provides (to confirm requireScheduled matches).
async function heartbeat(context) {
  try {
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!k) return;
    const ctxKeys = context ? Object.keys(context).join(',') : '(no context)';
    const sched = !!(context?.next_run || context?.scheduledTime || context?.scheduled_time);
    const now = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: {
        apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json',
        'Accept-Profile': 'ops', 'Content-Profile': 'ops', Prefer: 'return=minimal',
      },
      body: JSON.stringify([{
        source: 'resq-sf-sync-cron', sync_type: 'heartbeat',
        status: sched ? 'scheduled' : 'unscheduled', started_at: now, completed_at: now,
        records_synced: 0, metadata: { ctxKeys, sched },
      }]),
    });
  } catch { /* non-fatal */ }
}

export default async (req, context) => {
  await heartbeat(context);
  // Reject manual HTTP hits to this URL — only the Netlify scheduler may invoke.
  const gate = requireScheduled(req, context);
  if (!gate.ok) return gate.response;

  console.log('[CRON] ResQ↔SF sync starting...');

  try {
    await bgHandler({ httpMethod: 'POST', _internalCron: true });
    console.log('[CRON] Sync complete');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[CRON] Sync failed:', e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = {
  schedule: '*/5 * * * *',
};
