// sync-qbo-expenses — APBG-BILLING Supabase project
// Pulls Bill + Purchase + VendorCredit transactions and writes one row per
// expense line to ops.qbo_expense_lines.
//
// v10 (2026-07-04): add stable line_key and upsert on qbo_txn_type/qbo_txn_id/
// line_key. QBO Purchase rows commonly have line_num = NULL, and the old upsert
// key allowed duplicate rows to pile up every daily sync.
// v9 (2026-05-17): verify_jwt=false to match the nightly cron.

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 100 * 24 * 3600;
const REFRESH_MIN_REMAINING_SECONDS = 300;
const LEASE_SECONDS = 20;
const LEASE_POLL_INTERVAL_MS = 750;
const LEASE_POLL_MAX_ATTEMPTS = 40;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

interface ClaimResult {
  cached_access_token: string | null;
  cached_refresh_token: string | null;
  must_refresh: boolean;
  lease_acquired: boolean;
}

function getRealm(): string {
  return Deno.env.get("QBO_REALM_ID") || "";
}

function qboBaseUrl(): string {
  const env = Deno.env.get("QBO_ENVIRONMENT") ?? "production";
  return env === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

function getSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function claimRefresh(sb: SupabaseClient): Promise<ClaimResult> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh: " + error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row as ClaimResult;
}

async function persistTokens(
  sb: SupabaseClient,
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number,
  refreshTokenExpiresInSeconds: number | null,
): Promise<void> {
  const accessExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshExpiry = refreshTokenExpiresInSeconds
    ? new Date(Date.now() + refreshTokenExpiresInSeconds * 1000).toISOString()
    : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(),
    p_access_token: accessToken,
    p_access_expires: accessExpiry,
    p_refresh_token: refreshToken,
    p_refresh_expires: refreshExpiry,
    p_refreshed_by: "sync-qbo-expenses@v10",
  });
  if (error) throw new Error("token_persist: " + error.message);
}

async function releaseFailedLease(sb: SupabaseClient, message: string): Promise<void> {
  await sb.rpc("qbo_token_release_failed", {
    p_realm_id: getRealm(),
    p_error: message.slice(0, 500),
  });
}

async function intuitRefresh(refreshToken: string) {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("missing QBO creds");
  const creds = btoa(clientId + ":" + clientSecret);
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + creds,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("intuit refresh: " + JSON.stringify(data));
  }
  return data;
}

async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let i = 0; i < LEASE_POLL_MAX_ATTEMPTS; i++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const seed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) {
        await releaseFailedLease(sb, "no refresh token");
        throw new Error("no refresh token");
      }
      try {
        const fresh = await intuitRefresh(seed);
        await persistTokens(
          sb,
          fresh.access_token,
          fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS,
          fresh.x_refresh_token_expires_in ?? null,
        );
        return fresh.access_token;
      } catch (err) {
        await releaseFailedLease(sb, (err as Error).message);
        throw err;
      }
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
    const url = qboBaseUrl() + "/v3/company/" + getRealm() + "/query?query=" +
      encodeURIComponent(sql) + "&minorversion=70";
    let token = await getAccessToken(sb);
    let res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (res.status === 401) {
      await sb.rpc("qbo_token_release_failed", {
        p_realm_id: getRealm(),
        p_error: "401 from " + entity + " query",
      });
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

function fallbackLineKey(ln: any, idx: number): string {
  const dt = ln.DetailType ?? "";
  const item = ln.ItemBasedExpenseLineDetail;
  const acct = ln.AccountBasedExpenseLineDetail;
  return [
    idx,
    dt,
    item?.ItemRef?.value ?? "",
    item?.ItemRef?.name ?? "",
    acct?.AccountRef?.value ?? "",
    acct?.AccountRef?.name ?? "",
    ln.Description ?? "",
    ln.Amount ?? "",
    item?.Qty ?? "",
    item?.UnitPrice ?? "",
  ].join("|");
}

function lineRows(txn: any, type: string) {
  const lines: any[] = [];
  const date = txn.TxnDate || null;
  const vendor = txn.EntityRef?.name ?? txn.VendorRef?.name ?? null;
  const txnLines = txn.Line ?? [];
  for (let idx = 0; idx < txnLines.length; idx++) {
    const ln = txnLines[idx];
    const dt = ln.DetailType;
    const item = ln.ItemBasedExpenseLineDetail;
    const acct = ln.AccountBasedExpenseLineDetail;
    if (!dt) continue;
    const row: any = {
      qbo_txn_id: txn.Id,
      qbo_txn_type: type,
      line_key: String(ln.Id ?? ln.LineNum ?? fallbackLineKey(ln, idx)),
      line_num: ln.LineNum ?? null,
      detail_type: dt,
      description: ln.Description ?? null,
      amount: typeof ln.Amount === "number" ? ln.Amount : null,
      txn_date: date,
      vendor_name: vendor,
      synced_at: new Date().toISOString(),
    };
    if (dt === "ItemBasedExpenseLineDetail" && item) {
      row.item_ref_id = item.ItemRef?.value ?? null;
      row.item_name = item.ItemRef?.name ?? null;
      row.quantity = typeof item.Qty === "number" ? item.Qty : null;
      row.unit_cost = typeof item.UnitPrice === "number" ? item.UnitPrice : null;
    } else if (dt === "AccountBasedExpenseLineDetail" && acct) {
      row.account_ref_id = acct.AccountRef?.value ?? null;
      row.account_name = acct.AccountRef?.name ?? null;
    }
    lines.push(row);
  }
  return lines;
}

async function chunkUpsert(
  sb: SupabaseClient,
  table: string,
  rows: any[],
  onConflict: string,
  chunk = 500,
) {
  let total = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await sb.schema("ops").from(table).upsert(slice, { onConflict });
    if (error) throw new Error("upsert " + table + ": " + error.message);
    total += slice.length;
  }
  return total;
}

async function logSync(
  sb: SupabaseClient,
  startedAt: number,
  status: "success" | "error",
  recordsSynced: number | null,
  metadata: Record<string, unknown> | null,
  errorMessage: string | null,
) {
  try {
    await sb.schema("ops").from("sync_log").insert({
      source: "qbo",
      sync_type: "expenses",
      status,
      records_synced: recordsSynced,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
      metadata,
    });
  } catch (e) {
    console.error("sync_log insert failed (non-fatal):", e);
  }
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
    if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    }
    await getAccessToken(sb);
    const where = `TxnDate >= '${since}'`;
    const types = ["Bill", "Purchase", "VendorCredit"];
    const linesOut: any[] = [];
    const counts: Record<string, number> = {};
    for (const t of types) {
      const list = await qboQueryAll(sb, t, where);
      counts[t] = list.length;
      for (const txn of list) for (const r of lineRows(txn, t)) linesOut.push(r);
    }
    const lineCount = await chunkUpsert(
      sb,
      "qbo_expense_lines",
      linesOut,
      "qbo_txn_type,qbo_txn_id,line_key",
    );
    const itemLines = linesOut.filter((l) =>
      l.detail_type === "ItemBasedExpenseLineDetail" && l.item_ref_id
    ).length;
    await logSync(sb, startedAt, "success", lineCount, { since, counts, item_lines: itemLines }, null);
    return jsonRes({
      ok: true,
      since,
      counts,
      lines_upserted: lineCount,
      item_lines: itemLines,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("sync-qbo-expenses FATAL:", err);
    const msg = err instanceof Error ? err.message : String(err);
    await logSync(sb, startedAt, "error", null, { since }, msg);
    return jsonRes({
      ok: false,
      error: msg,
      duration_ms: Date.now() - startedAt,
    }, 500);
  }
});
