// Master Health Cron — runs every 12 hours as keep-alive
// Exercises all site health endpoints (which exercise their tokens)
// Sends alert email if any site is failing

import { runMasterHealthChecks } from './lib/master-health-core.mjs';
import { requireScheduled } from './lib/auth.mjs';

export default async function handler(req, context) {
  // Reject manual HTTP hits — only the Netlify scheduler may invoke.
  const gate = requireScheduled(req, context);
  if (!gate.ok) return gate.response;

  console.log('[master-health-cron] Running scheduled cross-site health check');
  const payload = await runMasterHealthChecks();
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Scheduled run RETIRED 2026-06-30 — cross-site health alerting consolidated
// into the single Supabase `health-alert` edge function (pg_cron, every 15 min).
// runMasterHealthChecks() stays importable / on-demand (master-health.mjs API)
// but no longer self-schedules.
// (no `export const config = { schedule }`)
