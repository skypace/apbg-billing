// sync-qbo-items edge function — APBG-OPS Supabase project
// Pulls QBO Item master into ops.qbo_items so the margin dashboard can
// compute estimated COGS = quantity x Item.PurchaseCost.
//
// v7 (2026-05-14): include inactive items in the QBO query.
// QBO's default `select * from Item` returns only Active=true rows. We
// need the full set so deactivations in QBO get reflected in our local
// copy. Adds `where Active in (true, false)`. Also reconciles anything
// in our DB that's missing from the QBO response by setting active=false
// (defensive — covers hard-deletes).
//
// Mirrors sync-qbo-employees v2: lease-based token rotation through
// ops.qbo_token_cache + qbo_token_claim_refresh / qbo_token_persist /
// qbo_token_release_failed RPCs. No write-once env-var assumptions.

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

type QboRef = { value?: string; name?: string };

type QboItem = {
  Id: string;
  Name?: string;
  FullyQualifiedName?: string;
  Sku?: string;
  Active?: boolean;
  Type?: string;
  Taxable?: boolean;
  UnitPrice?: number;
  PurchaseCost?: number;
  QtyOnHand?: number;
  IncomeAccountRef?: QboRef;
  ExpenseAccountRef?: QboRef;
  AssetAccountRef?: QboRef;
  ParentRef?: QboRef;
  MetaData?: { LastUpdatedTime?: string };
};

interface ClaimResult {
  cached_access_token: string | null;
  cached_refresh_token: string | null;
  must_refresh: boolean;
  lease_acquired: boolean;
  reason: string;
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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function claimRefresh(sb: SupabaseClient): Promise<ClaimResult> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
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
    p_refreshed_by: "sync-qbo-items@v7",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
}

async function releaseFailedLease(sb: SupabaseClient, message: string): Promise<void> {
  await sb.rpc("qbo_token_release_failed", {
    p_realm_id: getRealm(),
    p_error: message.slice(0, 500),
  });
}

async function intuitRefresh(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
}> {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) {
    throw new Error("missing QBO_CLIENT_ID or QBO_CLIENT_SECRET env");
  }
  const creds = btoa(clientId + ":" + clientSecret);
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + creds,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("intuit refresh failed (" + res.status + "): " + JSON.stringify(data));
  }
  return data;
}

async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < LEASE_POLL_MAX_ATTEMPTS; attempt++) {
    const claim = await claimRefresh(sb);

    if (!claim.must_refresh && claim.cached_access_token) {
      return claim.cached_access_token;
    }

    if (claim.lease_acquired) {
      const refreshSeed =
        claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!refreshSeed) {
        await releaseFailedLease(
          sb,
          "no refresh token available — cache empty and QBO_REFRESH_TOKEN env unset",
        );
        throw new Error("no refresh token available (cache empty, env unset)");
      }
      try {
        const fresh = await intuitRefresh(refreshSeed);
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
  throw new Error(
    "timed out waiting for QBO refresh lease (" + LEASE_POLL_MAX_ATTEMPTS + " polls)",
  );
}

async function fetchAllItems(sb: SupabaseClient): Promise<QboItem[]> {
  const realm = getRealm();
  const base = qboBaseUrl();
  const all: QboItem[] = [];
  const pageSize = 1000;
  let startPosition = 1;

  while (true) {
    // CRITICAL: include `where Active in (true, false)` so QBO returns
    // BOTH active and inactive items. Without this, QBO's default is
    // to return only Active=true rows, which means deactivations in
    // QBO never reach our local copy.
    const q = encodeURIComponent(
      `select * from Item where Active in (true, false) startposition ${startPosition} maxresults ${pageSize}`,
    );
    const url = `${base}/v3/company/${realm}/query?query=${q}&minorversion=70`;

    let token = await getAccessToken(sb);
    let resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (resp.status === 401) {
      await sb.rpc("qbo_token_release_failed", {
        p_realm_id: realm,
        p_error: "401 from QBO Item query",
      });
      token = await getAccessToken(sb);
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`QBO query failed (${resp.status}): ${text}`);
    }
    const json: any = await resp.json();
    const batch: QboItem[] = json?.QueryResponse?.Item ?? [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    startPosition += pageSize;
  }
  return all;
}

function toRow(it: QboItem) {
  const inc = it.IncomeAccountRef ?? {};
  const exp = it.ExpenseAccountRef ?? {};
  const ass = it.AssetAccountRef ?? {};
  const fqn = it.FullyQualifiedName ?? null;
  const categoryPath = fqn && fqn.includes(":")
    ? fqn.split(":").slice(0, -1).join(":")
    : null;
  return {
    qbo_item_id: it.Id,
    name: it.Name ?? fqn ?? `Item ${it.Id}`,
    fully_qualified_name: fqn,
    sku: it.Sku ?? null,
    type: it.Type ?? null,
    active: it.Active ?? true,
    taxable: typeof it.Taxable === "boolean" ? it.Taxable : null,
    unit_price: it.UnitPrice ?? null,
    purchase_cost: it.PurchaseCost ?? null,
    qty_on_hand: it.QtyOnHand ?? null,
    income_account_ref_id: inc.value ?? null,
    income_account_name: inc.name ?? null,
    expense_account_ref_id: exp.value ?? null,
    expense_account_name: exp.name ?? null,
    asset_account_ref_id: ass.value ?? null,
    asset_account_name: ass.name ?? null,
    parent_ref_id: it.ParentRef?.value ?? null,
    category_path: categoryPath,
    qbo_updated_at: it.MetaData?.LastUpdatedTime
      ? new Date(it.MetaData.LastUpdatedTime).toISOString()
      : null,
    synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const startedAt = Date.now();
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "sync";
  const sb = getSB();

  if (mode === "test") {
    const r: Record<string, any> = {};
    r.env = {
      QBO_CLIENT_ID: (Deno.env.get("QBO_CLIENT_ID") || "").length > 0 ? "SET" : "MISSING",
      QBO_CLIENT_SECRET:
        (Deno.env.get("QBO_CLIENT_SECRET") || "").length > 0 ? "SET" : "MISSING",
      QBO_REFRESH_TOKEN:
        (Deno.env.get("QBO_REFRESH_TOKEN") || "").length > 0 ? "SET" : "MISSING",
      QBO_REALM_ID: (Deno.env.get("QBO_REALM_ID") || "").length > 0 ? "SET" : "MISSING",
      SUPABASE_URL: (Deno.env.get("SUPABASE_URL") || "").length > 0 ? "SET" : "MISSING",
      SUPABASE_SERVICE_ROLE_KEY:
        (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").length > 0 ? "SET" : "MISSING",
    };
    try {
      const tok = await getAccessToken(sb);
      r.qbo = "OK (token len=" + tok.length + ")";
    } catch (e: any) {
      r.qbo = "FAIL: " + e.message;
    }
    return jsonRes(r);
  }

  try {
    const realm = getRealm();
    if (!realm) throw new Error("Missing QBO_REALM_ID");
    if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    }

    await getAccessToken(sb);

    const items = await fetchAllItems(sb);
    const rowsRaw = items.map(toRow);
    const withCost = rowsRaw.filter((r) => r.purchase_cost != null).length;
    const activeCount   = rowsRaw.filter((r) => r.active === true).length;
    const inactiveCount = rowsRaw.filter((r) => r.active === false).length;

    // Skip items that the user has edited locally in the Margin Control
    // Items master. ops.inventory_settings.is_qbo_locked = true means the
    // inbound sync must not overwrite that qbo_items row. Sky's normal
    // workflow is: edit in BRIX → push-qbo-item explicitly when ready,
    // not the other way around.
    const { data: lockedRows, error: lockErr } = await sb
      .schema("ops")
      .from("inventory_settings")
      .select("qbo_item_id")
      .eq("is_qbo_locked", true);
    if (lockErr) throw lockErr;
    const lockedIds = new Set(
      (lockedRows ?? []).map((r: { qbo_item_id: string }) => r.qbo_item_id),
    );
    const rows = rowsRaw.filter((r) => !lockedIds.has(r.qbo_item_id));
    const skipped_locked = rowsRaw.length - rows.length;

    let upserted = 0;
    if (rows.length) {
      const { error } = await sb
        .schema("ops")
        .from("qbo_items")
        .upsert(rows, { onConflict: "qbo_item_id" });
      if (error) throw error;
      upserted = rows.length;
    }

    // Belt-and-suspenders reconciliation: anything in our DB that
    // didn't come back from QBO is either hard-deleted or otherwise
    // unreachable. Mark such rows inactive so they at least disappear
    // from default UI filters. Locked rows are exempted — if Sky has
    // intentionally curated an item that no longer exists in QBO, we
    // respect that choice rather than silently deactivating it.
    const fetchedIds = new Set(items.map((i) => i.Id));
    let reconciled_inactive = 0;
    const { data: existing, error: existErr } = await sb
      .schema("ops")
      .from("qbo_items")
      .select("qbo_item_id");
    if (existErr) throw existErr;
    const stale = (existing ?? [])
      .map((r) => r.qbo_item_id)
      .filter((id: string) => !fetchedIds.has(id) && !lockedIds.has(id));
    if (stale.length > 0) {
      const { error: updErr } = await sb
        .schema("ops")
        .from("qbo_items")
        .update({ active: false, synced_at: new Date().toISOString() })
        .in("qbo_item_id", stale);
      if (updErr) throw updErr;
      reconciled_inactive = stale.length;
    }

    return jsonRes({
      ok: true,
      realm_id: realm,
      environment: Deno.env.get("QBO_ENVIRONMENT") ?? "production",
      synced: items.length,
      active_in_qbo: activeCount,
      inactive_in_qbo: inactiveCount,
      with_purchase_cost: withCost,
      without_cost: items.length - withCost,
      upserted,
      skipped_locked,
      reconciled_inactive,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("sync-qbo-items FATAL:", err);
    return jsonRes(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt,
      },
      500,
    );
  }
});
