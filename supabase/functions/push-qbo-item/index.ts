// push-qbo-item v9 — QBO sync function.
// All write-to-QBO actions are DISABLED 2026-05-22 per owner instruction.
// The nightly push cron jobs (jobid 31, 32, 33) have all been unscheduled.
//
// Actions:
//   action: 'setActive'                  → DISABLED. Returns HTTP 410.
//   action: 'bulkSyncCategories'         → DISABLED. Returns HTTP 410.
//   action: 'postInventoryAdjustment'    → DISABLED. Returns HTTP 410.
//   action: 'postPurchaseOrder'          → DISABLED. Returns HTTP 410.
//   action: 'unparentAndInactivateCategories' → DISABLED. Returns HTTP 410.
//                                          (Category cleanup completed 2026-05-22.)
//   action: 'syncVendors'                → ACTIVE. Read-only pull: QBO → ops.qbo_vendors.
//                                          Upsert by qbo_vendor_id; soft-deletes by
//                                          flipping active=false.
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
    p_refreshed_by: "push-qbo-item@v5",
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
      // DISABLED 2026-05-22. No data is to be pushed to QBO.
      return jsonRes({
        ok: false, disabled: true, action: "setActive",
        error: "setActive is disabled. No data may be pushed to QBO.",
      }, 410);
    }

    if (action === "bulkSyncCategories") {
      // DISABLED 2026-05-22. This used to push BRIX's local category_override
      // into QBO as Category items + ParentRef on every product. The nightly
      // cron (jobid 31) was unscheduled and the action is now a hard no-op so
      // neither a future cron, a UI button, nor a manual curl can re-create
      // the QBO category structure. BRIX's local categorization in
      // ops.inventory_settings.category_override is untouched and Margin
      // Control still uses it.
      return jsonRes({
        ok: false,
        disabled: true,
        action: "bulkSyncCategories",
        error: "bulkSyncCategories is permanently disabled. BRIX local " +
          "categorization is preserved in ops.inventory_settings.category_override; " +
          "QBO category structure must NOT be re-synced. Remove this guard in " +
          "supabase/functions/push-qbo-item/index.ts only if reviving the path " +
          "is a deliberate decision.",
      }, 410);
    }

    if (action === "postInventoryAdjustment") {
      // DISABLED 2026-05-22. No data is to be pushed to QBO.
      return jsonRes({
        ok: false, disabled: true, action: "postInventoryAdjustment",
        error: "postInventoryAdjustment is disabled. No data may be pushed to QBO.",
      }, 410);
    }

    // ───────── NEW v5: syncVendors ─────────
    if (action === "syncVendors") {
      const includeInactive = body?.include_inactive !== false; // default true
      const seen = new Set<string>();
      let start = 1;
      const page = 1000;
      let total = 0;
      while (true) {
        const filter = includeInactive ? "where Active in (true, false)" : "";
        const q = encodeURIComponent(
          `select * from Vendor ${filter} startposition ${start} maxresults ${page}`.trim(),
        );
        const j = await qboGet(sb, "/query?query=" + q);
        const list = j?.QueryResponse?.Vendor ?? [];
        if (list.length === 0) break;
        const rows = list.map((v: any) => {
          const addr = v?.BillAddr || {};
          return {
            qbo_vendor_id: String(v.Id),
            display_name: String(v.DisplayName || v.CompanyName || ("Vendor " + v.Id)),
            company_name: v.CompanyName ?? null,
            active: v.Active !== false,
            email: v?.PrimaryEmailAddr?.Address ?? null,
            phone: v?.PrimaryPhone?.FreeFormNumber ?? null,
            address_line1: addr.Line1 ?? null,
            city: addr.City ?? null,
            state: addr.CountrySubDivisionCode ?? null,
            postal_code: addr.PostalCode ?? null,
            country: addr.Country ?? null,
            default_terms: v?.TermRef?.name ?? null,
            qbo_updated_at: v?.MetaData?.LastUpdatedTime ?? null,
            synced_at: new Date().toISOString(),
          };
        });
        for (const r of rows) seen.add(r.qbo_vendor_id);
        const { error: upErr } = await sb
          .schema("ops").from("qbo_vendors")
          .upsert(rows, { onConflict: "qbo_vendor_id" });
        if (upErr) throw new Error("upsert vendors: " + upErr.message);
        total += rows.length;
        if (list.length < page) break;
        start += page;
      }
      try {
        await sb.schema("ops").from("sync_log").insert({
          sync_type: "sync_qbo_vendors",
          status: "success",
          metadata: { count: total },
          completed_at: new Date().toISOString(),
        });
      } catch (_e) { /* non-fatal */ }
      return jsonRes({
        ok: true, vendors_synced: total,
        duration_ms: Date.now() - startedAt,
      });
    }

    if (action === "postPurchaseOrder") {
      // DISABLED 2026-05-22. No data is to be pushed to QBO.
      return jsonRes({
        ok: false, disabled: true, action: "postPurchaseOrder",
        error: "postPurchaseOrder is disabled. No data may be pushed to QBO.",
      }, 410);
    }

    if (action === "unparentAndInactivateCategories") {
      // DISABLED 2026-05-22. Cleanup completed; QBO categories have been
      // unparented and inactivated. No data is to be pushed to QBO.
      return jsonRes({
        ok: false, disabled: true, action: "unparentAndInactivateCategories",
        error: "unparentAndInactivateCategories is disabled. Cleanup completed 2026-05-22. No data may be pushed to QBO.",
      }, 410);
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
