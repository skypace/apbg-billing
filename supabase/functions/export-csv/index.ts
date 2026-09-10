// export-csv — APBG-OPS Supabase project
//
// Returns the pivot rows for a saved view as a CSV. Designed for use in
// Google Sheets via =IMPORTDATA("https://...") so a sheet can stay in
// sync with the live data without any Google API setup.
//
//   GET /functions/v1/export-csv?view_id=<uuid>
//
// verify_jwt=false: the URL is shareable. If you want to gate it,
// require ?token=<some shared secret> via env var EXPORT_TOKEN.

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function csvEsc(v: any) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);

  // Optional shared-secret gate
  const requireToken = Deno.env.get("EXPORT_TOKEN");
  if (requireToken && url.searchParams.get("token") !== requireToken) {
    return new Response("forbidden\n", { status: 403, headers: { "Content-Type": "text/plain", ...CORS } });
  }

  const viewId = url.searchParams.get("view_id");
  if (!viewId) {
    return new Response("missing view_id\n", { status: 400, headers: { "Content-Type": "text/plain", ...CORS } });
  }

  const supa = sb();

  try {
    const { data: vRow, error: vErr } = await supa
      .schema("ops").from("saved_views").select("*").eq("id", viewId).maybeSingle();
    if (vErr) throw vErr;
    if (!vRow) {
      return new Response("saved view not found\n", { status: 404, headers: { "Content-Type": "text/plain", ...CORS } });
    }

    const cfg = (vRow.config || {}) as any;
    const args = {
      p_dim: cfg.dim || "category",
      p_start: cfg.start, p_end: cfg.end,
      p_entities:    (cfg.entities && cfg.entities.length)     ? cfg.entities    : null,
      p_categories:  (cfg.categories && cfg.categories.length) ? cfg.categories  : null,
      p_customers:   (cfg.customers && cfg.customers.length)   ? cfg.customers   : null,
      p_items:       (cfg.items && cfg.items.length)           ? cfg.items       : null,
      p_channels:    (cfg.channels && cfg.channels.length)     ? cfg.channels    : null,
      p_segments:    (cfg.segments && cfg.segments.length)     ? cfg.segments    : null,
      p_sales_reps:  (cfg.sales_reps && cfg.sales_reps.length) ? cfg.sales_reps  : null,
      p_limit: 2000,
    };

    const { data: rows, error: rErr } = await supa.rpc("fn_sales_pivot", args);
    if (rErr) throw rErr;

    const header = [
      cfg.dim || "dim",
      "line_count", "qty", "revenue",
      "avg_price", "est_cost", "est_margin", "margin_pct"
    ];
    const lines = [header.join(",")];
    (rows ?? []).forEach((r: any) => {
      lines.push([
        r.dim_label,
        r.line_count,
        r.qty != null ? Number(r.qty).toFixed(0) : "",
        r.revenue != null ? Number(r.revenue).toFixed(2) : "",
        r.avg_price != null ? Number(r.avg_price).toFixed(4) : "",
        r.est_cost != null ? Number(r.est_cost).toFixed(2) : "",
        r.est_margin != null ? Number(r.est_margin).toFixed(2) : "",
        r.margin_pct != null ? (Number(r.margin_pct) * 100).toFixed(2) + "%" : "",
      ].map(csvEsc).join(","));
    });

    const csv = lines.join("\n");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `inline; filename="${(vRow.name || "view").replace(/[^a-z0-9-]+/gi, "_")}.csv"`,
        // Cache for 5 min so Sheets doesn't hammer the function
        "Cache-Control": "public, max-age=300",
        ...CORS,
      },
    });
  } catch (err) {
    return new Response("error: " + (err instanceof Error ? err.message : String(err)) + "\n",
      { status: 500, headers: { "Content-Type": "text/plain", ...CORS } });
  }
});
