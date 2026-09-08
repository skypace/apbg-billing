// /api/qbo-time-sync — mirror QuickBooks TimeActivity into ops.qbo_time_activities.
//
// This is the labour clock. Sky, 2026-09-07: "I don't care about Service
// Fusion... The drivers are clocking in and out using QuickBooks Time so
// specific drivers will be associated with specific time that will be able to
// break down." He is right — 14,694 entries were already sitting in QuickBooks
// and nothing read them.
//
// ⚠ WHAT THIS DATA IS, AND WHAT IT IS NOT (measured live, 90 days, 718 rows):
//   IS   — person × day × hours, with a REAL COST RATE on 602 of them. That
//          rate beats the annual_wage/2080 the Job Ledger derives, and it is
//          the number a cost-per-job should be built on.
//   NOT  — per-customer or per-job attribution. CustomerRef looks like it and
//          is a stuck default: five distinct values across 649 entries, one
//          constant per person. ItemRef is the literal string "Sales" on every
//          row and BillableStatus is Billable on none. Mirror it faithfully,
//          attribute nothing through it until a human fixes those profiles in
//          QuickBooks Time.
//
// ⚠ ENTRIES LAND ~14 DAYS AFTER THE WORK (measured lag 9–20 days, mean 14) —
// they are created at payroll close, not when the clock stops. So the sync must
// re-read a WIDE window every run rather than resuming from the newest work
// day it has seen, or it would never pick up a fortnight-old day that only just
// appeared. Hence the lookback below is in months, and it is an UPSERT.
//
// ⚠ EmployeeRef IS NOT QUERYABLE on TimeActivity — QBO answers
// "QueryValidationError: Property EmployeeRef not found for Entity
// TimeActivity", the same shape as the POStatus trap in qbo-purchasing-sync.
// Filter by TxnDate only; everything else is filtered locally.
//
// Netlify, not a Supabase edge function, deliberately: the deployed sync-qbo
// and push-qbo-item have drifted from their repo copies more than once, and
// pg_cron only knocks. Same reasoning as qbo-purchasing-sync (2026-09-04).
//
// Auth: cron secret header (x-sf-autopost-secret, the shared one) OR
// superadmin/admin bearer.

import { requireAuth } from './lib/auth.mjs';
import { qboQuery } from './qbo-helpers.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-sf-autopost-secret',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

// QBO caps a query at 1000 rows and pages with STARTPOSITION (1-based).
const PAGE = 1000;
const DEFAULT_LOOKBACK_MONTHS = 6;

function cronSecretOk(req) {
  const given = req.headers.get('x-sf-autopost-secret') || '';
  if (!given) return false;
  const want = process.env.SF_AUTOPOST_CRON_SECRET || '';
  const fallback = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32);
  return (!!want && given === want) || (!!fallback && given === fallback);
}

async function ops(method, path, body, prefer) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key || SUPABASE_ANON_KEY,
      Authorization: `Bearer ${key || SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'ops',
      'Accept-Profile': 'ops',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`ops ${method} ${path} (${res.status}) ${txt.slice(0, 300)}`);
  return txt.trim() ? JSON.parse(txt) : null;
}

/**
 * QBO splits a duration across Hours/Minutes/Seconds. Doing that arithmetic at
 * every call site is how three surfaces end up disagreeing about the same day,
 * so it is done ONCE, here, and stored as decimal hours.
 */
export function decimalHours(ta) {
  const h = Number(ta?.Hours) || 0;
  const m = Number(ta?.Minutes) || 0;
  const s = Number(ta?.Seconds) || 0;
  return Math.round((h + m / 60 + s / 3600) * 10000) / 10000;
}

export function timeRow(ta, nowIso = new Date().toISOString()) {
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    qbo_id: String(ta.Id),
    txn_date: ta.TxnDate || null,
    employee_qbo_id: ta.EmployeeRef?.value ?? null,
    employee_name: ta.EmployeeRef?.name ?? null,
    // Mirrored, deliberately not trusted — see the header.
    customer_qbo_id: ta.CustomerRef?.value ?? null,
    customer_name: ta.CustomerRef?.name ?? null,
    item_qbo_id: ta.ItemRef?.value ?? null,
    item_name: ta.ItemRef?.name ?? null,
    hours: decimalHours(ta),
    // 0 means "QuickBooks recorded no rate", which is not the same as free
    // labour — store null so a consumer falls back to the roster wage and can
    // say which it used.
    hourly_rate: num(ta.HourlyRate) || null,
    cost_rate: num(ta.CostRate) || null,
    billable_status: ta.BillableStatus ?? null,
    description: (ta.Description || '').slice(0, 500) || null,
    qbo_created_at: ta.MetaData?.CreateTime ?? null,
    qbo_updated_at: ta.MetaData?.LastUpdatedTime ?? null,
    sync_token: ta.SyncToken ?? null,
    synced_at: nowIso,
  };
}

export function windowStart(months, now = new Date()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export async function runTimeSync({ trigger = 'cron', months = DEFAULT_LOOKBACK_MONTHS, budgetMs = 20_000 } = {}) {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const from = windowStart(months);
  const counts = { scanned: 0, upserted: 0, pages: 0, errors: 0 };
  const log = [];
  let fatal = null;

  try {
    for (let pos = 1; ; pos += PAGE) {
      if (Date.now() - t0 > budgetMs) { log.push('time budget'); break; }
      // TxnDate is the ONLY filterable property that matters here; see header.
      const q = `select * from TimeActivity where TxnDate >= '${from}' order by TxnDate startposition ${pos} maxresults ${PAGE}`;
      const res = await qboQuery(q);
      const rows = res?.QueryResponse?.TimeActivity || [];
      counts.pages += 1;
      if (!rows.length) { log.push(`page at ${pos}: empty — done`); break; }
      counts.scanned += rows.length;

      const nowIso = new Date().toISOString();
      const payload = rows.map((r) => timeRow(r, nowIso));
      await ops('POST', 'qbo_time_activities?on_conflict=qbo_id', payload, 'resolution=merge-duplicates,return=minimal');
      counts.upserted += payload.length;
      log.push(`page at ${pos}: ${rows.length} entries`);
      if (rows.length < PAGE) break;
    }
  } catch (err) {
    fatal = String(err?.message || err).slice(0, 400);
    counts.errors += 1;
    log.push(`FATAL: ${fatal}`);
  }

  const meta = { ...counts, trigger, window_from: from, elapsed_ms: Date.now() - t0 };
  // Log EVERY run, success or not. A run that leaves no row reads exactly like
  // "nothing to do", which is how the SF job sync hid for months.
  try {
    await ops('POST', 'sync_log', [{
      source: 'qbo', sync_type: 'time_activities',
      status: fatal ? 'error' : 'success',
      records_synced: counts.upserted,
      started_at: startedAt, completed_at: new Date().toISOString(),
      ...(fatal ? { error_message: fatal } : {}),
      metadata: meta,
    }], 'return=minimal');
  } catch (e) { log.push(`sync_log write failed: ${String(e?.message || e).slice(0, 120)}`); }

  return { ok: !fatal, ...meta, log, ...(fatal ? { error: fatal } : {}) };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'POST' }, 405);

  let trigger = 'cron';
  if (!cronSecretOk(req)) {
    const auth = await requireAuth(req, ['superadmin', 'admin']);
    if (!auth.ok) return auth.response;
    trigger = auth.user?.email || 'staff';
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on this site' }, 500);
  }

  const url = new URL(req.url);
  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
  const months = Math.max(1, Math.min(60,
    parseInt(body.months || url.searchParams.get('months') || DEFAULT_LOOKBACK_MONTHS, 10) || DEFAULT_LOOKBACK_MONTHS));

  const result = await runTimeSync({ trigger, months, budgetMs: 20_000 });
  return json(result, result.ok ? 200 : 502);
}
