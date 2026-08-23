# BRIX Refractor (Margin Control) — Sales, Margin & Catalog Analytics

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

BRIX Refractor is APBG's internal sales, margin, customer, and catalog analytics app — named for the refractometer, the instrument that reads degrees Brix. It reads QuickBooks invoice and item data mirrored into the Supabase `ops.*` schema and renders operator dashboards around it. This chapter is a working summary for staff plus a pointer to the full interactive guide; it is not a duplicate of that guide.

## Where it lives

| Thing | Location |
|---|---|
| App | https://alamedapointbg.com/margin/ |
| Full interactive user guide | https://alamedapointbg.com/margin/docs/margin-control/ |
| Guide source (edit → push → live on next deploy) | `apbg-billing/docs/margin-control/user-guide.md` |
| Source code | `apbg-billing/app/` (React 18 + Vite + MUI X Pro, builds to `public/sales-next/`) |
| Login | Supabase email + password — same account as the rest of APBG |

If your email isn't recognized, ask Sky or Whitney to create an account in the Operations Hub admin panel (https://alamedapointbg.com/admin.html). Everyone with an APBG login can read the data; admin-only screens (Settings sub-screens like Sales Reps and Categories) quietly hide their controls if you're not a superadmin — a "read-only-looking" screen is usually role-gating, not a bug.

## The main screens

The sidebar sections: **Overview · Margin · Customers · Plans · Production · Compare · Inventory · Reports · Settings**. The header shows data freshness — a LIVE badge, cost-cache age, and last QBO sync time.

### Overview (the daily dashboard)

Six KPI cards with 12-month sparklines — Revenue (YTD), Gross margin %, Net income, AR outstanding, AR overdue, Active customers — plus a "top movers" strip of the biggest week/month-over-month changes. Default scope is YTD · All entities; date pickers and the entity pill (Brix / Alameda Soda / FreeFlow / shared) scope the whole page. Morning routine: scan the cards, click into any new red arrow.

### Margin (the heavyweight pivot)

A DataGrid Pro pivot over invoice lines: revenue, COGS, gross profit, GM %, est. cost, est. margin %. Group by category, item, customer, month, segment, or entity; filter by date range, entity, and multi-select chips. Click a row for the drilldown modal (underlying invoice lines + "filter by this row"). Toggle **Prior period** / **Prior year** for comparison columns. **Export CSV** downloads exactly what's on screen.

Two Margin-page specials:

- **Sync Item Costs** — if the cost cache header is stale (>24h), this triggers a server-side refresh of `ops.qbo_items.purchase_cost`; the est. cost / est. margin columns light up when done.
- **Chain Rollup picker (exclude)** — chips like `MTE` (Melt E&S) or `SBE` (Starbird E&S) *subtract* that chain's revenue from the totals, answering "what does margin look like without Melt?" Rollups are defined under Settings → Chain Rollups as ILIKE patterns over customer names, resolved to a live customer list at click time (with runtime fuzzy matching since v0.9.27), so QBO renames don't silently break the math.

### Customers + Customer Detail

The customer master list (search, channel filter, show-inactive toggle) with state, channel, YTD revenue, invoice count, RFM segment and score. The list caps at the top 200 active customers by revenue — search by name to pull in anyone else. Rows reading `(no name · QBO #1234)` in amber are customers deleted in QBO after invoicing; they persist as inactive ghost rows for revenue history.

Clicking a row opens **Customer Detail**: contact & address (sub-customers fall back to the parent's address), revenue summary (YTD vs prior year, AR, days-to-pay), a margin-by-item mini pivot (sort ascending by margin % before a pricing call), and recent invoices. The list is read-only; master-record edits happen in **Settings → Customers**, which also carries the **per-customer entity** assignment (shipped v0.9.24).

### Plans

Annual revenue/COGS/margin planning shaped like a P&L: Revenue → COGS → Gross Margin → OpEx → Net Income, with editable monthly cells in the Plan Lines tab, a vs-Actuals variance tab, and a Forecast tab. The **BUILD…** dialog does bottom-up planning per QBO item category with per-item Qty % / Price % growth. **PUSH TO QBO** generates a QBO Budget import CSV. See the full guide for the complete planning workflow.

### Compare

Two arbitrary date ranges (Period A vs B) compared on any dimension, with MoM / QoQ / YoY presets. More flexible than the Margin page's prior-period toggle.

### Inventory (items master, field view)

Every item with SKU, category, segment, type, est. cost, last cost update, and the **P&L Alignment** column (which QBO account its COGS routes to). Filters include "Items missing cost" and "Items with P&L mismatch." The **Auto-categorize from P&L** button applies bulk category suggestions from the P&L alignment audit (`fn_item_pl_audit` / `fn_apply_pl_category_suggestions`, shipped v0.9.23) — preview first, then commit. A data-hygiene summary (`fn_item_hygiene_summary`, v0.9.26) backs the cleanup workflow.

### Reports

Named report views: **Voids & Cross-sells** (the deep one — item-set coverage per customer, gap-$ potential, per-item must-buy/must-not-buy chips), Anomalies, Health Movers, Inactive Customers, AR aging. Any pivot on Margin or Compare can be saved as a shared report via **Save view → Save as Report**.

### Settings (admin)

Sub-screens still maturing: **Customers master, Items master, Categories, P&L Alignment editor, Sales Reps** (assignment + commission), plus Chain Rollups and Item Sets definitions. The Items master (Settings → Items) is where the QBO writeback buttons live — see below.

### Production

The Production section (Formulas & Spec Sheets, BOMs, Work Orders, Purchase Orders, Co-Pack Legacy) has its own chapter: [Production — Formulas, BOMs, Work Orders & Purchase Orders](#/10-production).

### Proposal Builder

Refractor also hosts the **Proposal Builder** (`ProposalBuilderPage`) for sales proposals:

- **Venue templates** — a "Start from a Template" gallery (Restaurants, Corporate Cafes, Bars, Fast Casual, Grocery) that pre-fills business type, lease terms, service plan, and a suggested beverage lineup.
- **Product images** — served from the real catalog (`ops.qbo_items` joined to `orders.catalog`, images in the `brix-catalog-images` bucket), so beverage rows show actual product photos.
- **Brand Library** — replaced the retired Brandox subscription (2026-07-04). Brand art lives in the Supabase `brand-assets` public Storage bucket, managed in-app: upload type-tagged assets (logo / can / equipment / hero / testimonial / sell-sheet / other) and delete, backed by `proposal-brand-assets.mjs` (roles: superadmin / admin / sales). Four built-in Brix/Alameda logos always merge in as a never-empty fallback.

## QBO writebacks — what the buttons actually change in QuickBooks

Refractor's writebacks go through the **`push-qbo-item`** Supabase edge function (v2). Two paths:

| Action in Refractor | What changes in QBO |
|---|---|
| **Active toggle** on an item (Settings → Items) | Flips `Item.Active` on the QuickBooks item — deactivating an item here really deactivates it in QBO. |
| **Push to QBO** / bulk category sync (Settings → Items) | Runs `bulkSyncCategories`: rewrites each item's **Category (ParentRef)** in QBO to match Refractor's category assignment. The UI runs a **dry-run first** and shows what would change, then you commit. |

Treat these as real accounting changes, not app settings: the P&L alignment workflow is *audit → auto-categorize locally → review → Push to QBO*. If you're not sure, stop at the dry-run and ask Sky.

## Data freshness & troubleshooting (short version)

- Nightly sync (09:00 UTC) pulls all QBO sales transaction types; a rolling refresh re-fetches recent invoice lines every ~10 minutes, so QBO edits propagate within hours without manual backfill. The app reads from the `ops.mv_sales_lines` materialized view (sub-100 ms responses).
- Authority order when a number looks wrong: **QBO P&L → `ops.pl_snapshots` → `ops.mv_sales_lines` → Refractor UI**. Drift between layers is a bug — report it.
- "License expired" watermark on grids = missing `VITE_MUI_X_LICENSE` env var on Netlify; ask Sky.
- Stale numbers = trigger a materialized-view refresh (admin) or click the LIVE badge to re-fetch.
- The full troubleshooting table lives in the interactive guide.

## Related

- Full interactive guide: https://alamedapointbg.com/margin/docs/margin-control/ (source: `apbg-billing/docs/margin-control/user-guide.md`)
- Architecture: `apbg-billing/architecture/MARGIN-CONTROL.md`
- [Production — Formulas, BOMs, Work Orders & Purchase Orders](#/10-production)
- [APBG Gateway — Operations Hub, Login, Roles & App Manager](#/01-gateway-hub)
- [Master Control — Health, ResQ Sync, Linked Customers, Maintenance & Sweeps](#/09-master-control)
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering)
