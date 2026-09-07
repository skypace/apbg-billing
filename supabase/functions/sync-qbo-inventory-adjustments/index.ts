// sync-qbo-inventory-adjustments — APBG-OPS Supabase project
//
// Pulls QBO InventoryAdjustment transactions (shrinkage, write-offs,
// count corrections, found inventory). Each line carries an item_ref +
// qty_diff (signed: negative = removed, positive = added).
//
// v15 (2026-09-04) — THE DUPLICATE BUG. QuickBooks does not put a LineNum on
// InventoryAdjustment lines, so v14 wrote line_num = NULL on every row, and the
// upsert's conflict key (qbo_txn_id, line_num) never fired: NULLs are distinct
// in a unique index. Every nightly run therefore INSERTED every line again —
// 125,694 rows for 1,138 real lines by 2026-09-03 (one copy per night since
// 2026-05-03), and fn_items_master summed them as "shrinkage" demand: root beer
// cases read 39 units/day of velocity against a true 7.8, and 5 days of supply
// against a true 30. Fixed two ways: line_num is now the QuickBooks line Id,
// falling back to the 1-based position, so the key is real; and every
// adjustment's lines are DELETED and rewritten on each run, so a line
// QuickBooks removed disappears here too and a NULL line_num can never
// accumulate again. Migration 20260904f deduplicated the existing rows.
//
// The repo copy of this source lives at
// supabase/functions/sync-qbo-inventory-adjustments/index.ts — deploy from
// there, with verify_jwt=false (it is called by pg_cron with the service key).

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 3600;
const REFRESH_MIN_REMAINING_SECONDS = 300;
const LEASE_SECONDS = 20;
const LEASE_POLL_INTERVAL_MS = 750;
const LEASE_POLL_MAX_ATTEMPTS = 20;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function getRealm() { return Deno.env.get("QBO_REALM_ID") || ""; }
function qboBaseUrl() {
  const env = Deno.env.get("QBO_ENVIRONMENT") ?? "production";
  return env === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}
function getSB() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}
function jsonRes(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type":"application/json", ...CORS } });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function claimRefresh(sb: SupabaseClient): Promise<any> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh: " + error.message);
  return Array.isArray(data) ? data[0] : data;
}
async function persistTokens(sb: SupabaseClient, accessToken: string, refreshToken: string,
  expiresInSeconds: number, refreshTokenExpiresInSeconds: number | null) {
  const accessExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshExpiry = refreshTokenExpiresInSeconds
    ? new Date(Date.now() + refreshTokenExpiresInSeconds * 1000).toISOString()
    : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: accessToken, p_access_expires: accessExpiry,
    p_refresh_token: refreshToken, p_refresh_expires: refreshExpiry,
    p_refreshed_by: "sync-qbo-inventory-adjustments@v15",
  });
  if (error) throw new Error("token_persist: " + error.message);
}
async function releaseFailedLease(sb: SupabaseClient, message: string) {
  await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: message.slice(0, 500) });
}
async function intuitRefresh(refreshToken: string) {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("missing QBO creds");
  const creds = btoa(clientId + ":" + clientSecret);
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded", Accept:"application/json", Authorization: "Basic " + creds },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("intuit refresh: " + JSON.stringify(data));
  return data;
}
async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let i = 0; i < LEASE_POLL_MAX_ATTEMPTS; i++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const seed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) { await releaseFailedLease(sb, "no refresh token"); throw new Error("no refresh token"); }
      try {
        const fresh = await intuitRefresh(seed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS,
          fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) { await releaseFailedLease(sb, (err as Error).message); throw err; }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}
async function qboQueryAll(sb: SupabaseClient, entity: string, where: string): Promise<any[]> {
  const all: any[] = [];
  let start = 1;
  const page = 1000;
  while (true) {
    const sql = `select * from ${entity}${where ? " where " + where : ""} startposition ${start} maxresults ${page}`;
    const url = qboBaseUrl() + "/v3/company/" + getRealm() + "/query?query=" + encodeURIComponent(sql) + "&minorversion=70";
    let token = await getAccessToken(sb);
    let res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (res.status === 401) {
      await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: "401 from " + entity + " query" });
      token = await getAccessToken(sb);
      res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`QBO ${entity} query failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    const list = json?.QueryResponse?.[entity] ?? [];
    all.push(...list);
    if (list.length < page) break;
    start += page;
  }
  return all;
}

function headerRow(adj: any) {
  // Account ref shape varies: AdjustAccountRef or AccountRef
  const acctRef = adj.AdjustAccountRef ?? adj.AccountRef ?? {};
  return {
    qbo_txn_id: adj.Id,
    txn_date: adj.TxnDate || null,
    ref_number: adj.DocNumber ?? null,
    adjustment_account_id: acctRef.value ?? null,
    adjustment_account_name: acctRef.name ?? null,
    memo: adj.PrivateNote ?? null,
    total_lines: (adj.Line ?? []).length,
    synced_at: new Date().toISOString(),
  };
}
// A line number that is never NULL: QuickBooks' LineNum when it sends one,
// else its line Id, else the 1-based position. NULL here is exactly what let
// v1–v14 duplicate every line every night.
export function lineNumberFor(ln: any, idx: number): number {
  if (typeof ln?.LineNum === "number") return ln.LineNum;
  const id = Number(ln?.Id);
  if (Number.isFinite(id) && id > 0) return id;
  return idx + 1;
}
export function lineRows(adj: any) {
  const date = adj.TxnDate || null;
  const lines: any[] = [];
  (adj.Line ?? []).forEach((ln: any, idx: number) => {
    // Inventory adjustment uses ItemAdjustmentLineDetail with QtyDiff
    const det = ln.ItemAdjustmentLineDetail ?? {};
    const itemRef = det.ItemRef ?? {};
    lines.push({
      qbo_txn_id: adj.Id,
      line_num: lineNumberFor(ln, idx),
      item_ref_id: itemRef.value ?? null,
      item_name: itemRef.name ?? null,
      qty_diff: typeof det.QtyDiff === "number" ? det.QtyDiff
              : typeof ln.Amount   === "number" ? ln.Amount    // some payloads put it on Amount
              : null,
      new_qty: typeof det.NewQuantity === "number" ? det.NewQuantity : null,
      description: ln.Description ?? null,
      txn_date: date,
      synced_at: new Date().toISOString(),
    });
  });
  return lines;
}
async function chunkUpsert(sb: SupabaseClient, table: string, rows: any[], onConflict: string, chunk = 500) {
  let total = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await sb.schema("ops").from(table).upsert(slice, { onConflict });
    if (error) throw new Error("upsert " + table + ": " + error.message);
    total += slice.length;
  }
  return total;
}
// Rewrite, don't accumulate: the lines QuickBooks holds for these adjustments
// TODAY are the lines we hold. A line QuickBooks deleted disappears here, and
// no keying accident can stack copies again.
async function replaceLines(sb: SupabaseClient, txnIds: string[], rows: any[], chunk = 200) {
  for (let i = 0; i < txnIds.length; i += chunk) {
    const { error } = await sb.schema("ops").from("qbo_inventory_adjustment_lines")
      .delete().in("qbo_txn_id", txnIds.slice(i, i + chunk));
    if (error) throw new Error("delete qbo_inventory_adjustment_lines: " + error.message);
  }
  return chunkUpsert(sb, "qbo_inventory_adjustment_lines", rows, "qbo_txn_id,line_num");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const startedAt = Date.now();
  const sb = getSB();
  let since = "2025-01-01";
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body && typeof body.since === "string") since = body.since;
    } else {
      const url = new URL(req.url);
      since = url.searchParams.get("since") || since;
    }
  } catch (_e) {}

  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    await getAccessToken(sb);

    const where = `TxnDate >= '${since}'`;
    let list: any[] = [];
    try { list = await qboQueryAll(sb, "InventoryAdjustment", where); }
    catch (e) {
      // If PACER doesn't use InventoryAdjustment, the entity may 400.
      // Surface gracefully so downstream code can tell.
      return jsonRes({
        ok: false,
        error: "InventoryAdjustment query failed: " + (e as Error).message,
        note: "This usually means the QBO realm doesn't track inventory adjustments. Skipping is fine.",
        duration_ms: Date.now() - startedAt,
      }, 200);
    }

    const headers: any[] = [];
    const lines: any[] = [];
    for (const adj of list) {
      headers.push(headerRow(adj));
      for (const r of lineRows(adj)) lines.push(r);
    }
    const headerCount = await chunkUpsert(sb, "qbo_inventory_adjustments", headers, "qbo_txn_id");
    const lineCount   = await replaceLines(sb, list.map((a: any) => String(a.Id)), lines);

    const lostQty = lines.filter((l: any) => Number(l.qty_diff || 0) < 0)
      .reduce((s: number, l: any) => s + Math.abs(Number(l.qty_diff || 0)), 0);

    return jsonRes({
      ok: true, since, version: 15,
      adjustments_seen: list.length,
      headers_upserted: headerCount,
      lines_upserted: lineCount,
      total_negative_qty: lostQty,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
