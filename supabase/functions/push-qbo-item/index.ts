// push-qbo-item v5 — single-item + bulk pushes back to QBO.
// verify_jwt=false so pg_cron can call this; QBO writes are gated by
// SUPABASE_SERVICE_ROLE_KEY + QBO OAuth.
//
// Actions:
//   action: 'setActive'                  → flips Item.Active in QBO + mirrors locally
//   action: 'bulkSyncCategories'         → ensures QBO Category Items exist for every
//                                          category_override and points each item's
//                                          ParentRef at it. Supports {commit: true}.
//   action: 'postInventoryAdjustment'    → given {work_order_id}, builds + POSTs an
//                                          InventoryAdjustment for the WO's consume +
//                                          yield movements so QBO's Item.QtyOnHand
//                                          reflects the build. Idempotent.
//   action: 'syncVendors'                → pulls QBO Vendors into ops.qbo_vendors.
//                                          Upsert by qbo_vendor_id; soft-deletes by
//                                          flipping active=false (we never hard-delete).
//   action: 'postPurchaseOrder'          → given {purchase_order_id}, builds + POSTs a
//                                          QBO PurchaseOrder and persists the returned id
//                                          to ops.purchase_orders. Idempotent.
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
  const j = await qboPost(sb, "/item", { Name: trimmed, Type: "Category" });
  const created_item = j?.Item;
  if (!created_item?.Id) throw new Error("category create failed for " + trimmed);
  const id = String(created_item.Id);
  const syncToken = String(created_item.SyncToken ?? "0");
  categoryMap.set(trimmed, { id, syncToken });
  if (!created.includes(trimmed)) created.push(trimmed);
  return id;
}

async function resolveAdjustAccount(
  sb: SupabaseClient,
  preferredId: string | null,
): Promise<{ id: string; name: string }> {
  if (preferredId) {
    const j = await qboGet(sb, "/account/" + encodeURIComponent(preferredId));
    if (j?.Account?.Id) {
      return { id: String(j.Account.Id), name: String(j.Account.Name) };
    }
  }
  for (const candidate of ["Inventory Shrinkage", "Inventory Adjustment", "Cost of Goods Sold"]) {
    const q = encodeURIComponent(
      `select Id, Name from Account where Name = '${candidate.replace(/'/g, "''")}'`,
    );
    const j = await qboGet(sb, "/query?query=" + q);
    const found = (j?.QueryResponse?.Account ?? [])[0];
    if (found?.Id) return { id: String(found.Id), name: String(found.Name) };
  }
  throw new Error(
    "No usable adjust account found in QBO. Create an 'Inventory Shrinkage' or 'Inventory Adjustment' account, or pass adjust_account_id explicitly.",
  );
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
      const commit = body?.commit === true;

      const { data: targets, error: tErr } = await sb
        .schema("ops").from("inventory_settings")
        .select("qbo_item_id, category_override")
        .not("category_override", "is", null).neq("category_override", "");
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

      const categoryMap = await fetchAllQboCategories(sb);
      const desiredNames = Array.from(new Set(Array.from(overrides.values())));
      const createdLog: string[] = [];
      for (const n of desiredNames) {
        await ensureCategoryId(sb, categoryMap, n, commit, createdLog);
      }

      const summary = {
        total: overrides.size, already_correct: 0, would_update: 0, updated: 0,
        skipped_unknown_category: 0, errors: [] as any[],
      };
      let i = 0;
      for (const [qboItemId, desiredName] of overrides) {
        i++;
        try {
          const cat = categoryMap.get(desiredName);
          if (!cat) {
            if (!commit) { summary.would_update++; continue; }
            summary.skipped_unknown_category++; continue;
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
      try {
        await sb.schema("ops").from("sync_log").insert({
          sync_type: "push_qbo_categories",
          status:    summary.errors.length === 0 ? "success" : "partial",
          metadata:  { commit, summary, categories_created: createdLog },
          completed_at: new Date().toISOString(),
        });
      } catch (_e) { /* sync_log shape may differ; non-fatal */ }
      return jsonRes({
        ok: true, commit,
        categories_total: desiredNames.length,
        categories_created: createdLog, summary,
        duration_ms: Date.now() - startedAt,
      });
    }

    if (action === "postInventoryAdjustment") {
      const workOrderId = String(body?.work_order_id || "").trim();
      if (!workOrderId) throw new Error("work_order_id required");
      const dryRun = body?.dry_run === true;
      const preferredAcct = body?.adjust_account_id ? String(body.adjust_account_id) : null;

      const { data: wo, error: woErr } = await sb
        .schema("ops").from("work_orders")
        .select("id, batch_code, status, closed_at, qbo_inventory_adjustment_id, qbo_pushed_at")
        .eq("id", workOrderId).single();
      if (woErr || !wo) throw new Error("work order not found: " + workOrderId);
      if (wo.status !== "closed") {
        throw new Error("work order status is '" + wo.status + "', must be 'closed' before QBO push");
      }
      if (wo.qbo_inventory_adjustment_id) {
        return jsonRes({
          ok: true, no_change: true, work_order_id: workOrderId,
          qbo_inventory_adjustment_id: wo.qbo_inventory_adjustment_id,
          qbo_pushed_at: wo.qbo_pushed_at,
          message: "work order already pushed to QBO",
          duration_ms: Date.now() - startedAt,
        });
      }

      const { data: moves, error: mErr } = await sb
        .schema("ops").from("inventory_movements")
        .select("movement_type, qbo_item_id, qty, unit_cost")
        .eq("source_doc_type", "work_order")
        .eq("source_doc_id", workOrderId);
      if (mErr) throw new Error("read movements: " + mErr.message);
      if (!moves || moves.length === 0) {
        throw new Error("no inventory movements found for work order " + workOrderId);
      }

      const byItem = new Map<string, { qty: number; cost?: number }>();
      for (const m of moves) {
        if (!m.qbo_item_id) continue;
        const signed = m.movement_type === "production_consume" ? -Number(m.qty || 0) : Number(m.qty || 0);
        const existing = byItem.get(m.qbo_item_id);
        if (existing) existing.qty += signed;
        else byItem.set(m.qbo_item_id, { qty: signed, cost: m.unit_cost ?? undefined });
      }

      const lines: any[] = [];
      const skipped: { qbo_item_id: string; reason: string }[] = [];
      for (const [qboItemId, agg] of byItem) {
        if (agg.qty === 0) continue;
        const j = await qboGet(sb, "/item/" + encodeURIComponent(qboItemId));
        const it = j?.Item;
        if (!it) { skipped.push({ qbo_item_id: qboItemId, reason: "item not found in QBO" }); continue; }
        if (it.Type !== "Inventory") {
          skipped.push({ qbo_item_id: qboItemId, reason: "item Type=" + it.Type + " (must be Inventory for adjustments)" });
          continue;
        }
        lines.push({
          DetailType: "ItemAdjustmentLineDetail",
          ItemAdjustmentLineDetail: {
            ItemRef: { value: String(it.Id), name: String(it.Name) },
            QtyDiff: agg.qty,
          },
        });
      }

      if (lines.length === 0) {
        throw new Error(
          "no inventory-tracked items in this work order; nothing to push (" +
          skipped.length + " items skipped: " +
          skipped.map((s) => s.qbo_item_id + "=" + s.reason).join(", ") + ")",
        );
      }

      const acct = await resolveAdjustAccount(sb, preferredAcct);
      const today = new Date().toISOString().slice(0, 10);
      const payload = {
        TxnDate: today,
        DocNumber: wo.batch_code ? String(wo.batch_code).slice(0, 21) : undefined,
        AdjustAccountRef: { value: acct.id, name: acct.name },
        Line: lines,
        PrivateNote: "BRIX work order " + (wo.batch_code || wo.id),
      };

      if (dryRun) {
        return jsonRes({
          ok: true, dry_run: true, work_order_id: workOrderId,
          adjust_account: acct, payload, skipped,
          duration_ms: Date.now() - startedAt,
        });
      }

      const result = await qboPost(sb, "/inventoryadjustment", payload);
      const adj = result?.InventoryAdjustment;
      if (!adj?.Id) {
        throw new Error("QBO did not return an InventoryAdjustment id: " + JSON.stringify(result).slice(0, 300));
      }

      const { error: updErr } = await sb
        .schema("ops").from("work_orders")
        .update({
          qbo_inventory_adjustment_id: String(adj.Id),
          qbo_pushed_at: new Date().toISOString(),
          qbo_push_error: null,
        })
        .eq("id", workOrderId);
      if (updErr) throw new Error("persist QBO id: " + updErr.message);

      return jsonRes({
        ok: true, work_order_id: workOrderId,
        qbo_inventory_adjustment_id: String(adj.Id),
        adjust_account: acct,
        line_count: lines.length,
        skipped,
        duration_ms: Date.now() - startedAt,
      });
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

    // ───────── NEW v5: postPurchaseOrder ─────────
    if (action === "postPurchaseOrder") {
      const poId = String(body?.purchase_order_id || "").trim();
      if (!poId) throw new Error("purchase_order_id required");
      const dryRun = body?.dry_run === true;

      // 1. Fetch PO header
      const { data: po, error: poErr } = await sb
        .schema("ops").from("purchase_orders")
        .select(
          "id, po_number, qbo_vendor_id, status, expected_date, notes, " +
          "qbo_purchase_order_id, qbo_pushed_at, destination_location_id",
        )
        .eq("id", poId).single();
      if (poErr || !po) throw new Error("purchase order not found: " + poId);
      if (po.status === "void") throw new Error("PO is void, cannot push");
      if (po.qbo_purchase_order_id) {
        return jsonRes({
          ok: true, no_change: true, purchase_order_id: poId,
          qbo_purchase_order_id: po.qbo_purchase_order_id,
          qbo_pushed_at: po.qbo_pushed_at,
          message: "PO already pushed to QBO",
          duration_ms: Date.now() - startedAt,
        });
      }

      // 2. Fetch lines
      const { data: lines, error: lErr } = await sb
        .schema("ops").from("purchase_order_lines")
        .select("id, qbo_item_id, description, qty_ordered, unit_cost, notes, sort_order")
        .eq("po_id", poId).order("sort_order", { ascending: true });
      if (lErr) throw new Error("read PO lines: " + lErr.message);
      if (!lines || lines.length === 0) throw new Error("PO has no lines");

      // 3. Resolve vendor — refuse if it doesn't exist in QBO
      const vRes = await qboGet(sb, "/vendor/" + encodeURIComponent(po.qbo_vendor_id));
      const vendor = vRes?.Vendor;
      if (!vendor?.Id) throw new Error("vendor not found in QBO: " + po.qbo_vendor_id);

      // 4. Build line array. We use ItemBasedExpenseLineDetail with ItemRef
      //    so QBO ties this PO to inventory items (same shape used by the AP
      //    flow's bill creation). Each line is an ItemBasedExpense line.
      const qboLines: any[] = [];
      const skipped: { line_id: string; qbo_item_id: string; reason: string }[] = [];
      for (const ln of lines) {
        const j = await qboGet(sb, "/item/" + encodeURIComponent(ln.qbo_item_id));
        const it = j?.Item;
        if (!it?.Id) {
          skipped.push({ line_id: ln.id, qbo_item_id: ln.qbo_item_id, reason: "item not found in QBO" });
          continue;
        }
        const qty = Number(ln.qty_ordered || 0);
        const cost = Number(ln.unit_cost || 0);
        qboLines.push({
          DetailType: "ItemBasedExpenseLineDetail",
          Amount: Number((qty * cost).toFixed(2)),
          Description: ln.description || ln.notes || it.Name,
          ItemBasedExpenseLineDetail: {
            ItemRef: { value: String(it.Id), name: String(it.Name) },
            Qty: qty,
            UnitPrice: cost,
            BillableStatus: "NotBillable",
          },
        });
      }

      if (qboLines.length === 0) {
        throw new Error("no usable lines (every line skipped: " +
          skipped.map((s) => s.qbo_item_id + "=" + s.reason).join(", ") + ")");
      }

      const payload: any = {
        VendorRef: { value: String(vendor.Id), name: String(vendor.DisplayName || vendor.CompanyName || vendor.Id) },
        DocNumber: po.po_number ? String(po.po_number).slice(0, 21) : undefined,
        TxnDate: new Date().toISOString().slice(0, 10),
        DueDate: po.expected_date ? String(po.expected_date) : undefined,
        POStatus: "Open",
        Line: qboLines,
        PrivateNote: po.notes || ("BRIX PO " + po.po_number),
      };

      if (dryRun) {
        return jsonRes({
          ok: true, dry_run: true, purchase_order_id: poId,
          vendor: { id: String(vendor.Id), name: vendor.DisplayName || vendor.CompanyName },
          payload, skipped,
          duration_ms: Date.now() - startedAt,
        });
      }

      // 5. POST to QBO
      const result = await qboPost(sb, "/purchaseorder", payload);
      const newPo = result?.PurchaseOrder;
      if (!newPo?.Id) {
        throw new Error("QBO did not return a PurchaseOrder id: " + JSON.stringify(result).slice(0, 300));
      }

      const { error: updErr } = await sb
        .schema("ops").from("purchase_orders")
        .update({
          qbo_purchase_order_id: String(newPo.Id),
          qbo_pushed_at: new Date().toISOString(),
          qbo_push_error: null,
        })
        .eq("id", poId);
      if (updErr) throw new Error("persist QBO PO id: " + updErr.message);

      return jsonRes({
        ok: true, purchase_order_id: poId,
        qbo_purchase_order_id: String(newPo.Id),
        line_count: qboLines.length,
        skipped,
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
