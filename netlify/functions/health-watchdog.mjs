// Health Watchdog — scheduled every 30 minutes
// Checks QBO, Service Fusion, ResQ, sync freshness, and ResQ schema drift
// Sends alert email only when something is wrong

import { qboQuery } from './qbo-helpers.mjs';
import { sfRequest } from './sf-helpers.mjs';
import { resqLogin, resqGql } from './resq-helpers.mjs';
import { sendEmail, APPROVAL_EMAIL } from './email-helpers.mjs';

export const config = { schedule: '*/30 * * * *' };

// ── Mutations and enum values the sync depends on ──
const REQUIRED_MUTATIONS = [
  'startVisit', 'endVisit', 'createRecordOfWork', 'saveRecordOfWork',
  'submitRecordOfWork', 'createOriginalVendorInvoice',
  'createUpdatePayoutOffer', 'addAttachment', 'captureVisitNotes',
];

const REQUIRED_ENUMS = {
  VisitOutcome: ['COMPLETED'],
  RecordOfWorkLineItemEnum: [
    'ITEM_TYPE_PART', 'ITEM_TYPE_SERVICE_CHARGE',
    'ITEM_TYPE_LABOUR', 'ITEM_TYPE_TRAVEL', 'ITEM_TYPE_OTHER',
  ],
};

// ── Blob helpers ──
let stores = {};

async function getBlobStore(name) {
  if (stores[name]) return stores[name];
  try {
    const { getStore } = await import('@netlify/blobs');
    stores[name] = getStore({
      name,
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });
    return stores[name];
  } catch (e) {
    console.error(`Failed to get blob store "${name}":`, e.message);
    return null;
  }
}

// ── Individual health checks ──

async function checkQBO() {
  try {
    const result = await qboQuery('SELECT Id FROM CompanyInfo');
    return { status: 'ok', detail: 'CompanyInfo query succeeded' };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

async function checkSF() {
  try {
    const me = await sfRequest('GET', '/me');
    const name = me?.first_name
      ? `${me.first_name} ${me.last_name || ''}`.trim()
      : 'authenticated';
    return { status: 'ok', detail: `Logged in as ${name}` };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

async function checkResQ() {
  try {
    const session = await resqLogin();
    const result = await resqGql(session, '{ me { id email } }');
    const email = result?.data?.me?.email || 'authenticated';
    return { status: 'ok', detail: `Logged in as ${email}`, session };
  } catch (e) {
    return { status: 'error', detail: e.message, session: null };
  }
}

async function checkSyncFreshness() {
  try {
    const store = await getBlobStore('resq-sf-sync');
    if (!store) return { status: 'warn', detail: 'Blob store unavailable' };

    const raw = await store.get('last-sync');
    if (!raw) return { status: 'warn', detail: 'No last-sync record found' };

    const data = JSON.parse(raw);
    const ts = data.finishedAt || data.startedAt || data.ts;
    if (!ts) return { status: 'warn', detail: 'last-sync blob has no timestamp' };

    const age = Date.now() - new Date(ts).getTime();
    const ageMin = Math.round(age / 60000);

    if (age > 15 * 60 * 1000) {
      return { status: 'error', detail: `Last sync was ${ageMin} minutes ago (threshold: 15 min)` };
    }
    return { status: 'ok', detail: `Last sync ${ageMin} min ago` };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

// ── ResQ Schema Introspection ──

const INTROSPECTION_QUERY = `{
  __schema {
    mutationType {
      fields { name }
    }
    types {
      name
      kind
      enumValues { name }
    }
  }
}`;

async function introspectResqSchema(session) {
  const result = await resqGql(session, INTROSPECTION_QUERY);
  const schema = result?.data?.__schema;
  if (!schema) throw new Error('Introspection returned no schema');

  const mutations = (schema.mutationType?.fields || []).map(f => f.name);
  const enums = {};
  for (const t of schema.types) {
    if (t.kind === 'ENUM' && t.enumValues) {
      enums[t.name] = t.enumValues.map(v => v.name);
    }
  }
  return { mutations, enums };
}

async function checkResqSchema(session) {
  if (!session) {
    return { status: 'skip', detail: 'Skipped — ResQ login failed' };
  }

  try {
    const store = await getBlobStore('health-watchdog');
    if (!store) return { status: 'warn', detail: 'Blob store unavailable for schema check' };

    const current = await introspectResqSchema(session);

    // Load saved baseline
    const savedRaw = await store.get('resq-schema-snapshot');

    if (!savedRaw) {
      // First run — save baseline, no comparison needed
      await store.set('resq-schema-snapshot', JSON.stringify({
        savedAt: new Date().toISOString(),
        mutations: current.mutations,
        enums: current.enums,
      }));
      return { status: 'ok', detail: 'First run — baseline schema saved' };
    }

    const baseline = JSON.parse(savedRaw);
    const problems = [];

    // Check mutations we depend on
    for (const m of REQUIRED_MUTATIONS) {
      const inBaseline = baseline.mutations.includes(m);
      const inCurrent = current.mutations.includes(m);
      if (inBaseline && !inCurrent) {
        problems.push(`Mutation REMOVED: ${m}`);
      } else if (!inCurrent) {
        // Not in baseline either but we need it
        problems.push(`Mutation MISSING: ${m} (never seen in schema)`);
      }
    }

    // Check enum values we depend on
    for (const [enumName, requiredValues] of Object.entries(REQUIRED_ENUMS)) {
      const baselineValues = baseline.enums[enumName] || [];
      const currentValues = current.enums[enumName] || [];

      if (!current.enums[enumName]) {
        problems.push(`Enum REMOVED: ${enumName}`);
        continue;
      }

      for (const v of requiredValues) {
        const inBaseline = baselineValues.includes(v);
        const inCurrent = currentValues.includes(v);
        if (inBaseline && !inCurrent) {
          problems.push(`Enum value REMOVED: ${enumName}.${v}`);
        } else if (!inCurrent) {
          problems.push(`Enum value MISSING: ${enumName}.${v} (never seen in schema)`);
        }
      }
    }

    if (problems.length > 0) {
      return { status: 'error', detail: problems.join('; ') };
    }

    // Update baseline with current schema (so additions are captured)
    await store.set('resq-schema-snapshot', JSON.stringify({
      savedAt: new Date().toISOString(),
      mutations: current.mutations,
      enums: current.enums,
    }));

    return { status: 'ok', detail: 'All required mutations and enums present' };
  } catch (e) {
    return { status: 'error', detail: `Schema check failed: ${e.message}` };
  }
}

// ── Alert email ──

function buildAlertEmail(results, timestamp) {
  const rows = Object.entries(results).map(([name, r]) => {
    const color = r.status === 'ok' ? '#065F46'
      : r.status === 'warn' ? '#92400E'
      : r.status === 'skip' ? '#6B7280'
      : '#991B1B';
    const bg = r.status === 'ok' ? '#D1FAE5'
      : r.status === 'warn' ? '#FEF3C7'
      : r.status === 'skip' ? '#F3F4F6'
      : '#FEE2E2';
    const icon = r.status === 'ok' ? 'OK'
      : r.status === 'warn' ? 'WARN'
      : r.status === 'skip' ? 'SKIP'
      : 'FAIL';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">
        <span style="background:${bg};color:${color};padding:2px 10px;border-radius:4px;font-size:12px;font-weight:700;">${icon}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;color:#374151;">${r.detail}</td>
    </tr>`;
  }).join('');

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#991B1B;padding:20px 24px;border-radius:8px 8px 0 0;">
      <h1 style="color:#fff;font-size:18px;margin:0;">Integration Health Alert</h1>
      <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:4px 0 0;">${timestamp}</p>
    </div>
    <div style="padding:20px 24px;border:1px solid #e2e6ed;border-top:0;border-radius:0 0 8px 8px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f4f6f9;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Check</th>
          <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#6b7280;">Status</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Detail</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Main handler ──

export default async function handler(req) {
  // Handle GET requests — return last health check result (or live with ?refresh=1)
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const wantRefresh = url.searchParams.get('refresh') === '1';

    // If ?refresh=1, fall through to run live checks below
    if (!wantRefresh) {
      try {
        const store = await getBlobStore('health-watchdog');
        if (!store) {
          return new Response(JSON.stringify({ error: 'Blob store unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
        const raw = await store.get('last-result');
        if (!raw) {
          return new Response(JSON.stringify({ error: 'No health check results yet' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
        return new Response(raw, {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }
    // else: fall through to run live checks
  }

  // Handle OPTIONS for CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  // ── Scheduled run (or POST trigger) ──
  const timestamp = new Date().toISOString();
  console.log(`[health-watchdog] Starting checks at ${timestamp}`);

  // Run all checks concurrently (ResQ schema depends on ResQ login)
  const [qbo, sf, resq, syncFreshness] = await Promise.all([
    checkQBO(),
    checkSF(),
    checkResQ(),
    checkSyncFreshness(),
  ]);

  // Schema check uses the ResQ session from the login check
  const resqSchema = await checkResqSchema(resq.session || null);

  // Strip session from result before storing
  const { session: _, ...resqClean } = resq;

  const results = {
    qbo,
    serviceFusion: sf,
    resq: resqClean,
    syncFreshness,
    resqSchema,
  };

  const hasFailure = Object.values(results).some(r => r.status === 'error');
  const hasWarning = Object.values(results).some(r => r.status === 'warn');
  const overall = hasFailure ? 'error' : hasWarning ? 'warn' : 'ok';

  const payload = { timestamp, overall, checks: results };

  // Store result in blobs for UI
  try {
    const store = await getBlobStore('health-watchdog');
    if (store) {
      await store.set('last-result', JSON.stringify(payload));
    }
  } catch (e) {
    console.error('[health-watchdog] Failed to save result to blobs:', e.message);
  }

  // Send alert email only if something is wrong
  if (hasFailure || hasWarning) {
    const failedChecks = Object.entries(results)
      .filter(([, r]) => r.status === 'error' || r.status === 'warn')
      .map(([name]) => name);

    const subject = `[ALERT] Integration health: ${failedChecks.join(', ')} ${hasFailure ? 'FAILING' : 'WARNING'}`;

    try {
      await sendEmail({
        to: APPROVAL_EMAIL,
        subject,
        html: buildAlertEmail(results, timestamp),
      });
      console.log('[health-watchdog] Alert email sent');
    } catch (e) {
      console.error('[health-watchdog] Failed to send alert email:', e.message);
    }
  } else {
    console.log('[health-watchdog] All checks passed — no alert needed');
  }

  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
