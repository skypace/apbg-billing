// QBO sync runner.
//
// This is the safer scheduler bridge for QBO cache jobs. Older pg_cron jobs
// call Supabase Edge Functions directly, which means auth has to live in SQL.
// This Netlify scheduled function keeps the bearer token in Netlify env and
// calls the existing Supabase Edge Functions from there.

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';
import { requireScheduledOrAuth } from './lib/auth.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const EDGE_KEY = SERVICE_KEY || SUPABASE_ANON_KEY;
const DEFAULT_LINE_BATCH = 50;
const DEFAULT_REFRESH_LINE_BATCH = 100;
const LINE_BACKFILL_MAX_AGE_MS = 10 * 60 * 1000;
const REFRESH_LINES_MAX_AGE_MS = 15 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const ageMs = (iso) => (iso ? Date.now() - new Date(iso).getTime() : Number.POSITIVE_INFINITY);
const stale = (iso, maxMs) => ageMs(iso) > maxMs;

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: CORS });
}

function sbClient() {
  if (!SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    db: { schema: 'ops' },
    auth: { persistSession: false },
  });
}

async function latestSync(sb, syncType, statuses = ['success', 'ok']) {
  const { data, error } = await sb
    .from('sync_log')
    .select('completed_at, metadata')
    .eq('source', 'qbo')
    .eq('sync_type', syncType)
    .in('status', statuses)
    .order('completed_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`sync_log latest ${syncType}: ${error.message}`);
  return data?.[0] || null;
}

async function latestTableTimestamp(sb, table, column) {
  const { data, error } = await sb
    .from(table)
    .select(column)
    .not(column, 'is', null)
    .order(column, { ascending: false })
    .limit(1);
  if (error) throw new Error(`${table}.${column} latest: ${error.message}`);
  return data?.[0]?.[column] || null;
}

async function qboInvoiceCount(sb) {
  const { count, error } = await sb
    .from('qbo_invoices')
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`qbo_invoices count: ${error.message}`);
  return Math.max(count || 0, 1);
}

async function qboRecentInvoiceCount(sb, startDate) {
  const { count, error } = await sb
    .from('qbo_invoices')
    .select('id', { count: 'exact', head: true })
    .gte('txn_date', startDate);
  if (error) throw new Error(`qbo_invoices recent count: ${error.message}`);
  return Math.max(count || 0, 1);
}

async function nextLineOffset(sb, batch = DEFAULT_LINE_BATCH) {
  const total = await qboInvoiceCount(sb);
  const last = await latestSync(sb, 'lines_backfill');
  const metadata = last?.metadata || {};
  const previousOffset = Number(metadata.offset);
  const previousBatch = Number(metadata.batch || batch);
  if (!Number.isFinite(previousOffset) || previousOffset < 0) return 0;
  return (previousOffset + (Number.isFinite(previousBatch) ? previousBatch : batch)) % total;
}

async function nextRefreshLineOffset(sb, startDate, batch = DEFAULT_REFRESH_LINE_BATCH) {
  const total = await qboRecentInvoiceCount(sb, startDate);
  const last = await latestSync(sb, 'runner_refresh_lines');
  const metadata = last?.metadata || {};
  const previousOffset = Number(metadata.offset);
  const previousBatch = Number(metadata.batch || batch);
  if (!Number.isFinite(previousOffset) || previousOffset < 0) return 0;
  return (previousOffset + (Number.isFinite(previousBatch) ? previousBatch : batch)) % total;
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function logRunner(sb, name, status, metadata, errorMessage = null) {
  if (!sb) return;
  try {
    await sb.from('sync_log').insert({
      source: 'qbo',
      sync_type: `runner_${name}`,
      status,
      records_synced: Number(metadata?.records_synced || 0),
      error_message: errorMessage,
      started_at: metadata.started_at,
      completed_at: new Date().toISOString(),
      metadata,
    });
  } catch (_e) {
    // Runner logging is helpful, but it should not mask the underlying job result.
  }
}

async function callEdge(sb, name, path, { method = 'GET', body = null, timeoutMs = 180000, logName = name, metadataExtra = {} } = {}) {
  const startedAt = new Date().toISOString();
  const url = `${SUPABASE_URL}/functions/v1/${name}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const metadata = { started_at: startedAt, function: name, path, method, ...metadataExtra };

  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        apikey: EDGE_KEY,
        Authorization: `Bearer ${EDGE_KEY}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_e) {
      payload = { raw: text.slice(0, 1000) };
    }

    const payloadStatus = String(payload?.status ?? payload?.ok ?? '').toLowerCase();
    const ok = res.ok && !['error', 'failed', 'false', 'partial'].includes(payloadStatus);
    const result = {
      ok,
      http_status: res.status,
      payload,
      duration_ms: Date.now() - new Date(startedAt).getTime(),
    };
    await logRunner(
      sb,
      logName,
      ok ? 'success' : 'error',
      { ...metadata, ...result },
      ok ? null : `${name} returned HTTP ${res.status}`,
    );
    return result;
  } catch (err) {
    const message = err?.name === 'AbortError'
      ? `${name} timed out after ${timeoutMs}ms`
      : String(err?.message || err);
    const result = { ok: false, error: message, duration_ms: Date.now() - new Date(startedAt).getTime() };
    await logRunner(sb, logName, 'error', { ...metadata, ...result }, message);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function runAuto(sb, url) {
  const force = url.searchParams.get('force') === '1';
  const dryRun = url.searchParams.get('dry_run') === '1';
  const batch = Number(url.searchParams.get('batch') || DEFAULT_LINE_BATCH) || DEFAULT_LINE_BATCH;
  const refreshBatch = Number(url.searchParams.get('refresh_batch') || DEFAULT_REFRESH_LINE_BATCH) || DEFAULT_REFRESH_LINE_BATCH;
  const refreshStart = url.searchParams.get('refresh_start') || isoDateDaysAgo(90);
  const refreshEnd = url.searchParams.get('refresh_end') || new Date().toISOString().slice(0, 10);
  const tasks = [];

  const [invoiceSync, lineSync, refreshLineSync, mvRefresh, itemCacheAt] = await Promise.all([
    latestSync(sb, 'invoices'),
    latestSync(sb, 'lines_backfill'),
    latestSync(sb, 'runner_refresh_lines'),
    latestSync(sb, 'mv_refresh'),
    latestTableTimestamp(sb, 'qbo_items', 'synced_at'),
  ]);

  if (force || stale(invoiceSync?.completed_at, 30 * 60 * 60 * 1000)) {
    tasks.push({ key: 'invoices', fn: 'sync-qbo', path: '?mode=fast', timeoutMs: 300000, logName: 'invoices' });
  }

  if (force || stale(lineSync?.completed_at, LINE_BACKFILL_MAX_AGE_MS)) {
    const offset = await nextLineOffset(sb, batch);
    tasks.push({
      key: 'lines_backfill',
      fn: 'sync-qbo',
      path: `?mode=lines&batch=${batch}&offset=${offset}`,
      timeoutMs: 180000,
      logName: 'lines_backfill',
      metadataExtra: { offset, batch },
    });
  }

  if (force || stale(refreshLineSync?.completed_at, REFRESH_LINES_MAX_AGE_MS)) {
    const offset = await nextRefreshLineOffset(sb, refreshStart, refreshBatch);
    tasks.push({
      key: 'refresh_lines',
      fn: 'sync-qbo',
      path: `?mode=refresh-lines&start=${refreshStart}&end=${refreshEnd}&batch=${refreshBatch}&offset=${offset}`,
      timeoutMs: 180000,
      logName: 'refresh_lines',
      metadataExtra: { start: refreshStart, end: refreshEnd, offset, batch: refreshBatch },
    });
  }

  if (force || stale(itemCacheAt, 30 * 60 * 60 * 1000)) {
    tasks.push({ key: 'items', fn: 'sync-qbo-items', path: '', method: 'POST', body: {}, timeoutMs: 300000, logName: 'items' });
  }

  if (tasks.length === 0 && stale(mvRefresh?.completed_at, 60 * 60 * 1000)) {
    tasks.push({ key: 'mv_refresh', fn: 'sync-qbo', path: '?mode=refresh-mv', timeoutMs: 120000, logName: 'mv_refresh' });
  }

  if (dryRun) {
    return {
      dry_run: true,
      observed: {
        invoices: invoiceSync?.completed_at || null,
        lines_backfill: lineSync?.completed_at || null,
        refresh_lines: refreshLineSync?.completed_at || null,
        mv_refresh: mvRefresh?.completed_at || null,
        qbo_items: itemCacheAt || null,
      },
      tasks,
    };
  }

  const results = [];
  for (const task of tasks) {
    const result = await callEdge(sb, task.fn, task.path, task);
    results.push({ ...task, result });
  }

  return {
    dry_run: false,
    observed: {
      invoices: invoiceSync?.completed_at || null,
      lines_backfill: lineSync?.completed_at || null,
      refresh_lines: refreshLineSync?.completed_at || null,
      mv_refresh: mvRefresh?.completed_at || null,
      qbo_items: itemCacheAt || null,
    },
    tasks: results,
  };
}

export default async function handler(req, context) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const gate = await requireScheduledOrAuth(req, context);
  if (!gate.ok) return gate.response;

  const sb = sbClient();
  if (!sb) return json(500, { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not set' });

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') || 'auto';

  let payload;
  if (mode === 'auto') {
    payload = await runAuto(sb, url);
  } else if (mode === 'lines') {
    const batch = Number(url.searchParams.get('batch') || DEFAULT_LINE_BATCH) || DEFAULT_LINE_BATCH;
    const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : await nextLineOffset(sb, batch);
    payload = { tasks: [{ key: 'lines_backfill', result: await callEdge(sb, 'sync-qbo', `?mode=lines&batch=${batch}&offset=${offset}`, { logName: 'lines_backfill', metadataExtra: { offset, batch } }) }] };
  } else if (mode === 'refresh-lines') {
    const batch = Number(url.searchParams.get('batch') || DEFAULT_REFRESH_LINE_BATCH) || DEFAULT_REFRESH_LINE_BATCH;
    const start = url.searchParams.get('start') || isoDateDaysAgo(90);
    const end = url.searchParams.get('end') || new Date().toISOString().slice(0, 10);
    const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : await nextRefreshLineOffset(sb, start, batch);
    payload = { tasks: [{ key: 'refresh_lines', result: await callEdge(sb, 'sync-qbo', `?mode=refresh-lines&start=${start}&end=${end}&batch=${batch}&offset=${offset}`, { logName: 'refresh_lines', metadataExtra: { start, end, offset, batch } }) }] };
  } else if (mode === 'invoices') {
    payload = { tasks: [{ key: 'invoices', result: await callEdge(sb, 'sync-qbo', '?mode=fast', { timeoutMs: 300000, logName: 'invoices' }) }] };
  } else if (mode === 'items') {
    payload = { tasks: [{ key: 'items', result: await callEdge(sb, 'sync-qbo-items', '', { method: 'POST', body: {}, timeoutMs: 300000, logName: 'items' }) }] };
  } else if (mode === 'refresh-mv') {
    payload = { tasks: [{ key: 'mv_refresh', result: await callEdge(sb, 'sync-qbo', '?mode=refresh-mv', { timeoutMs: 120000, logName: 'mv_refresh' }) }] };
  } else {
    return json(400, { ok: false, error: `Unknown mode: ${mode}` });
  }

  const failed = (payload.tasks || []).filter((task) => task.result && task.result.ok === false);
  return json(failed.length > 0 ? 207 : 200, {
    ok: failed.length === 0,
    mode,
    scheduled: !!gate.scheduled,
    ...payload,
  });
}

export const config = {
  schedule: '*/5 * * * *',
};
