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
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SF_API = "https://api.servicefusion.com/v1";
const SF_TOKEN_URL = "https://api.servicefusion.com/oauth/access_token";
const ADMIN_BASE = "https://admin.servicefusion.com";
const PORTAL_HOOK = Deno.env.get("SF_PORTAL_REFRESH_HOOK") || "https://hook.us1.make.celonis.com/l9jobjd5bx7gob8icc06ncv981anl4ki";
const ATTACH_BUCKET = "expense-attachments";
const SUBMITTER_ID = "2da634b7-623d-4f73-b667-cf87975fcdb6"; // skypace@brixbev.com (system)
const START_DATE = Deno.env.get("SF_SWEEP_START_DATE") || "2026-06-03";
const PAGES_PER_RUN = 8;
const ACCOUNT_MAP: Record<string, { id: string; name: string }> = {
  equipment: { id: "42", name: "Equipment Sales COGS" },
  service: { id: "101", name: "Service COGS" },
};

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { db: { schema: "ops" } });
}
function json(d: any, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json" } }); }

let accessToken = ""; let tokenExpires = 0;
async function sfToken(s: any): Promise<string> {
  if (accessToken && tokenExpires > Date.now()) return accessToken;
  const { data: c } = await s.from("sf_token_cache").select("*").eq("id", 1).single();
  if (c?.access_token && new Date(c.access_expires_at).getTime() > Date.now()) { accessToken = c.access_token; tokenExpires = new Date(c.access_expires_at).getTime(); return accessToken; }
  const rt = c?.refresh_token || Deno.env.get("SF_REFRESH_TOKEN") || "";
  if (!rt) throw new Error("No SF refresh token");
  const res = await fetch(SF_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&client_id=" + (Deno.env.get("SF_CLIENT_ID") || "") + "&client_secret=" + (Deno.env.get("SF_CLIENT_SECRET") || "") + "&refresh_token=" + rt });
  if (!res.ok) throw new Error("SF token fail " + res.status);
  const d = await res.json(); if (!d.access_token) throw new Error("No token");
  accessToken = d.access_token; tokenExpires = Date.now() + 50 * 60 * 1000;
  const u: any = { id: 1, access_token: d.access_token, access_expires_at: new Date(tokenExpires).toISOString(), updated_at: new Date().toISOString() };
  if (d.refresh_token) u.refresh_token = d.refresh_token;
  await s.from("sf_token_cache").upsert(u); return accessToken;
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
  const res = await fetch(PORTAL_HOOK, { method: "GET" });
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
  const doFetch = (c: string) => fetch(ADMIN_BASE + path, { ...init, headers: { ...(init?.headers || {}), Cookie: c }, redirect: "manual" });
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

function receiptRefs(ex: any): string[] {
  const refOf = (v: any) => { if (!v) return null; if (typeof v === "string") return v; if (typeof v === "object") return v.file_location || v.url || v.receipt_url || v.path || v.location || null; return null; };
  const out: string[] = [];
  for (const k of ["receipt", "receipt_url", "file_location", "picture", "image", "photo"]) { const r = refOf(ex[k]); if (r) out.push(r); }
  return [...new Set(out)];
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
    let rr = await fetch(url);
    if ((rr.status === 401 || rr.status === 403) && /servicefusion/i.test(url)) { const ck = await getPortalCookie(s); rr = await fetch(url, { headers: { Cookie: ck } }); }
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

async function landJob(s: any, job: any, log: string[], opts: { gateByDate?: boolean } = {}): Promise<{ landed: number; attached: number; skipped?: string }> {
  let full = job;
  if (!Array.isArray(job.expenses)) { try { full = await sfGet(s, `/jobs/${job.id}?expand=expenses`); } catch { full = job; } }
  const expenses = Array.isArray(full.expenses) ? full.expenses : [];
  if (!expenses.length) return { landed: 0, attached: 0, skipped: "no expenses" };
  const startMs = Date.parse(START_DATE + "T00:00:00Z") || 0;
  const jobNumber = String(full.number || job.id);
  let landed = 0, attached = 0;
  // Resolve the admin encId + receipt URLs once per job, lazily (only when needed).
  let resolved: { encId: string; urls: string[] } | null = null;
  const resolve = async () => { if (resolved === null) { try { resolved = await resolveJobAssets(s, jobNumber); } catch (e: any) { resolved = { encId: "", urls: [] }; log.push(`recv ${jobNumber}: ${String(e.message).slice(0, 80)}`); } } return resolved; };

  for (const ex of expenses) {
    const exKey = expenseKey(full.id || job.id, ex);
    if (opts.gateByDate) {
      const exDate = ex.updated_at || ex.created_at || null;
      if (exDate && Date.parse(exDate) < startMs) continue;
    }
    const { data: dup } = await s.from("expense_requests").select("id, sf_admin_job_id").eq("sf_expense_id", exKey).limit(1);

    let reqId: string | null = null;
    let hasEnc = false;
    if (dup && dup.length) {
      reqId = dup[0].id; hasEnc = !!dup[0].sf_admin_job_id; // already landed — backfill receipt/encId
    } else {
      const amt = Number(ex.amount ?? ex.total ?? 0) || 0;
      const acct = ACCOUNT_MAP[String(ex.category || "").toLowerCase()] || null;
      const vendor = ex.purchased_from || ex.vendor_name || ex.vendor || null;
      const rdate = (ex.date && ex.date !== "1970-01-01") ? ex.date : (ex.created_at ? String(ex.created_at).slice(0, 10) : null);
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
  return { landed, attached };
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const s = sb();
  const log: string[] = [];

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

  // ?job=<number> — find & process one invoiced job by number (lands + attaches).
  if (u.searchParams.get("job")) {
    const target = u.searchParams.get("job")!.trim().toLowerCase();
    try {
      const meta = (await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=1`))._meta || {};
      const pageCount = meta.pageCount || 1;
      let found = null; let scanned = 0;
      for (let p = pageCount; p >= Math.max(1, pageCount - 40) && !found; p--) {
        const d = await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=50&page=${p}`);
        scanned++;
        found = (d.items || []).find((j: any) => String(j.number || "").toLowerCase() === target) || null;
      }
      if (!found) return json({ job: target, found: false, pagesScanned: scanned, pageCount });
      const r = await landJob(s, found, log, { gateByDate: false });
      return json({ job: target, id: found.id, number: found.number, status: found.status, result: r, log });
    } catch (e: any) { return json({ job: target, error: e.message }, 500); }
  }

  // Sweep modes: ?fresh=N (newest N pages, fast) or default crawl (time-bounded,
  // cursor only advances past fully-processed pages — no silent skips).
  const started = new Date().toISOString();
  const freshParam = u.searchParams.get("fresh");
  const fresh = freshParam !== null;
  let meta: any = {};
  try { meta = (await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=1`))._meta || {}; } catch (e: any) { return json({ error: "SF: " + e.message }, 500); }
  const pageCount = meta.pageCount || 1;

  let page = parseInt(u.searchParams.get("page") || "0");
  if (fresh) {
    page = pageCount;
  } else if (page === 0) {
    const { data: last } = await s.from("sync_log").select("metadata").eq("source", "sf-receipt-sync").eq("status", "ok").order("completed_at", { ascending: false }).limit(1);
    const lp = last?.[0]?.metadata?.next_page;
    page = (lp && lp >= 1) ? lp : pageCount;
  }
  const span = fresh ? Math.max(1, parseInt(freshParam || "3") || 3) : page;
  let drafts = 0, attached = 0, jobsSeen = 0, detail = 0;
  const lo = Math.max(1, page - span + 1);
  const budgetMs = 110000; const t0 = Date.now();
  let lastCompleted = page + 1; let budgetHit = false;
  try {
    for (let p = page; p >= lo; p--) {
      if (Date.now() - t0 > budgetMs) { budgetHit = true; log.push("time budget"); break; }
      const d = await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=50&page=${p}`);
      const jobs = d.items || [];
      for (const j of jobs) {
        jobsSeen++;
        if (!Array.isArray(j.expenses)) detail++;
        const r = await landJob(s, j, log, { gateByDate: true });
        drafts += r.landed; attached += r.attached;
      }
      lastCompleted = p;
    }
  } catch (e: any) { log.push("FATAL " + e.message); }
  const nextPage = fresh ? null : (lastCompleted <= 1 ? pageCount : lastCompleted - 1);
  const result: any = { ok: true, mode: fresh ? "fresh" : "crawl", pageCount, fromPage: page, lastCompleted, budgetHit, jobsSeen, detail, drafts, attached };
  if (nextPage !== null) result.next_page = nextPage;
  try { await s.from("sync_log").insert({ source: "sf-receipt-sync", sync_type: "receipts", status: "ok", records_synced: drafts, started_at: started, completed_at: new Date().toISOString(), metadata: { ...result, log: log.slice(0, 20) } }); } catch (_e) { /**/ }
  return json({ ...result, log });
});
