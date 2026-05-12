// import-qbo-budget — pulls a budget out of QuickBooks Online and
// materializes it as an ops.sales_plans row + ops.sales_plan_lines
// (one line per Account, with amounts[1..12] populated).
//
// POST body:
//   { fiscal_year: 2026, budget_name?: 'My Budget', new_plan_name?: '...', dry_run?: true }
//
// If multiple budgets exist for that fiscal_year, the most recently-updated
// one is used unless budget_name is provided as an exact match.
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
    p_realm_id: getRealm(), p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS, p_lease_seconds: LEASE_SECONDS,
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
    p_refreshed_by: "import-qbo-budget@v1",
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
      if (!refreshSeed) { await releaseFailedLease(sb, "no refresh token"); throw new Error("no refresh token"); }
      try {
        const fresh = await intuitRefresh(refreshSeed);
        await persistTokens(sb, fresh.access_token, fresh.refresh_token, fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS, fresh.x_refresh_token_expires_in ?? null);
        return fresh.access_token;
      } catch (err) { await releaseFailedLease(sb, (err as Error).message); throw err; }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}
async function qboGet(sb: SupabaseClient, path: string): Promise<any> {
  const token = await getAccessToken(sb);
  const url = qboBaseUrl() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) throw new Error("QBO GET " + path + " failed (" + res.status + "): " + await res.text());
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
    const fiscalYear: number = Number(body?.fiscal_year);
    if (!Number.isFinite(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) throw new Error("fiscal_year required (2000-2100)");
    const dryRun: boolean = body?.dry_run === true;
    const wantedName: string | undefined = body?.budget_name?.toString()?.trim() || undefined;
    const newPlanName: string = body?.new_plan_name?.toString()?.trim() || ('QBO Budget FY' + fiscalYear);

    const q = encodeURIComponent('select * from Budget');
    const listResp = await qboGet(sb, '/query?query=' + q);
    const allBudgets: any[] = listResp?.QueryResponse?.Budget ?? [];
    const yearStart = fiscalYear + '-01-01';
    const candidates = allBudgets.filter((b) => {
      const sd = String(b?.StartDate || '');
      return sd === yearStart || sd.startsWith(String(fiscalYear));
    });
    if (candidates.length === 0) {
      return jsonRes({
        ok: false,
        error: 'no QBO budget found for fiscal_year ' + fiscalYear,
        all_budgets_found: allBudgets.map((b) => ({ id: b.Id, name: b.Name, start: b.StartDate, end: b.EndDate })),
      }, 404);
    }
    let chosen = candidates[0];
    if (wantedName) {
      const named = candidates.find((b) => String(b.Name || '').trim().toLowerCase() === wantedName.toLowerCase());
      if (named) chosen = named;
    } else {
      chosen = candidates.reduce((a, b) =>
        new Date(a?.MetaData?.LastUpdatedTime || 0) > new Date(b?.MetaData?.LastUpdatedTime || 0) ? a : b,
      );
    }

    type AccountAgg = { account_id: string; account_name: string; amounts: number[] };
    const byAccount = new Map<string, AccountAgg>();
    const details: any[] = chosen?.BudgetDetail ?? [];
    for (const d of details) {
      const ref = d?.AccountRef;
      const accId = String(ref?.value ?? '');
      const accName = String(ref?.name ?? accId);
      const startDate = String(d?.StartDate ?? '');
      if (!startDate || !accId) continue;
      const m = parseInt(startDate.slice(5, 7), 10) - 1;
      if (m < 0 || m > 11) continue;
      if (!byAccount.has(accId)) byAccount.set(accId, { account_id: accId, account_name: accName, amounts: Array(12).fill(0) });
      const agg = byAccount.get(accId)!;
      agg.amounts[m] += Number(d?.Amount ?? 0);
    }

    const linesPreview = Array.from(byAccount.values())
      .sort((a, b) => a.account_name.localeCompare(b.account_name))
      .map((agg, i) => ({
        line_type: 'account',
        qbo_account_id: agg.account_id,
        account_name: agg.account_name,
        amounts: agg.amounts,
        annual_total: agg.amounts.reduce((s, v) => s + v, 0),
        sort_order: i + 1,
      }));
    const grandTotal = linesPreview.reduce((s, l) => s + l.annual_total, 0);

    if (dryRun) {
      return jsonRes({
        ok: true, mode: 'dry_run',
        budget: { id: chosen.Id, name: chosen.Name, start: chosen.StartDate, end: chosen.EndDate },
        new_plan_name: newPlanName,
        line_count: linesPreview.length,
        grand_total: grandTotal,
        preview: linesPreview.slice(0, 20),
        duration_ms: Date.now() - startedAt,
      });
    }

    const { data: planRow, error: pErr } = await sb.schema('ops')
      .from('sales_plans')
      .insert({
        name: newPlanName,
        fiscal_year: fiscalYear,
        scenario: 'budget',
        status: 'active',
      })
      .select('id')
      .single();
    if (pErr || !planRow) throw new Error('plan insert failed: ' + (pErr?.message || 'unknown'));
    const planId = (planRow as any).id;

    const inserts = linesPreview.map((l) => ({
      plan_id: planId,
      line_type: 'account',
      qbo_account_id: l.qbo_account_id,
      account_name: l.account_name,
      amounts: l.amounts,
      sort_order: l.sort_order,
    }));
    if (inserts.length > 0) {
      const { error: lErr } = await sb.schema('ops').from('sales_plan_lines').insert(inserts);
      if (lErr) throw new Error('lines insert failed: ' + lErr.message);
    }

    return jsonRes({
      ok: true, mode: 'committed',
      plan_id: planId,
      plan_name: newPlanName,
      qbo_budget: { id: chosen.Id, name: chosen.Name, start: chosen.StartDate, end: chosen.EndDate },
      lines_imported: inserts.length,
      grand_total: grandTotal,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('import-qbo-budget FATAL:', err);
    return jsonRes({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    }, 500);
  }
});
