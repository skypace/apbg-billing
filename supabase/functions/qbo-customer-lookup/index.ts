// qbo-customer-lookup v5 — live QBO customer lookup by display name, with
// mirror heal, deactivation, payment-settings read, customer-master push, and
// a master snapshot for the portal's drift check.
//
// ⚠ THIS FILE WAS RECOVERED FROM THE DEPLOYED FUNCTION (2026-08-31).
// The repo copy had been stuck at v2 while v6 (source header v3) was live, so
// deploying the repo file would have SILENTLY DROPPED the payment_settings
// action that brix-order's admin-payment-profile card depends on. Before
// editing this file again, diff it against the deployed source
// (Supabase MCP get_edge_function) — same drift that bit sync-qbo.
//
// Purpose: ops.qbo_customers refreshes once a day (sync-qbo), so a brand-new
// customer created via the SF→QBO first-invoice flow is invisible to the
// portal for up to ~24h — brix-order's "Finish onboarding" button stays
// greyed even though the customer exists in QBO. This function lets
// brix-order's admin-list-onboarding ask QBO directly and, on a hit, upserts
// the row into ops.qbo_customers immediately (the nightly sync harmlessly
// re-upserts with full detail later).
//
// body: { display_name }                                → lookup (+ mirror heal)
// body: { action: "deactivate", qbo_customer_id }        → set Active=false in
//        QBO (sparse update; QBO refuses when the customer still carries a
//        balance — brix-order's closure flow gates on $0 first) and flip the
//        mirror row inactive. Used by the account-closure final step.
// body: { action: "payment_settings", qbo_customer_id }  → live read of the
//        QBO customer's payment setup: Terms (SalesTermRef) + preferred
//        payment method (PaymentMethodRef), names resolved. Used by
//        brix-order's admin-payment-profile card so staff see the
//        QuickBooks-side payment settings next to the portal profile.
//        Read-only — never writes QBO.
// body: { action: "update_customer", qbo_customer_id,
//         terms?, payment_method?, email?, bill_addr? }  → push the portal's
//        customer master INTO QBO (sparse update). The portal is the record
//        (Sky, 2026-08-31): a value changed there wins, and this is how QBO
//        is told. See the notes on the handler — a term or method name that
//        does not exist in the realm is REFUSED and reported, never invented
//        and never silently dropped.
//
// Requires header x-internal-secret == INTERNAL_PAY_SECRET. verify_jwt=false.
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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*, authorization, content-type, apikey, x-internal-secret",
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
    { auth: { persistSession: false } },
  );
}
// Data client pinned to the ops schema for the mirror upsert (the default
// client targets public — see the "Default-schema bug" note in CLAUDE.md).
function getOpsSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false }, db: { schema: "ops" } },
  );
}
function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── QBO token (same lease/refresh pattern as qbo-charge / qbo-cylinder-audit) ──
async function claimRefresh(sb: SupabaseClient): Promise<any> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return Array.isArray(data) ? data[0] : data;
}
async function persistTokens(sb: SupabaseClient, a: string, r: string, exp: number, rExp: number | null) {
  const accessExpiry = new Date(Date.now() + exp * 1000).toISOString();
  const refreshExpiry = new Date(Date.now() + (rExp ?? REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(), p_access_token: a, p_access_expires: accessExpiry,
    p_refresh_token: r, p_refresh_expires: refreshExpiry, p_refreshed_by: "qbo-customer-lookup@v1",
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
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
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


// ── QBO Accounting (v3) ──
async function acctPost(token: string, path: string, body: any): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("QBO acct POST " + path + " (" + res.status + "): " + await res.text());
  return res.json();
}
async function acctQuery(token: string, query: string): Promise<any> {
  const url = accountingBase() + "/v3/company/" + getRealm() + "/query?query=" + encodeURIComponent(query) + "&minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) throw new Error("QBO query (" + res.status + "): " + await res.text());
  return res.json();
}

/** QBO query strings are single-quoted; escape any quote in the value. */
function esc(v: string): string { return v.replace(/'/g, "\\'"); }

/**
 * Resolve a NAME to the Id of an existing QBO reference object.
 *
 * Deliberately never creates one. Terms and payment methods are accounting
 * objects that show up on every invoice and in reporting; minting "Net 45"
 * because someone typed it into the portal is not a sync, it is the portal
 * quietly editing the chart of accounts. An unknown name comes back null and
 * the caller reports it as refused.
 */
async function resolveRefId(token: string, entity: "Term" | "PaymentMethod", name: string): Promise<string | null> {
  const data = await acctQuery(token, "select Id, Name from " + entity + " where Name = '" + esc(name) + "'");
  const rows: any[] = data?.QueryResponse?.[entity] ?? [];
  return rows.length > 0 ? String(rows[0].Id) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST required" }, 405);

  const startedAt = Date.now();
  const sb = getSB();
  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    const secret = Deno.env.get("INTERNAL_PAY_SECRET") || "";
    const provided = req.headers.get("x-internal-secret") || "";
    if (!secret || provided !== secret) return jsonRes({ ok: false, error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));

    // ── action: deactivate ──
    if (body?.action === "deactivate") {
      const qboId = String(body?.qbo_customer_id || "").trim();
      if (!/^[0-9]+$/.test(qboId)) throw new Error("bad qbo_customer_id");
      const token = await getAccessToken(sb);
      const data = await acctQuery(token, "select Id, SyncToken, DisplayName, Active from Customer where Id = '" + qboId + "'");
      const rows: any[] = data?.QueryResponse?.Customer ?? [];
      if (rows.length === 0) throw new Error("QBO customer " + qboId + " not found");
      const cust = rows[0];
      if (cust.Active === false) {
        return jsonRes({ ok: true, action: "deactivate", already_inactive: true, duration_ms: Date.now() - startedAt });
      }
      const updated = (await acctPost(token, "/customer", {
        Id: String(cust.Id), SyncToken: String(cust.SyncToken), sparse: true, Active: false,
      }))?.Customer;
      // Mirror: flip inactive so the portal stops offering the customer.
      try {
        const ops = getOpsSB();
        await ops.from("qbo_customers").update({ active: false, synced_at: new Date().toISOString() })
          .eq("qbo_customer_id", qboId);
      } catch (err) {
        console.error("qbo-customer-lookup mirror deactivate failed:", err);
      }
      return jsonRes({
        ok: true, action: "deactivate",
        customer: { id: String(updated?.Id ?? qboId), display_name: updated?.DisplayName ?? cust.DisplayName ?? null, active: updated?.Active ?? false },
        duration_ms: Date.now() - startedAt,
      });
    }

    // ── action: payment_settings ── read-only: the QBO customer's Terms +
    // preferred payment method, names resolved (QBO refs usually carry the
    // name inline; the Term/PaymentMethod queries are the fallback).
    if (body?.action === "payment_settings") {
      const qboId = String(body?.qbo_customer_id || "").trim();
      if (!/^[0-9]+$/.test(qboId)) throw new Error("bad qbo_customer_id");
      const token = await getAccessToken(sb);
      const data = await acctQuery(token, "select Id, DisplayName, SalesTermRef, PaymentMethodRef from Customer where Id = '" + qboId + "'");
      const rows: any[] = data?.QueryResponse?.Customer ?? [];
      if (rows.length === 0) {
        return jsonRes({ ok: true, action: "payment_settings", found: false, duration_ms: Date.now() - startedAt });
      }
      const c = rows[0];
      let termsName: string | null = c.SalesTermRef?.name ?? null;
      if (!termsName && c.SalesTermRef?.value) {
        try {
          const t = await acctQuery(token, "select Id, Name from Term where Id = '" + String(c.SalesTermRef.value) + "'");
          termsName = t?.QueryResponse?.Term?.[0]?.Name ?? null;
        } catch (_err) { /* best-effort name resolve */ }
      }
      let pmName: string | null = c.PaymentMethodRef?.name ?? null;
      if (!pmName && c.PaymentMethodRef?.value) {
        try {
          const p = await acctQuery(token, "select Id, Name from PaymentMethod where Id = '" + String(c.PaymentMethodRef.value) + "'");
          pmName = p?.QueryResponse?.PaymentMethod?.[0]?.Name ?? null;
        } catch (_err) { /* best-effort name resolve */ }
      }
      return jsonRes({
        ok: true, action: "payment_settings", found: true,
        payment_settings: { terms: termsName, payment_method: pmName },
        customer: { id: String(c.Id), display_name: c.DisplayName ?? null },
        duration_ms: Date.now() - startedAt,
      });
    }

    // ── action: update_customer ── push the portal's customer master INTO QBO.
    //
    // The portal is the record; this is how QuickBooks is told. Three rules
    // make that safe to run on every save:
    //
    //  - Only the fields the caller SENDS are touched (QBO sparse update), so
    //    a push of terms can never blank an address.
    //  - A terms / payment-method NAME that does not exist in the realm is
    //    REFUSED and named in `refused[]`, never invented (see resolveRefId)
    //    and never silently dropped. A push that quietly no-ops is worse than
    //    no push, because the portal then implies QBO agrees when it does not.
    //  - Sending null for terms or payment_method CLEARS the ref, which is a
    //    real intent ("no terms on this customer") and distinct from omitting
    //    the key.
    if (body?.action === "update_customer") {
      const qboId = String(body?.qbo_customer_id || "").trim();
      if (!/^[0-9]+$/.test(qboId)) throw new Error("bad qbo_customer_id");
      const token = await getAccessToken(sb);
      const data = await acctQuery(token, "select Id, SyncToken, DisplayName from Customer where Id = '" + qboId + "'");
      const rows: any[] = data?.QueryResponse?.Customer ?? [];
      if (rows.length === 0) {
        return jsonRes({ ok: true, action: "update_customer", found: false, duration_ms: Date.now() - startedAt });
      }
      const cust = rows[0];

      const patch: Record<string, unknown> = {
        Id: String(cust.Id), SyncToken: String(cust.SyncToken), sparse: true,
      };
      const applied: string[] = [];
      const refused: Array<{ field: string; value: string; reason: string }> = [];

      if ("terms" in body) {
        const name = body.terms == null ? null : String(body.terms).trim();
        if (!name) { patch.SalesTermRef = null; applied.push("terms"); }
        else {
          const id = await resolveRefId(token, "Term", name);
          if (id) { patch.SalesTermRef = { value: id, name }; applied.push("terms"); }
          else refused.push({ field: "terms", value: name, reason: "no QuickBooks Term with that name — create it in QuickBooks first" });
        }
      }
      if ("payment_method" in body) {
        const name = body.payment_method == null ? null : String(body.payment_method).trim();
        if (!name) { patch.PaymentMethodRef = null; applied.push("payment_method"); }
        else {
          const id = await resolveRefId(token, "PaymentMethod", name);
          if (id) { patch.PaymentMethodRef = { value: id, name }; applied.push("payment_method"); }
          else refused.push({ field: "payment_method", value: name, reason: "no QuickBooks PaymentMethod with that name — create it in QuickBooks first" });
        }
      }
      // DisplayName. ⚠ QBO requires it UNIQUE across customers, so a rename
      // can collide with an existing record; that comes back as a QBO fault
      // rather than a silent no-op, and the caller surfaces it. Only sent on
      // an actual name edit (the portal decides that, not this function).
      if ("name" in body) {
        const nm = body.name == null ? "" : String(body.name).trim();
        if (nm) { patch.DisplayName = nm; applied.push("name"); }
      }
      if ("taxable" in body) {
        patch.Taxable = body.taxable === true;
        applied.push("taxable");
      }
      if ("email" in body) {
        const email = body.email == null ? "" : String(body.email).trim();
        if (email) { patch.PrimaryEmailAddr = { Address: email }; applied.push("email"); }
      }
      if (body?.bill_addr && typeof body.bill_addr === "object") {
        const a = body.bill_addr as Record<string, unknown>;
        const line1 = String(a.line1 ?? "").trim();
        if (line1) {
          patch.BillAddr = {
            Line1: line1,
            ...(String(a.line2 ?? "").trim() ? { Line2: String(a.line2).trim() } : {}),
            ...(String(a.city ?? "").trim() ? { City: String(a.city).trim() } : {}),
            ...(String(a.state ?? "").trim() ? { CountrySubDivisionCode: String(a.state).trim() } : {}),
            ...(String(a.zip ?? "").trim() ? { PostalCode: String(a.zip).trim() } : {}),
          };
          applied.push("bill_addr");
        }
      }

      if (applied.length === 0) {
        return jsonRes({
          ok: true, action: "update_customer", found: true, applied, refused,
          note: "nothing to push", duration_ms: Date.now() - startedAt,
        });
      }

      const updated = (await acctPost(token, "/customer", patch))?.Customer;

      // Mirror heal so the portal's QBO-side read agrees immediately instead
      // of waiting for the nightly sync-qbo run.
      try {
        const ops = getOpsSB();
        const mirror: Record<string, unknown> = { synced_at: new Date().toISOString() };
        if (updated?.DisplayName) mirror.display_name = updated.DisplayName;
        if (updated?.PrimaryEmailAddr?.Address) mirror.email = updated.PrimaryEmailAddr.Address;
        if (updated?.BillAddr) {
          mirror.bill_addr_line1 = updated.BillAddr.Line1 ?? null;
          mirror.bill_addr_city = updated.BillAddr.City ?? null;
          mirror.bill_addr_state = updated.BillAddr.CountrySubDivisionCode ?? null;
          mirror.bill_addr_postal = updated.BillAddr.PostalCode ?? null;
        }
        if (Object.keys(mirror).length > 1) {
          await ops.from("qbo_customers").update(mirror).eq("qbo_customer_id", qboId);
        }
      } catch (err) {
        console.error("qbo-customer-lookup mirror heal after update failed:", err);
      }

      return jsonRes({
        ok: true, action: "update_customer", found: true, applied, refused,
        customer: { id: String(updated?.Id ?? qboId), display_name: updated?.DisplayName ?? cust.DisplayName ?? null },
        duration_ms: Date.now() - startedAt,
      });
    }

    // ── action: customer_master_snapshot ── read-only.
    //
    // What QuickBooks holds for the customer master, so the portal can diff
    // its own record against it. Deliberately covers the three fields the
    // ops.qbo_customers mirror does NOT carry — SalesTermRef, PaymentMethodRef
    // and Taxable — because those are precisely the ones the portal now pushes
    // and therefore the ones where a disagreement would otherwise be invisible.
    //
    // Pages through the QBO query API rather than asking per customer: 150+
    // customers one-at-a-time is minutes of round trips and a token-refresh
    // hazard, where this is a handful of calls.
    if (body?.action === "customer_master_snapshot") {
      const wanted: string[] = Array.isArray(body?.qbo_customer_ids)
        ? body.qbo_customer_ids.map((v: unknown) => String(v)).filter((v: string) => /^[0-9]+$/.test(v))
        : [];
      const want = wanted.length > 0 ? new Set(wanted) : null;
      const token = await getAccessToken(sb);

      const out: Record<string, unknown> = {};
      const PAGE = 200;
      const MAX_PAGES = 40; // 8,000 customers; the realm holds ~850 today
      let start = 1;
      let scanned = 0;
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        if (page === MAX_PAGES - 1) truncated = true;
        const q = "select Id, DisplayName, Active, Taxable, PrimaryEmailAddr, BillAddr, " +
          "SalesTermRef, PaymentMethodRef from Customer startposition " + start +
          " maxresults " + PAGE;
        const data = await acctQuery(token, q);
        const rows: any[] = data?.QueryResponse?.Customer ?? [];
        if (rows.length === 0) break;
        scanned += rows.length;
        for (const c of rows) {
          const id = String(c.Id);
          if (want && !want.has(id)) continue;
          out[id] = {
            display_name: c.DisplayName ?? null,
            active: c.Active !== false,
            // ⚠ Absent means QBO did not return the field, which is NOT the
            // same as false — reported as null so the portal can say
            // "unknown" instead of inventing a disagreement.
            taxable: typeof c.Taxable === "boolean" ? c.Taxable : null,
            email: c.PrimaryEmailAddr?.Address ?? null,
            bill_addr: c.BillAddr
              ? {
                  line1: c.BillAddr.Line1 ?? null,
                  line2: c.BillAddr.Line2 ?? null,
                  city: c.BillAddr.City ?? null,
                  state: c.BillAddr.CountrySubDivisionCode ?? null,
                  zip: c.BillAddr.PostalCode ?? null,
                }
              : null,
            terms: c.SalesTermRef?.name ?? null,
            payment_method: c.PaymentMethodRef?.name ?? null,
          };
        }
        if (rows.length < PAGE) { truncated = false; break; }
        start += PAGE;
      }
      return jsonRes({
        ok: true, action: "customer_master_snapshot",
        // ⚠ truncated = we hit the page cap, so a customer absent from `customers`
        // may simply not have been reached. The caller MUST NOT report those as
        // missing from QuickBooks — that would be a false alarm on every one.
        scanned, truncated, returned: Object.keys(out).length, customers: out,
        duration_ms: Date.now() - startedAt,
      });
    }

    const name = String(body?.display_name || "").trim().slice(0, 200);
    if (name.length < 2) throw new Error("display_name required");

    const token = await getAccessToken(sb);
    const escaped = name.replace(/'/g, "\\'");
    const data = await acctQuery(token, "select Id, DisplayName, FullyQualifiedName, ParentRef, Active, PrimaryEmailAddr, PrimaryPhone from Customer where DisplayName = '" + escaped + "'");
    const rows: any[] = data?.QueryResponse?.Customer ?? [];
    if (rows.length === 0) {
      return jsonRes({ ok: true, found: false, duration_ms: Date.now() - startedAt });
    }
    const c = rows[0];

    // Mirror heal — same conflict key as sync-qbo; nightly run re-upserts.
    let mirrored = false;
    try {
      const ops = getOpsSB();
      const { error } = await ops.from("qbo_customers").upsert([{
        qbo_customer_id: String(c.Id),
        display_name: c.DisplayName ?? null,
        fully_qualified_name: c.FullyQualifiedName ?? null,
        parent_ref_id: c.ParentRef?.value ?? null,
        is_sub_customer: !!c.ParentRef?.value,
        active: c.Active !== false,
        email: c.PrimaryEmailAddr?.Address ?? null,
        phone: c.PrimaryPhone?.FreeFormNumber ?? null,
        synced_at: new Date().toISOString(),
      }], { onConflict: "qbo_customer_id" });
      mirrored = !error;
      if (error) console.error("qbo-customer-lookup mirror upsert failed:", error.message);
    } catch (err) {
      console.error("qbo-customer-lookup mirror upsert threw:", err);
    }

    return jsonRes({
      ok: true,
      found: true,
      customer: { id: String(c.Id), display_name: c.DisplayName ?? null, email: c.PrimaryEmailAddr?.Address ?? null },
      mirrored,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("qbo-customer-lookup failed:", err);
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - startedAt }, 500);
  }
});
