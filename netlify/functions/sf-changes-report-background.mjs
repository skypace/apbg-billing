// sf-changes-report-background.mjs — the Service Fusion Changes report.
//
// Scans EVERY Service Fusion customer (with contacts + emails), diffs against
// the last snapshot in ops.sf_customer_snapshot, then emails a report of:
//   - communication-settings changes (per contact email `types_accepted` —
//     the per-address CONF/STATUS/PMT/INV checkboxes in the SF customer screen)
//   - new customers
//   - removed customers (SF's API has NO active/archived flag — a deleted OR
//     deactivated customer simply vanishes from the list, so both report as
//     "removed")
//   - customer renames
// and updates the snapshot. First run seeds the baseline and says so.
//
// Why: SF's API is read-only for customers (GET + create only, verified live
// 2026-07-15 — PUT /customers/{id} is 405), so comms settings can't be
// enforced programmatically. This report is the watchdog instead.
//
// SF auth: piggybacks on the pacerfinance SF MCP's token (ops.pacer_mcp_tokens,
// provider='sf'). SF rotates refresh tokens on every use, so we NEVER refresh
// here — if the stored access token is stale we poke the MCP (sf_whoami) via
// PACER_MCP_API_KEY, which refreshes + persists, then re-read. (The old
// ops.sf_token_cache grant used by resq-sync is a different credential and has
// been dead since 2026-06-29.)
//
// Runs as a Netlify BACKGROUND function (15-min budget — the SF scan takes
// ~1-2 min). Invoked by the Master Control button (superadmin Bearer) or the
// daily cron (x-sf-changes-secret = SUPABASE_SERVICE_ROLE_KEY prefix). The
// cron path emails ONLY when something changed; the button always emails.
// Every run appends an ops.sync_log row (existing logging convention).

import { requireAuth } from './lib/auth.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';

const SF_API = 'https://api.servicefusion.com/v1';
const PACER_MCP = 'https://pacerfinance.netlify.app/servicefusion';
const REPORT_TO = process.env.SF_CHANGES_REPORT_TO || 'service@brixbev.com';

function serviceHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function opsGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: serviceHeaders({ 'Accept-Profile': 'ops' }),
  });
  if (!res.ok) throw new Error(`ops read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function opsWrite(method, pathAndQuery, body, prefer = 'return=minimal') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: serviceHeaders({ 'Content-Profile': 'ops', 'Content-Type': 'application/json', Prefer: prefer }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** SF access token via the pacerfinance MCP's store — never refresh ourselves
 *  (SF rotates refresh tokens per use; two refreshers invalidate each other). */
async function getSfToken() {
  const read = () => opsGet(`pacer_mcp_tokens?provider=eq.sf&select=access_token,access_expires_at`);
  let rows = await read();
  const fresh = (r) => r?.access_token && r?.access_expires_at && new Date(r.access_expires_at).getTime() - Date.now() > 120000;
  if (fresh(rows[0])) return rows[0].access_token;
  const mcpKey = process.env.PACER_MCP_API_KEY;
  if (!mcpKey) throw new Error('SF token stale and PACER_MCP_API_KEY not set — cannot ask the MCP to refresh');
  const poke = await fetch(PACER_MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-api-key': mcpKey },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'sf_whoami', arguments: {} }, id: 1 }),
  });
  if (!poke.ok) throw new Error(`MCP token poke failed (${poke.status})`);
  await poke.text();
  rows = await read();
  if (fresh(rows[0])) return rows[0].access_token;
  throw new Error('SF token still stale after MCP refresh — check the pacerfinance SF connection');
}

async function fetchAllSfCustomers(token) {
  const out = [];
  let page = 1;
  for (;;) {
    const url = `${SF_API}/customers?per-page=50&page=${page}&expand=contacts,contacts.emails&fields=id,customer_name`;
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (res.ok) break;
      if (attempt >= 2) throw new Error(`SF customers page ${page} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    const d = await res.json();
    out.push(...(d.items || []));
    const meta = d._meta || {};
    if (page >= (meta.pageCount || 1)) break;
    page++;
  }
  return out;
}

/** Normalize one SF customer into its comms fingerprint. */
function commsOf(c) {
  const rows = [];
  for (const ct of c.contacts || []) {
    for (const e of ct.emails || []) {
      const t = e.types_accepted;
      const types = t == null ? '' : String(t).split(',').map((x) => x.trim()).filter(Boolean).sort().join(',');
      if (types) rows.push({ contact: `${ct.fname || ''} ${ct.lname || ''}`.trim(), email: e.email || '(blank address)', types });
    }
  }
  rows.sort((a, b) => (a.email + a.contact).localeCompare(b.email + b.contact));
  return rows;
}

function fmtComms(rows) {
  if (!rows.length) return '<i>none</i>';
  return rows.map((r) => `${esc(r.email)}${r.contact ? ` (${esc(r.contact)})` : ''}: <b>${esc(r.types)}</b>`).join('<br>');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export default async (req) => {
  // Auth: superadmin Bearer (Master Control button) OR the cron's shared secret.
  const cronSecret = req.headers.get('x-sf-changes-secret') || '';
  const isCron = cronSecret && cronSecret === (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 32);
  if (!isCron) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;
  }
  const quietIfUnchanged = isCron; // cron only emails on changes; button always emails

  const startedAt = new Date().toISOString();
  let logMsg = '';
  try {
    const token = await getSfToken();
    const customers = await fetchAllSfCustomers(token);
    const current = new Map(customers.map((c) => [String(c.id), { name: c.customer_name || '', comms: commsOf(c) }]));

    const snapRows = await opsGet('sf_customer_snapshot?select=sf_customer_id,customer_name,comms,removed_at&limit=10000');
    const snap = new Map(snapRows.map((r) => [String(r.sf_customer_id), r]));
    const isBaseline = snap.size === 0;

    const added = [];
    const removed = [];
    const commsChanged = [];
    const renamed = [];
    const returned = [];

    for (const [id, cur] of current) {
      const old = snap.get(id);
      if (!old) { added.push({ id, ...cur }); continue; }
      if (old.removed_at) returned.push({ id, ...cur });
      const oldComms = JSON.stringify(old.comms || []);
      const newComms = JSON.stringify(cur.comms);
      if (oldComms !== newComms) commsChanged.push({ id, name: cur.name, before: old.comms || [], after: cur.comms });
      if ((old.customer_name || '') !== cur.name) renamed.push({ id, before: old.customer_name, after: cur.name });
    }
    for (const [id, old] of snap) {
      if (!current.has(id) && !old.removed_at) removed.push({ id, name: old.customer_name, comms: old.comms || [] });
    }

    const changes = added.length + removed.length + commsChanged.length + renamed.length + returned.length;

    // ── persist the new snapshot (upsert current, stamp removed) ──
    const now = new Date().toISOString();
    const upserts = [...current].map(([id, c]) => ({
      sf_customer_id: id, customer_name: c.name, comms: c.comms, last_seen_at: now, removed_at: null,
    }));
    for (let i = 0; i < upserts.length; i += 500) {
      await opsWrite('POST', 'sf_customer_snapshot?on_conflict=sf_customer_id', upserts.slice(i, i + 500), 'resolution=merge-duplicates,return=minimal');
    }
    for (const r of removed) {
      await opsWrite('PATCH', `sf_customer_snapshot?sf_customer_id=eq.${encodeURIComponent(r.id)}`, { removed_at: now });
    }

    // ── email ──
    const section = (title, bodyHtml) => (bodyHtml ? `<h3 style="margin:18px 0 6px;color:#0F172A">${title}</h3>${bodyHtml}` : '');
    const table = (rows) => `<table style="border-collapse:collapse;font-size:13px">${rows}</table>`;
    const td = 'padding:5px 10px;border-top:1px solid #E5E7EB;vertical-align:top';

    let html;
    if (isBaseline) {
      html = `<p><b>Baseline created.</b> Snapshot of ${current.size} Service Fusion customers stored. Future runs will report changes against it.</p>`;
    } else {
      html =
        `<p>Compared against the snapshot from the previous run. <b>${changes} change${changes === 1 ? '' : 's'}</b> across ${current.size} customers.</p>` +
        section(`⚙️ Communication settings changed (${commsChanged.length})`,
          commsChanged.length ? table(commsChanged.map((c) =>
            `<tr><td style="${td}"><b>${esc(c.name)}</b><br><span style="color:#6B7280">SF ${esc(c.id)}</span></td>` +
            `<td style="${td}"><span style="color:#6B7280">was:</span><br>${fmtComms(c.before)}</td>` +
            `<td style="${td}"><span style="color:#6B7280">now:</span><br>${fmtComms(c.after)}</td></tr>`).join('')) : '') +
        section(`🆕 New customers (${added.length})`,
          added.length ? table(added.map((c) => `<tr><td style="${td}"><b>${esc(c.name)}</b> — SF ${esc(c.id)}</td><td style="${td}">${fmtComms(c.comms)}</td></tr>`).join('')) : '') +
        section(`🗑 Removed customers — deleted or archived, SF's API can't tell which (${removed.length})`,
          removed.length ? table(removed.map((c) => `<tr><td style="${td}"><b>${esc(c.name)}</b> — SF ${esc(c.id)}</td><td style="${td}">had: ${fmtComms(c.comms)}</td></tr>`).join('')) : '') +
        section(`↩️ Returned (previously removed, visible again) (${returned.length})`,
          returned.length ? table(returned.map((c) => `<tr><td style="${td}"><b>${esc(c.name)}</b> — SF ${esc(c.id)}</td></tr>`).join('')) : '') +
        section(`✏️ Renamed (${renamed.length})`,
          renamed.length ? table(renamed.map((c) => `<tr><td style="${td}">SF ${esc(c.id)}: ${esc(c.before)} → <b>${esc(c.after)}</b></td></tr>`).join('')) : '') +
        (changes === 0 ? '<p style="color:#059669"><b>No changes.</b></p>' : '');
    }

    const shouldEmail = isBaseline || changes > 0 || !quietIfUnchanged;
    if (shouldEmail) {
      await sendEmail({
        to: REPORT_TO,
        subject: isBaseline
          ? `Service Fusion Changes report — baseline created (${current.size} customers)`
          : `Service Fusion Changes report — ${changes} change${changes === 1 ? '' : 's'}`,
        html: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:720px">` +
          `<div style="background:#0F172A;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0"><b>Service Fusion Changes report</b> · ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT</div>` +
          `<div style="border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px;padding:6px 20px 16px">${html}` +
          `<p style="color:#9CA3AF;font-size:12px;margin-top:16px">Run from ${isCron ? 'the daily check' : 'Master Control'} · comms settings = per-email types_accepted (CONF/STATUS/PMT/INV) · SF's API is read-only for customers, so fixes happen in the SF web UI.</p></div></div>`,
      });
    }

    logMsg = `${isBaseline ? `baseline ${current.size} customers` : `${changes} changes (${commsChanged.length} comms, +${added.length}, -${removed.length}, ${renamed.length} renamed)`}${shouldEmail ? ', emailed' : ', quiet (no changes)'}`;
    await opsWrite('POST', 'sync_log', {
      source: 'sf-changes-report', sync_type: 'sf_changes', status: 'success',
      records_synced: current.size, started_at: startedAt, completed_at: new Date().toISOString(),
      metadata: { message: logMsg },
    }).catch(() => {});
    console.log('[sf-changes-report]', logMsg);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    console.error('[sf-changes-report] failed:', e);
    await opsWrite('POST', 'sync_log', {
      source: 'sf-changes-report', sync_type: 'sf_changes', status: 'error',
      error_message: String(e?.message || e).slice(0, 500), started_at: startedAt, completed_at: new Date().toISOString(),
    }).catch(() => {});
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
};
