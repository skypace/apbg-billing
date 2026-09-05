// qbo-service-invoice v2 — turn a completed BrixSD order into a QuickBooks Invoice.
//
// The last link in the dispatch chain. Lives here (apbg-billing) because QBO
// token management lives here and nothing else may talk to Intuit directly —
// same boundary as qbo-charge / qbo-return-order / qbo-cylinder-audit.
//
// ⚠ THE CALLER DOES NOT SEND LINES. It sends an order id, and this function
// reads the order and its lines from the database itself. That is not
// tidiness: Sky's rule (2026-09-05) is that an order becomes an invoice "only
// when it's invoiced on the handheld or when create invoice is selected", and
// that rule is enforced by dispatch.fn_order_request_invoice() plus a trigger.
// A function that accepted arbitrary lines would be a THIRD door, straight
// past the gate. So the gate is re-checked here as well as in the database.
//
// Modes (body.mode):
//   "preview" — read-only. Returns the exact Invoice payload "create" would
//               POST, plus what it found to attach. Touches nothing.
//   "create"  — posts the Invoice, stamps the order, mirrors it into ops so
//               the portal sees it immediately, then uploads the signature and
//               photos as QBO Attachables.
//
// Requires header x-internal-secret == INTERNAL_PAY_SECRET. verify_jwt=false;
// security is the internal secret + QBO OAuth.
//
// v2: loadMedia() surfaces read failures instead of degrading to an empty list.
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

const MAX_LINES = 60;
const MAX_DOCNUMBER = 21;          // QuickBooks' own limit
const MEDIA_BUCKET = "job-media";
const MAX_ATTACH_FILES = 8;
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const VERSION = "qbo-service-invoice@v2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*, authorization, content-type, apikey, x-internal-secret",
};

const getRealm = () => Deno.env.get("QBO_REALM_ID") || "";
const isSandbox = () => (Deno.env.get("QBO_ENVIRONMENT") ?? "production") === "sandbox";
const acctBase = () =>
  isSandbox() ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";

function sbFor(schema?: string): SupabaseClient {
  // ⚠ createClient defaults the data client to `public`. Everything we touch is
  // in `dispatch` or `ops`, and a wrong-schema write silently no-ops.
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false }, ...(schema ? { db: { schema } } : {}) },
  );
}
const jsonRes = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── QBO token: the shared lease/refresh pattern ──────────────────────────────
async function claimRefresh(sb: SupabaseClient) {
  const { data, error } = await sb.rpc("qbo_token_claim_refresh", {
    p_realm_id: getRealm(), p_min_ttl_seconds: REFRESH_MIN_REMAINING_SECONDS, p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error("claim_refresh RPC failed: " + error.message);
  return Array.isArray(data) ? data[0] : data;
}
async function intuitRefresh(refreshToken: string) {
  const id = Deno.env.get("QBO_CLIENT_ID") || "", secret = Deno.env.get("QBO_CLIENT_SECRET") || "";
  if (!id || !secret) throw new Error("missing QBO creds");
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json",
      Authorization: "Basic " + btoa(id + ":" + secret),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("intuit refresh failed (" + res.status + "): " + JSON.stringify(data));
  return data;
}
async function getAccessToken(sb: SupabaseClient): Promise<string> {
  for (let i = 0; i < LEASE_POLL_MAX_ATTEMPTS; i++) {
    const claim = await claimRefresh(sb);
    if (!claim.must_refresh && claim.cached_access_token) return claim.cached_access_token;
    if (claim.lease_acquired) {
      const seed = claim.cached_refresh_token || Deno.env.get("QBO_REFRESH_TOKEN") || "";
      if (!seed) {
        await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: "no refresh token" });
        throw new Error("no refresh token available");
      }
      try {
        const fresh = await intuitRefresh(seed);
        const { error } = await sb.rpc("qbo_token_persist", {
          p_realm_id: getRealm(), p_access_token: fresh.access_token,
          p_access_expires: new Date(Date.now() + (fresh.expires_in || ACCESS_TOKEN_TTL_SECONDS) * 1000).toISOString(),
          p_refresh_token: fresh.refresh_token,
          p_refresh_expires: new Date(Date.now() + (fresh.x_refresh_token_expires_in ?? REFRESH_TOKEN_TTL_SECONDS) * 1000).toISOString(),
          p_refreshed_by: VERSION,
        });
        if (error) throw new Error("token_persist RPC failed: " + error.message);
        return fresh.access_token;
      } catch (err) {
        await sb.rpc("qbo_token_release_failed", { p_realm_id: getRealm(), p_error: String((err as Error).message).slice(0, 500) });
        throw err;
      }
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }
  throw new Error("timed out waiting for QBO refresh lease");
}

// ── QBO Accounting v3 ────────────────────────────────────────────────────────
async function acctPost(token: string, path: string, body: any) {
  const url = acctBase() + "/v3/company/" + getRealm() + path + (path.includes("?") ? "&" : "?") + "minorversion=70";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("QBO POST " + path + " (" + res.status + "): " + (await res.text()).slice(0, 600));
  return res.json();
}
async function acctQuery(token: string, query: string) {
  const url = acctBase() + "/v3/company/" + getRealm() + "/query?minorversion=70&query=" + encodeURIComponent(query);
  const res = await fetch(url, { method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!res.ok) throw new Error("QBO query (" + res.status + "): " + (await res.text()).slice(0, 400));
  return res.json();
}

// ── the invoice payload, built from what the database says ───────────────────
function buildInvoice(order: any, lines: any[], mediaCount: number) {
  const qboLines = lines.map((l) => {
    const qty = Number(l.qty ?? 1);
    const unit = Number(l.unit_price ?? 0);
    const amount = l.amount != null ? Number(l.amount) : Math.round(qty * unit * 100) / 100;
    return {
      DetailType: "SalesItemLineDetail",
      Amount: amount,
      Description: String(l.description || "").slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: String(l.qbo_item_id) },
        Qty: qty,
        UnitPrice: unit,
      },
    };
  });

  const note = [
    `BrixSD order ${order.order_number || order.id}`,
    order.po_number ? `PO ${order.po_number}` : null,
    `sent for invoicing from the ${order.invoice_source === "handheld" ? "handheld" : "back office"} by ${order.invoice_requested_by || "unknown"}`,
    // ⚠ Say the evidence exists even when the upload later fails. The note is
    // written in the same call that posts the invoice; the attachments are a
    // second round trip that can fail on its own.
    mediaCount ? `${mediaCount} signature/photo file(s) attached` : "no signature or photos on file",
  ].filter(Boolean).join(" · ");

  const payload: any = {
    CustomerRef: { value: String(order.qbo_customer_id) },
    Line: qboLines,
    PrivateNote: note.slice(0, 4000),
    TxnDate: (order.fulfilled_at || order.invoice_requested_at || new Date().toISOString()).slice(0, 10),
  };
  if (order.order_number) payload.DocNumber = String(order.order_number).slice(0, MAX_DOCNUMBER);
  return payload;
}

// ── evidence: the signature and the technician's photos ──────────────────────
async function loadMedia(dsp: SupabaseClient, orderId: string) {
  // ⚠ These reads THROW on failure rather than degrading to an empty list, and
  // that is deliberate. supabase-js returns an error object instead of
  // throwing, so a swallowed failure here would post an invoice whose note
  // reads "no signature or photos on file" while the signature sat in the
  // bucket — a silent read failure that changes what a document SAYS. It
  // nearly happened: service_role had no grant on either table until
  // migration 20260905i.
  const { data: jobs, error: jErr } = await dsp.from("jobs")
    .select("id").eq("dispatch_order_id", orderId);
  if (jErr) throw new Error("could not read this order's jobs: " + jErr.message);
  const ids = (jobs || []).map((j: any) => j.id);
  if (!ids.length) return [];
  const { data, error: mErr } = await dsp.from("job_media")
    .select("id,kind,storage_key,caption,captured_at")
    .in("job_id", ids)
    // signature first: it is the one a bookkeeper actually opens
    .order("kind", { ascending: true }).order("captured_at", { ascending: true })
    .limit(MAX_ATTACH_FILES);
  if (mErr) throw new Error("could not read this order's signature and photos: " + mErr.message);
  return data || [];
}

async function attachMedia(token: string, invoiceId: string, media: any[]) {
  const out = { attached: 0, skipped: 0, errors: [] as string[] };
  const base = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  for (const [i, m] of media.entries()) {
    try {
      const fileRes = await fetch(`${base}/storage/v1/object/${MEDIA_BUCKET}/${m.storage_key}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!fileRes.ok) { out.errors.push(`${m.storage_key}: storage ${fileRes.status}`); continue; }
      const bytes = await fileRes.arrayBuffer();
      if (!bytes.byteLength) { out.skipped++; continue; }
      if (bytes.byteLength > MAX_ATTACH_BYTES) { out.skipped++; out.errors.push(`${m.storage_key}: too large`); continue; }

      const ext = (m.storage_key.split(".").pop() || "jpg").toLowerCase();
      const contentType = ext === "png" ? "image/png" : ext === "pdf" ? "application/pdf"
        : ext === "webp" ? "image/webp" : "image/jpeg";
      const fileName = `${m.kind}-${i + 1}.${ext}`.replace(/[^\w.\- ]/g, "_");
      const metadata = {
        AttachableRef: [{ EntityRef: { type: "Invoice", value: String(invoiceId) }, IncludeOnSend: false }],
        FileName: fileName, ContentType: contentType,
      };
      const fd = new FormData();
      fd.append("file_metadata_01", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
      fd.append("file_content_01", new Blob([bytes], { type: contentType }), fileName);
      const up = await fetch(`${acctBase()}/v3/company/${getRealm()}/upload`, {
        method: "POST", headers: { Authorization: "Bearer " + token, Accept: "application/json" }, body: fd,
      });
      const text = await up.text();
      if (!up.ok) { out.errors.push(`${fileName}: upload ${up.status} ${text.slice(0, 120)}`); continue; }
      // ⚠ QBO answers 200 with a per-file response that can still carry a Fault.
      if (/"Fault"/.test(text) && !/"Attachable"/.test(text)) { out.errors.push(`${fileName}: fault ${text.slice(0, 120)}`); continue; }
      out.attached++;
    } catch (e) {
      out.errors.push(`${m.storage_key}: ${String((e as Error).message).slice(0, 120)}`);
    }
  }
  return out;
}

// ── instant mirror, so the portal shows the invoice without waiting for sync ──
async function mirror(txn: any) {
  try {
    const ops = sbFor("ops");
    const header = {
      qbo_invoice_id: txn.Id, txn_type: "Invoice", doc_number: txn.DocNumber || null,
      txn_date: txn.TxnDate, due_date: txn.DueDate || null,
      customer_ref_id: txn.CustomerRef?.value || null, customer_name: txn.CustomerRef?.name || null,
      total_amount: parseFloat(txn.TotalAmt) || 0, balance: parseFloat(txn.Balance ?? 0) || 0,
      status: (parseFloat(txn.Balance ?? 0) || 0) === 0 ? "paid" : "open",
      department: txn.DepartmentRef?.name || null, memo: txn.PrivateNote || null,
      synced_at: new Date().toISOString(), qbo_updated_at: txn.MetaData?.LastUpdatedTime || null,
    };
    const { error } = await ops.from("qbo_invoices").upsert([header], { onConflict: "qbo_invoice_id,txn_type" });
    if (error) throw new Error(error.message);
    return { mirrored: true, error: null as string | null };
  } catch (e) {
    // Non-fatal: the periodic sync-qbo run mirrors invoices anyway.
    console.error("mirror failed:", e);
    return { mirrored: false, error: String((e as Error).message) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonRes({ ok: false, error: "POST required" }, 405);

  const sb = sbFor();
  const dsp = sbFor("dispatch");
  let orderId = "";
  try {
    if (!getRealm()) throw new Error("Missing QBO_REALM_ID");
    const secret = Deno.env.get("INTERNAL_PAY_SECRET") || "";
    if (!secret || (req.headers.get("x-internal-secret") || "") !== secret) {
      return jsonRes({ ok: false, error: "unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const mode = body?.mode === "create" ? "create" : "preview";
    orderId = String(body?.order_id || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new Error("bad order_id");

    const { data: order, error: oErr } = await dsp.from("orders").select("*").eq("id", orderId).maybeSingle();
    if (oErr) throw new Error("order read failed: " + oErr.message);
    if (!order) throw new Error("no such order");

    // ── the gate, re-checked here. The database enforces it too; this returns
    //    a sentence a person can act on instead of a constraint violation.
    if (!order.invoice_requested_at) {
      return jsonRes({
        ok: false, error: "not_sent_for_invoicing",
        message: "This order has not been sent for invoicing. Mark it invoiced on the handheld, or select Create invoice.",
      }, 409);
    }
    if (order.qbo_invoice_id) {
      return jsonRes({ ok: true, already: true, qbo_invoice_id: order.qbo_invoice_id,
        message: `Already invoiced in QuickBooks as ${order.qbo_invoice_id}.` });
    }
    if (order.state === "cancelled") throw new Error("this order is cancelled");
    if (!order.qbo_customer_id) throw new Error("this order has no QuickBooks customer");

    const { data: lines, error: lErr } = await dsp.from("order_lines")
      .select("*").eq("order_id", orderId).order("sort").order("created_at");
    if (lErr) throw new Error("line read failed: " + lErr.message);
    if (!lines || !lines.length) throw new Error("this order has no lines");
    if (lines.length > MAX_LINES) throw new Error(`too many lines (${lines.length})`);

    // ⚠ Refuse the whole invoice rather than post a partial one. An invoice
    // missing a line is far worse than an invoice that did not go out: the
    // second is visible, the first gets paid and nobody notices.
    const unmapped = lines.filter((l: any) => !l.qbo_item_id);
    if (unmapped.length) {
      return jsonRes({
        ok: false, error: "unmapped_lines",
        message: `${unmapped.length} line(s) are not linked to a QuickBooks item, so the invoice would be short. Link them first.`,
        lines: unmapped.map((l: any) => l.description),
      }, 409);
    }

    const media = await loadMedia(dsp, orderId);
    const payload = buildInvoice(order, lines, media.length);

    if (mode === "preview") {
      return jsonRes({
        ok: true, mode: "preview", order_number: order.order_number,
        would_post: payload,
        would_attach: media.map((m: any) => ({ kind: m.kind, file: m.storage_key })),
        total_from_lines: payload.Line.reduce((s: number, l: any) => s + l.Amount, 0),
        order_total: order.total,
      });
    }

    const token = await getAccessToken(sb);

    // ⚠ Before posting, look for an invoice already carrying this DocNumber.
    // The dangerous case is a create that succeeded at Intuit and timed out on
    // our side: a blind retry would bill the customer twice. Link instead.
    if (payload.DocNumber) {
      const esc = String(payload.DocNumber).replace(/'/g, "''");
      const found = await acctQuery(token, `select Id, DocNumber, TotalAmt from Invoice where DocNumber = '${esc}'`)
        .catch(() => null);
      const hit = found?.QueryResponse?.Invoice?.[0];
      if (hit?.Id) {
        await dsp.from("orders").update({
          qbo_invoice_id: String(hit.Id), billing_stage: "invoiced",
          invoiced_at: new Date().toISOString(), invoice_error: null,
        }).eq("id", orderId);
        await dsp.from("order_events").insert({
          order_id: orderId, actor: VERSION, event: "invoice_relinked", to_value: String(hit.Id),
          detail: { doc_number: payload.DocNumber, reason: "an invoice with this number already existed in QuickBooks" },
        });
        return jsonRes({ ok: true, relinked: true, qbo_invoice_id: String(hit.Id),
          message: `QuickBooks already had invoice ${payload.DocNumber}. Linked it rather than creating a second.` });
      }
    }

    const created = await acctPost(token, "/invoice", payload);
    const txn = created?.Invoice;
    if (!txn?.Id) throw new Error("QBO returned no invoice id");

    const { error: uErr } = await dsp.from("orders").update({
      qbo_invoice_id: String(txn.Id), billing_stage: "invoiced",
      invoiced_at: new Date().toISOString(), invoice_error: null,
    }).eq("id", orderId);
    // ⚠ The invoice EXISTS at this point. If our stamp fails, say so loudly —
    // silently returning ok would leave an order that re-invoices next time.
    if (uErr) {
      return jsonRes({
        ok: false, error: "stamp_failed", qbo_invoice_id: String(txn.Id),
        message: `QuickBooks invoice ${txn.DocNumber || txn.Id} was created but the order could not be marked invoiced (${uErr.message}). Do not retry — link it by hand.`,
      }, 500);
    }

    await dsp.from("order_events").insert({
      order_id: orderId, actor: VERSION, event: "invoiced", to_value: String(txn.Id),
      detail: { doc_number: txn.DocNumber, total: txn.TotalAmt, source: order.invoice_source },
    });

    const mirrored = await mirror(txn);
    const attached = media.length ? await attachMedia(token, String(txn.Id), media) : { attached: 0, skipped: 0, errors: [] };

    return jsonRes({
      ok: true, mode: "create",
      qbo_invoice_id: String(txn.Id), doc_number: txn.DocNumber || null,
      total: txn.TotalAmt, balance: txn.Balance,
      attachments: attached, mirror: mirrored,
    });
  } catch (err) {
    const message = String((err as Error)?.message || err).slice(0, 600);
    // Record the reason on the order so the screen can show it and the operator
    // can try again. The invoice REQUEST is deliberately left standing.
    if (orderId) {
      try { await sbFor("dispatch").from("orders").update({ invoice_error: message }).eq("id", orderId); } catch { /* best effort */ }
    }
    console.error(VERSION, message);
    return jsonRes({ ok: false, error: "failed", message }, 500);
  }
});
