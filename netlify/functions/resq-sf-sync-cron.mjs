// Scheduled: ResQ ↔ SF sync every 5 minutes
// Uses Netlify Functions v2 (default export) for schedule support

import { handler as syncHandler } from './resq-sf-sync.mjs';

export default async (req) => {
  console.log('[CRON] ResQ↔SF sync starting...');

  try {
    const result = await syncHandler({ httpMethod: 'POST' });
    const body = JSON.parse(result.body);
    console.log(`[CRON] Sync complete: ${body.created || 0} created, ${body.updated || 0} updated, ${body.errors?.length || 0} errors`);
    return new Response(result.body, {
      status: result.statusCode,
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

// Netlify scheduled function config — every 5 minutes
export const config = {
  schedule: '*/5 * * * *',
};
