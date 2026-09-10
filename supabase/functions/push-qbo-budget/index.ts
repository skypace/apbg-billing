// push-qbo-budget edge function — APBG-OPS Supabase project
//
// Reads ops.fn_plan_account_rollup(plan_id) for a sales plan and
// produces:
//   - a QBO-import-ready CSV (Account, Jan..Dec columns)
//   - the equivalent JSON payload for QBO's Budget API
//   - if write=true and the Budget create API is enabled for this realm,
//     attempts to POST it. QBO's Budget create endpoint is restricted
//     to certain accounts/SKUs; if it returns 4xx, we fall back to
//     returning the CSV for manual upload via QBO UI:
//        QBO Web → Settings → Tools → Budgeting → Add Budget → Import.
//
// Auth: lease-based token rotation via ops.qbo_token_cache, mirrors
// sync-qbo-items v1. Caller must pass {plan_id: uuid, write?: bool}.
//
// verify_jwt = true: caller must be an authenticated Supabase user
// (the dashboard sends the user's bearer token).

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
  return env === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}
function getSB(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}
function jsonRes(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function claimRefresh(sb: SupabaseClient): Promise<ClaimResult> {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(),
    p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return (Array.isArray(data) ? data[0] : data) as ClaimResult;
}

async function persistTokens(sb: SupabaseClient, accessToken: string, refreshToken: string, expiresInSeconds: number, refreshExpiresIn: number | null): Promise<void> {
  const accessExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const refreshExpiry = refreshExpiresIn
    ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString()
    : new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  const { error } = await sb.rpc("qbo_token_persist", {
    p_realm_id: getRealm(),
    p_access_token: accessToken, p_access_expires: accessExpiry,
    p_refresh_token: refreshToken, p_refresh_expires: refreshExpiry,
    p_refreshed_by: "push-qbo-budget@v1",
  });
  if (error) throw new Error("token_persist RPC failed: " + error.message);
}

async function releaseFailedLease(sb: SupabaseClient, message: string): Promise<void> {
  await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: message.slice(0, 500) });
}

async function intuitRefresh(refreshToken: string) {
  const clientId = Deno.env.get("QBO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("missing QBO_CLIENT_ID or QBO_CLIENT_SECRET env");
  const creds = btoa(clientId + ":" + clientSecret);
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: "Basic " + creds },
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
      const refreshSeed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!refreshSeed) {
        await releaseFailedLease(sb, "no refresh token available — cache empty and QBO_REFRESH_TOKEN env unset");
        throw new Error("no refresh token available (cache empty, env unset)");
      }
      try {
        const fresh = await intuitRefresh(refreshSeed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token, fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS, fresh.x_refresh_token_expires_in ?? null);
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

function csvEscape(v: any) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

type RollupRow = {
  qbo_account_id: string | null;
  account_name: string;
  m1: number | string; m2: number | string; m3: number | string; m4: number | string;
  m5: number | string; m6: number | string; m7: number | string; m8: number | string;
  m9: number | string; m10: number | string; m11: number | string; m12: number | string;
  total: number | string;
};

function monthKey(i: number) { return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][i]; }

function buildCsv(rows: RollupRow[]) {
  const header = ["Account", ...Array.from({length: 12}, (_, i) => monthKey(i)), "Total"];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    const row = [
      r.account_name,
      ...Array.from({length: 12}, (_, i) => Number((r as any)["m" + (i+1)] || 0).toFixed(2)),
      Number(r.total || 0).toFixed(2),
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function buildBudgetJson(rows: RollupRow[], fiscalYear: number, name: string) {
  // Approximate QBO Budget shape. Each line = one (account, month).
  // Real QBO Budget create requires this exact shape, but only certain
  // accounts can be budgeted depending on the company's QBO plan.
  const details: any[] = [];
  for (const r of rows) {
    if (!r.qbo_account_id) continue;
    for (let i = 0; i < 12; i++) {
      const amt = Number((r as any)["m" + (i+1)] || 0);
      if (amt === 0) continue;
      const start = new Date(Date.UTC(fiscalYear, i, 1)).toISOString().slice(0,10);
      details.push({
        AccountRef: { value: r.qbo_account_id, name: r.account_name },
        StartDate: start,
        Amount: amt,
      });
    }
  }
  return {
    Name: name,
    StartDate: fiscalYear + "-01-01",
    EndDate: fiscalYear + "-12-31",
    BudgetEntryType: "Account",
    BudgetType: "Profit_and_Loss",
    BudgetDetail: details,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST only" }, 405);

  const sb = getSB();
  const body = await req.json().catch(() => ({}));
  const planId = body.plan_id;
  const write = body.write === true;
  if (!planId) return jsonRes({ ok: false, error: "plan_id required" }, 400);

  try {
    const { data: plan, error: pErr } = await sb.schema("ops")
      .from("sales_plans").select("id,name,fiscal_year,scenario").eq("id", planId).single();
    if (pErr || !plan) throw new Error("plan not found: " + (pErr?.message || ""));

    const { data: rows, error: rErr } = await sb.rpc("fn_plan_account_rollup", { p_plan_id: planId });
    if (rErr) throw new Error("rollup RPC failed: " + rErr.message);
    const rollup = (rows || []) as RollupRow[];

    const fiscalYear = (plan as any).fiscal_year as number;
    const planName = `${(plan as any).name} — FY${fiscalYear} (${(plan as any).scenario || "plan"})`;

    const csv = buildCsv(rollup);
    const json = buildBudgetJson(rollup, fiscalYear, planName);

    if (!write) {
      return jsonRes({
        ok: true,
        mode: "dry_run",
        plan: { id: plan.id, name: plan.name, fiscal_year: fiscalYear, scenario: plan.scenario },
        rollup_count: rollup.length,
        budget_detail_count: json.BudgetDetail.length,
        csv,
        budget_payload: json,
        upload_instructions: [
          "QBO's Budget API is read-only for most accounts.",
          "To import this CSV in QuickBooks Online:",
          "  1. Settings (gear) → Tools → Budgeting",
          "  2. Click Add Budget → enter a name, set fiscal year to " + fiscalYear,
          "  3. Choose Subdivide by None, click Next → Create Budget",
          "  4. In the budget grid, click the dropdown next to Save → Import budget",
          "  5. Save the CSV from this response, choose it in the import dialog",
          "     Account names must match QBO account names exactly",
        ],
      });
    }

    // write=true: attempt POST
    const realm = getRealm();
    if (!realm) throw new Error("QBO_REALM_ID env missing");
    const token = await getAccessToken(sb);
    const url = `${qboBaseUrl()}/v3/company/${realm}/budget?minorversion=70`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(json),
    });
    const text = await resp.text();
    let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* keep as text */ }

    if (!resp.ok) {
      return jsonRes({
        ok: false,
        mode: "write_attempted",
        write_status: resp.status,
        write_error: parsed || text,
        note: "QBO Budget create is not supported for most realms; CSV import via the QBO UI is the supported path.",
        csv, budget_payload: json,
      }, 200);
    }

    return jsonRes({
      ok: true,
      mode: "write_success",
      qbo_response: parsed || text,
      csv, budget_payload: json,
    });
  } catch (err) {
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
