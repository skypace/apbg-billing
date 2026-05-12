// push-qbo-item — single-item + bulk pushes back to QBO.
//
// Actions:
//   action: 'setActive'             → flips Item.Active in QBO + mirrors locally
//   action: 'bulkSyncCategories'    → for every item with inventory_settings.category_override,
//                                     ensure a QBO Category Item exists with that name and point
//                                     the item's ParentRef at it. Supports {commit: true} for actual
//                                     writes; defaults to dry-run.
//
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
  "Access-Control-Allow-Headers": "*, authorization, content-type, apikey",
};

interface ClaimResult {
  cached_access_token: string | null;
  cached_refresh_token: string | null;
  must_refresh: boolean;
  lease_acquired: boolean;
  reason: string;
}

function getRealm(): string { return Deno.env.get("QBO_REALM_ID") || ""; }
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
    status, headers: { "Content-Type": "application/json", ...CORS },
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
async function persistTokens(sb: SupabaseClient, accessToken: string, refreshToken: string,
  expiresInSeconds: number, refreshTokenExpiresInSeconds: number | null): Promise<void> {
  const accessExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshExpiry = refreshTokenExpiresInSeconds
    ? new Date(Date.now() + refreshTokenExpiresInSeconds * 1000).toISOString()
    : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: accessToken, p_access_expires: accessExpiry,
    p_refresh_token: refreshToken, p_refresh_expires: refreshExpiry,
    p_refreshed_by: "push-qbo-item@v2",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
}
async function releaseFailedLease(sb: SupabaseClient, message: string): Promise<void> {
  await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: message.slice(0, 500) });
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
    throw new Error("intuit refresh failed (" + res.status + "): " + JSON.stringify(data));
  }
  return data;
}
async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < LEASE_POLL_MAX_ATTEMPTS; attempt++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const refreshSeed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!refreshSeed) {
        await releaseFailedLease(sb, "no refresh token available");
        throw new Error("no refresh token available");
      }
      try {
        const fresh = await intuitRefresh(refreshSeed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS,
          fresh.x_refresh_token_expires_in ?? null);
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

async function qboGet(sb: SupabaseClient, path: string): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path
    + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("QBO GET " + path + " failed (" + res.status + "): " + text);
  }
  return res.json();
}
async function qboPost(sb: SupabaseClient, path: string, body: any): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path
    + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("QBO POST " + path + " failed (" + res.status + "): " + text);
  }
  return res.json();
}

// Pull every QBO Item with Type='Category' so we can map name → Id.
async function fetchAllQboCategories(sb: SupabaseClient): Promise<Map<string, { id: string; syncToken: string }>> {
  const map = new Map<string, { id: string; syncToken: string }>();
  let start = 1;
  const page = 1000;
  while (true) {
    const q = encodeURIComponent(
      `select Id, Name, SyncToken from Item where Type = 'Category' startposition ${start} maxresults ${page}`,
    );
    const j = await qboGet(sb, "/query?query=" + q);
    const list = j?.QueryResponse?.Item ?? [];
    for (const it of list) {
      if (it?.Name) {
        map.set(String(it.Name).trim(), { id: String(it.Id), syncToken: String(it.SyncToken ?? "0") });
      }
    }
    if (list.length < page) break;
    start += page;
  }
  return map;
}

async function ensureCategoryId(
  sb: SupabaseClient,
  categoryMap: Map<string, { id: string; syncToken: string }>,
  name: string,
  commit: boolean,
  created: string[],
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const found = categoryMap.get(trimmed);
  if (found) return found.id;
  if (!commit) {
    if (!created.includes(trimmed)) created.push(trimmed + " (would create)");
    return null;
  }
  // QBO requires Type=Category, no SubItem, no income/expense accts.
  const j = await qboPost(sb, "/item", { Name: trimmed, Type: "Category" });
  const created_item = j?.Item;
  if (!created_item?.Id) throw new Error("category create failed for " + trimmed);
  const id = String(created_item.Id);
  const syncToken = String(created_item.SyncToken ?? "0");
  categoryMap.set(trimmed, { id, syncToken });
  if (!created.includes(trimmed)) created.push(trimmed);
  return id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST required" }, 405);

  const startedAt = Date.now();
  const sb = getSB();

  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "").trim();

    if (action === "setActive") {
      const qboItemId = String(body?.qbo_item_id || "").trim();
      if (!qboItemId) throw new Error("qbo_item_id required");
      const nextActive = body?.active === true;

      const j = await qboGet(sb, "/item/" + encodeURIComponent(qboItemId));
      const item = j?.Item;
      if (!item) throw new Error("item not found in QBO: " + qboItemId);
      const currentActive = item.Active !== false;
      if (currentActive === nextActive) {
        await sb.schema("ops").from("qbo_items").update({ active: nextActive }).eq("qbo_item_id", qboItemId);
        return jsonRes({
          ok: true, no_change: true, qbo_item_id: qboItemId,
          active: nextActive, sync_token: item.SyncToken,
          duration_ms: Date.now() - startedAt,
        });
      }
      const updated = await qboPost(sb, "/item", {
        Id: item.Id, SyncToken: item.SyncToken, sparse: true, Active: nextActive,
      });
      const newActive = updated?.Item?.Active !== false;
      await sb.schema("ops").from("qbo_items").update({ active: newActive }).eq("qbo_item_id", qboItemId);
      return jsonRes({
        ok: true, qbo_item_id: qboItemId,
        was_active: currentActive, now_active: newActive,
        sync_token: updated?.Item?.SyncToken,
        duration_ms: Date.now() - startedAt,
      });
    }

    if (action === "bulkSyncCategories") {
      const commit = body?.commit === true; // defaults to dry-run

      // 1. Pull all items that have a local category_override.
      const { data: targets, error: tErr } = await sb
        .schema("ops")
        .from("inventory_settings")
        .select("qbo_item_id, category_override")
        .not("category_override", "is", null)
        .neq("category_override", "");
      if (tErr) throw new Error("read inventory_settings: " + tErr.message);
      const overrides = new Map<string, string>();
      for (const t of targets ?? []) {
        if (t.qbo_item_id && t.category_override) {
          overrides.set(t.qbo_item_id, String(t.category_override).trim());
        }
      }

      if (overrides.size === 0) {
        return jsonRes({
          ok: true, commit, message: "no overrides to sync",
          duration_ms: Date.now() - startedAt,
        });
      }

      // 2. Fetch all current QBO categories so we know what to create.
      const categoryMap = await fetchAllQboCategories(sb);
      const desiredNames = Array.from(new Set(Array.from(overrides.values())));
      const createdLog: string[] = [];
      for (const n of desiredNames) {
        await ensureCategoryId(sb, categoryMap, n, commit, createdLog);
      }

      // 3. Walk each item and set its ParentRef if needed.
      const summary = {
        total: overrides.size,
        already_correct: 0, would_update: 0, updated: 0,
        skipped_unknown_category: 0,
        errors: [] as any[],
      };
      let i = 0;
      for (const [qboItemId, desiredName] of overrides) {
        i++;
        try {
          const cat = categoryMap.get(desiredName);
          if (!cat) {
            if (!commit) { summary.would_update++; continue; }
            summary.skipped_unknown_category++;
            continue;
          }
          const j = await qboGet(sb, "/item/" + encodeURIComponent(qboItemId));
          const item = j?.Item;
          if (!item) { summary.errors.push({ qboItemId, error: "item not found in QBO" }); continue; }
          const currentParentId = item?.ParentRef?.value;
          if (currentParentId === cat.id && item?.SubItem === true) {
            summary.already_correct++; continue;
          }
          if (!commit) { summary.would_update++; continue; }
          await qboPost(sb, "/item", {
            Id: item.Id, SyncToken: item.SyncToken, sparse: true,
            SubItem: true,
            ParentRef: { value: cat.id, name: desiredName },
          });
          summary.updated++;
        } catch (e) {
          summary.errors.push({ qboItemId, error: (e as Error).message });
        }
        if (i % 50 === 0) await sleep(200);
      }

      return jsonRes({
        ok: true, commit,
        categories_total: desiredNames.length,
        categories_created: createdLog,
        summary,
        duration_ms: Date.now() - startedAt,
      });
    }

    return jsonRes({ ok: false, error: "unknown action: " + action }, 400);
  } catch (err) {
    console.error("push-qbo-item FATAL:", err);
    return jsonRes({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    }, 500);
  }
});
