// sf-receipt-sync — pull Service Fusion expense RECEIPTS into Brixpense as
// reviewable DRAFTS. Edge function (reliable + visible via ops.sync_log),
// driven by Supabase pg_cron. Reuses sync-sf's SF auth (ops.sf_token_cache —
// no token-rotation conflict). NOTHING posts to QBO; Brixpense posts on submit.
//
// SF has no "recently invoiced" query (no modified sort), so we page through
// status=Invoiced jobs (newest pages first), resuming via sync_log, and dedup
// by ops.expense_requests.sf_expense_id. Only jobs that actually have an
// expense with a receipt produce a draft.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SF_API = "https://api.servicefusion.com/v1";
const SF_TOKEN_URL = "https://api.servicefusion.com/oauth/access_token";
const ATTACH_BUCKET = "expense-attachments";
const SUBMITTER_ID = "2da634b7-623d-4f73-b667-cf87975fcdb6"; // skypace@brixbev.com (system)
const START_DATE = Deno.env.get("SF_SWEEP_START_DATE") || "2026-06-03";
const PAGES_PER_RUN = 8;
const MAX_DETAIL = 80;
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

function receiptRefs(ex: any): string[] {
  const refOf = (v: any) => { if (!v) return null; if (typeof v === "string") return v; if (typeof v === "object") return v.file_location || v.url || v.receipt_url || v.path || v.location || null; return null; };
  const out: string[] = [];
  for (const k of ["receipt", "receipt_url", "file_location", "picture", "image", "photo"]) { const r = refOf(ex[k]); if (r) out.push(r); }
  for (const k of ["receipts", "pictures", "images", "attachments", "documents", "files"]) { if (Array.isArray(ex[k])) for (const it of ex[k]) { const r = refOf(it); if (r) out.push(r); } }
  return [...new Set(out)];
}

// Synthetic stable key for an expense that has no SF id (SF's jobs API does not
// expose an expense id). job + vendor + amount + created_at is stable per WO.
function expenseKey(jobId: string | number, ex: any): string {
  if (ex.id) return String(ex.id);
  const v = (ex.purchased_from || ex.vendor_name || ex.vendor || "").toString().trim().toLowerCase();
  const amt = Number(ex.amount ?? ex.total ?? 0) || 0;
  return `sfjob:${jobId}:${v}:${amt}:${ex.created_at || ex.date || ""}`;
}

async function landJob(s: any, job: any, log: string[], opts: { gateByDate?: boolean } = {}): Promise<{ landed: number; attached: number; skipped?: string }> {
  let full = job;
  if (!Array.isArray(job.expenses)) { try { full = await sfGet(s, `/jobs/${job.id}?expand=expenses`); } catch { full = job; } }
  const expenses = Array.isArray(full.expenses) ? full.expenses : [];
  if (!expenses.length) return { landed: 0, attached: 0, skipped: "no expenses" };
  const startMs = Date.parse(START_DATE + "T00:00:00Z") || 0;
  let landed = 0, attached = 0;
  for (const ex of expenses) {
    const exKey = expenseKey(full.id || job.id, ex);
    // Gate (sweep mode only): an expense first seen/updated after START_DATE.
    // SF's "date" is often epoch 1970; updated_at reflects the invoiced touch.
    if (opts.gateByDate) {
      const exDate = ex.updated_at || ex.created_at || null;
      if (exDate && Date.parse(exDate) < startMs) continue;
    }
    const { data: dup } = await s.from("expense_requests").select("id").eq("sf_expense_id", exKey).limit(1);
    if (dup && dup.length) continue;

    // Receipt bytes: the expense object carries no file ref, so try any explicit
    // ref (rare), then fall back to a job picture/document (public-S3 fetchable).
    let bytes: Uint8Array | null = null; let ct = "application/octet-stream"; let recName = "";
    const refs = receiptRefs(ex);
    let url = refs[0] || null;
    if (!url) {
      try {
        const withPics = Array.isArray(full.pictures) ? full : await sfGet(s, `/jobs/${full.id || job.id}?expand=pictures,documents`);
        const cand = (withPics.documents || []).concat(withPics.pictures || [])
          .find((p: any) => !p?.is_private && (p?.file_location || p?.url));
        if (cand) { url = cand.file_location || cand.url; recName = cand.name || ""; }
      } catch (_e) { /* none */ }
    }
    if (url) {
      try {
        let rr = await fetch(url);
        if ((rr.status === 401 || rr.status === 403) && /servicefusion/i.test(url)) { const t = await sfToken(s); rr = await fetch(url, { headers: { Authorization: "Bearer " + t } }); }
        if (rr.ok) { ct = rr.headers.get("content-type") || ct; bytes = new Uint8Array(await rr.arrayBuffer()); }
      } catch (_e) { /* land without image */ }
    }

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
      job_number: String(full.number || job.id),
      memo: `SF Job #${full.number || job.id}` + (vendor ? ` | ${vendor}` : "") + (ex.category ? ` | ${ex.category}` : ""),
      description: `Service Fusion job #${full.number || job.id} expense — review & submit`,
      qbo_bill_id: null,
    }).select("id").single();
    if (error) { log.push(`ins ${exKey}: ${error.message.slice(0, 120)}`); continue; }
    landed++;
    const reqId = ins.id;
    if (bytes && reqId) {
      try {
        const ext = ((ct.split("/")[1] || (recName.split(".").pop() || "pdf"))).replace(/[^a-z0-9]/gi, "") || "pdf";
        const path = `${SUBMITTER_ID}/${reqId}/sf-receipt.${ext}`;
        const up = await s.storage.from(ATTACH_BUCKET).upload(path, bytes, { contentType: ct, upsert: true });
        if (!up.error) { await s.from("expense_request_attachments").insert({ request_id: reqId, file_name: recName || `sf-receipt.${ext}`, file_type: ct, file_size: bytes.length, storage_path: path }); attached++; }
      } catch (_e) { /* draft already landed */ }
    }
  }
  return { landed, attached };
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const s = sb();
  const log: string[] = [];

  // ?raw=<id> — dump a job's raw expenses (expand) + the /jobs/<id>/expenses
  // sub-resource, to find where SF actually stores the expense/receipt.
  if (u.searchParams.get("raw")) {
    const id = u.searchParams.get("raw");
    const expand = u.searchParams.get("expand") || "expenses";
    const out: any = { id, expand };
    try {
      const full = await sfGet(s, `/jobs/${id}?expand=${encodeURIComponent(expand)}`);
      out.expandable = full._expandable ?? null;
      out.data = {};
      for (const k of expand.split(",")) out.data[k] = full[k] ?? null;
    } catch (e: any) { out.err = e.message; }
    return json(out);
  }

  // ?job=<number> — find & process one invoiced job by number (pages the
  // invoiced list; for diagnosing a specific WO like M-57240-PMS).
  if (u.searchParams.get("job")) {
    const target = u.searchParams.get("job")!.trim().toLowerCase();
    try {
      const meta = (await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=1`))._meta || {};
      const pageCount = meta.pageCount || 1;
      let found = null; const scan: number[] = [];
      // scan from newest invoiced (last page) backward a bounded number of pages
      for (let p = pageCount; p >= Math.max(1, pageCount - 40) && !found; p--) {
        const d = await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=50&page=${p}`);
        const jobs = d.items || [];
        scan.push(p);
        found = jobs.find((j: any) => String(j.number || "").toLowerCase() === target) || null;
      }
      if (!found) return json({ job: target, found: false, pagesScanned: scan.length, pageCount });
      const r = await landJob(s, found, log, { gateByDate: false });
      return json({ job: target, id: found.id, number: found.number, status: found.status, result: r, log });
    } catch (e: any) { return json({ job: target, error: e.message }, 500); }
  }

  // Sweep modes:
  //   ?fresh=N  → always scan the NEWEST N pages (default 3), full detail,
  //               no resume cursor. For go-forward: new invoices land fast.
  //   (default) → resume-crawl newest→oldest via sync_log (history backfill).
  const started = new Date().toISOString();
  const freshParam = u.searchParams.get("fresh");
  const fresh = freshParam !== null;
  let meta: any = {};
  try { meta = (await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=1`))._meta || {}; } catch (e: any) { return json({ error: "SF: " + e.message }, 500); }
  const pageCount = meta.pageCount || 1;

  let page = parseInt(u.searchParams.get("page") || "0");
  if (fresh) {
    page = pageCount; // newest invoiced jobs live on the last page
  } else if (page === 0) {
    const { data: last } = await s.from("sync_log").select("metadata").eq("source", "sf-receipt-sync").eq("status", "ok").order("completed_at", { ascending: false }).limit(1);
    const lp = last?.[0]?.metadata?.next_page;
    page = (lp && lp >= 1) ? lp : pageCount; // start newest, walk down
  }
  // fresh: bounded N-page window. crawl: time-bounded — walk down until budget.
  const span = fresh ? Math.max(1, parseInt(freshParam || "3") || 3) : page;
  let drafts = 0, attached = 0, jobsSeen = 0, detail = 0;
  const lo = Math.max(1, page - span + 1);
  const budgetMs = 110000; const t0 = Date.now();
  let lastCompleted = page + 1; // pages strictly above `page` are "done" already
  let budgetHit = false;
  try {
    for (let p = page; p >= lo; p--) {
      // Stop BEFORE a page we can't be sure to finish, so the cursor never
      // advances past jobs we didn't detail-check (no silent skips).
      if (Date.now() - t0 > budgetMs) { budgetHit = true; log.push("time budget"); break; }
      const d = await sfGet(s, `/jobs?filters[status]=Invoiced&per_page=50&page=${p}`);
      const jobs = d.items || [];
      for (const j of jobs) {
        jobsSeen++;
        if (!Array.isArray(j.expenses)) detail++;
        const r = await landJob(s, j, log, { gateByDate: true });
        drafts += r.landed; attached += r.attached;
      }
      lastCompleted = p; // this page fully processed
    }
  } catch (e: any) { log.push("FATAL " + e.message); }
  // Cursor (crawl only): resume just below the last fully-processed page; wrap to
  // the top once page 1 is done. fresh mode never moves the cursor.
  const nextPage = fresh ? null : (lastCompleted <= 1 ? pageCount : lastCompleted - 1);
  const result: any = { ok: true, mode: fresh ? "fresh" : "crawl", pageCount, fromPage: page, lastCompleted, budgetHit, jobsSeen, detail, drafts, attached };
  if (nextPage !== null) result.next_page = nextPage;
  try { await s.from("sync_log").insert({ source: "sf-receipt-sync", sync_type: "receipts", status: "ok", records_synced: drafts, started_at: started, completed_at: new Date().toISOString(), metadata: { ...result, log: log.slice(0, 20) } }); } catch (_e) { /**/ }
  return json({ ...result, log });
});
