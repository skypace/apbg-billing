// sync-sf — mirror Service Fusion jobs into ops.delivery_stops / service_jobs /
// reman_jobs. APBG-OPS computes cost-per-stop, utilisation, FTF% and callback%
// from those three tables, and BrixSD (apbg-dispatch) seeds dispatch.jobs from
// them, so this is the feed under two products.
//
// ⚠ THE REPO HAD NO COPY OF THIS FUNCTION UNTIL 2026-09-07. Deployed v33 was
// the only copy in existence; APBG-OPS's CLAUDE.md said it lived "in the
// billing repo, every 30 min" and both halves were wrong (no repo held it, and
// the cron is daily at 09:00 UTC). Recovered from the deployed source and
// fixed here, so the repo is authoritative from now on. Pull the deployed
// source with the Supabase MCP before editing — the same drift put
// qbo-stripe-deposit at v1 in-repo while v2 ran live.
//
// ── What was wrong, 2026-09-07 ────────────────────────────────────────────────
// The sync reported SUCCESS every day for months and landed almost nothing:
// 10 runs in 10 days, 1 record total. ops.delivery_stops had not been written
// since 2026-04-28. Four separate faults, and the run log made all four
// visible once anyone looked at metadata instead of status:
//
//   day         page  window_from   scanned  skipped  synced
//   2026-09-06  4063  2026-09-01    0        0        0
//   2026-09-04  4065  2026-09-01    10       10       0
//   2026-08-31  4070  2026-08-01    20       19       1
//
// 1. IT WALKED THE WRONG WAY. With no `sort`, SF's default is id ASCENDING, so
//    page 1 is the OLDEST and the last page is the NEWEST. The old code started
//    at pageCount (~4197) and walked DOWN, one page a day, resuming from
//    `last_page_processed - 1`. So it crawled backwards into 2025 and NEVER
//    revisited the newest page — a job created today could not be seen. At
//    ~1 page/day it would have reached page 1 in about eleven years.
// 2. `per_page` IS SILENTLY IGNORED. SF's parameter is `per-page`, hyphenated.
//    It asked for 50 and got SF's default ~10, so the page arithmetic was wrong
//    on top of pointing the wrong way.
// 3. THE DATE WINDOW DEFAULTED TO THE CURRENT CALENDAR MONTH. Combined with (1)
//    that guarantees zero matches: the cursor sits in 2025 while the window is
//    "this month". Every job scanned fell before the window, the loop hit its
//    all-before-start break, and the run logged success with 0 records.
// 4. NO `sort` AT ALL IS ALSO THE HANG TRIGGER on this account. SF's planner
//    hangs list queries 20s–2min+ without one (brix-order session 1.18;
//    sf-receipt-sync's pageCount probe re-learned it). Every query here now
//    carries an explicit sort.
//
// ── The fix, and why each part is shaped this way ─────────────────────────────
// FRESH mode (the daily run) sorts `-updated_at` and walks page 1 forward.
// Page 1 is then always the most-recently-touched work, so a daily run cannot
// miss new jobs however long it has been running. `-updated_at` rather than
// `-id` because a mirror of job STATE has to see a job created in July that
// completes today — sorting by id only surfaces newly-created jobs, which is
// exactly how sf-receipt-sync lost 12 expenses (~$9k) on old-but-updated jobs
// before its 2026-08-14 fix. Verified there that editing a job bumps its
// updated_at.
//
// BACKFILL mode keeps the stable `-id` cursor walk, because page order under
// `-updated_at` shifts as jobs change and a deep historical crawl needs a sort
// that cannot shuffle underneath it. Same split sf-receipt-sync settled on.
// It only runs when asked (`?mode=backfill`) — it is no longer what the cron
// does by accident.
//
// ⚠ FUTURE-DATED JOBS NOW LAND. The old upper bound (`d > endDate` → skip) was
// harmless for backward-looking KPIs and fatal for a dispatch board, whose
// whole subject is work that has not happened yet. They are counted as
// `future` so the new inflow is visible rather than surprising.
//
// ⚠ THE TOKEN IS LEASE-GUARDED NOW. This was the only SF reader that refreshed
// ops.sf_token_cache directly — sf-helpers.mjs and sf-receipt-sync both claim
// fn_sf_token_claim_refresh first. SF ROTATES the refresh token on every use,
// so an unguarded third refresher can spend the credential out from under the
// other two. One attempt, DB token only; SF_REFRESH_TOKEN is a bootstrap for an
// empty row, never a fallback for a rejected one (see apbg-billing 2026-09-07).
//
// Rule for anyone adding a filter below: IF YOU `continue`, INCREMENT A
// COUNTER. Every counter here is read by ops.fn_sf_job_sync_coverage(), which
// goes red when jobs are scanned and none land — the shape that hid this for
// months. "success" is not evidence that anything happened.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SF_API = "https://api.servicefusion.com/v1";
const SF_TOKEN_URL = "https://api.servicefusion.com/oauth/access_token";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
const SF_EXPAND = "techs_assigned,printable_work_order";
// per-page is HYPHENATED. SF ignores per_page and uses its default (~10).
const PER_PAGE = 50;
// Explicit sort on every list query, always. See fault 4 above.
const SORT_FRESH = "-updated_at";   // daily run: newest-touched first
const SORT_STABLE = "-id";          // backfill: a page order that cannot shuffle
const PAGES_PER_RUN = 6;            // 6 × 50 = 300 jobs; the budget usually stops it first
// The edge runtime hard-kills a request at 150s with no chance to log, and a run
// killed mid-flight writes no sync_log row — which reads exactly like "nothing
// to do". Budget well under it and leave room for the closing write.
const BUDGET_MS = 70000;
const SF_TIMEOUT_MS = 30000;
const LOOKBACK_DAYS = 90;
const TOKEN_LOCK_SECONDS = 45;
const TOKEN_LOCK_WAIT_MS = 2500;

function getSB() { return createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { db: { schema: "ops" } }); }
function jsonRes(d: any, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json", ...CORS } }); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dayOf = (v: any) => String(v || "").split(" ")[0].split("T")[0];

let accessToken = ""; let tokenExpires = 0;

async function readTokenCache(sb: any) {
  try { const { data } = await sb.from("sf_token_cache").select("*").eq("id", 1).maybeSingle(); return data || null; }
  catch (_e) { return null; }
}
function freshAccess(c: any): boolean {
  return !!(c?.access_token && c?.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now() + 30000);
}
function useCached(c: any): string {
  accessToken = c.access_token; tokenExpires = new Date(c.access_expires_at).getTime(); return accessToken;
}
async function noteRefreshError(sb: any, message: string) {
  try {
    await sb.from("sf_token_cache").update({
      last_refresh_error: message.slice(0, 500),
      last_refresh_error_at: new Date().toISOString(),
    }).eq("id", 1);
  } catch (_e) { /* best effort */ }
}

async function getSFToken(sb: any): Promise<string> {
  if (accessToken && tokenExpires > Date.now()) return accessToken;
  const cached = await readTokenCache(sb);
  if (freshAccess(cached)) return useCached(cached);

  // Bootstrap only — never a fallback for a token SF rejected.
  const rt = cached?.refresh_token || Deno.env.get("SF_REFRESH_TOKEN") || "";
  if (!rt || rt === "will-be-replaced-on-first-run") throw new Error("No SF refresh token — re-auth the billing app (apbg-billing CLAUDE.md → Service Fusion OAuth)");
  if (!cached?.refresh_token) console.warn("[sync-sf] no refresh token in ops.sf_token_cache; bootstrapping from SF_REFRESH_TOKEN env");

  // The lease. Without it this function can rotate the credential out from
  // under sf-helpers.mjs and sf-receipt-sync, which both claim it.
  const owner = `sync-sf:${crypto.randomUUID()}`;
  let claimed = true;
  try {
    const { data, error } = await sb.rpc("fn_sf_token_claim_refresh", { p_owner: owner, p_lock_seconds: TOKEN_LOCK_SECONDS });
    if (!error) claimed = data === true;
  } catch (_e) { /* keep going — a missing RPC must not stop the sync */ }

  if (!claimed) {
    for (let i = 0; i < 6; i++) {
      await sleep(TOKEN_LOCK_WAIT_MS);
      const retry = await readTokenCache(sb);
      if (freshAccess(retry)) return useCached(retry);
    }
    throw new Error("SF token refresh already running; no fresh access token appeared");
  }

  try {
    const latest = await readTokenCache(sb);
    if (freshAccess(latest)) return useCached(latest);
    // ONE attempt, with the freshest token we hold. Never retry with another
    // copy: SF rotates on use, so an older copy is one SF has already retired.
    const res = await fetch(SF_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: Deno.env.get("SF_CLIENT_ID") || "",
        client_secret: Deno.env.get("SF_CLIENT_SECRET") || "",
        refresh_token: latest?.refresh_token || rt,
      }),
    });
    if (!res.ok) {
      const msg = `SF token refresh failed ${res.status}${res.status === 400 ? " (refresh token rejected or already rotated)" : ""}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`;
      await noteRefreshError(sb, msg);
      throw new Error(msg);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error("No token in SF response");
    accessToken = data.access_token; tokenExpires = Date.now() + 50 * 60 * 1000;
    const u: any = {
      id: 1, access_token: data.access_token,
      access_expires_at: new Date(tokenExpires).toISOString(),
      updated_at: new Date().toISOString(),
      refresh_locked_until: null, refresh_lock_owner: null,
      last_refresh_error: null, last_refresh_error_at: null, last_error: null,
    };
    if (data.refresh_token) u.refresh_token = data.refresh_token;
    await sb.from("sf_token_cache").upsert(u);
    return accessToken;
  } finally {
    try { await sb.rpc("fn_sf_token_release_refresh", { p_owner: owner }); } catch (_e) { /* best effort */ }
  }
}

async function sfGet(sb: any, ep: string): Promise<any> {
  const t = await getSFToken(sb);
  const opts = (tok: string) => ({ headers: { Authorization: "Bearer " + tok, Accept: "application/json" }, signal: AbortSignal.timeout(SF_TIMEOUT_MS) });
  let r = await fetch(SF_API + ep, opts(t));
  if (r.status === 401) { accessToken = ""; tokenExpires = 0; const t2 = await getSFToken(sb); r = await fetch(SF_API + ep, opts(t2)); }
  if (!r.ok) throw new Error("SF " + r.status + " " + (await r.text()).slice(0, 200));
  const txt = await r.text(); return txt.trim() ? JSON.parse(txt) : {};
}

const jobsPath = (page: number, sort: string) =>
  `/jobs?per-page=${PER_PAGE}&page=${page}&sort=${encodeURIComponent(sort)}&expand=${SF_EXPAND}`;

function classifyJob(j: any): string {
  const t = ((j.category || "") + " " + (j.description || "") + " " + (j.source || "") + " " + (j.phase || "")).toLowerCase();
  if (t.includes("deliver") || t.includes("route") || t.includes("drop off") || t.includes("pickup") || t.includes("bib") || t.includes("co2") || t.includes("cylinder") || t.includes("cola") || t.includes("lemon lime") || t.includes("root beer") || t.includes("ginger") || t.includes("creme") || t.includes("cherry") || t.includes("orange") || t.includes("rental")) return "delivery";
  if (t.includes("reman") || t.includes("rebuild") || t.includes("refurb") || t.includes("scrap")) return "reman";
  return "service";
}
function getJobType(j: any): string {
  const t = ((j.category || "") + " " + (j.description || "")).toLowerCase();
  if (t.includes("pm") || t.includes("preventive") || t.includes("maintenance")) return "pm";
  if (t.includes("install")) return "install";
  if (t.includes("freshpet")) return "freshpet";
  return "break_fix";
}
function extractEncodedId(j: any): string | null {
  const pwo = j.printable_work_order;
  if (!pwo || !Array.isArray(pwo) || pwo.length === 0) return null;
  const m = String(pwo[0]?.url || "").match(/jobId=([^&]+)/);
  return m ? m[1] : null;
}

const teamCache: Record<string, number | null> = {};
async function matchTech(sb: any, firstName: string, lastName: string): Promise<{ id: number | null; name: string }> {
  const fullName = (firstName + " " + lastName).trim();
  if (!fullName || fullName === "Service Department General") return { id: null, name: fullName };
  if (fullName in teamCache) return { id: teamCache[fullName], name: fullName };
  const { data } = await sb.from("team_members").select("id,name").or("name.ilike.%" + firstName + "%,name.ilike.%" + lastName + "%").limit(1);
  const id = data?.[0]?.id || null;
  teamCache[fullName] = id;
  return { id, name: fullName };
}

type Counters = {
  scanned: number; delivery: number; service: number; reman: number;
  skippedOld: number; future: number; errors: number;
};

async function upsertJob(sb: any, j: any, c: Counters, log: string[]): Promise<void> {
  const d = dayOf(j.start_date || j.created_at) || null;
  const tech = j.techs_assigned?.[0];
  let techName: string | null = null; let techId: number | null = null;
  if (tech) { const m = await matchTech(sb, tech.first_name || "", tech.last_name || ""); techName = m.name; techId = m.id; }

  const cls = classifyJob(j);
  const sfTotal = parseFloat(j.total) || 0;
  const rawStatus = j.status || null;
  const encodedId = extractEncodedId(j);
  const s = (rawStatus || "").toLowerCase();
  const done = s.includes("complet") || s.includes("archiv") || s.includes("invoiced");
  const stamp = new Date().toISOString();

  if (cls === "delivery") {
    const { error } = await sb.from("delivery_stops").upsert({
      sf_job_id: String(j.id), sf_job_number: j.number || null, stop_date: d,
      customer_name: j.customer_name || null, customer_ref_id: j.customer_id ? String(j.customer_id) : null,
      driver_id: techId, driver_name: techName,
      address: [j.street_1, j.city, j.state_prov, j.postal_code].filter(Boolean).join(", ") || null,
      status: done ? "completed" : "open", sf_status: rawStatus, sf_encoded_id: encodedId,
      notes: (j.description || "").slice(0, 500) || null,
      sf_total: sfTotal, payment_status: j.payment_status || null, synced_at: stamp,
    }, { onConflict: "sf_job_id" });
    if (error) { c.errors++; log.push("DEL err " + j.id + ": " + error.message.slice(0, 120)); } else c.delivery++;
  } else if (cls === "reman") {
    const { error } = await sb.from("reman_jobs").upsert({
      sf_job_id: String(j.id), sf_job_number: j.number || null, intake_date: d,
      completion_date: j.closed_at ? dayOf(j.closed_at) : null,
      tech_id: techId, tech_name: techName,
      customer_ref_id: j.customer_id ? String(j.customer_id) : null, equipment_type: j.category || null,
      status: done ? "complete" : "in_progress", sf_status: rawStatus, sf_encoded_id: encodedId,
      notes: (j.description || "").slice(0, 500) || null,
      sf_total: sfTotal, payment_status: j.payment_status || null, synced_at: stamp,
    }, { onConflict: "sf_job_id" });
    if (error) { c.errors++; log.push("REM err " + j.id + ": " + error.message.slice(0, 120)); } else c.reman++;
  } else {
    const { error } = await sb.from("service_jobs").upsert({
      sf_job_id: String(j.id), sf_job_number: j.number || null, job_date: d,
      customer_name: j.customer_name || null, customer_ref_id: j.customer_id ? String(j.customer_id) : null,
      tech_id: techId, tech_name: techName,
      job_type: getJobType(j), status: done ? "completed" : "open", sf_status: rawStatus, sf_encoded_id: encodedId,
      notes: (j.description || "").slice(0, 500) || null, duration_min: j.duration || null,
      sf_total: sfTotal, payment_status: j.payment_status || null, synced_at: stamp,
    }, { onConflict: "sf_job_id" });
    if (error) { c.errors++; log.push("SVC err " + j.id + ": " + error.message.slice(0, 120)); } else c.service++;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "fresh";
  const sb = getSB();
  const log: string[] = [];
  const started = new Date().toISOString();
  const t0 = Date.now();

  if (mode === "test") {
    const r: Record<string, any> = {};
    try { await getSFToken(sb); r.sf_auth = "OK"; } catch (e: any) { r.sf_auth = "FAIL: " + e.message; }
    if (r.sf_auth === "OK") {
      try {
        const d = await sfGet(sb, jobsPath(1, SORT_FRESH));
        const items = d?.items || [];
        r.sf_api = "OK"; r.meta = d?._meta || {}; r.page1_count = items.length;
        if (items[0]) {
          const j = items[0];
          r.newest = { id: j.id, number: j.number, status: j.status, customer: j.customer_name, start_date: j.start_date, updated_at: j.updated_at, classification: classifyJob(j) };
        }
      } catch (e: any) { r.sf_api = "FAIL: " + e.message; }
    }
    return jsonRes(r);
  }

  // Window: a LOOKBACK, not a calendar month, and no upper bound — a dispatch
  // board needs the work that has not happened yet.
  const lookbackDays = parseInt(url.searchParams.get("days") || String(LOOKBACK_DAYS)) || LOOKBACK_DAYS;
  const startDate = url.searchParams.get("start") ||
    new Date(Date.now() - lookbackDays * 86400000).toISOString().split("T")[0];

  const c: Counters = { scanned: 0, delivery: 0, service: 0, reman: 0, skippedOld: 0, future: 0, errors: 0 };
  const today = new Date().toISOString().split("T")[0];
  const backfill = mode === "backfill";
  const sort = backfill ? SORT_STABLE : SORT_FRESH;

  // Fresh always starts at page 1 — under -updated_at that IS the newest work,
  // which is the whole point of the fix. Backfill keeps a cursor.
  let page = parseInt(url.searchParams.get("page") || "0") || 0;
  if (page < 1) {
    if (backfill) {
      const { data: last } = await sb.from("sync_log").select("metadata")
        .eq("source", "sf").eq("sync_type", "jobs").eq("status", "success")
        .order("completed_at", { ascending: false }).limit(1);
      const np = last?.[0]?.metadata?.backfill_next_page;
      page = np && np >= 1 ? np : 1;
    } else page = 1;
  }

  let lastCompleted = page - 1;
  let ranDry = false, budgetHit = false, allOld = false;
  let fatal = "";

  log.push(`${mode} | sort ${sort} | from ${startDate} (no upper bound) | page ${page}`);

  try {
    for (let p = page; p < page + PAGES_PER_RUN; p++) {
      if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; log.push("time budget"); break; }
      let data: any;
      try { data = await sfGet(sb, jobsPath(p, sort)); }
      catch (e: any) { c.errors++; log.push(`page ${p} failed: ${String(e.message).slice(0, 120)}`); continue; }
      const jobs = data?.items || [];
      if (!jobs.length) { ranDry = true; log.push(`page ${p}: empty — end of list`); break; }
      c.scanned += jobs.length;

      let old = 0;
      for (const j of jobs) {
        if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; log.push(`time budget mid-page ${p}`); break; }
        const d = dayOf(j.start_date || j.created_at);
        if (d && d < startDate) { old++; c.skippedOld++; continue; }
        if (d && d > today) c.future++;   // counted, NOT skipped — see header
        await upsertJob(sb, j, c, log);
      }
      log.push(`page ${p}: ${jobs.length} jobs, ${old} older than window`);
      if (budgetHit) break;
      lastCompleted = p;
      // A whole page older than the window means we have walked off the end of
      // what we care about. Under -updated_at that is the natural terminator.
      if (old === jobs.length) { allOld = true; log.push("whole page older than window — done"); break; }
    }

    const synced = c.delivery + c.service + c.reman;
    log.push(`synced ${synced} (${c.delivery} del / ${c.service} svc / ${c.reman} rem), ${c.future} future-dated`);

    const meta: any = {
      ...c, synced, mode, sort, start_date: startDate, lookback_days: lookbackDays,
      from_page: page, last_page: lastCompleted, ran_dry: ranDry, budget_hit: budgetHit,
      all_old: allOld, elapsed_ms: Date.now() - t0,
    };
    // Only backfill carries a cursor. Fresh must always restart at page 1 —
    // a fresh-mode cursor is the bug this function is being fixed for.
    if (backfill) meta.backfill_next_page = allOld || ranDry ? 1 : Math.max(1, lastCompleted + 1);

    await sb.from("sync_log").insert({
      source: "sf", sync_type: "jobs", status: "success", records_synced: synced,
      started_at: started, completed_at: new Date().toISOString(), metadata: meta,
    });
    return jsonRes({ status: "success", ...meta, log });
  } catch (err: any) {
    fatal = err.message;
    log.push("FATAL: " + fatal);
    try {
      await sb.from("sync_log").insert({
        source: "sf", sync_type: "jobs", status: "error", records_synced: c.delivery + c.service + c.reman,
        started_at: started, completed_at: new Date().toISOString(), error_message: fatal,
        metadata: { ...c, mode, sort, from_page: page, last_page: lastCompleted, elapsed_ms: Date.now() - t0 },
      });
    } catch (_e) { /* nothing left to do */ }
    return jsonRes({ status: "error", message: fatal, ...c, log }, 500);
  }
});
