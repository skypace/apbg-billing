// shopify-qbo-sync v1 — replaces the Intuit QBO Commerce "Shopify channel" app.
// Books each PAID Shopify order as an SKU-mapped QBO Sales Receipt (order-level
// idempotency via DocNumber SH-<order#> + ops.shopify_sync_orders), refunds as
// Refund Receipts, and Shopify Payments payouts as Deposits (net = bank credit,
// fee line to the Shopify Selling Fees account).
// Gate: x-internal-secret == INTERNAL_PAY_SECRET (same pattern as qbo-reconcile).
// Inert until ops.shopify_sync_config.enabled = true AND SHOPIFY_ADMIN_TOKEN secret set.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_SECRET = Deno.env.get("INTERNAL_PAY_SECRET") ?? "";
const SHOPIFY_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN") ?? "";
const QBO_REALM = Deno.env.get("QBO_REALM") ?? "9130352144155116";
const QBO_BANK_ACCOUNT = Deno.env.get("QBO_SHOPIFY_BANK_ACCOUNT_ID") ?? "72"; // Chase Business Checking
const QBO_BASE = `https://quickbooks.api.intuit.com/v3/company/${QBO_REALM}`;
const API_VER = "2025-01";

// NB: ops schema explicitly — default-schema bug is a known trap in this project.
const sb = createClient(SB_URL, SB_KEY, { db: { schema: "ops" } });

const cents = (s: string | number | null | undefined): number => Math.round(parseFloat(String(s ?? "0")) * 100) || 0;
const dollars = (c: number): number => Math.round(c) / 100;
const ptDate = (iso: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

async function qboToken(): Promise<string> {
  const { data, error } = await sb.from("qbo_token_cache").select("access_token, access_token_expires_at").limit(1).single();
  if (error || !data) throw new Error("qbo_token_cache read failed: " + (error?.message ?? "empty"));
  if (new Date(data.access_token_expires_at).getTime() < Date.now() + 60_000)
    throw new Error("QBO access token expired — sync-qbo cron refreshes hourly; retry next run");
  return data.access_token;
}

async function qbo(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${QBO_BASE}${path}${path.includes("?") ? "&" : "?"}minorversion=75`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`QBO ${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function qboQuery(token: string, q: string): Promise<any> {
  return qbo(token, "GET", `/query?query=${encodeURIComponent(q)}`);
}

async function shopify(cfg: any, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://${cfg.shop_domain}/admin/api/${API_VER}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error("Shopify GraphQL: " + JSON.stringify(json.errors ?? json).slice(0, 400));
  return json.data;
}

const ORDER_FIELDS = `
  id name test createdAt updatedAt cancelledAt displayFinancialStatus
  totalPriceSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  lineItems(first: 50) { nodes { sku title quantity discountedTotalSet { shopMoney { amount } } } }
  refunds { id createdAt
    totalRefundedSet { shopMoney { amount } }
    refundLineItems(first: 50) { nodes { quantity restockType subtotalSet { shopMoney { amount } } lineItem { sku title } } } }`;

const BOOKABLE = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "PARTIALLY_PAID"]);

interface RunStats { orders_booked: number; refunds_booked: number; payouts_booked: number; skipped: number; errors: string[] }

async function bookOrder(token: string, cfg: any, itemMap: Map<string, string>, o: any, stats: RunStats): Promise<void> {
  const oid = o.id as string;
  const docNum = "SH-" + String(o.name ?? "").replace(/^#/, "").slice(0, 18);
  const base = {
    shopify_order_id: oid, order_name: o.name, created_at_shopify: o.createdAt,
    updated_at_shopify: o.updatedAt, total: parseFloat(o.totalPriceSet?.shopMoney?.amount ?? "0"),
    financial_status: o.displayFinancialStatus, updated_at: new Date().toISOString(),
  };
  const { data: existing } = await sb.from("shopify_sync_orders").select("status, qbo_salesreceipt_id").eq("shopify_order_id", oid).maybeSingle();
  const already = existing?.status === "booked";

  if (!already) {
    if (o.test) { await sb.from("shopify_sync_orders").upsert({ ...base, status: "skipped_test" }); stats.skipped++; }
    else if (new Date(o.createdAt) < new Date(cfg.backfill_start_at)) {
      await sb.from("shopify_sync_orders").upsert({ ...base, status: "skipped_precutover" }); stats.skipped++;
    } else if (!BOOKABLE.has(o.displayFinancialStatus)) {
      await sb.from("shopify_sync_orders").upsert({ ...base, status: "skipped_unpaid" }); stats.skipped++;
    } else {
      // Idempotency double-guard: DocNumber lookup in QBO itself.
      const dup = await qboQuery(token, `select Id from SalesReceipt where DocNumber = '${docNum}'`);
      const dupId = dup?.QueryResponse?.SalesReceipt?.[0]?.Id;
      if (dupId) {
        await sb.from("shopify_sync_orders").upsert({ ...base, status: "booked", qbo_salesreceipt_id: dupId, qbo_doc_number: docNum, booked_at: new Date().toISOString() });
      } else {
        const totalC = cents(o.totalPriceSet?.shopMoney?.amount);
        const taxC = cents(o.totalTaxSet?.shopMoney?.amount);
        const shipC = cents(o.totalShippingPriceSet?.shopMoney?.amount);
        let unmapped = false;
        const lines: any[] = [];
        let lineSumC = 0;
        for (const li of o.lineItems?.nodes ?? []) {
          const amtC = cents(li.discountedTotalSet?.shopMoney?.amount);
          if (amtC === 0 && !li.sku) continue;
          const sku = (li.sku ?? "").trim();
          let itemId = itemMap.get(sku);
          if (!itemId && /crv/i.test(li.title ?? "")) itemId = cfg.qbo_item_crv;
          if (!itemId) { itemId = cfg.qbo_item_fallback; if (amtC !== 0) unmapped = true; }
          lineSumC += amtC;
          lines.push({
            Amount: dollars(amtC), DetailType: "SalesItemLineDetail",
            Description: `${li.title ?? ""}${sku ? " [" + sku + "]" : ""}`.slice(0, 4000),
            SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: li.quantity ?? 1, UnitPrice: dollars(Math.round(amtC / (li.quantity || 1))), TaxCodeRef: { value: "NON" } },
          });
        }
        // Order-level discount residual so the document total equals the Shopify order total.
        const residualC = totalC - taxC - shipC - lineSumC;
        if (residualC < 0) lines.push({ Amount: dollars(residualC), DetailType: "SalesItemLineDetail", Description: "Order-level discount", SalesItemLineDetail: { ItemRef: { value: cfg.qbo_item_discount }, TaxCodeRef: { value: "NON" } } });
        else if (residualC > 0) lines.push({ Amount: dollars(residualC), DetailType: "SalesItemLineDetail", Description: "Rounding/adjustment", SalesItemLineDetail: { ItemRef: { value: cfg.qbo_item_fallback }, TaxCodeRef: { value: "NON" } } });
        if (shipC !== 0) lines.push({ Amount: dollars(shipC), DetailType: "SalesItemLineDetail", Description: "Shipping", SalesItemLineDetail: { ItemRef: { value: cfg.qbo_item_shipping }, TaxCodeRef: { value: "NON" } } });
        if (taxC !== 0) lines.push({ Amount: dollars(taxC), DetailType: "SalesItemLineDetail", Description: "Sales tax collected by Shopify", SalesItemLineDetail: { ItemRef: { value: cfg.qbo_item_tax }, TaxCodeRef: { value: "NON" } } });
        const sr = await qbo(token, "POST", "/salesreceipt", {
          DocNumber: docNum,
          TxnDate: ptDate(o.createdAt),
          CustomerRef: { value: cfg.qbo_customer_id },
          DepositToAccountRef: { value: cfg.qbo_clearing_account_id },
          PrivateNote: `shopify-qbo-sync ${oid}`,
          Line: lines,
        });
        await sb.from("shopify_sync_orders").upsert({ ...base, status: "booked", qbo_salesreceipt_id: sr?.SalesReceipt?.Id, qbo_doc_number: docNum, had_unmapped_sku: unmapped, error: null, booked_at: new Date().toISOString() });
        stats.orders_booked++;
      }
    }
  }

  // Refunds (booked independently; order may have been booked in an earlier run).
  for (const [idx, r] of (o.refunds ?? []).entries()) {
    const refC = cents(r.totalRefundedSet?.shopMoney?.amount);
    if (refC <= 0) continue;
    if (new Date(r.createdAt) < new Date(cfg.backfill_start_at)) continue;
    const { data: rEx } = await sb.from("shopify_sync_refunds").select("status").eq("shopify_refund_id", r.id).maybeSingle();
    if (rEx?.status === "booked") continue;
    const rDoc = ("SHR-" + String(o.name ?? "").replace(/^#/, "") + "-" + (idx + 1)).slice(0, 21);
    const dup = await qboQuery(token, `select Id from RefundReceipt where DocNumber = '${rDoc}'`);
    const dupId = dup?.QueryResponse?.RefundReceipt?.[0]?.Id;
    let rrId = dupId;
    if (!rrId) {
      const rLines: any[] = [];
      let restockedC = 0;
      for (const rli of r.refundLineItems?.nodes ?? []) {
        const amtC = cents(rli.subtotalSet?.shopMoney?.amount);
        const sku = (rli.lineItem?.sku ?? "").trim();
        const itemId = itemMap.get(sku);
        const restocked = rli.restockType === "RETURN" || rli.restockType === "CANCEL";
        if (itemId && restocked && amtC > 0 && restockedC + amtC <= refC) {
          restockedC += amtC;
          rLines.push({ Amount: dollars(amtC), DetailType: "SalesItemLineDetail", Description: `Refund (restocked): ${rli.lineItem?.title ?? ""} [${sku}]`, SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: rli.quantity ?? 1, TaxCodeRef: { value: "NON" } } });
        }
      }
      const restC = refC - restockedC;
      if (restC !== 0) rLines.push({ Amount: dollars(restC), DetailType: "SalesItemLineDetail", Description: "Refund (tax/shipping/non-restocked)", SalesItemLineDetail: { ItemRef: { value: cfg.qbo_item_fallback }, TaxCodeRef: { value: "NON" } } });
      const rr = await qbo(token, "POST", "/refundreceipt", {
        DocNumber: rDoc,
        TxnDate: ptDate(r.createdAt),
        CustomerRef: { value: cfg.qbo_customer_id },
        DepositToAccountRef: { value: cfg.qbo_clearing_account_id },
        PrivateNote: `shopify-qbo-sync ${r.id} (order ${oid})`,
        Line: rLines,
      });
      rrId = rr?.RefundReceipt?.Id;
      stats.refunds_booked++;
    }
    await sb.from("shopify_sync_refunds").upsert({ shopify_refund_id: r.id, shopify_order_id: oid, order_name: o.name, created_at_shopify: r.createdAt, amount: dollars(refC), status: "booked", qbo_refundreceipt_id: rrId, qbo_doc_number: rDoc, error: null, booked_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
}

async function syncOrders(token: string, cfg: any, itemMap: Map<string, string>, stats: RunStats): Promise<void> {
  const wm = new Date(new Date(cfg.orders_watermark ?? cfg.backfill_start_at).getTime() - 10 * 60_000).toISOString();
  let after: string | null = null;
  let maxUpdated = cfg.orders_watermark;
  for (let page = 0; page < 5; page++) {
    const data = await shopify(cfg, `query($after: String, $q: String) { orders(first: 25, after: $after, query: $q, sortKey: UPDATED_AT) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`, { after, q: `updated_at:>='${wm}'` });
    const conn = data.orders;
    for (const o of conn.nodes) {
      try {
        await bookOrder(token, cfg, itemMap, o, stats);
        if (!maxUpdated || new Date(o.updatedAt) > new Date(maxUpdated)) maxUpdated = o.updatedAt;
      } catch (e) {
        stats.errors.push(`${o.name}: ${String(e).slice(0, 300)}`);
        await sb.from("shopify_sync_orders").upsert({ shopify_order_id: o.id, order_name: o.name, created_at_shopify: o.createdAt, updated_at_shopify: o.updatedAt, status: "error", error: String(e).slice(0, 1000), updated_at: new Date().toISOString() });
      }
    }
    if (!conn.pageInfo.hasNextPage) {
      if (stats.errors.length === 0 && maxUpdated) await sb.from("shopify_sync_config").update({ orders_watermark: maxUpdated }).eq("id", 1);
      return;
    }
    after = conn.pageInfo.endCursor;
  }
  // >5 pages: watermark intentionally NOT advanced; next run continues.
}

async function syncPayouts(token: string, cfg: any, stats: RunStats): Promise<void> {
  let data: any;
  try {
    data = await shopify(cfg, `{ shopifyPaymentsAccount { payouts(first: 25) { nodes { id issuedAt status net { amount } summary { chargesFee refundsFee adjustmentsFee reservedFundsFee retriedPayoutsFee } } } } }`);
  } catch (e) {
    stats.errors.push("payouts scope/read failed (grant read_shopify_payments_payouts?): " + String(e).slice(0, 200));
    return;
  }
  for (const p of data?.shopifyPaymentsAccount?.payouts?.nodes ?? []) {
    if (p.status !== "PAID" || !p.issuedAt) continue;
    if (new Date(p.issuedAt) < new Date(cfg.backfill_start_at)) continue;
    const { data: ex } = await sb.from("shopify_sync_payouts").select("status").eq("shopify_payout_id", p.id).maybeSingle();
    if (ex?.status === "booked") continue;
    try {
      const netC = cents(p.net?.amount);
      const s = p.summary ?? {};
      const feeC = cents(s.chargesFee?.amount) + cents(s.refundsFee?.amount) + cents(s.adjustmentsFee?.amount) + cents(s.reservedFundsFee?.amount) + cents(s.retriedPayoutsFee?.amount);
      if (netC <= 0) continue; // negative/zero payouts (clawbacks) -> manual review, leave unbooked
      const dep = await qbo(token, "POST", "/deposit", {
        TxnDate: ptDate(p.issuedAt),
        DepositToAccountRef: { value: QBO_BANK_ACCOUNT },
        PrivateNote: `shopify-qbo-sync payout ${p.id}`,
        Line: [
          { Amount: dollars(netC + feeC), DetailType: "DepositLineDetail", Description: "Shopify payout — gross from clearing", DepositLineDetail: { AccountRef: { value: cfg.qbo_clearing_account_id } } },
          ...(feeC !== 0 ? [{ Amount: -dollars(feeC), DetailType: "DepositLineDetail", Description: "Shopify processing fees", DepositLineDetail: { AccountRef: { value: cfg.qbo_fee_account_id } } }] : []),
        ],
      });
      await sb.from("shopify_sync_payouts").upsert({ shopify_payout_id: p.id, issued_at: p.issuedAt, net: dollars(netC), fee: dollars(feeC), status: "booked", qbo_deposit_id: dep?.Deposit?.Id, error: null, booked_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      stats.payouts_booked++;
    } catch (e) {
      stats.errors.push(`payout ${p.id}: ${String(e).slice(0, 200)}`);
      await sb.from("shopify_sync_payouts").upsert({ shopify_payout_id: p.id, issued_at: p.issuedAt, status: "error", error: String(e).slice(0, 1000), updated_at: new Date().toISOString() });
    }
  }
}

Deno.serve(async (req: Request) => {
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
  if ((req.headers.get("x-internal-secret") ?? "") !== INTERNAL_SECRET || !INTERNAL_SECRET) return j({ error: "forbidden" }, 403);

  const { data: cfg, error: cfgErr } = await sb.from("shopify_sync_config").select("*").eq("id", 1).single();
  if (cfgErr || !cfg) return j({ error: "config read failed: " + cfgErr?.message }, 500);
  if (!cfg.enabled) return j({ disabled: true, note: "set ops.shopify_sync_config.enabled = true after Shopify token + channel-app disconnect" });
  if (!SHOPIFY_TOKEN) return j({ error: "SHOPIFY_ADMIN_TOKEN secret not set" }, 500);

  const mode = new URL(req.url).searchParams.get("mode") ?? "all";
  const stats: RunStats = { orders_booked: 0, refunds_booked: 0, payouts_booked: 0, skipped: 0, errors: [] };
  try {
    const token = await qboToken();
    const { data: mapRows } = await sb.from("shopify_item_map").select("shopify_sku, qbo_item_id");
    const itemMap = new Map((mapRows ?? []).map((r: any) => [r.shopify_sku, r.qbo_item_id]));
    if (mode === "orders" || mode === "all") await syncOrders(token, cfg, itemMap, stats);
    if (mode === "payouts" || mode === "all") await syncPayouts(token, cfg, stats);
  } catch (e) {
    stats.errors.push("run: " + String(e).slice(0, 400));
  }
  const summary = `booked ${stats.orders_booked} orders, ${stats.refunds_booked} refunds, ${stats.payouts_booked} payouts; ${stats.skipped} skipped; ${stats.errors.length} errors`;
  await sb.from("shopify_sync_config").update({ last_run_at: new Date().toISOString(), last_result: { summary, ...stats } }).eq("id", 1);
  return j({ summary, ...stats }, stats.errors.length ? 207 : 200);
});
