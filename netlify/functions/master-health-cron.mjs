// Master Health Cron — runs every 12 hours as keep-alive
// Exercises all site health endpoints (which exercise their tokens)
// Sends alert email if any site is failing

import { runMasterHealthChecks } from './lib/master-health-core.mjs';

export default async function handler() {
  console.log('[master-health-cron] Running scheduled cross-site health check');
  const payload = await runMasterHealthChecks();
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = {
  schedule: '0 */12 * * *',
};
