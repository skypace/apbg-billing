// qbo-reconcile v1 — prune mirror invoices that QBO no longer has.
//
// sync-qbo only ever upserts invoices QBO returns; it never removes ones that
// were DELETED in QBO, so deleted invoices linger as "ghosts" (still showing
// open in brix-order). This reconciler closes that gap: for a date window it
// pulls QBO's *active* invoice IDs and deletes mirror rows QBO didn't return.
//
// SAFETY (deleting prod mirror data):
//   * mode=dry (DEFAULT) only reports; mode=prune actually deletes.
//   * requires x-internal-secret == INTERNAL_PAY_SECRET.
//   * per-type guard: if QBO returns 0 ids for a type but the mirror has rows,
//     SKIP that type (treats it as a read error, never a mass-delete signal).
//   * global cap: if total ghosts > max_prune (default 200), abort without
//     deleting and report — a real deletion batch is tiny; a huge count = bug.
//
// verify_jwt=false; auth is the internal secret.
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
const PAGE = 1000;
const RECONCILE_TYPES = ["Invoice", "SalesReceipt", "CreditMemo", "RefundReceipt"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*, authorization, content-type, x-internal-secret",
};

function getRealm(): string { return Deno.env.get("QBO_REALM_ID") || ""; }
function isSandbox(): boolean { return (Deno.env.get("QBO_ENVIRONMENT") ?? "production") === "sandbox"; }
function accountingBase(): string {
  return isSandbox() ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}
function getSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false }, db: { schema: "ops" } },
  );
}
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function reqId(): string { return crypto.randomUUID().replace(/-/g, "").slice(0, 32); }
function pad(n: number) { return String(n).padStart(2, "0"); }

async function claimRefresh(sb: SupabaseClient): Promise<any> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(), p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS, p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return Array.isArray(data) ? data[0] : data;
}
async function persistTokens(sb: SupabaseClient, a: string, r: string, exp: number, rExp: number | null) {
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: a, p_access_expires: new Date(Date.now() + exp * 1000).toISOString(),
    p_refresh_token: r, p_refresh_expires: new Date(Date.now() + (rExp ?? REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    p_refreshed_by: "qbo-reconcile@v1",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
}
async function releaseFailedLease(sb: SupabaseClient, message: string) {
  await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: message.slice(0, 500) });
}
async function intuitRefresh(refreshToken: string) {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("missing QBO creds");
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
      Authorization: "Basic " + btoa(clientId + ":" + clientSecret),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("intuit refresh failed (" + res.status + "): " + JSON.stringify(data));
  return data;
}
async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < LEASE_POLL_MAX_ATTEMPTS; attempt++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const seed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) { await releaseFailedLease(sb, "no refresh token"); throw new Error("no refresh token available"); }
      try {
        const fresh = await intuitRefresh(seed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token,
          fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS, fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) { await releaseFailedLease(sb, (err as Error).message); throw err; }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}
async function acctGet(token: string, path: string): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json", "Request-Id": reqId() } });
  if (!res.ok) throw new Error("QBO acct GET (" + res.status + "): " + (await res.text()).slice(0, 200));
  return res.json();
}
// All active QBO IDs for an entity in [start,end] (paginated).
async function qboIds(token: string, entity: string, start: string, end: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let pos = 1;
  while (true) {
    const q = `SELECT Id FROM ${entity} WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' STARTPOSITION ${pos} MAXRESULTS ${PAGE}`;
    const j = await acctGet(token, "/query?query=" + encodeURIComponent(q));
    const arr: any[] = j?.QueryResponse?.[entity] ?? [];
    for (const r of arr) if (r?.Id) ids.add(String(r.Id));
    if (arr.length < PAGE) break;
    pos += PAGE;
  }
  return ids;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST required" }, 405);

  const startedAt = Date.now();
  const sb = getSB();
  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    const url = new URL(req.url);
    const prune = url.searchParams.get("mode") === "prune";
    // Read-only dry-run is open; the destructive prune requires the secret.
    if (prune) {
      const secret = Deno.env.get("INTERNAL_PAY_SECRET") || "";
      if (!secret || req.headers.get("x-internal-secret") !== secret) {
        return jsonRes({ ok: false, error: "unauthorized (prune requires x-internal-secret)" }, 401);
      }
    }
    const now = new Date();
    const defStart = new Date(now.getTime() - 120 * 24 * 3600 * 1000);
    const start = url.searchParams.get("start") || `${defStart.getFullYear()}-${pad(defStart.getMonth() + 1)}-${pad(defStart.getDate())}`;
    const end = url.searchParams.get("end") || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const maxPrune = parseInt(url.searchParams.get("max_prune") || "200");

    const token = await getAccessToken(sb);

    const perType: Record<string, any> = {};
    let ghostBigintIds: number[] = [];
    let ghostDocs: string[] = [];

    for (const entity of RECONCILE_TYPES) {
      const liveIds = await qboIds(token, entity, start, end);
      // Page past PostgREST's 1000-row cap so we compare ALL mirror rows.
      const mirror: any[] = [];
      let from = 0;
      while (true) {
        const { data: rows, error } = await sb.from("qbo_invoices")
          .select("id, qbo_invoice_id, doc_number")
          .eq("txn_type", entity).gte("txn_date", start).lte("txn_date", end)
          .order("id", { ascending: true }).range(from, from + 999);
        if (error) throw new Error("mirror read " + entity + ": " + error.message);
        const batch = rows ?? [];
        mirror.push(...batch);
        if (batch.length < 1000) break;
        from += 1000;
      }
      // Guard: QBO returned nothing but we hold rows → treat as a read error, skip.
      if (liveIds.size === 0 && mirror.length > 0) {
        perType[entity] = { qbo: 0, mirror: mirror.length, ghosts: 0, skipped: "qbo returned 0 — not pruning" };
        continue;
      }
      const ghosts = mirror.filter((m: any) => !liveIds.has(String(m.qbo_invoice_id)));
      perType[entity] = { qbo: liveIds.size, mirror: mirror.length, ghosts: ghosts.length };
      for (const g of ghosts) { ghostBigintIds.push(g.id); ghostDocs.push(g.doc_number || g.qbo_invoice_id); }
    }

    const totalGhosts = ghostBigintIds.length;
    // Global safety cap — a real delete batch is tiny; a huge count means a bug.
    if (totalGhosts > maxPrune) {
      return jsonRes({
        ok: false, aborted: true, reason: "ghost count " + totalGhosts + " exceeds max_prune " + maxPrune + " — not pruning",
        window: { start, end }, per_type: perType, sample: ghostDocs.slice(0, 20), duration_ms: Date.now() - startedAt,
      }, 409);
    }

    let pruned = 0;
    if (prune && totalGhosts > 0) {
      await sb.from("qbo_invoice_lines").delete().in("invoice_id", ghostBigintIds);
      const { error: delErr, count } = await sb.from("qbo_invoices").delete({ count: "exact" }).in("id", ghostBigintIds);
      if (delErr) throw new Error("prune delete: " + delErr.message);
      pruned = count ?? ghostBigintIds.length;
      await sb.from("sync_log").insert({
        source: "qbo", sync_type: "reconcile", status: "success", records_synced: pruned,
        completed_at: new Date().toISOString(), metadata: { window: { start, end }, per_type: perType, docs: ghostDocs.slice(0, 50) },
      });
    }

    return jsonRes({
      ok: true, mode: prune ? "prune" : "dry", window: { start, end },
      per_type: perType, total_ghosts: totalGhosts, pruned,
      ghosts: ghostDocs.slice(0, 50), duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("qbo-reconcile FATAL:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
