// Shared core logic for master health checks
// Used by both master-health.mjs (API) and master-health-cron.mjs (scheduled)

import { sendEmail, APPROVAL_EMAIL } from '../email-helpers.mjs';

const SITES = [
  {
    id: 'apbg',
    name: 'APBG 3rd Party Billing',
    healthUrl: 'https://pacer-billing.netlify.app/.netlify/functions/health-watchdog',
  },
  {
    id: 'melt',
    name: 'Melt Dashboard',
    healthUrl: 'https://melt-dashboard.netlify.app/api/health',
  },
  {
    id: 'pacer',
    name: 'Pacer Finance',
    healthUrl: 'https://pacer-finance.netlify.app/api/health',
  },
];

// ── Blob helpers ──
let _store = null;
async function getStore() {
  if (_store) return _store;
  try {
    const { getStore: gs } = await import('@netlify/blobs');
    _store = gs({
      name: 'master-health',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    return _store;
  } catch (e) {
    console.error('[master-health] Blob store error:', e.message);
    return null;
  }
}

// ── Fetch a site's health endpoint with timeout ──
async function checkSite(site) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(site.healthUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        id: site.id,
        name: site.name,
        status: 'error',
        httpStatus: res.status,
        detail: `HTTP ${res.status} from health endpoint`,
        checks: null,
      };
    }

    const data = await res.json();

    let status = 'ok';
    let checks = {};

    if (data.overall) {
      if (['ok', 'healthy'].includes(data.overall)) status = 'ok';
      else if (['warn', 'degraded'].includes(data.overall)) status = 'warn';
      else status = 'error';
    }

    // Extract individual checks — handle different response shapes
    if (data.checks) {
      // APBG watchdog format: { checks: { qbo: {status, detail}, ... } }
      checks = data.checks;
    } else {
      // Melt format: { qbo: {ok, message}, cache: {ok, ...}, resq: {ok, ...} }
      for (const [key, val] of Object.entries(data)) {
        if (key === 'overall' || key === 'checkedAt') continue;
        if (val && typeof val === 'object') {
          checks[key] = {
            status: val.ok === true ? 'ok' : val.ok === false ? 'error' : (val.status || 'unknown'),
            detail: val.message || val.detail || JSON.stringify(val),
          };
        }
      }
    }

    return { id: site.id, name: site.name, status, checks, raw: data };
  } catch (e) {
    clearTimeout(timeout);
    const isTimeout = e.name === 'AbortError';
    return {
      id: site.id,
      name: site.name,
      status: 'error',
      detail: isTimeout ? 'Health check timed out (15s)' : e.message,
      checks: null,
    };
  }
}

// ── Alert email ──
function buildAlertEmail(results, timestamp) {
  const siteRows = results.map(r => {
    const color = r.status === 'ok' ? '#065F46' : r.status === 'warn' ? '#92400E' : '#991B1B';
    const bg = r.status === 'ok' ? '#D1FAE5' : r.status === 'warn' ? '#FEF3C7' : '#FEE2E2';
    const icon = r.status === 'ok' ? 'OK' : r.status === 'warn' ? 'WARN' : 'FAIL';

    let checkDetails = '';
    if (r.checks) {
      checkDetails = Object.entries(r.checks).map(([name, c]) => {
        const cIcon = (c.status === 'ok') ? 'OK' : (c.status === 'warn') ? 'WARN' : 'FAIL';
        return `<div style="font-size:12px;color:#374151;padding:2px 0;">${cIcon} ${name}: ${c.detail || c.status}</div>`;
      }).join('');
    }

    return `<tr>
      <td style="padding:12px;border-bottom:1px solid #eee;font-weight:600;">${r.name}</td>
      <td style="padding:12px;border-bottom:1px solid #eee;text-align:center;">
        <span style="background:${bg};color:${color};padding:3px 12px;border-radius:4px;font-size:12px;font-weight:700;">${icon}</span>
      </td>
      <td style="padding:12px;border-bottom:1px solid #eee;">
        ${r.detail ? `<div style="font-size:13px;color:#991B1B;">${r.detail}</div>` : ''}
        ${checkDetails}
      </td>
    </tr>`;
  }).join('');

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#1F4E79;padding:20px 24px;border-radius:8px 8px 0 0;">
      <h1 style="color:#fff;font-size:18px;margin:0;">Master Control — Health Alert</h1>
      <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:4px 0 0;">${timestamp}</p>
    </div>
    <div style="padding:20px 24px;border:1px solid #e2e6ed;border-top:0;border-radius:0 0 8px 8px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f4f6f9;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Site</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#6b7280;">Status</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Details</th>
        </tr></thead>
        <tbody>${siteRows}</tbody>
      </table>
      <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:16px;">
        <a href="https://pacer-billing.netlify.app/control.html" style="color:#1F4E79;">Open Master Control Dashboard</a>
      </p>
    </div>
  </div>`;
}

// ── Main exported function ──
export async function runMasterHealthChecks() {
  const timestamp = new Date().toISOString();
  console.log(`[master-health] Checking all sites at ${timestamp}`);

  const results = await Promise.all(SITES.map(s => checkSite(s)));

  const hasError = results.some(r => r.status === 'error');
  const hasWarn = results.some(r => r.status === 'warn');
  const overall = hasError ? 'error' : hasWarn ? 'warn' : 'ok';

  const payload = { timestamp, overall, sites: results };

  // Store in blobs
  try {
    const store = await getStore();
    if (store) {
      await store.set('last-result', JSON.stringify(payload));
      await store.set('last-check-time', timestamp);
    }
  } catch (e) {
    console.error('[master-health] Blob save error:', e.message);
  }

  // Alert email on failures
  if (hasError || hasWarn) {
    const failedSites = results.filter(r => r.status !== 'ok').map(r => r.name);
    const subject = `[MASTER CONTROL] ${hasError ? 'FAILURE' : 'WARNING'}: ${failedSites.join(', ')}`;

    try {
      await sendEmail({
        to: APPROVAL_EMAIL,
        subject,
        html: buildAlertEmail(results, timestamp),
      });
      console.log('[master-health] Alert email sent');
    } catch (e) {
      console.error('[master-health] Email error:', e.message);
    }
  } else {
    console.log('[master-health] All sites healthy');
  }

  return payload;
}
