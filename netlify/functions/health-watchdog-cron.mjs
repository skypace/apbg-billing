// Health Watchdog Cron — every 30 minutes.
//
// Thin scheduled wrapper around health-watchdog.mjs, split out 2026-08-20:
// Netlify answers any external HTTP request to a function that carries a
// `schedule` with a bare platform 403 (no CORS, no body) BEFORE the function
// code runs. health-watchdog carried its own schedule, so control.html and
// the gateway hub could never actually fetch it — their fetch threw on the
// unreadable 403 and the "APBG 3rd Party Billing" card rendered a permanent
// "Down"/UNREACHABLE regardless of real health. Same split as
// master-health.mjs (API) + master-health-cron.mjs (schedule).
//
// The wrapper passes its own req/context through: the scheduler's context
// carries next_run, so requireScheduledOrAuth inside the watchdog passes and
// the non-GET method falls through to the full check run + blob cache + email.

import watchdog from './health-watchdog.mjs';
import { requireScheduled } from './lib/auth.mjs';

export default async function handler(req, context) {
  // Reject manual HTTP hits — only the Netlify scheduler may invoke.
  const gate = requireScheduled(req, context);
  if (!gate.ok) return gate.response;

  console.log('[health-watchdog-cron] Running scheduled watchdog checks');
  return watchdog(req, context);
}

export const config = {
  schedule: '*/30 * * * *',
};
