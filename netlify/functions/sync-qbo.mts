// ═══════════════════════════════════════════════════════════════════
// netlify/functions/sync-qbo.mts
// QBO → Supabase sync for PACER Ops Dashboard
//
// Deploy to: apbg-billing Netlify site
// Schedule: Nightly 2am Pacific (9am UTC) or manual trigger
// Manual: GET /sync-qbo?mode=full&start=2025-01-01
// Env vars needed:
//   QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN, QBO_REALM_ID
//   SUPABASE_URL (https://gfsdpwiqzshhexkofiif.supabase.co)
//   SUPABASE_SERVICE_KEY (service_role key, not anon)
// ═══════════════════════════════════════════════════════════════════

import type { Config } from "@netlify/functions";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const PAGE_SIZE = 500;

const REVENUE_LINE_MAP: Record<string, string> = {
  "120": "BIB - 3 Gallon",
  "121": "BIB - 5 Gallon",
  "273": "BIB - Delivery Fees",
  "123": "Gas - CO2",
  "124": "Gas - Mixed/Nitro",
  "272": "Gas - Hazmat Fees",
  "32":  "Equipment Sales",
  "33":  "Equipment Rental",
  "278": "Packaged Beverage",
  "35":  "Service - General",
  "253": "Service - Reman",
  "255": "Service - Freshpet",
  "303": "Service - PM Contract",
  "306": "Shopify Sales",
  "312": "Shopify Shipping",
  "230": "Shipping Income",
  "229": "Markup",
  "10":  "Shipping and Delivery",
};

// ── QBO AUTH ────────────────────────────────────────────────────
let accessToken = "";

async function refreshQBOToken(): Promise<string> {
  const creds = btoa(process.env.QBO_CLIENT_ID + ":" + process.env.QBO_CLIENT_SECRET);
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + creds,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.QBO_REFRESH_TOKEN || "",
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    accessToken = data.access_token;
    if (data.refresh_token && data.refresh_token !== process.env.QBO_REFRESH_TOKEN) {
      console.log("[QBO] Refresh token rotated - update NETLIFY env var!");
    }
    return accessToken;
  }
  throw new Error("QBO token refresh failed: " + JSON.stringify(data));
}

async function qboQuery(query: string): Promise<any> {
  const realm = process.env.QBO_REALM_ID || "9130352144155116";
  const url = QBO_BASE + "/" + realm + "/query?query=" + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
  });
  if (res.status === 401) {
    await refreshQBOToken();
    return qboQuery(query);
  }
  return res.json();
}

async function qboRead(entity: string, id: string): Promise<any> {
  const realm = process.env.QBO_REALM_ID || "9130352144155116";
  const url = QBO_BASE + "/" + realm + "/" + entity + "/" + id;
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
  });
  if (res.status === 401) {
    await refreshQBOToken();
    return qboRead(entity, id);
  }
  return res.json();
}

async function qboReport(reportName: string, params: Record<string, string>): Promise<any> {
  const realm = process.env.QBO_REALM_ID || "9130352144155116";
  const qs = new URLSearchParams(params).toString();
  const url = QBO_BASE + "/" + realm + "/reports/" + reportName + "?" + qs;
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
  });
  if (res.status === 401) {
    await refreshQBOToken();
    return qboReport(reportName, params);
  }
  return res.json();
}

// ── SUPABASE HELPERS ────────────────────────────────────────────
const SB_URL = process.env.SUPABASE_URL || "https://gfsdpwiqzshhexkofiif.supabase.co";

async function sbFetch(method: string, table: string, opts: {
  body?: any;
  filter?: string;
  headers?: Record<string, string>;
} = {}) {
  let url = SB_URL + "/rest/v1/" + table;
  if (opts.filter) url += "?" + opts.filter;
  const hdrs: Record<string, string> = {
    apikey: process.env.SUPABASE_SERVICE_KEY || "",
    Authorization: "Bearer " + (process.env.SUPABASE_SERVICE_KEY || ""),
    "Accept-Profile": "ops",
    "Content-Profile": "ops",
    "Content-Type": "application/json",
    ...opts.headers,
  };
  const init: RequestInit = { method, headers: hdrs };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const res = await fetch(url, init);
  if (!res.ok && method !== "DELETE") {
    const err = await res.text();
    throw new Error("Supabase " + method + " " + table + ": " + res.status + " " + err);
  }
  return res;
}

async function sbUpsert(table: string, rows: any[], onConflict?: string) {
  return sbFetch("POST", table, {
    body: rows,
    headers: { Prefer: onConflict ? "resolution=merge-duplicates" : "return=minimal" },
  });
}

async function sbDelete(table: string, filter: string) {
  return sbFetch("DELETE", table, { filter });
}

async function sbSelect(table: string, params: string): Promise<any[]> {
  const url = SB_URL + "/rest/v1/" + table + "?" + params;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY || "",
      Authorization: "Bearer " + (process.env.SUPABASE_SERVICE_KEY || ""),
      "Accept-Profile": "ops",
    },
  });
  return res.json();
}

// ── SYNC: INVOICES ──────────────────────────────────────────────
async function syncInvoices(startDate: string, endDate: string): Promise<number> {
  let synced = 0;
  let startPos = 1;
  let hasMore = true;

  while (hasMore) {
    const q = "SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef, DepartmentRef, PrivateNote, MetaData FROM Invoice WHERE TxnDate >= '" + startDate + "' AND TxnDate <= '" + endDate + "' STARTPOSITION " + startPos + " MAXRESULTS " + PAGE_SIZE;
    const result = await qboQuery(q);
    const invoices = result?.QueryResponse?.Invoice || [];

    if (invoices.length === 0) { hasMore = false; break; }

    const rows = invoices.map(function(inv: any) {
      return {
        qbo_invoice_id: inv.Id,
        doc_number: inv.DocNumber || null,
        txn_date: inv.TxnDate,
        due_date: inv.DueDate || null,
        customer_ref_id: inv.CustomerRef?.value || null,
        customer_name: inv.CustomerRef?.name || null,
        total_amount: parseFloat(inv.TotalAmt) || 0,
        balance: parseFloat(inv.Balance) || 0,
        status: parseFloat(inv.Balance) === 0 ? "paid" : "open",
        department: inv.DepartmentRef?.name || null,
        memo: inv.PrivateNote || null,
        synced_at: new Date().toISOString(),
        qbo_updated_at: inv.MetaData?.LastUpdatedTime || null,
      };
    });

    await sbUpsert("qbo_invoices", rows, "qbo_invoice_id");

    for (const inv of invoices) {
      try {
        const full = await qboRead("invoice", inv.Id);
        const lines = full?.Invoice?.Line || [];

        const invRows = await sbSelect("qbo_invoices", "select=id&qbo_invoice_id=eq." + inv.Id);
        const invRow = invRows?.[0];
        if (!invRow) continue;

        const lineRows: any[] = [];
        let idx = 0;
        for (const l of lines) {
          if (l.DetailType !== "SalesItemLineDetail") continue;
          idx++;
          const d = l.SalesItemLineDetail || {};
          const acctId = d.ItemAccountRef?.value || "";
          lineRows.push({
            invoice_id: invRow.id,
            line_num: idx,
            description: l.Description || null,
            quantity: d.Qty || null,
            unit_price: d.UnitPrice || null,
            amount: parseFloat(l.Amount) || 0,
            item_ref_id: d.ItemRef?.value || null,
            item_name: d.ItemRef?.name || null,
            account_ref_id: acctId,
            account_name: d.ItemAccountRef?.name || null,
            revenue_line: REVENUE_LINE_MAP[acctId] || null,
            department: inv.DepartmentRef?.name || null,
          });
        }

        if (lineRows.length > 0) {
          await sbDelete("qbo_invoice_lines", "invoice_id=eq." + invRow.id);
          await sbUpsert("qbo_invoice_lines", lineRows);
        }
      } catch (e: any) {
        console.error("[SYNC] Invoice " + inv.Id + " line read failed:", e.message);
      }

      await new Promise(function(r) { setTimeout(r, 150); });
    }

    synced += invoices.length;
    startPos += PAGE_SIZE;
    hasMore = invoices.length === PAGE_SIZE;
  }

  return synced;
}

// ── SYNC: P/L SNAPSHOTS ────────────────────────────────────────
async function syncPLSnapshot(monthStart: string, monthEnd: string): Promise<number> {
  const report = await qboReport("ProfitAndLoss", {
    start_date: monthStart,
    end_date: monthEnd,
    accounting_method: "Accrual",
  });

  const rows: any[] = [];

  function extract(section: any, accountType: string) {
    if (!section?.Row) return;
    for (const row of section.Row) {
      if (row.type === "Data" && row.ColData) {
        const name = row.ColData[0]?.value;
        const id = row.ColData[0]?.id;
        const amt = parseFloat(row.ColData[1]?.value) || 0;
        if (name && id) {
          rows.push({
            period: monthStart,
            account_id: id,
            account_name: name,
            account_type: accountType,
            amount: amt,
            entity: "combined",
            snapshot_at: new Date().toISOString(),
          });
        }
      }
      if (row.Rows) extract(row.Rows, accountType);
    }
  }

  const sections = report?.Rows?.Row || [];
  for (const section of sections) {
    const h = section.Header?.ColData?.[0]?.value || "";
    let t = "Other";
    if (h === "Income") t = "Income";
    else if (h === "Cost of Goods Sold") t = "Cost of Goods Sold";
    else if (h === "Expenses") t = "Expense";
    if (section.Rows) extract(section.Rows, t);
  }

  if (rows.length > 0) {
    await sbDelete("pl_snapshots", "period=eq." + monthStart + "&entity=eq.combined");
    await sbUpsert("pl_snapshots", rows);
  }

  return rows.length;
}

// ── SYNC LOG ────────────────────────────────────────────────────
async function logSync(syncType: string, status: string, count: number, errMsg?: string, meta?: any) {
  try {
    await sbUpsert("sync_log", [{
      source: "qbo",
      sync_type: syncType,
      status: status,
      records_synced: count,
      error_message: errMsg || null,
      completed_at: new Date().toISOString(),
      metadata: meta || {},
    }]);
  } catch (e) {
    console.error("[SYNC] Failed to write sync_log:", e);
  }
}

// ── HANDLER ─────────────────────────────────────────────────────
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "incremental";

  const now = new Date();
  const pad = function(n: number) { return String(n).padStart(2, "0"); };
  let startDate = url.searchParams.get("start") || (now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-01");
  let endDate = url.searchParams.get("end") || now.toISOString().split("T")[0];

  if (mode === "full") startDate = "2025-01-01";

  console.log("[SYNC] QBO sync: " + mode + " | " + startDate + " to " + endDate);

  try {
    await refreshQBOToken();

    // Invoices
    const invCount = await syncInvoices(startDate, endDate);
    console.log("[SYNC] " + invCount + " invoices synced");
    await logSync("invoices", "success", invCount, undefined, { start_date: startDate, end_date: endDate, mode: mode });

    // P/L monthly snapshots
    let plCount = 0;
    const startD = new Date(startDate);
    const endD = new Date(endDate);
    const cur = new Date(startD.getFullYear(), startD.getMonth(), 1);

    while (cur <= endD) {
      const ms = cur.toISOString().split("T")[0];
      const me = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).toISOString().split("T")[0];
      plCount += await syncPLSnapshot(ms, me);
      cur.setMonth(cur.getMonth() + 1);
    }

    console.log("[SYNC] " + plCount + " PL rows synced");
    await logSync("pl_snapshots", "success", plCount, undefined, { start_date: startDate, end_date: endDate });

    return new Response(JSON.stringify({
      status: "success",
      mode: mode,
      date_range: { start: startDate, end: endDate },
      invoices_synced: invCount,
      pl_rows_synced: plCount,
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("[SYNC] Fatal:", err);
    await logSync("fatal", "error", 0, err.message);
    return new Response(JSON.stringify({ status: "error", message: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export const config: Config = {
  schedule: "0 9 * * *",
  path: "/sync-qbo",
};
