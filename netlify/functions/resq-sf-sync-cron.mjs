// Scheduled: ResQ ↔ SF sync every 5 minutes
// Calls the sync handler directly (same process, no HTTP round-trip)

import { handler as syncHandler } from './resq-sf-sync.mjs';

export async function handler(event) {
  console.log('[CRON] ResQ↔SF sync starting...');

  try {
    const result = await syncHandler({ httpMethod: 'POST' });
    const body = JSON.parse(result.body);
    console.log(`[CRON] Sync complete: ${body.created || 0} created, ${body.updated || 0} updated, ${body.errors?.length || 0} errors`);
    return result;
  } catch (e) {
    console.error('[CRON] Sync failed:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
}

// Netlify scheduled function — every 5 minutes
export const config = {
  schedule: '*/5 * * * *',
};
