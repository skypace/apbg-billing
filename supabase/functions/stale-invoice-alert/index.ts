import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API = "https://api.resend.com/emails";
const SF_BASE_URL = "https://admin.servicefusion.com/jobs/jobView?id=";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };

function getSB() { return createClient(Deno.env.get("SUPABASE_URL")||"", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"", { db: { schema: "ops" } }); }
function jsonRes(d: any, s=200) { return new Response(JSON.stringify(d,null,2), { status:s, headers: { "Content-Type": "application/json", ...CORS } }); }

function sfJobUrl(encodedId: string|null, jobId: string): string {
  if (encodedId) return SF_BASE_URL + encodedId;
  return "https://admin.servicefusion.com/#!/jobs/" + jobId;
}
function statusColor(st: string): string {
  const s = (st||"").toLowerCase();
  if (s.includes("scheduled")) return "#FEF3C7";
  if (s.includes("completed")) return "#DBEAFE";
  if (s.includes("paused")) return "#FDE2E2";
  if (s.includes("cancel")) return "#F3F4F6";
  return "#F3F4F6";
}

Deno.serve(async (req: Request) => {
  if (req.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const sb = getSB();
  const log: string[] = [];

  try {
    // Read settings from dashboard-managed table
    const { data: settings } = await sb.from("alert_settings").select("*").eq("alert_type", "stale_invoice").single();
    if (!settings) return jsonRes({ status: "error", message: "No stale_invoice alert settings found" }, 400);
    if (!settings.enabled && !dryRun) {
      log.push("Alert is disabled in settings.");
      return jsonRes({ status: "skipped", message: "Alert disabled", log });
    }

    const recipients: string[] = settings.recipients || [];
    const config = settings.config || {};
    const fromEmail = config.from_email || "alerts@alamedapointbg.com";
    const fromName = config.from_name || "PACER Ops";

    if (recipients.length === 0 && !dryRun) {
      log.push("No recipients configured.");
      return jsonRes({ status: "skipped", message: "No recipients", log });
    }
    log.push("Recipients: " + recipients.join(", "));

    // Date range
    const now = new Date();
    const dow = now.getDay();
    const daysToThisMon = dow === 0 ? 6 : dow - 1;
    const thisMon = new Date(now); thisMon.setDate(now.getDate() - daysToThisMon);
    const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
    const lastSun = new Date(thisMon); lastSun.setDate(thisMon.getDate() - 1);
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    const startDate = url.searchParams.get("start") || fmt(lastMon);
    const endDate = url.searchParams.get("end") || fmt(lastSun);
    log.push("Date range: " + startDate + " to " + endDate);

    // Query all three tables
    const allJobs: any[] = [];

    const { data: svc } = await sb.from("service_jobs")
      .select("sf_job_id, sf_job_number, sf_encoded_id, job_date, customer_name, sf_total, sf_status, payment_status, tech_name, notes")
      .gte("job_date", startDate).lte("job_date", endDate)
      .not("sf_status", "ilike", "Invoiced%").not("sf_status", "ilike", "Archived%");
    for (const j of (svc||[])) allJobs.push({ type:"Service", ...j, date:j.job_date, tech:j.tech_name||"Unassigned" });

    const { data: del } = await sb.from("delivery_stops")
      .select("sf_job_id, sf_job_number, sf_encoded_id, stop_date, customer_name, sf_total, sf_status, payment_status, driver_name, notes")
      .gte("stop_date", startDate).lte("stop_date", endDate)
      .not("sf_status", "ilike", "Invoiced%").not("sf_status", "ilike", "Archived%");
    for (const j of (del||[])) allJobs.push({ type:"Delivery", ...j, date:j.stop_date, tech:j.driver_name||"Unassigned" });

    const { data: rem } = await sb.from("reman_jobs")
      .select("sf_job_id, sf_job_number, sf_encoded_id, intake_date, customer_ref_id, sf_total, sf_status, payment_status, tech_name, notes")
      .gte("intake_date", startDate).lte("intake_date", endDate)
      .not("sf_status", "ilike", "Invoiced%").not("sf_status", "ilike", "Archived%");
    for (const j of (rem||[])) allJobs.push({ type:"Reman", ...j, date:j.intake_date, tech:j.tech_name||"Unassigned", customer_name:j.customer_ref_id });

    // Three groups
    const cancelled = allJobs.filter(j => (j.sf_status||"").toLowerCase().includes("cancel"));
    const active = allJobs.filter(j => !(j.sf_status||"").toLowerCase().includes("cancel"));
    const withMoney = active.filter(j => (parseFloat(j.sf_total)||0) > 0).sort((a,b) => (parseFloat(b.sf_total)||0) - (parseFloat(a.sf_total)||0));
    const noMoney = active.filter(j => (parseFloat(j.sf_total)||0) === 0);
    const totalRisk = withMoney.reduce((s,j) => s + (parseFloat(j.sf_total)||0), 0);

    log.push(withMoney.length + " with $$ ($" + totalRisk.toFixed(2) + "), " + noMoney.length + " at $0, " + cancelled.length + " cancelled");

    if (allJobs.length === 0) {
      log.push("All clear.");
      await sb.from("alert_settings").update({ last_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("alert_type", "stale_invoice");
      return jsonRes({ status: "success", suspicious: 0, log });
    }

    // Build email
    const mkRow = (j: any, showAmt: boolean) => {
      const jobUrl = sfJobUrl(j.sf_encoded_id, j.sf_job_id);
      const total = parseFloat(j.sf_total)||0;
      return '<tr style="border-bottom:1px solid #eee;">'+
        '<td style="padding:6px 8px;"><a href="'+jobUrl+'" style="color:#1B4F72;font-weight:600;text-decoration:none;">'+(j.sf_job_number||j.sf_job_id)+'</a></td>'+
        '<td style="padding:6px 8px;font-size:11px;color:#6B7280;">'+j.type+'</td>'+
        '<td style="padding:6px 8px;">'+(j.customer_name||"Unknown")+'</td>'+
        '<td style="padding:6px 8px;"><span style="background:'+statusColor(j.sf_status)+';padding:2px 6px;border-radius:3px;font-size:11px;">'+(j.sf_status||"Unknown")+'</span></td>'+
        (showAmt?'<td style="padding:6px 8px;text-align:right;font-weight:600;color:#991B1B;">$'+total.toFixed(2)+'</td>':'')+
        '<td style="padding:6px 8px;font-size:12px;">'+j.date+'</td>'+
        '<td style="padding:6px 8px;font-size:12px;">'+j.tech+'</td></tr>';
    };

    let html = '<div style="font-family:system-ui;max-width:850px;margin:0 auto;">';
    html += '<h2 style="color:#1B4F72;margin-bottom:4px;">Weekly Uninvoiced Jobs Report</h2>';
    html += '<p style="color:#6B7280;margin-top:0;">'+startDate+' to '+endDate+'</p>';

    if (withMoney.length > 0) {
      html += '<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px 16px;margin-bottom:12px;">';
      html += '<span style="color:#991B1B;font-size:20px;font-weight:700;">$'+totalRisk.toFixed(2)+' at risk</span>';
      html += '<span style="color:#991B1B;margin-left:8px;font-size:13px;">('+withMoney.length+' jobs not invoiced)</span></div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:24px;">';
      html += '<tr style="background:#F9FAFB;"><th style="padding:6px 8px;text-align:left;">Job #</th><th style="padding:6px 8px;text-align:left;">Type</th><th style="padding:6px 8px;text-align:left;">Customer</th><th style="padding:6px 8px;text-align:left;">Status</th><th style="padding:6px 8px;text-align:right;">Amount</th><th style="padding:6px 8px;text-align:left;">Date</th><th style="padding:6px 8px;text-align:left;">Tech</th></tr>';
      html += withMoney.map(j => mkRow(j, true)).join('') + '</table>';
    }
    if (noMoney.length > 0) {
      html += '<div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:12px 16px;margin-bottom:12px;">';
      html += '<span style="color:#92400E;font-weight:600;">'+noMoney.length+' jobs at $0 still open</span></div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:24px;">';
      html += '<tr style="background:#F9FAFB;"><th style="padding:6px 8px;text-align:left;">Job #</th><th style="padding:6px 8px;text-align:left;">Type</th><th style="padding:6px 8px;text-align:left;">Customer</th><th style="padding:6px 8px;text-align:left;">Status</th><th style="padding:6px 8px;text-align:left;">Date</th><th style="padding:6px 8px;text-align:left;">Tech</th></tr>';
      html += noMoney.map(j => mkRow(j, false)).join('') + '</table>';
    }
    if (cancelled.length > 0) {
      html += '<div style="background:#F3F4F6;border:1px solid #D1D5DB;border-radius:8px;padding:10px 16px;margin-bottom:12px;">';
      html += '<span style="color:#6B7280;font-weight:600;">'+cancelled.length+' Cancelled Jobs</span></div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:11px;color:#9CA3AF;">';
      html += '<tr style="background:#F9FAFB;"><th style="padding:4px 8px;text-align:left;">Job #</th><th style="padding:4px 8px;text-align:left;">Type</th><th style="padding:4px 8px;text-align:left;">Customer</th><th style="padding:4px 8px;text-align:left;">Status</th><th style="padding:4px 8px;text-align:left;">Date</th><th style="padding:4px 8px;text-align:left;">Tech</th></tr>';
      html += cancelled.map(j => mkRow(j, false)).join('') + '</table>';
    }
    html += '<p style="color:#9CA3AF;font-size:9px;margin-top:16px;">PACER Ops Dashboard | Click job # to open in SF | '+new Date().toISOString()+'</p></div>';

    // Send
    if (!dryRun) {
      const rk = Deno.env.get("RESEND_API_KEY")||"";
      if (rk && recipients.length > 0) {
        const subj = withMoney.length > 0
          ? "[PACER] "+withMoney.length+" uninvoiced ($"+totalRisk.toFixed(0)+") - wk "+startDate
          : "[PACER] "+noMoney.length+" open jobs - wk "+startDate;
        const er = await fetch(RESEND_API,{method:"POST",headers:{Authorization:"Bearer "+rk,"Content-Type":"application/json"},body:JSON.stringify({from:fromName+" <"+fromEmail+">",to:recipients,subject:subj,html:html})});
        log.push(er.ok ? "Email sent to " + recipients.join(", ") : "Resend err: "+er.status);
        if (er.ok) {
          await sb.from("alert_settings").update({ last_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("alert_type", "stale_invoice");
        }
      } else log.push(rk ? "No recipients" : "No RESEND_API_KEY");
    } else log.push("DRY RUN");

    await sb.from("sync_log").insert({source:"sf",sync_type:"stale_alert",status:"success",records_synced:allJobs.length,completed_at:new Date().toISOString(),metadata:{start_date:startDate,end_date:endDate,with_money:withMoney.length,no_money:noMoney.length,cancelled:cancelled.length,total_risk:totalRisk,dry_run:dryRun,recipients}});

    return jsonRes({status:"success",date_range:{start:startDate,end:endDate},with_money:withMoney.length,no_money:noMoney.length,cancelled:cancelled.length,total_risk:totalRisk,dry_run:dryRun,recipients,log});
  } catch(err:any) {
    log.push("FATAL: "+err.message);
    return jsonRes({status:"error",message:err.message,log},500);
  }
});
