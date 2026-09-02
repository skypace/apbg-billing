// qbo-raw-materials v2 — QuickBooks items for raw ingredients, and restoring
// the BOM components QuickBooks is holding inactive.
// Every raw ingredient on a batching sheet needs a real QuickBooks item before
// it can reach a purchase order. Until 2026-09-02 not one existed — no sugar,
// no citric acid, no flavor — which is why each case BOM carried a single
// "1 gal of finished beverage" line instead of a recipe, and why no AC
// Calderoni purchase order could ever fall out of a work order.
//
// Actions:
//   { action: 'preview' }                 → what WOULD be created. Writes nothing.
//   { action: 'create', commit: true }    → creates them and links the ids back.
//   optional { slugs: ['cane-sugar'] }    → limit to specific materials.
//
//   { action: 'restore_components' }      → every BOM component that is
//     INACTIVE in QuickBooks: reactivate it and strip the " (deleted)" suffix
//     QBO appends on deactivation. Preview by default; needs commit:true.
//     optional { rename: { "685": "CAN HANGAR 25 COLA 12OZ SLEEK EMPTY" } }
//     for a name that needs more than the mechanical suffix strip.
//
//     ⚠ It REFUSES an Inventory-type item, by design. Everything the
//     production system consumes is Service or NonInventory; the only
//     Inventory items are the finished cases that come BACK to the warehouse,
//     and those are somebody else's to switch on. Reactivating an inventory
//     item also revives a quantity and a valuation, which is an accounting
//     decision, not a housekeeping one.
//
// This lives beside push-qbo-item rather than inside it on purpose: that
// function is the shared item/PO pusher that pg_cron and several pages depend
// on, and a production-module feature should not be a reason to redeploy it.
//
// Three things it deliberately does NOT do:
//   * It never invents a cost. PurchaseCost is sent only when the master
//     already carries one; otherwise the gap stays visible in
//     ops.v_raw_ingredients rather than becoming a fake per-case cost.
//   * It never creates a second item with a name QuickBooks already holds.
//     QBO enforces unique item names, so a collision means the item exists —
//     it is looked up and LINKED. A duplicate item splits an item's purchase
//     history in two, which is not recoverable by editing.
//   * It writes nothing without commit:true.
//
// verify_jwt=false — gated by SUPABASE_SERVICE_ROLE_KEY + the QBO OAuth lease,
// the same posture as every other qbo-* function on this project.
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
const LEASE_POLL_MAX_ATTEMPTS = 40;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*, authorization, content-type, apikey",
};

function getRealm(): string { return Deno.env.get("QBO_REALM_ID") || ""; }
function qboBaseUrl(): string {
  return (Deno.env.get("QBO_ENVIRONMENT") ?? "production") === "sandbox"
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

// ── QBO OAuth: the same lease dance every qbo-* function uses. The lease is
//    what stops two concurrent functions race-rotating the refresh token.
async function claimRefresh(sb: SupabaseClient): Promise<any> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return Array.isArray(data) ? data[0] : data;
}
async function persistTokens(sb: SupabaseClient, accessToken: string, refreshToken: string,
  expiresInSeconds: number, refreshTokenExpiresInSeconds: number | null): Promise<void> {
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(),
    p_access_token: accessToken,
    p_access_expires: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    p_refresh_token: refreshToken,
    p_refresh_expires: new Date(Date.now() +
      (refreshTokenExpiresInSeconds ?? REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    p_refreshed_by: "qbo-raw-materials@v1",
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
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + btoa(clientId + ":" + clientSecret),
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
      const seed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) {
        await releaseFailedLease(sb, "no refresh token available");
        throw new Error("no refresh token available");
      }
      try {
        const fresh = await intuitRefresh(seed);
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
async function qboFetch(sb: SupabaseClient, path: string, body?: any): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path
    + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error("QBO " + (body ? "POST " : "GET ") + path +
      " failed (" + res.status + "): " + (await res.text()).slice(0, 400));
  }
  return res.json();
}


/**
 * Bring back the BOM components QuickBooks is holding as inactive.
 *
 * A deactivated item is invisible to a transaction: QBO refuses any PO that
 * references one, and it refuses it at the PUSH, long after the run was
 * planned. Six of the seven empty-can items were in that state, which is why
 * six case BOMs had no can line at all.
 *
 * Restoring beats recreating here and the difference matters: the existing
 * items are already NonInventory, on the right expense account, at the right
 * cost, and they carry the purchase history. A fresh near-identical item would
 * split that history in two and leave two confusable names in the item list.
 */
async function restoreComponents(sb: SupabaseClient, body: any, startedAt: number) {
  const commit = body?.commit === true;
  const rename: Record<string, string> = (body?.rename && typeof body.rename === "object")
    ? body.rename : {};

  // Only items a BOM actually depends on. This is not a general "reactivate
  // everything" button -- QuickBooks is full of deliberately retired items.
  const { data: lines, error: lErr } = await sb.schema("ops")
    .from("product_bom_lines").select("component_qbo_item_id")
    .not("component_qbo_item_id", "is", null);
  if (lErr) throw new Error("read product_bom_lines: " + lErr.message);
  const ids = [...new Set((lines ?? []).map((l: any) => String(l.component_qbo_item_id)))];
  if (!ids.length) return jsonRes({ ok: true, commit, candidates: 0, restored: [], skipped: [], failed: [] });

  const restored: any[] = [], skipped: any[] = [], failed: any[] = [], planned: any[] = [];

  for (const id of ids) {
    let item: any;
    try {
      item = (await qboFetch(sb, "/item/" + encodeURIComponent(id)))?.Item;
    } catch (e) {
      failed.push({ qbo_item_id: id, error: String((e as Error).message || e) });
      continue;
    }
    if (!item?.Id) { failed.push({ qbo_item_id: id, error: "not found in QBO" }); continue; }
    if (item.Active !== false) continue; // already live, nothing to do

    const currentName = String(item.Name || "");
    // QBO appends " (deleted)" to the NAME when an item is made inactive, and
    // does not take it off again on reactivation. Stripping it is mechanical.
    const stripped = currentName.replace(/\s*\(deleted\)\s*$/i, "").trim();
    const targetName = (rename[id] ?? stripped).slice(0, 100);

    if (String(item.Type) === "Inventory") {
      skipped.push({
        qbo_item_id: id, name: currentName, type: item.Type,
        reason: "Inventory item — reviving it revives a quantity and a valuation. "
              + "Switch it back on in QuickBooks deliberately if that is what you mean.",
      });
      continue;
    }

    if (!commit) {
      planned.push({ qbo_item_id: id, from: currentName, to: targetName, type: item.Type });
      continue;
    }

    try {
      const patch: any = { Id: item.Id, SyncToken: item.SyncToken, sparse: true, Active: true };
      // Name is only sent when it actually changes: QBO enforces unique item
      // names, so a needless rename is a needless chance of a collision.
      if (targetName && targetName !== currentName) patch.Name = targetName;
      const out = (await qboFetch(sb, "/item", patch))?.Item;
      const outName = String(out?.Name ?? targetName);

      await sb.schema("ops").from("qbo_items")
        .update({ name: outName, fully_qualified_name: outName, active: true,
                  synced_at: new Date().toISOString() })
        .eq("qbo_item_id", id);

      restored.push({ qbo_item_id: id, from: currentName, to: outName, type: String(item.Type) });
    } catch (e) {
      failed.push({ qbo_item_id: id, name: currentName, error: String((e as Error).message || e) });
    }
  }

  return jsonRes({
    ok: true, commit, candidates: ids.length,
    restored, skipped, failed,
    planned: commit ? undefined : planned,
    duration_ms: Date.now() - startedAt,
  });
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
    const action = String(body?.action || "preview").trim();
    if (action !== "preview" && action !== "create" && action !== "restore_components") {
      return jsonRes({ ok: false, error: "unknown action: " + action }, 400);
    }

    if (action === "restore_components") {
      return await restoreComponents(sb, body, startedAt);
    }

    const commit = action === "create" && body?.commit === true;
    const only: string[] = Array.isArray(body?.slugs) ? body.slugs.map(String) : [];

    const { data: settings } = await sb
      .schema("ops").from("production_settings")
      .select("clearing_account_ref_id, clearing_account_name").eq("id", true).single();
    const expenseAcctId = String(
      body?.expense_account_id || settings?.clearing_account_ref_id || "").trim();
    if (!expenseAcctId) {
      throw new Error("no clearing account configured — set ops.production_settings.clearing_account_ref_id");
    }
    // Prove the account exists before writing seventeen items against it.
    const acct = (await qboFetch(sb, "/account/" + encodeURIComponent(expenseAcctId)))?.Account;
    if (!acct?.Id) throw new Error("expense account not found in QBO: " + expenseAcctId);

    let q = sb.schema("ops").from("raw_ingredients")
      .select("id, slug, name, recipe_uom, purchase_uom, purchase_cost")
      .eq("is_purchased", true).eq("active", true).is("qbo_item_id", null);
    if (only.length) q = q.in("slug", only);
    const { data: rows, error: rErr } = await q.order("name");
    if (rErr) throw new Error("read raw_ingredients: " + rErr.message);

    const created: any[] = [], linked: any[] = [], failed: any[] = [], planned: any[] = [];

    for (const r of rows ?? []) {
      // "RM " keeps the raw materials together in QuickBooks' item list and out
      // of the way of sellable SKUs. Rename freely — nothing keys on the name.
      const itemName = ("RM " + String(r.name)).slice(0, 100);
      const sku = ("RM-" + String(r.slug).toUpperCase()).slice(0, 100);
      const payload: any = {
        Name: itemName,
        Sku: sku,
        Type: "NonInventory",
        Taxable: false,
        TrackQtyOnHand: false,
        ExpenseAccountRef: { value: String(acct.Id), name: String(acct.Name) },
        PurchaseDesc: String(r.name) +
          (r.recipe_uom ? " (" + r.recipe_uom + ")" : "") + " — raw material",
      };
      if (r.purchase_cost != null) payload.PurchaseCost = Number(r.purchase_cost);

      if (!commit) { planned.push({ slug: r.slug, name: itemName, sku, has_cost: r.purchase_cost != null }); continue; }

      try {
        let itemId: string, itemNameOut: string, wasExisting = false;
        const nameQ = encodeURIComponent(
          "select Id, Name from Item where Name = '" + itemName.replace(/'/g, "''") + "'");
        const existing = (await qboFetch(sb, "/query?query=" + nameQ))?.QueryResponse?.Item?.[0];
        if (existing?.Id) {
          itemId = String(existing.Id); itemNameOut = String(existing.Name); wasExisting = true;
        } else {
          const made = (await qboFetch(sb, "/item", payload))?.Item;
          if (!made?.Id) throw new Error("QBO returned no Item id");
          itemId = String(made.Id); itemNameOut = String(made.Name);
        }

        await sb.schema("ops").from("qbo_items").upsert({
          qbo_item_id: itemId,
          name: itemNameOut,
          fully_qualified_name: itemNameOut,
          sku,
          type: "NonInventory",
          active: true,
          taxable: false,
          purchase_cost: r.purchase_cost ?? null,
          expense_account_ref_id: String(acct.Id),
          expense_account_name: String(acct.Name),
          synced_at: new Date().toISOString(),
        }, { onConflict: "qbo_item_id" });

        const { error: linkErr } = await sb.schema("ops").from("raw_ingredients")
          .update({ qbo_item_id: itemId }).eq("id", r.id);
        if (linkErr) throw new Error("link back: " + linkErr.message);

        (wasExisting ? linked : created).push({ slug: r.slug, name: itemNameOut, qbo_item_id: itemId });
      } catch (e) {
        failed.push({ slug: r.slug, name: itemName, error: String((e as Error).message || e) });
      }
    }

    return jsonRes({
      ok: true,
      commit,
      expense_account: { id: String(acct.Id), name: String(acct.Name) },
      candidates: (rows ?? []).length,
      created, linked, failed,
      planned: commit ? undefined : planned,
      duration_ms: Date.now() - startedAt,
    });
  } catch (e) {
    return jsonRes({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
