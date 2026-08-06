// sf-receipt-sync — pull Service Fusion expense lines + RECEIPTS into Brixpense
// as reviewable DRAFTS. Edge function (reliable pg_cron + visible ops.sync_log).
// Reuses sync-sf's SF auth (ops.sf_token_cache). NOTHING posts to QBO; Brixpense
// posts on submit.
//
// Receipt images: SF's REST API exposes the expense LINE but not the receipt
// file. The receipt URL is only on the admin.servicefusion.com job page. So we:
//   1. resolve job number -> encrypted admin id via /serviceSpot/loadGlobalSearchResults
//   2. GET /jobs/jobView?id=<enc> and scrape the userdocs/.../jobexpense/... S3 URL
//   3. fetch the receipt from public S3 (anon) and attach it to the draft
// The admin portal needs the orders.sf_portal_session cookie; when it's stale we
// auto-refresh it by calling the Make login hook (SF_PORTAL_REFRESH_HOOK) and
// writing the fresh cookie back to the DB.
//
// 2026-07-24: success runs now log status='success' (was 'ok' — which violated
// ops.sync_log's status CHECK constraint, so EVERY success insert was silently
// rejected since day one: no success visibility AND the crawl cursor — which
// resumes from the last success row's next_page — never advanced, so the
// historical backfill restarted at the newest page forever).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SF_API = "https://api.servicefusion.com/v1";
const SF_TOKEN_URL = "https://api.servicefusion.com/oauth/access_token";
const ADMIN_BASE = "https://admin.servicefusion.com";
const PORTAL_HOOK = Deno.env.get("SF_PORTAL_REFRESH_HOOK") || "https://hook.us1.make.celonis.com/l9jobjd5bx7gob8icc06ncv981anl4ki";
// Per-call network caps. Without these a single hung admin-portal scrape or S3
// receipt download can burn the whole 150s request wall, and the run dies before
// it can write its sync_log row (invisible failure — see the crawl note below).
const PORTAL_TIMEOUT_MS = 20000;
const RECEIPT_TIMEOUT_MS = 25000;
const HOOK_TIMEOUT_MS = 20000;
const ATTACH_BUCKET = "expense-attachments";
const SUBMITTER_ID = "2da634b7-623d-4f73-b667-cf87975fcdb6"; // skypace@brixbev.com (system)
const START_DATE = Deno.env.get("SF_SWEEP_START_DATE") || "2026-06-03";
const PAGES_PER_RUN = 8;
const TOKEN_LOCK_SECONDS = 45;
const TOKEN_LOCK_WAIT_MS = 2500;
const ACCOUNT_MAP: Record<string, { id: string; name: string }> = {
  equipment: { id: "42", name: "Equipment Sales COGS" },
  service: { id: "101", name: "Service COGS" },
};

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { db: { schema: "ops" } });
}
function json(d: any, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json" } }); }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readTokenCache(s: any): Promise<any | null> {
  try {
    const { data } = await s.from("sf_token_cache").select("*").eq("id", 1).maybeSingle();
    return data || null;
  } catch (_e) {
    return null;
  }
}
function cacheHasFreshAccessToken(c: any): boolean {
  return !!(c?.access_token && c?.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now() + 30000);
}
function useCachedAccess(c: any): string {
  accessToken = c.access_token;
  tokenExpires = new Date(c.access_expires_at).getTime();
  return accessToken;
}
async function claimRefreshLock(s: any, owner: string): Promise<boolean> {
  try {
    const { data, error } = await s.rpc("fn_sf_token_claim_refresh", { p_owner: owner, p_lock_seconds: TOKEN_LOCK_SECONDS });
    if (error) return true; // migration may not be applied yet; keep old behavior.
    return data === true;
  } catch (_e) {
    return true;
  }
}
async function releaseRefreshLock(s: any, owner: string): Promise<void> {
  try { await s.rpc("fn_sf_token_release_refresh", { p_owner: owner }); } catch (_e) { /* best effort */ }
}
async function noteRefreshError(s: any, message: string): Promise<void> {
  try {
    await s.from("sf_token_cache").update({
      last_refresh_error: message.slice(0, 500),
      last_refresh_error_at: new Date().toISOString(),
    }).eq("id", 1);
  } catch (_e) { /* best effort */ }
}
async function writeTokenCache(s: any, row: any): Promise<void> {
  const { error } = await s.from("sf_token_cache").upsert(row);
  if (!error) return;
  const fallback = { ...row };
  delete fallback.refresh_locked_until;
  delete fallback.refresh_lock_owner;
  delete fallback.last_refresh_error;
  delete fallback.last_refresh_error_at;
  await s.from("sf_token_cache").upsert(fallback);
}
function tokenErrorMessage(status: number, body: string): string {
  const clean = body.replace(/\s+/g, " ").trim().slice(0, 300);
  const hint = status === 400 ? " (refresh token rejected or already rotated)" : "";
  return `SF token refresh failed ${status}${hint}${clean ? ": " + clean : ""}`;
}

let accessToken = ""; let tokenExpires = 0;
async function sfToken(s: any): Promise<string> {
  if (accessToken && tokenExpires > Date.now()) return accessToken;
  const cached = await readTokenCache(s);
  if (cacheHasFreshAccessToken(cached)) return useCachedAccess(cached);
  const rt = cached?.refresh_token || Deno.env.get("SF_REFRESH_TOKEN") || "";
  if (!rt) throw new Error("No SF refresh token");

  const owner = `sf-receipt-sync:${crypto.randomUUID()}`;
  const claimed = await claimRefreshLock(s, owner);
  if (!claimed) {
    for (let i = 0; i < 6; i++) {
      await sleep(TOKEN_LOCK_WAIT_MS);
      const retry = await readTokenCache(s);
      if (cacheHasFreshAccessToken(retry)) return useCachedAccess(retry);
    }
    throw new Error("SF token refresh already running; no fresh access token appeared");
  }

  try {
    const latest = await readTokenCache(s);
    if (cacheHasFreshAccessToken(latest)) return useCachedAccess(latest);
    const refreshToken = latest?.refresh_token || rt;
    const envRefreshToken = Deno.env.get("SF_REFRESH_TOKEN") || "";
    const candidates = [refreshToken, envRefreshToken].filter((v, i, arr) => v && arr.indexOf(v) === i);
    let lastError = "";
    for (const candidate of candidates) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: Deno.env.get("SF_CLIENT_ID") || "",
        client_secret: Deno.env.get("SF_CLIENT_SECRET") || "",
        refresh_token: candidate,
      });
      const res = await fetch(SF_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      if (!res.ok) {
        lastError = tokenErrorMessage(res.status, await res.text());
        await noteRefreshError(s, lastError);
        continue;
      }
      const d = await res.json(); if (!d.access_token) throw new Error("No token");
      accessToken = d.access_token; tokenExpires = Date.now() + 50 * 60 * 1000;
      const u: any = {
        id: 1,
        access_token: d.access_token,
        access_expires_at: new Date(tokenExpires).toISOString(),
        updated_at: new Date().toISOString(),
        refresh_locked_until: null,
        refresh_lock_owner: null,
        last_refresh_error: null,
        last_refresh_error_at: null,
      };
      if (d.refresh_token) u.refresh_token = d.refresh_token;
      await writeTokenCache(s, u); return accessToken;
    }
    throw new Error(lastError || "SF token refresh failed");
  } finally {
    await releaseRefreshLock(s, owner);
  }
}
async function sfGet(s: any, ep: string): Promise<any> {
  const t = await sfToken(s);
  let r = await fetch(SF_API + ep, { headers: { Authorization: "Bearer " + t, Accept: "application/json" } });
  if (r.status === 401) { accessToken = ""; tokenExpires = 0; const t2 = await sfToken(s); r = await fetch(SF_API + ep, { headers: { Authorization: "Bearer " + t2, Accept: "application/json" } }); }
  if (!r.ok) throw new Error("SF " + r.status + " " + (await r.text()).slice(0, 150));
  const txt = await r.text(); return txt.trim() ? JSON.parse(txt) : {};
}

// ── SF admin portal (cookie) — for receipt URL discovery ──────────────────────
let cookieCache = "";
function buildCookie(r: any): string {
  const p: string[] = [];
  if (r.xsrf_token) p.push(`XSRF-TOKEN=${r.xsrf_token}`);
  if (r.servicefusion_session) p.push(`servicefusion_session=${r.servicefusion_session}`);
  if (r.session_token) p.push(`session_token=${r.session_token}`);
  if (r.phpsessid) p.push(`PHPSESSID=${r.phpsessid}`);
  if (r.remember_me_company) p.push(`remember_me_company=${r.remember_me_company}`);
  if (r.remember_me_user) p.push(`remember_me_user=${r.remember_me_user}`);
  if (r.remember_me_company_id) p.push(`remember_me_company_id=${r.remember_me_company_id}`);
  return p.join("; ");
}
async function refreshPortalCookie(s: any): Promise<string> {
  // The Make hook logs into SF and returns the cookie as "k=v;k=v;..." — it does
  // NOT write the DB, so we parse + persist it here.
  const res = await fetch(PORTAL_HOOK, { method: "GET", signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
  const raw = (await res.text()).trim();
  const pairs: Record<string, string> = {};
  for (const part of raw.split(";")) { const seg = part.trim(); const i = seg.indexOf("="); if (i > 0) { const k = seg.slice(0, i).trim(); if (!(k in pairs)) pairs[k] = seg.slice(i + 1).trim(); } }
  if (!pairs["servicefusion_session"] && !pairs["session_token"]) return cookieCache; // hook gave nothing usable
  const row: any = { id: 1, xsrf_token: pairs["XSRF-TOKEN"] || null, servicefusion_session: pairs["servicefusion_session"] || null, session_token: pairs["session_token"] || null, phpsessid: pairs["PHPSESSID"] || null, remember_me_company: pairs["remember_me_company"] || null, remember_me_user: pairs["remember_me_user"] || null, remember_me_company_id: pairs["remember_me_company_id"] || null, updated_at: new Date().toISOString() };
  try { await s.schema("orders").from("sf_portal_session").upsert(row); } catch (_e) { /* keep in-memory */ }
  cookieCache = buildCookie(row);
  return cookieCache;
}
async function getPortalCookie(s: any, force = false): Promise<string> {
  if (cookieCache && !force) return cookieCache;
  if (!force) {
    try { const { data } = await s.schema("orders").from("sf_portal_session").select("*").eq("id", 1).single(); if (data) { cookieCache = buildCookie(data); if (cookieCache) return cookieCache; } } catch (_e) { /* fall through */ }
  }
  return await refreshPortalCookie(s);
}
function looksLoggedOut(status: number, body: string): boolean {
  return status === 302 || status === 401 || status === 403 || /auth\.servicefusion\.com|name="password"/i.test(body);
}
// Admin request with one auto-refresh retry on a logged-out response.
async function adminReq(s: any, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  let cookie = await getPortalCookie(s);
  const doFetch = (c: string) => fetch(ADMIN_BASE + path, { ...init, headers: { ...(init?.headers || {}), Cookie: c }, redirect: "manual", signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS) });
  let r = await doFetch(cookie);
  let body = await r.text();
  if (looksLoggedOut(r.status, body)) { cookie = await getPortalCookie(s, true); r = await doFetch(cookie); body = await r.text(); }
  return { status: r.status, body };
}

// Resolve a SF job number to its admin-portal encrypted id (for deep links) and
// the receipt S3 URLs on its job page. encId is stable per job — store it so the
// UI can link straight to admin.servicefusion.com/jobs/jobView?id=<encId>.
async function resolveJobAssets(s: any, jobNumber: string): Promise<{ encId: string; urls: string[] }> {
  const tryQueries = [jobNumber, (jobNumber.match(/\d{3,}/) || [""])[0]].filter(Boolean);
  let enc = "";
  for (const q of tryQueries) {
    const gr = await adminReq(s, "/serviceSpot/loadGlobalSearchResults", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" }, body: "string=" + encodeURIComponent(q) });
    if (gr.status !== 200) continue;
    let obj: any = {}; try { obj = JSON.parse(gr.body); } catch { continue; }
    const wantDigits = jobNumber.replace(/[^0-9]/g, "");
    const results = (obj.results || []).filter((x: any) => String(x.type || "").toLowerCase() === "jobs" || x.id);
    const hit = results.find((x: any) => String(x.name || "").replace(/[^0-9]/g, "") === wantDigits) || results.find((x: any) => String(x.name || "").replace(/[^0-9]/g, "").includes(wantDigits)) || results[0];
    if (hit?.id) { enc = hit.id; break; }
  }
  if (!enc) return { encId: "", urls: [] };
  const jr = await adminReq(s, "/jobs/jobView?id=" + encodeURIComponent(enc));
  if (jr.status !== 200) return { encId: enc, urls: [] };
  const urls = [...new Set([...jr.body.matchAll(/https?:\/\/servicefusion\.s3\.amazonaws\.com\/userdocs\/\d+\/jobexpense\/[^\s"'<>\\)]+/gi)].map((m) => m[0]))];
  return { encId: enc, urls };
}

// SF's GET /jobs HANGS (20s..2min+) on any query that relies on its DEFAULT sort —
// an SF-side query-plan problem on our ~22k-row jobs table, first hit in brix-order
// (session 1.18). An EXPLICIT sort returns in under a second. The pageCount probe
// here carried no sort and was burning ~100s of the 150s request wall on its own,
// which is why sweeps kept dying before they could write their sync_log row.
//
// `sort=-id` means page 1 is the NEWEST page, so both sweep modes read forward:
// fresh takes pages 1..N, and the crawl walks 1,2,3... back through history and
// wraps when it runs dry. No pageCount probe is needed at all — an empty page IS
// the end. Note `per-page` is HYPHENATED; SF silently ignores `per_page` and falls
// back to its default page size (which is why a "50/page" sweep only ever saw ~10).
const JOB_LIST = "/jobs?filters[status]=Invoiced&sort=-id&per-page=50";
const jobListPath = (page: number) => `${JOB_LIST}&page=${page}`;

function receiptRefs(ex: any): string[] {
  const refOf = (v: any) => { if (!v) return null; if (typeof v === "string") return v; if (typeof v === "object") return v.file_location || v.url || v.receipt_url || v.path || v.location || null; return null; };
  const out: string[] = [];
  for (const k of ["receipt", "receipt_url", "file_location", "picture", "image", "photo"]) { const r = refOf(ex[k]); if (r) out.push(r); }
  return [...new Set(out)];
}
// SF writes the UNIX EPOCH ("1970-01-01...") — not null — into date fields it has
// no value for. An expense that has never been EDITED since it was created comes
// back with `updated_at: "1970-01-01T00:00:00+00:00"`, and `date` is epoch unless
// a human typed one in. The sweep's date gate used to read
// `ex.updated_at || ex.created_at`, so epoch won the `||` and every never-edited
// expense tested as 1970 < START_DATE and was silently skipped — i.e. the sweep
// only ever landed expenses somebody had gone back and edited. (SF job 1093536433,
// $650 Arturo.s d&a restaurant repair, was dropped on all 24 sweeps between
// 2026-07-28 and 2026-08-04 for exactly this reason.)
//
// So: ignore epoch values entirely and gate on the NEWEST real date we can find.
// An expense with no usable date at all returns null and is NOT skipped — landing
// a reviewable draft is always cheaper than silently losing a receipt.
const EPOCH_PREFIX = "1970-01-01";
function realDateMs(v: any): number | null {
  if (!v) return null;
  const str = String(v);
  if (str.startsWith(EPOCH_PREFIX)) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}
function newestRealDate(ex: any): number | null {
  const all = [ex.updated_at, ex.created_at, ex.date].map(realDateMs).filter((v): v is number => v !== null);
  return all.length ? Math.max(...all) : null;
}

function expenseKey(jobId: string | number, ex: any): string {
  if (ex.id) return String(ex.id);
  const v = (ex.purchased_from || ex.vendor_name || ex.vendor || "").toString().trim().toLowerCase();
  const amt = Number(ex.amount ?? ex.total ?? 0) || 0;
  return `sfjob:${jobId}:${v}:${amt}:${ex.created_at || ex.date || ""}`;
}

// Download a receipt (public S3 anon; portal cookie fallback) and attach it to a draft.
async function attachReceipt(s: any, reqId: string, url: string, idx: number): Promise<boolean> {
  let bytes: Uint8Array | null = null; let ct = "application/octet-stream";
  try {
    let rr = await fetch(url, { signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS) });
    if ((rr.status === 401 || rr.status === 403) && /servicefusion/i.test(url)) { const ck = await getPortalCookie(s); rr = await fetch(url, { headers: { Cookie: ck }, signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS) }); }
    if (rr.ok) { ct = rr.headers.get("content-type") || ct; bytes = new Uint8Array(await rr.arrayBuffer()); }
  } catch (_e) { /* skip */ }
  if (!bytes || !bytes.length) return false;
  const base = (url.split("/").pop() || `sf-receipt-${idx}`).split("?")[0];
  const ext = (base.includes(".") ? base.split(".").pop() : (ct.split("/")[1] || "pdf"))!.replace(/[^a-z0-9]/gi, "") || "pdf";
  const path = `${SUBMITTER_ID}/${reqId}/sf-receipt-${idx}.${ext}`;
  const up = await s.storage.from(ATTACH_BUCKET).upload(path, bytes, { contentType: ct, upsert: true });
  if (up.error) return false;
  await s.from("expense_request_attachments").insert({ request_id: reqId, file_name: base, file_type: ct, file_size: bytes.length, storage_path: path });
  return true;
}

async function logReceiptSync(s: any, started: string, status: "success" | "error", records: number, metadata: any, errorMessage: string | null = null): Promise<void> {
  try {
    await s.from("sync_log").insert({
      source: "sf-receipt-sync",
      sync_type: "receipts",
      status,
      records_synced: records,
      started_at: started,
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
      metadata,
    });
  } catch (_e) { /**/ }
}

// Every counter here exists so a silent drop can't happen again. The epoch bug
// was invisible for two months because the only number the sweep reported was
// `drafts` — and "drafts: 0" reads identically whether SF genuinely had nothing
// new or the gate was throwing away every expense it saw. So we now also count
// what we LOOKED at and what we THREW AWAY, and ops.fn_sync_health_extra() goes
// red when those disagree. Rule for anyone adding a future filter here: if you
// `continue`, increment a counter.
type LandStats = { landed: number; attached: number; seen: number; skippedByDate: number; skippedEmpty: number; dup: number; skipped?: string; timedOut?: boolean };

// SF happily stores a completely blank expense row (no vendor, no amount, no notes,
// no category) — they show up on ordinary delivery jobs and carry no information.
// The epoch bug used to hide them as a side effect; once the gate was fixed they
// arrived as ~14 empty drafts in the first sweep. Skip them, but COUNT them: a
// filter that drops rows without a number next to it is how this whole outage
// started. Blank vendor WITH an amount still lands (operators fill the vendor in
// later — see the dedup note in CLAUDE.md).
function isEmptyExpense(ex: any): boolean {
  const vendor = String(ex.purchased_from ?? ex.vendor_name ?? ex.vendor ?? "").trim();
  const amt = Number(ex.amount ?? ex.total ?? 0) || 0;
  const notes = String(ex.notes ?? "").trim();
  const category = String(ex.category ?? "").trim();
  return !vendor && amt === 0 && !notes && !category;
}

// `deadline` is an ABSOLUTE timestamp, checked per EXPENSE — not per job. Landing
// one expense costs an admin-portal scrape plus a receipt download, so a single
// multi-expense job can run well past a whole sweep's budget. Checking only
// between jobs (the original design) let one job overrun the 150s request wall,
// which kills the run before it writes its sync_log row and leaves the crawl
// cursor stuck. Bail mid-job instead and report it.
async function landJob(s: any, job: any, log: string[], opts: { gateByDate?: boolean; deadline?: number } = {}): Promise<LandStats> {
  let full = job;
  if (!Array.isArray(job.expenses)) { try { full = await sfGet(s, `/jobs/${job.id}?expand=expenses`); } catch { full = job; } }
  const expenses = Array.isArray(full.expenses) ? full.expenses : [];
  if (!expenses.length) return { landed: 0, attached: 0, seen: 0, skippedByDate: 0, skippedEmpty: 0, dup: 0, skipped: "no expenses" };
  const outOfTime = () => !!opts.deadline && Date.now() > opts.deadline;
  const startMs = Date.parse(START_DATE + "T00:00:00Z") || 0;
  const jobNumber = String(full.number || job.id);
  let landed = 0, attached = 0, skippedByDate = 0, skippedEmpty = 0, dupCount = 0, timedOut = false;
  const seen = expenses.length;
  // Resolve the admin encId + receipt URLs once per job, lazily (only when needed).
  let resolved: { encId: string; urls: string[] } | null = null;
  const resolve = async () => { if (resolved === null) { try { resolved = await resolveJobAssets(s, jobNumber); } catch (e: any) { resolved = { encId: "", urls: [] }; log.push(`recv ${jobNumber}: ${String(e.message).slice(0, 80)}`); } } return resolved; };

  for (const ex of expenses) {
    if (outOfTime()) { timedOut = true; log.push(`deadline mid-job ${jobNumber}`); break; }
    if (isEmptyExpense(ex)) { skippedEmpty++; continue; }
    const exKey = expenseKey(full.id || job.id, ex);
    if (opts.gateByDate) {
      const exDate = newestRealDate(ex);
      if (exDate && exDate < startMs) { skippedByDate++; continue; }
    }
    const { data: dup } = await s.from("expense_requests").select("id, sf_admin_job_id").eq("sf_expense_id", exKey).limit(1);

    let reqId: string | null = null;
    let hasEnc = false;
    if (dup && dup.length) {
      dupCount++;
      reqId = dup[0].id; hasEnc = !!dup[0].sf_admin_job_id; // already landed — backfill receipt/encId
    } else {
      const amt = Number(ex.amount ?? ex.total ?? 0) || 0;
      const acct = ACCOUNT_MAP[String(ex.category || "").toLowerCase()] || null;
      const vendor = ex.purchased_from || ex.vendor_name || ex.vendor || null;
      // Same epoch trap as the date gate — never stamp 1970 onto a draft.
      const rdate = realDateMs(ex.date) !== null
        ? String(ex.date).slice(0, 10)
        : (realDateMs(ex.created_at) !== null ? String(ex.created_at).slice(0, 10) : null);
      const { data: ins, error } = await s.from("expense_requests").insert({
        request_type: "expense", status: "draft", as_bill: true, tag: "Service Fusion",
        sf_expense_id: exKey, submitted_by: SUBMITTER_ID, submitter_name: "Service Fusion (system)",
        submitter_email: "skypace@brixbev.com",
        vendor_name: vendor, total_amount: amt || null, currency: "USD",
        receipt_date: rdate,
        line_items: [{ description: ex.notes || ex.category || "Service Fusion expense", qty: 1, unit_price: amt, amount: amt }],
        customer_name: full.customer_name || null,
        cogs_account_id: acct?.id || null, cogs_account_label: acct?.name || null,
        job_number: jobNumber,
        memo: `SF Job #${jobNumber}` + (vendor ? ` | ${vendor}` : "") + (ex.category ? ` | ${ex.category}` : ""),
        description: `Service Fusion job #${jobNumber} expense — review & submit`,
        qbo_bill_id: null,
      }).select("id").single();
      if (error) { log.push(`ins ${exKey}: ${error.message.slice(0, 120)}`); continue; }
      reqId = ins.id; landed++;
    }
    if (!reqId) continue;

    const { data: have } = await s.from("expense_request_attachments").select("id").eq("request_id", reqId).limit(1);
    const needReceipt = !(have && have.length);
    if (!needReceipt && hasEnc) continue; // nothing left to do for this draft

    // Resolve once: gives encId (for the deep link) + receipt URLs.
    const { encId, urls: portalUrls } = await resolve();

    // Stamp the admin encId so the UI can deep-link to the SF job page.
    if (!hasEnc && encId) { try { await s.from("expense_requests").update({ sf_admin_job_id: encId }).eq("id", reqId); } catch (_e) { /* non-fatal */ } }

    if (needReceipt) {
      let urls = receiptRefs(ex);
      if (!urls.length) urls = portalUrls;
      let i = 0;
      for (const u of urls) { if (await attachReceipt(s, reqId, u, i++)) attached++; }
    }
  }
  return { landed, attached, seen, skippedByDate, skippedEmpty, dup: dupCount, timedOut };
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const s = sb();
  const log: string[] = [];
  const started = new Date().toISOString();

  // ?raw=<id>&expand=... — dump a job's expand data (diagnostics).
  if (u.searchParams.get("raw")) {
    const id = u.searchParams.get("raw");
    const expand = u.searchParams.get("expand") || "expenses";
    const out: any = { id, expand };
    try { const full = await sfGet(s, `/jobs/${id}?expand=${encodeURIComponent(expand)}`); out.expandable = full._expandable ?? null; out.data = {}; for (const k of expand.split(",")) out.data[k] = full[k] ?? null; } catch (e: any) { out.err = e.message; }
    return json(out);
  }

  // ?receipts=<jobNumber> — diagnostics: resolve a job number to its admin encId + receipt URLs.
  if (u.searchParams.get("receipts")) {
    const num = u.searchParams.get("receipts")!;
    try { const { encId, urls } = await resolveJobAssets(s, num); return json({ job: num, encId, jobView: encId ? `${ADMIN_BASE}/jobs/jobView?id=${encId}` : null, urls }); } catch (e: any) { return json({ job: num, error: e.message }, 500); }
  }

  // ?refreshCookie=1 — force a portal-cookie refresh via the Make hook.
  if (u.searchParams.get("refreshCookie")) {
    try { const c = await getPortalCookie(s, true); return json({ refreshed: !!c, len: c.length }); } catch (e: any) { return json({ error: e.message }, 500); }
  }

  // ?landJob=<sfJobId> — land ONE job straight off its SF id. No page scanning,
  // so it returns in seconds instead of dying on the 150s edge wall clock the way
  // ?job=<number> does (that path walks up to 40 pages of the Invoiced list).
  // Use this to repair a single job an operator reports as missing; the date gate
  // is off, and the sf_expense_id dedup makes it safe to re-run.
  if (u.searchParams.get("landJob")) {
    const id = u.searchParams.get("landJob")!.trim();
    try {
      const full = await sfGet(s, `/jobs/${encodeURIComponent(id)}?expand=expenses`);
      const r = await landJob(s, full, log, { gateByDate: false });
      return json({ landJob: id, number: full.number ?? null, status: full.status ?? null, result: r, log });
    } catch (e: any) { return json({ landJob: id, error: e.message }, 500); }
  }

  // ?job=<number> — find & process one invoiced job by NUMBER (lands + attaches).
  // Prefer ?landJob=<sfJobId> when you have the id: it is a single GET. This path
  // has to scan because SF gives no working by-number lookup, but it now scans
  // newest-first with an explicit sort and a wall-clock cap, so it degrades into a
  // "not found in the last N pages" answer instead of a 504.
  if (u.searchParams.get("job")) {
    const target = u.searchParams.get("job")!.trim().toLowerCase();
    const scanStart = Date.now();
    try {
      let found = null; let scanned = 0;
      for (let p = 1; p <= 40 && !found; p++) {
        if (Date.now() - scanStart > 60000) break;
        const d = await sfGet(s, jobListPath(p));
        const items = d.items || [];
        scanned++;
        if (!items.length) break;
        found = items.find((j: any) => String(j.number || "").toLowerCase() === target) || null;
      }
      if (!found) return json({ job: target, found: false, pagesScanned: scanned, hint: "use ?landJob=<sfJobId> for an older job" });
      const r = await landJob(s, found, log, { gateByDate: false });
      return json({ job: target, id: found.id, number: found.number, status: found.status, result: r, log });
    } catch (e: any) { return json({ job: target, error: e.message }, 500); }
  }

  // Sweep modes: ?fresh=N (the N newest pages) or default crawl (walks back through
  // history from a stored cursor). Both now page NEWEST-FIRST — see JOB_LIST below.
  const freshParam = u.searchParams.get("fresh");
  const fresh = freshParam !== null;

  // Start the clock BEFORE the first SF call. It used to start after the pageCount
  // probe, so the probe's time was invisible to the budget — and that probe was the
  // whole problem (see JOB_LIST). A budget that doesn't cover every call it is
  // meant to bound is not a budget.
  const t0 = Date.now();

  let page = parseInt(u.searchParams.get("page") || "0");
  if (fresh || page === 0) {
    if (fresh) {
      page = 1;                       // page 1 IS the newest page now
    } else {
      const { data: last } = await s.from("sync_log").select("metadata").eq("source", "sf-receipt-sync").eq("status", "success").order("completed_at", { ascending: false }).limit(1);
      const lp = last?.[0]?.metadata?.next_page;
      page = (lp && lp >= 1) ? lp : 1;
    }
  }
  // crawl has no page span of its own — it runs until the budget or an empty page.
  const span = fresh ? Math.max(1, parseInt(freshParam || "3") || 3) : 0;
  let drafts = 0, attached = 0, jobsSeen = 0, detail = 0;
  let expensesSeen = 0, skippedByDate = 0, skippedEmpty = 0, alreadyLanded = 0;
  let ranDry = false;
  // The edge runtime hard-kills a request at 150s (504). The budget has to leave
  // room for the slowest single job still in flight (an admin-portal scrape plus
  // a receipt download runs 10-40s) AND the closing sync_log write — otherwise the
  // run is killed mid-flight, logs NOTHING, and the crawl cursor (which resumes
  // from the last success row's next_page) never advances. That is exactly what
  // happened to the daily 10:00 crawl: at 110s it never once logged a run between
  // 2026-07-26 and 2026-08-04, so it restarted from the newest page every day and
  // the historical backfill never moved. 60s + per-call network caps + a per-expense
  // deadline leave ~90s of headroom for whatever is still in flight.
  const budgetMs = 60000;
  let lastCompleted = page - 1; let budgetHit = false;
  let fatalError = "";
  try {
    for (let p = page; span === 0 || p < page + span; p++) {
      if (Date.now() - t0 > budgetMs) { budgetHit = true; log.push("time budget"); break; }
      const d = await sfGet(s, jobListPath(p));
      const jobs = d.items || [];
      if (!jobs.length) { ranDry = true; break; }   // walked off the end of history
      for (const j of jobs) {
        // Mid-page budget check: a page dense with expense jobs — each needing SF
        // detail calls + admin-portal receipt scrapes — could blow past the wall
        // clock inside a single page. Exiting here returns a LOGGED partial run;
        // the cursor stays on this page so the next run resumes where we stopped.
        if (Date.now() - t0 > budgetMs) { budgetHit = true; log.push(`time budget mid-page ${p}`); break; }
        jobsSeen++;
        if (!Array.isArray(j.expenses)) detail++;
        const r = await landJob(s, j, log, { gateByDate: true, deadline: t0 + budgetMs });
        drafts += r.landed; attached += r.attached;
        expensesSeen += r.seen; skippedByDate += r.skippedByDate; skippedEmpty += r.skippedEmpty; alreadyLanded += r.dup;
        if (r.timedOut) { budgetHit = true; break; }
      }
      if (budgetHit) break;
      lastCompleted = p;
    }
  } catch (e: any) { fatalError = e.message; log.push("FATAL " + fatalError); }
  // Crawl cursor walks FORWARD into history and wraps to page 1 when it runs dry.
  // Resume AFTER the last fully-processed page; if none completed, retry the same
  // page rather than stepping over it (a page that always times out must not be
  // silently skipped — that is how work disappears without an error).
  const nextPage = fresh ? null : (ranDry ? 1 : (lastCompleted >= page ? lastCompleted + 1 : page));
  const result: any = { ok: !fatalError, mode: fresh ? "fresh" : "crawl", fromPage: page, lastCompleted, ranDry, budgetHit, jobsSeen, detail, drafts, attached, expensesSeen, skippedByDate, skippedEmpty, alreadyLanded, elapsedMs: Date.now() - t0 };
  if (fatalError) result.error = fatalError;
  if (nextPage !== null) result.next_page = nextPage;
  await logReceiptSync(s, started, fatalError ? "error" : "success", drafts, { ...result, log: log.slice(0, 20) }, fatalError || null);
  return json({ ...result, log }, fatalError ? 500 : 200);
});
