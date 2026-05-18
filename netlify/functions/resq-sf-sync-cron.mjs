// Scheduled: ResQ ↔ SF sync every 5 minutes
// Calls the background worker directly (same process, no HTTP)

import { handler as bgHandler } from './resq-sf-sync-background.mjs';
import { requireScheduled } from './lib/auth.mjs';

export default async (req, context) => {
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
