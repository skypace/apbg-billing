// Health Watchdog — scheduled every 30 minutes
// Checks QBO, Service Fusion, ResQ, sync freshness, and ResQ schema drift
// Sends alert email only when something is wrong

import { qboQuery } from './qbo-helpers.mjs';
import { requireScheduledOrAuth } from './lib/auth.mjs';
import { sfRequest } from './sf-helpers.mjs';
import { resqLogin, resqGql } from './resq-helpers.mjs';
import { sendEmail, APPROVAL_EMAIL } from './email-helpers.mjs';
import { createClient } from '@supabase/supabase-js';

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
    const ts = data.completed || data.finishedAt || data.started || data.startedAt || data.ts;
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

// ── Per-source freshness from ops.sync_log ──────────────────────────────
//
// Why this exists: the legacy `checkSyncFreshness` only watches the
// ResQ↔SF blob. Every other sync (sync-qbo invoice/lines, sync-qbo-items,
// sync-qbo-customers, sync-qbo-expenses, sync-sf, sync-fleetcomplete) is
// invisible to it. We learned this the hard way on 2026-05-14 — sync-qbo
// had been silently writing zero rows for 19 days because the edge
// function was defaulting to the `public` schema while every table lives
// in `ops`. The function returned HTTP 200, pg_cron logged "succeeded,"
// no alert ever fired, and Margin showed stale data without anyone
// noticing.
//
// This check reads max(completed_at) per (source, sync_type) from
// ops.sync_log directly and compares to a per-source SLA. Any source
// older than its threshold gets surfaced as a row in the watchdog email.
const SYNC_SLA = {
  // expected nightly + Netlify-runner backfill; data should be < 1 day old
  'qbo:invoices':           { maxAgeMs: 30 * 60 * 60 * 1000, label: 'sync-qbo header upserts' },
  'qbo:lines_backfill':     { maxAgeMs: 30 * 60 * 1000,      label: 'sync-qbo line backfill (Netlify runner every 15 min)' },
  'qbo:pl_snapshots':       { maxAgeMs: 30 * 60 * 60 * 1000, label: 'sync-qbo P&L snapshots (nightly)' },
  // SF jobs incremental: every 30 min
  'sf:jobs':                { maxAgeMs: 90 * 60 * 1000,      label: 'sync-sf jobs (every 30 min)' },
};

// ── Direct cache-table freshness (max(synced_at) per table) ────────────
//
// Belt-and-suspenders for the 2026-05-14 sync-qbo silent-failure. The
// source-based check above reads `ops.sync_log`, which is written by the
// edge function itself — if the function defaults to the wrong schema
// (the actual bug), it can still log "success" with records_synced=0 while
// every cache table stays frozen. Reading max(synced_at) on the cache
// table directly catches that case: the row count won't move and the
// timestamp won't advance no matter what sync_log says.
//
// Column names aren't uniform across tables — see the per-table `col`
// below. SLA is generous (24h+ for daily caches, 7d for low-churn caches)
// to avoid flapping during cron slippage.
const CACHE_TABLES = [
  { table: 'qbo_invoices',              col: 'synced_at',      maxAgeMs: 30 * 60 * 60 * 1000, label: 'qbo_invoices cache' },
  { table: 'qbo_items',                 col: 'synced_at',      maxAgeMs: 30 * 60 * 60 * 1000, label: 'qbo_items cache' },
  { table: 'qbo_customers',             col: 'synced_at',      maxAgeMs: 30 * 60 * 60 * 1000, label: 'qbo_customers cache' },
  { table: 'qbo_vendors',               col: 'synced_at',      maxAgeMs: 30 * 60 * 60 * 1000, label: 'qbo_vendors cache' },
  { table: 'qbo_expense_lines',         col: 'synced_at',      maxAgeMs: 30 * 60 * 60 * 1000, label: 'qbo_expense_lines cache' },
  { table: 'qbo_inventory_adjustments', col: 'synced_at',      maxAgeMs: 7 * 24 * 60 * 60 * 1000, label: 'qbo_inventory_adjustments cache' },
  { table: 'qbo_purchase_orders',       col: 'last_synced_at', maxAgeMs: 30 * 60 * 60 * 1000, label: 'qbo_purchase_orders cache' },
  { table: 'qbo_employees_cache',       col: 'qbo_synced_at',  maxAgeMs: 7 * 24 * 60 * 60 * 1000, label: 'qbo_employees_cache' },
  { table: 'qbo_pto_cache',             col: 'last_synced_at', maxAgeMs: 7 * 24 * 60 * 60 * 1000, label: 'qbo_pto_cache' },
];

// ── pg_net cron-trigger failures ───────────────────────────────────────
//
// Final layer of the silent-cron-failure defense. The migration
// 20260517_pg_net_failure_scanner runs `ops.fn_scan_pg_net_failures()`
// every 5 min, which inserts a row in `ops.sync_log` (status='error',
// source IN ('qbo','sf','fleetcomplete','pg_net')) for every non-2xx or
// timed-out response in `net._http_response`. This means a cron job whose
// http_post lands on a 401/500/timeout no longer disappears — it lands as
// a sync_log error row that this check counts.
//
// Why a separate check (vs. just reading sync_log staleness): the SLA-
// based check only fires on lack of recent success. A cron that fails
// every run might not have any success rows to compare against. This
// check looks at recent errors directly.
async function checkPgNetFailures() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { status: 'warn', detail: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — cannot read sync_log' };
  }
  try {
    const sb = createClient(url, key, { db: { schema: 'ops' } });
    // Last 35 min so we cover the full watchdog tick window (every 30min).
    const cutoff = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('sync_log')
      .select('source, sync_type, error_message, started_at, metadata')
      .eq('status', 'error')
      .gte('started_at', cutoff)
      .order('started_at', { ascending: false })
      .limit(50);
    if (error) {
      return { status: 'error', detail: 'sync_log error scan failed: ' + error.message };
    }
    const failures = data || [];
    if (failures.length === 0) {
      return { status: 'ok', detail: 'No cron→HTTP failures in the last 35 min' };
    }
    // Group by sync_type for a concise summary.
    const byType = new Map();
    for (const f of failures) {
      const key = `${f.source}:${f.sync_type}`;
      const cur = byType.get(key) || { count: 0, lastErr: '', lastAt: '' };
      cur.count += 1;
      if (!cur.lastAt || f.started_at > cur.lastAt) {
        cur.lastAt = f.started_at;
        cur.lastErr = (f.error_message || '').slice(0, 200);
      }
      byType.set(key, cur);
    }
    const summary = [...byType.entries()]
      .map(([k, v]) => `${k} ×${v.count}: ${v.lastErr}`)
      .join(' | ');
    return {
      status: 'error',
      detail: `${failures.length} cron→HTTP failures in last 35 min — ${summary}`,
      failures: failures.length,
      groups: Object.fromEntries(byType),
    };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

async function checkCacheTableFreshness() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { status: 'warn', detail: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — cannot read cache tables' };
  }
  try {
    const sb = createClient(url, key, { db: { schema: 'ops' } });
    const now = Date.now();

    const rows = await Promise.all(CACHE_TABLES.map(async (cfg) => {
      const { data, error } = await sb
        .from(cfg.table)
        .select(cfg.col)
        .order(cfg.col, { ascending: false, nullsFirst: false })
        .limit(1);
      if (error) {
        return { table: cfg.table, status: 'error', detail: `${cfg.label} — read failed: ${error.message}` };
      }
      const ts = data?.[0]?.[cfg.col];
      if (!ts) {
        // Empty cache could be legitimate (no source data yet) or a never-run
        // sync — ambiguous, so warn rather than error to avoid paging on a
        // false positive. The 'rows' row still surfaces it in the email.
        return { table: cfg.table, status: 'warn', detail: `${cfg.label} — empty (no rows or all-null timestamps)` };
      }
      const age = now - new Date(ts).getTime();
      const ageMin = Math.round(age / 60000);
      const ageHr  = Math.round(age / 3600000);
      const friendly = age > 24 * 3600 * 1000 ? `${ageHr}h` : `${ageMin}m`;
      if (age > cfg.maxAgeMs) {
        return {
          table: cfg.table,
          status: 'error',
          detail: `${cfg.label} — newest row ${friendly} old (SLA: ${Math.round(cfg.maxAgeMs / 3600000)}h)`,
          lastSyncedAt: ts,
          ageMs: age,
        };
      }
      return {
        table: cfg.table,
        status: 'ok',
        detail: `${cfg.label} — newest ${friendly} ago`,
        lastSyncedAt: ts,
        ageMs: age,
      };
    }));

    const worst = rows.some(r => r.status === 'error') ? 'error'
                : rows.some(r => r.status === 'warn')  ? 'warn'
                : 'ok';
    return {
      status: worst,
      detail: rows.filter(r => r.status !== 'ok').map(r => r.detail).join(' | ')
              || 'All cache tables within SLA',
      rows,
    };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

async function checkOpsSyncFreshness() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { status: 'warn', detail: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — cannot read ops.sync_log' };
  }
  try {
    const sb = createClient(url, key, { db: { schema: 'ops' } });
    // Pull the most recent completed_at per (source, sync_type) where status=success.
    const { data, error } = await sb
      .from('sync_log')
      .select('source, sync_type, completed_at, records_synced')
      .eq('status', 'success')
      .order('completed_at', { ascending: false })
      .limit(1000);
    if (error) {
      return { status: 'error', detail: 'sync_log read failed: ' + error.message };
    }

    // Reduce to one row per (source, sync_type) — latest only.
    const latestByKey = new Map();
    for (const r of (data || [])) {
      const k = r.source + ':' + r.sync_type;
      if (!latestByKey.has(k)) latestByKey.set(k, r);
    }

    const now = Date.now();
    const rows = [];
    let worst = 'ok';
    for (const [key, sla] of Object.entries(SYNC_SLA)) {
      const r = latestByKey.get(key);
      if (!r) {
        rows.push({ key, status: 'error', detail: sla.label + ' — no success entry on file' });
        worst = 'error';
        continue;
      }
      const age = now - new Date(r.completed_at).getTime();
      const ageMin = Math.round(age / 60000);
      const ageHr  = Math.round(age / 3600000);
      const friendly = age > 24 * 3600 * 1000 ? `${ageHr}h` : `${ageMin}m`;
      if (age > sla.maxAgeMs) {
        rows.push({ key, status: 'error', detail: `${sla.label} — last success ${friendly} ago (SLA: ${Math.round(sla.maxAgeMs / 60000)}m)` });
        worst = 'error';
      } else {
        rows.push({ key, status: 'ok', detail: `${sla.label} — ${friendly} ago` });
      }
    }

    return {
      status: worst,
      detail: rows.filter(r => r.status === 'error').map(r => r.detail).join(' | ') || 'All ops.sync_log entries within SLA',
      rows,
    };
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

export default async function handler(req, context) {
  // CORS preflight must short-circuit BEFORE auth — preflights are unauthenticated.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  // Allow Netlify scheduler OR authenticated superadmin only.
  const auth = await requireScheduledOrAuth(req, context);
  if (!auth.ok) return auth.response;

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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  // ── Scheduled run (or POST trigger) ──
  const timestamp = new Date().toISOString();
  console.log(`[health-watchdog] Starting checks at ${timestamp}`);

  // ResQ asked us to keep usage at ticket volume — so health checks must NOT
  // auto-login to ResQ (the control panel auto-refreshes every 60s and the
  // gateway probes on load; that was a ResQ login every minute, and a FAILED
  // one while the account is deactivated). Skip ResQ unless explicitly asked
  // with ?resq=1.
  let includeResq = false;
  try { includeResq = new URL(req.url).searchParams.get('resq') === '1'; } catch { /* default off */ }
  const resqSkipped = { status: 'skipped', detail: 'ResQ health check disabled to avoid auto-login (append ?resq=1 to run it)', session: null };

  // Run all checks concurrently (ResQ schema depends on ResQ login)
  const [qbo, sf, resq, syncFreshness, opsSyncFreshness, cacheTableFreshness, pgNetFailures] = await Promise.all([
    checkQBO(),
    checkSF(),
    includeResq ? checkResQ() : Promise.resolve(resqSkipped),
    checkSyncFreshness(),
    checkOpsSyncFreshness(),
    checkCacheTableFreshness(),
    checkPgNetFailures(),
  ]);

  // Schema check uses the ResQ session from the login check (skipped unless asked)
  const resqSchema = includeResq
    ? await checkResqSchema(resq.session || null)
    : { status: 'skipped', detail: 'skipped (ResQ check disabled)' };

  // Strip session from result before storing
  const { session: _, ...resqClean } = resq;

  const results = {
    qbo,
    serviceFusion: sf,
    resq: resqClean,
    syncFreshness,           // resq-sf blob (legacy)
    opsSyncFreshness,        // per-source SLA on ops.sync_log
    cacheTableFreshness,     // max(synced_at) on each cache table — catches silent no-op writes
    pgNetFailures,           // any pg_net 4xx/5xx/timeout in last 35min — catches cron-triggered HTTP failures
    resqSchema,
  };

  // Primary services flip the hub "Billing Down" dot. Secondary integrations
  // (SF, ResQ, sync freshness, ResQ schema drift) still page via email when
  // they break, but a flaky 3rd-party shouldn't make the gateway show
  // "Some systems down" — that wakes up the operator on a problem that's not
  // theirs to fix. Matches the QBO+cache-only `overall` rule in
  // melt-dashboard/netlify/functions/health-check.mjs.
  const PRIMARY = new Set(['qbo']);
  const primaryFailure = Object.entries(results).some(([k, r]) => PRIMARY.has(k) && r.status === 'error');
  const anyFailure    = Object.values(results).some(r => r.status === 'error');
  const anyWarning    = Object.values(results).some(r => r.status === 'warn');
  const overall = primaryFailure ? 'error' : (anyFailure || anyWarning) ? 'warn' : 'ok';
  // hasFailure / hasWarning preserved for the email-alert branch below so a
  // ResQ outage still emails the operator even though `overall` stays 'warn'.
  const hasFailure = anyFailure;
  const hasWarning = anyWarning;

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
