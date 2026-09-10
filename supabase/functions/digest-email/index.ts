// digest-email — APBG-OPS Supabase project
//
// Builds an HTML digest of sales/health analytics highlights and emails
// it via Resend. Two modes:
//
//   - {mode:'scheduled'}: loops through active digest_subscriptions and
//     sends to any whose frequency window is due (called by pg_cron).
//   - {mode:'manual', subscription_id?, recipients?, sections?}:
//     immediate send, useful for the "Send Test Now" button.
//
// Sections:
//   margin_summary | inactive | top_movers | health_movers | plan_alerts | voids
//
// verify_jwt = false because pg_cron calls this without an Authorization
// header. The function is anon-callable but only acts on data already
// gated by service-role queries inside.

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function jsonRes(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
}
function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}
function money(v: any) {
  const n = Number(v || 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function pct(v: any) {
  if (v == null) return "—";
  return (Number(v) * 100).toFixed(1) + "%";
}
function esc(s: any) {
  return String(s == null ? "" : s).replace(/[&<>\"']/g, (c) =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '\"':"&quot;", "'":"&#39;" }[c] as string));
}

async function buildSections(supa: SupabaseClient, sections: string[]) {
  const today = new Date();
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const yStart = today.getFullYear() + "-01-01";
  const yEnd = ymd(today);
  const priorStart = (today.getFullYear() - 1) + "-01-01";
  const priorEnd = (today.getFullYear() - 1) + "-12-31";

  let html = `<div style=\"font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;max-width:780px;margin:0 auto\">`;
  html += `<h1 style=\"font-size:18px;letter-spacing:1.5px;color:#22d3ee;border-bottom:1px solid #1e2d4a;padding-bottom:8px\">PACER MARGIN — DIGEST</h1>`;
  html += `<p style=\"font-size:12px;color:#64748b;margin:0 0 18px\">Period: ${yStart} → ${yEnd}</p>`;

  if (sections.includes("margin_summary")) {
    const { data } = await supa.rpc("fn_sales_totals", { p_start: yStart, p_end: yEnd });
    const t = (data && data[0]) || {};
    html += `<h2 style=\"font-size:14px;color:#0a0e17;margin:0 0 8px\">YTD Snapshot</h2>`;
    html += `<table style=\"width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px\">`;
    [
      ["Revenue", money(t.revenue)],
      ["Est Margin", money(t.est_margin)],
      ["Margin %", pct(t.margin_pct)],
      ["Invoices", t.invoice_count || 0],
      ["Customers", t.customer_count || 0],
      ["Cost Coverage", pct(t.cost_coverage_pct)],
    ].forEach(([k, v]) => {
      html += `<tr><td style=\"padding:6px 12px;background:#f1f5f9;border:1px solid #e2e8f0;font-weight:600\">${k}</td><td style=\"padding:6px 12px;border:1px solid #e2e8f0\">${esc(v)}</td></tr>`;
    });
    html += `</table>`;
  }

  if (sections.includes("inactive")) {
    const { data } = await supa.rpc("fn_inactive_customers", {
      p_current_start: yStart, p_current_end: yEnd,
      p_prior_start: priorStart, p_prior_end: priorEnd,
      p_min_prior_rev: 1000, p_max_current_rev: 0, p_limit: 25,
    });
    const rows = data || [];
    const totalLost = rows.reduce((s: number, r: any) => s + Number(r.prior_revenue || 0), 0);
    html += `<h2 style=\"font-size:14px;margin:18px 0 8px\">Lost / Inactive Customers <span style=\"color:#64748b;font-weight:400;font-size:12px\">${rows.length} accounts · ${money(totalLost)} prior revenue at risk</span></h2>`;
    if (rows.length === 0) {
      html += `<p style=\"font-size:12px;color:#64748b\">No inactive customers — everyone with prior-year revenue is buying again.</p>`;
    } else {
      html += `<table style=\"width:100%;border-collapse:collapse;font-size:12px\">`;
      html += `<thead><tr style=\"background:#1a2235;color:#e2e8f0\">${["Customer","Prior Rev","Current","Channel","Rep"].map(h=>`<th style=\"padding:6px 10px;text-align:left\">${h}</th>`).join("")}</tr></thead><tbody>`;
      rows.slice(0, 15).forEach((r: any) => {
        html += `<tr style=\"border-bottom:1px solid #e2e8f0\">`;
        html += `<td style=\"padding:6px 10px\">${esc(r.customer_name)}</td>`;
        html += `<td style=\"padding:6px 10px;color:#fbbf24;font-weight:600\">${money(r.prior_revenue)}</td>`;
        html += `<td style=\"padding:6px 10px\">${money(r.current_revenue)}</td>`;
        html += `<td style=\"padding:6px 10px;color:#64748b\">${esc(r.primary_channel || "—")}</td>`;
        html += `<td style=\"padding:6px 10px;color:#64748b\">${esc(r.primary_sales_rep || "no rep")}</td>`;
        html += `</tr>`;
      });
      html += `</tbody></table>`;
    }
  }

  if (sections.includes("top_movers")) {
    const { data } = await supa.rpc("fn_top_movers", {
      p_dim: "customer", p_start: yStart, p_end: yEnd,
      p_prev_start: priorStart, p_prev_end: priorEnd, p_limit: 50,
    });
    const rows = data || [];
    const gainers = rows.filter((r: any) => Number(r.delta_rev) > 0).slice(0, 5);
    const losers = rows.filter((r: any) => Number(r.delta_rev) < 0).sort((a: any,b: any)=>Number(a.delta_rev)-Number(b.delta_rev)).slice(0, 5);
    html += `<h2 style=\"font-size:14px;margin:18px 0 8px\">Top Movers vs ${today.getFullYear() - 1}</h2>`;
    function moverTable(items: any[], title: string, color: string) {
      let h = `<div style=\"margin-bottom:12px\"><div style=\"font-size:12px;color:${color};font-weight:600;margin-bottom:4px\">${title}</div>`;
      h += `<table style=\"width:100%;border-collapse:collapse;font-size:12px\">`;
      items.forEach((r: any) => {
        const dr = Number(r.delta_rev);
        const sign = dr >= 0 ? "+" : "";
        h += `<tr style=\"border-bottom:1px solid #e2e8f0\">`;
        h += `<td style=\"padding:6px 10px\">${esc(r.dim_label)}</td>`;
        h += `<td style=\"padding:6px 10px;text-align:right\">${money(r.current_rev)}</td>`;
        h += `<td style=\"padding:6px 10px;text-align:right;color:${color};font-weight:600\">${sign}${money(dr)}</td>`;
        h += `<td style=\"padding:6px 10px;text-align:right;color:#64748b\">${pct(r.delta_pct)}</td>`;
        h += `</tr>`;
      });
      h += `</table></div>`;
      return h;
    }
    html += moverTable(gainers, "Top Gainers", "#16a34a");
    html += moverTable(losers, "Top Decliners", "#dc2626");
  }

  if (sections.includes("health_movers")) {
    const { data } = await supa.rpc("fn_health_movers", { p_max_age_days: 14 });
    const rows = (data || []) as any[];
    const promoted = rows.filter((r: any) => Number(r.rfm_total_delta || 0) > 0 || r.prev_segment === null).slice(0, 10);
    const demoted  = rows.filter((r: any) => Number(r.rfm_total_delta || 0) < 0).sort((a: any, b: any) => Number(a.rfm_total_delta) - Number(b.rfm_total_delta)).slice(0, 10);
    html += `<h2 style=\"font-size:14px;margin:18px 0 8px\">Customer Health Movement <span style=\"color:#64748b;font-weight:400;font-size:12px\">${rows.length} customers shifted RFM since last snapshot</span></h2>`;
    if (rows.length === 0) {
      html += `<p style=\"font-size:12px;color:#64748b\">No prior snapshot in window, or all customers stable.</p>`;
    } else {
      function moverHealthTable(items: any[], title: string, color: string) {
        if (items.length === 0) return "";
        let h = `<div style=\"margin-bottom:12px\"><div style=\"font-size:12px;color:${color};font-weight:600;margin-bottom:4px\">${title}</div>`;
        h += `<table style=\"width:100%;border-collapse:collapse;font-size:12px\">`;
        items.forEach((r: any) => {
          h += `<tr style=\"border-bottom:1px solid #e2e8f0\">`;
          h += `<td style=\"padding:6px 10px\">${esc(r.customer_name)}</td>`;
          h += `<td style=\"padding:6px 10px;color:#64748b\">${esc(r.movement || "")}</td>`;
          h += `<td style=\"padding:6px 10px;color:#64748b\">${esc(r.primary_sales_rep || "no rep")}</td>`;
          h += `<td style=\"padding:6px 10px;text-align:right;color:${color};font-weight:600\">${money(r.curr_monetary)}</td>`;
          h += `</tr>`;
        });
        h += `</table></div>`;
        return h;
      }
      html += moverHealthTable(promoted, "Promoted / New", "#16a34a");
      html += moverHealthTable(demoted, "Demoted", "#dc2626");
    }
  }

  if (sections.includes("plan_alerts")) {
    const { data: plans } = await supa.schema("ops").from("sales_plans")
      .select("id, name, fiscal_year, scenario, status")
      .eq("fiscal_year", today.getFullYear())
      .neq("status", "archived");
    html += `<h2 style=\"font-size:14px;margin:18px 0 8px\">Plan Variance Alerts <span style=\"color:#64748b;font-weight:400;font-size:12px\">FY${today.getFullYear()} plans &gt;10% behind YTD plan</span></h2>`;
    if (!plans || plans.length === 0) {
      html += `<p style=\"font-size:12px;color:#64748b\">No active plan for FY${today.getFullYear()}.</p>`;
    } else {
      let any = false;
      for (const plan of plans) {
        const { data: alerts } = await supa.rpc("fn_plan_alerts", { p_plan_id: plan.id, p_threshold: 0.10 });
        const rows = (alerts || []) as any[];
        if (rows.length === 0) continue;
        any = true;
        html += `<div style=\"margin-bottom:12px\"><div style=\"font-size:12px;color:#dc2626;font-weight:600;margin-bottom:4px\">${esc(plan.name)} (${esc(plan.scenario || "plan")})</div>`;
        html += `<table style=\"width:100%;border-collapse:collapse;font-size:12px\">`;
        html += `<thead><tr style=\"background:#1a2235;color:#e2e8f0\">${["Item","YTD Plan","YTD Actual","Variance"].map(h=>`<th style=\"padding:6px 10px;text-align:left\">${h}</th>`).join("")}</tr></thead><tbody>`;
        rows.slice(0, 12).forEach((r: any) => {
          const v = Number(r.variance_pct);
          html += `<tr style=\"border-bottom:1px solid #e2e8f0\">`;
          html += `<td style=\"padding:6px 10px\">${esc(r.item_name || r.account_name || "—")}</td>`;
          html += `<td style=\"padding:6px 10px;text-align:right\">${money(r.ytd_plan)}</td>`;
          html += `<td style=\"padding:6px 10px;text-align:right\">${money(r.ytd_actual)}</td>`;
          html += `<td style=\"padding:6px 10px;text-align:right;color:#dc2626;font-weight:600\">${pct(v)}</td>`;
          html += `</tr>`;
        });
        html += `</tbody></table></div>`;
      }
      if (!any) html += `<p style=\"font-size:12px;color:#16a34a\">All plan lines are within 10% of YTD plan. Nice.</p>`;
    }
  }

  html += `<p style=\"font-size:11px;color:#64748b;margin-top:24px;border-top:1px solid #e2e8f0;padding-top:8px\">View full dashboard: <a href=\"https://apbg-billing.netlify.app/sales/\" style=\"color:#22d3ee\">apbg-billing.netlify.app/sales/</a></p>`;
  html += `</div>`;
  return html;
}

async function sendViaResend(to: string[], subject: string, html: string): Promise<{ok:boolean, error?:string}> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "RESEND_API_KEY not set — dry-run only" };
  const from = Deno.env.get("DIGEST_FROM") || "PACER Digest <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${text}` };
  }
  return { ok: true };
}

async function logDigest(supa: SupabaseClient, sub_id: string | null, recipients: string[], subject: string, status: string, error?: string, preview?: string) {
  await supa.schema("ops").from("digest_log").insert({
    subscription_id: sub_id,
    recipients,
    subject,
    status,
    error: error || null,
    preview: preview ? preview.slice(0, 1000) : null,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const supa = sb();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const mode = body.mode || "manual";

  try {
    if (mode === "scheduled") {
      const { data: subs } = await supa.schema("ops").from("digest_subscriptions").select("*").eq("is_active", true);
      const now = new Date();
      const result: any[] = [];
      for (const s of subs ?? []) {
        const lastMs = s.last_sent_at ? Date.parse(s.last_sent_at) : 0;
        const daysSince = (Date.now() - lastMs) / (24 * 3600 * 1000);
        const due =
          (s.frequency === "daily" && daysSince >= 0.95) ||
          (s.frequency === "weekly" && daysSince >= 6.5 && now.getUTCDay() === s.day_of_week) ||
          (s.frequency === "monthly" && daysSince >= 28);
        if (!due) { result.push({ id: s.id, status: "skipped", daysSince }); continue; }
        const html = await buildSections(supa, s.sections);
        const subject = `PACER Margin — ${s.frequency} digest — ${now.toISOString().slice(0,10)}`;
        const send = await sendViaResend(s.recipients, subject, html);
        await supa.schema("ops").from("digest_subscriptions").update({ last_sent_at: now.toISOString() }).eq("id", s.id);
        await logDigest(supa, s.id, s.recipients, subject, send.ok ? "sent" : "failed", send.error, html);
        result.push({ id: s.id, status: send.ok ? "sent" : "failed", error: send.error });
      }
      return jsonRes({ ok: true, mode: "scheduled", processed: result });
    }

    const sections: string[] = body.sections || ["margin_summary", "inactive", "top_movers"];
    const recipients: string[] = body.recipients || [];
    const html = await buildSections(supa, sections);
    const subject = body.subject || `PACER Margin — Manual digest — ${new Date().toISOString().slice(0,10)}`;

    if (body.dry_run || recipients.length === 0) {
      await logDigest(supa, body.subscription_id || null, recipients, subject, "dry_run", undefined, html);
      return jsonRes({ ok: true, mode: "dry_run", html, recipients, subject });
    }

    const send = await sendViaResend(recipients, subject, html);
    await logDigest(supa, body.subscription_id || null, recipients, subject, send.ok ? "sent" : "failed", send.error, html);
    return jsonRes({ ok: send.ok, mode: "manual", error: send.error, subject, recipients });
  } catch (err) {
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
