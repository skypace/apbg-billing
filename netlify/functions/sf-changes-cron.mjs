// sf-changes-cron.mjs — daily trigger for the Service Fusion Changes report.
//
// Scheduled functions get a short execution window, so this is a thin kick:
// it invokes the background function (15-min budget) with the shared secret
// and exits. The background run emails ONLY when something changed.

export default async () => {
  const secret = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32);
  if (!secret) {
    console.error('[sf-changes-cron] SUPABASE_SERVICE_ROLE_KEY not set');
    return new Response('missing secret', { status: 500 });
  }
  const base = process.env.URL || 'https://apbg-billing.netlify.app';
  const res = await fetch(`${base}/.netlify/functions/sf-changes-report-background`, {
    method: 'POST',
    headers: { 'x-sf-changes-secret': secret },
  });
  console.log('[sf-changes-cron] kicked background report:', res.status);
  return new Response('ok', { status: 200 });
};

export const config = {
  schedule: '0 15 * * *', // daily 15:00 UTC = 8am PT
};
