# BRIX Refractor — User Guide

> **Live URL:** `alamedapointbg.com/margin/`
> **This guide:** `alamedapointbg.com/margin/docs/margin-control/`
> **Editable source:** `apbg-billing/docs/margin-control/user-guide.md` on GitHub. The viewer fetches this file at runtime — edit it, push, and the guide updates on the next Netlify deploy.

BRIX Refractor is the internal margin / product / customer analytics tool — named for the instrument that measures degrees Brix in a sample. It reads QuickBooks invoice and item data through a curated `ops.*` schema in Supabase and renders 9 dashboards around it. This guide covers what each page does, the controls on it, and the workflows people use it for.

---

## Getting started

### Sign in

1. Open **alamedapointbg.com/margin/**.
2. The login screen asks for email + password — same Supabase account you use for the rest of APBG.
3. Hit **Sign in**. You'll land on the **Overview** page.

If your email isn't recognized, ask Sky or Whitney to create an account in the Operations Hub admin panel (`alamedapointbg.com/admin.html`).

### Who sees what

Everyone with an APBG login can read the data. Some admin-only screens (Settings → Sales Reps, Settings → Categories) check your role server-side and quietly hide controls if you're not a superadmin. If a screen looks "empty" or read-only, that's likely role-gating — not a bug.

### Sidebar (left)

8 sections, in order: **Overview · Margin · Customers · Plans · Production · Compare · Inventory · Reports · Settings**. Click any item to jump.

### Header (top right)

Shows the current data freshness — a "LIVE" badge plus how long ago the cost cache was synced and when the QBO sync last ran. If the cost cache is stale (orange), trigger a cost sync from the Margin page header.

---

## Overview

**What it's for:** the daily landing — hero KPIs, sparkline trends, top movers. Open this every morning to see if anything is off.

### KPI cards (top row)

Six tiles, each showing a current value, a comparison to prior period, and a sparkline:

| KPI | What it is |
|---|---|
| **Revenue** | Total invoice revenue, YTD |
| **Gross margin %** | (Revenue − COGS) / Revenue, YTD |
| **Net income** | From the latest P&L snapshot |
| **AR outstanding** | Sum of `balance > 0` invoices |
| **AR overdue** | Subset of AR where `due_date < today` |
| **Active customers** | Distinct customers with activity in the period |

Each card's sparkline shows the last 12 months. A green up-arrow + percentage means the latest value is up vs. prior period; red down-arrow means down.

### Top movers strip

Below the KPI cards: a horizontal strip of the biggest week-over-week or month-over-month movers — both up and down. Click any chip to drill into that customer or item.

### Filters

Default is **YTD · All entities**. Use the date pickers in the page header to scope the whole page to a specific range (e.g. last 30 days, single month). The "All entities" pill in the same header filters across Brix / Alameda Soda / FreeFlow / shared.

### Common workflows

- **Morning check:** open Overview, scan the six KPI cards. Any red arrow that wasn't there yesterday is worth a click.
- **Investigate a drop:** click the sparkline on the affected KPI → it deep-links to the Margin page filtered to whatever moved the number.
- **Quick narrative:** the top-movers strip gives you "X is up, Y is down" sentences for a status update without leaving the page.

---

## Margin

**What it's for:** the heavyweight margin pivot. Drill by category, item, customer, month, or entity. Compare prior period / prior year. Export to CSV.

### The pivot

The center of the page is a MUI X DataGrid Pro showing the current pivot. Columns include revenue, COGS, gross profit, gross margin %, est. cost (from item master), est. margin %. Rows are grouped by the dimension you pick in the header.

### Filters (page header)

| Filter | What it does |
|---|---|
| **Date range** | Start + end dates. Use the presets (YTD, last quarter, last 12 months) or pick exact dates. |
| **Entity** | Brix · Alameda Soda · FreeFlow · shared. Multi-select. |
| **Customer / Item / Category / Segment** | Multi-select pickers — type to search, click to add chips. |
| **Group by** | Choose the pivot dimension: category, item, customer, month, segment, entity. |

### Drilldown (row click)

Click any row in the pivot to open the **Row Detail Modal**: shows the underlying invoice lines that built that row, plus a mini chart and a "filter by this row" button. The button adds that row's value as a chip filter on the page so you can keep narrowing.

### Compare columns

In the header, toggle **Prior period** or **Prior year**. Two extra columns appear next to each metric: the comparison value and the delta as a percentage with color (green/red).

### Export

The **Export CSV** button (top right of the grid) downloads the current pivot exactly as you see it — same columns, same rows, same filter chips applied. Useful for emailing a quarterly margin breakdown.

### Sync costs

The Margin page header shows the last time the QBO item cost cache was refreshed. If it's stale (>24h), click **Sync Item Costs**. That triggers `sync-qbo-items` server-side and re-populates `ops.qbo_items.purchase_cost`. The est. cost / est. margin columns light up once it's done.

### Chain Rollup picker (exclude)

The **Rollup** picker in the Margin filter bar lets you **subtract a chain's revenue from the totals** so you can see what the numbers look like *without* that chain. Useful for "real margin excluding Melt" or "non-chain customer mix" questions.

- Click `MTE` (Melt E&S) → the totals row drops by the Melt amount; the hero line shows `· excluding: MTE (Nc · Mi)` so you can see the bucket size that got subtracted.
- Stack multiple chips (e.g. `MTE` + `SBE` Starbird E&S) to subtract more.
- Clear the chips to return to the baseline.

Rollup definitions live under **Settings → Chain Rollups** (admin) — each rollup is an ILIKE pattern over customer names. The picker resolves the pattern to a real customer list at the moment you click, so renames in QBO don't silently break the math.

### Common workflows

- **Quarterly margin review:** date = last quarter, group by category, prior-period on. Export. Done.
- **Investigate a customer:** customer filter = one chip, group by item, prior-year on. Tells you which items moved.
- **Spot underpriced items:** group by item, sort by est. margin % ascending. Lowest margins surface first.

---

## Customers

**What it's for:** the customer master. Find a customer, see their classification, parent/sub chain, address, and recent revenue.

### List view

The Customers page is an MUI DataGrid Pro — searchable, sortable, draggable, paginated. Use the search box at the top to filter by name. Toolbar filters: **Channel** dropdown, **Show inactive** checkbox.

Columns (drag headers to reorder, click headers to sort, right-click for show/hide):

- **Customer** — name (pinned left). Sub-customers show a SUB badge; inactive show INACTIVE.
- **State** — billing-address state
- **Channel** — primary channel
- **YTD Revenue** — current year invoiced
- **Invoices** — count this YTD
- **Segment** — RFM segment (Champions / Loyal / At-risk / Lost / etc.)
- **RFM** — 0–15 composite score

The list is capped at 200 of the most recent active customers by revenue (server-side `LIMIT 200`). If you can't find someone, search by name to pull them in regardless of the cap, or toggle **Show inactive**.

### Customers with no name

If you see a row reading `(no name · QBO #1234)` in italic amber, that customer was deleted in QBO after their invoices were already created. The invoice record persists (we still need it for revenue history), but the master record is gone. There were 22 of these in May 2026 — they've been backfilled as inactive ghost rows with the QBO-recorded name + `(deleted)` suffix, so they only show with **Show inactive** on. If a new one appears, message Sky with the QBO ID.

### Click a row

Opens the **Customer Detail** page. The list remembers your filters when you come back.

### Adding / editing customers

Customer master edits happen in **Settings → Customers**. The Customers page itself is read-only — it's the "view from the field" surface.

---

## Customer Detail

**What it's for:** everything about one customer in one place.

Header: customer name + classification + entity + total YTD revenue. Below the header, four sections:

### 1. Contact & address

Parent chain (if a sub), billing address (multi-line postal style: line 1 on top, City, ST ZIP below), contact info pulled from QBO. "Open in QBO" link sends you to the customer record on QuickBooks.

**Sub-customer address fallback.** When a sub-customer has no address of its own (common in QBO when address is set on the parent), the detail card now falls back to the parent customer's address. The card always shows _something_ when an address exists anywhere in the chain.

### 2. Revenue summary

YTD revenue, prior year, delta. AR outstanding, AR overdue. Average days-to-pay. Number of active invoices.

### 3. Margin by item

Mini pivot — every item this customer has been billed for in the date range, with revenue, est. cost, est. margin %, and quantity. Sort by margin % to find your worst-priced items for this customer.

### 4. Recent invoices

The last 20-50 invoices, newest first. Click any invoice to see its line items.

### Common workflows

- **Before a customer call:** open Customer Detail, scan revenue summary, screenshot the margin-by-item mini pivot. Five-minute prep.
- **Pricing review:** open the customer, sort margin-by-item ascending by margin %. Anything under your target margin is a conversation.

---

## Plans

**What it's for:** annual revenue / COGS / margin planning, built bottom-up from last year's actuals. The plan _is_ a P&L — open it and you see Revenue → COGS → Gross Margin → OpEx → Net Income directly, with editable cells inside each section.

A plan has a fiscal year + a name (e.g. "QBO Budget FY2026") + a status. The Plans landing page lists every plan you have. Click a plan to open the editor.

### Tabs inside a plan

- **P&L** (default landing) — read-only P&L view. Revenue lines, COGS lines, Gross Margin row (with %), OpEx lines, Net Income row (with %). Rows are grouped by P&L line label inside each section, then by item category.
- **Plan Lines** — the same data, fully editable, with the same P&L grouping plus per-month inputs. The pane you spend the most time in.
- **vs Actuals** — item-level variance: YTD plan vs. YTD actual, % delta, status badge.
- **Forecast** — projects full-year totals based on YTD pace.

### Plan Lines tab — how it works

The grid is grouped by section, then by P&L line (e.g. "BIB - 3 Gallon"), then by item. Subtotals appear at every level: pl_line subtotal, section subtotal (TOTAL REVENUE, TOTAL COGS, TOTAL OPERATING EXPENSES), plus computed **Gross Margin** (Revenue − COGS) and **Net Income** (GM − OpEx) rows with % of revenue.

**Expand / collapse arrows.** Every section and every pl_line group has a ▶/▼ caret. Click to toggle:
- Collapse a section → only its subtotal remains visible
- Collapse a pl_line group → only its subtotal remains visible

Use this to roll up to account level: collapse all pl_lines under Revenue and you get the per-account revenue breakdown with the Gross Margin still showing one row below.

**View modes** (top right of the table): switch between Revenue ($) / Qty / Price ($/unit) / Cost ($/unit). The same grid renders different cell values; the section grouping persists.

**Editing.** Click any monthly cell to type a new value. Tab/Shift-Tab to move horizontally. Blur (click away) commits. Changes save immediately to `sales_plan_lines`.

**Quick actions per row.** `÷12` button spreads an annual total flat across 12 months. `×` deletes the line.

### Build... dialog — bottom-up planning

Click **BUILD…** in the toolbar to open the plan-build dialog. Workflow:

1. **Source year** — defaults to the plan year minus 1. The dialog pulls last year's actual qty, average unit price, revenue, and customer count for every item in the chosen category.
2. **Category** — pick a QBO item category (e.g. "Beverages:3 Gallon BIB"). The table populates with one row per item in that category.
3. **Default qty %** and **Default price %** — apply to every row when you click **Apply defaults to all**. Per-item overrides are still editable.
4. **Per-item growth.** Each row has its own **Qty %** and **Price %** inputs. Live computed Plan Qty / Plan Price / Plan Revenue columns update as you type, plus a footer total for the whole category.
5. **Apply** — writes the plan lines via `fn_plan_build_from_growth`. Customers × items already in the plan for those items get overwritten with the new growth assumptions; the assumptions themselves are stored on the line so you can see what built it later.

Items in the chosen category that had zero sales last year still appear, but greyed out — set their growth manually or skip them.

### Other toolbar buttons

- **COPY FROM &lt;prior year&gt;** — bulk autofill from prior year's actuals with a single uniform multiplier. Older / simpler alternative to Build.
- **PUSH TO QBO** — generates a QuickBooks Online Budget import CSV. Drop into QBO → Settings → Tools → Budgeting → Import.
- **EXPORT CSV** — downloads plan lines aggregated by account, sorted by total.

### Common workflows

- **Build next year's plan.** New plan → set FY → open → Build → pick "3 Gallon BIB" category → +5% qty, +3% price → Apply. Repeat for each category. Switch to the P&L tab to sanity-check Gross Margin %.
- **What if we raised prices 8%?** Open the plan → Build → set Default price % to 8 → Apply defaults to all → click Apply. Plan Lines tab now shows Revenue up 8% with COGS unchanged → GM expands. Net Income row reflects the bottom-line impact.
- **Sales is asking what we'd need to grow 15% revenue.** Open Build → start with qty +15% / price 0 → see if the implied volumes are realistic. Iterate by category — some flavors can grow 25%, others maybe 5%.

---

## Production

**What it's for:** Bills of Materials (BOMs), work orders (production batches), and purchase orders.

### BOMs

A BOM is a recipe: finished good + a list of component items and service costs per yield unit. Click a BOM row in the list to open the detail modal.

**Editor sections:**

- **Name + version + yield** — what the BOM produces and the yield qty/UoM per batch run.
- **1 &lt;yield-uom&gt; produces &lt;N&gt; gal** — the bridge that lets you scale a count-based BOM (e.g. "1 case") by gallons. Only shows when yield UoM is a count unit.
- **Scale to make &lt;qty&gt; &lt;UoM&gt;** — the calculator at the top of every BOM modal. Type a target volume and pick the UoM (gal, oz, case, etc.). The header strip shows how many batch runs that would require, and **every BOM row below populates a "Required" column** with its scaled quantity in the correct UoM.
- **BOM rows** — editable Type / Component / Qty per yield / UoM / Scrap % / Unit cost / Notes table. The **Required** column only appears when "Scale to make" has a non-zero target — otherwise rows show just the per-yield ratios.

**The trick.** The per-yield values are what's _saved_. The Required column is a display-only multiplier — entering a target volume doesn't modify the BOM, it just shows what running the recipe at that scale would consume.

When the target UoM doesn't fit the BOM's natural family (e.g. you ask for gallons of a BOM that yields cases without a gal-per-case bridge), you'll get an amber "Can't convert" message pointing at the missing bridge.

### Work orders

A work order is a production batch tied to a BOM. Status flows: **draft → consumed → closed** (or **void**). When you close a work order, costs are locked in `ops.work_order_costs` and pushed to QBO if your environment is wired for QBO writebacks.

The Work Order detail modal opens with breathing room at the top of the screen so the header is never cut off, regardless of how tall the modal grows.

### Purchase orders

Vendor PO management — track expected ship date, BOL, receipt status. Outside the scope of margin planning; see the Production page for details.

---

## Compare

**What it's for:** rigorous period-vs-period comparison without leaving the page. More flexible than the Margin page's prior-period toggle.

### Layout

Two date-range pickers side by side: **Period A** and **Period B**. Pick anything for each — same month last year vs. this month, Q1 vs. Q2, 2025 vs. 2026. Below them, a multi-select for the dimension to compare on (customer, item, category, entity).

### Output

A side-by-side table: rows are the dimension values; columns are Period A, Period B, delta absolute, delta percent. Coloring is automatic — bigger green = bigger improvement, deeper red = bigger drop.

### Quick presets

Buttons above the date pickers: **MoM** (this month vs last), **QoQ** (this quarter vs last), **YoY** (this period vs same period last year). One click and the dates fill in.

### Common workflows

- **Board prep:** YoY, group by category, export to CSV.
- **Diagnose a slow month:** MoM, group by customer, sort by delta absolute descending. The biggest declines float to the top.

---

## Inventory

**What it's for:** item master. Every product or service you sell, with its est. cost and the P&L account it should map to.

### Columns

Item name · SKU · Category · Segment · Type (inventory / service / non-inventory) · Est. cost (purchase price) · Last cost update · **P&L Alignment** (the QBO account this item routes COGS to) · Notes.

### P&L Alignment column

This is the newest column (shipped in v0.9.23). It flags items whose category doesn't match what their P&L account expects. Click the **Auto-categorize from P&L** button to apply suggestions in bulk — preview first, then commit.

### Filters

Category · Segment · Type · "Items missing cost" · "Items with P&L mismatch."

### Common workflows

- **Quarterly cost refresh:** click **Sync Item Costs** in the page header. Last-purchase-cost from QBO pushes into est. cost.
- **Clean up category drift:** filter to "P&L mismatch," review the Auto-categorize suggestions, commit the ones that look right.

---

## Reports

**What it's for:** named report views — Voids & Cross-sells, Anomalies, Health Movers, Inactive Customers, plus saved templates.

### Voids & Cross-sells

The deepest of the reports. Built around the idea of an **item set** — a curated list of items that "go together" (e.g. **CSD FOUNTAIN** = the 11 fountain flavors). For each customer that buys ≥1 item from the set, the report shows which set items they're missing (the **voids**) and the gap-dollar potential if they bought the missing items at their average per-item AOV.

#### The rules

Who appears:

1. **Bought at least one item from the set** in the selected date window. Customers who bought zero set items never appear — there's nothing to void if they're not a buyer.
2. **Active in QBO** (the 22 deleted-customer ghosts are filtered out).
3. **Total spend on the set ≥ Min set $** (toolbar field; default 0).
4. **"Hide completionists" satisfied** — when checked, customers who bought every item in the set are dropped (they have no voids).

"Has the item" rule:

- `has_item = revenue > 0` over the window. Any positive spend counts. Trial/sample purchases register as "has it" intentionally.

KPI cards:

| Card | Formula |
|---|---|
| **CUSTOMERS** | Visible customer rows after all filters |
| **COVERAGE** | Σ items_bought ÷ Σ items_possible — fraction of (customer × item) cells that are green |
| **GAP $ POTENTIAL** | Σ over customers of `(set_revenue ÷ items_bought) × (set_total − items_bought)` — heuristic upside if each missing item sold at the customer's average per-item AOV |
| **ITEMS IN SET** | Count of items in the set (constant) |

Gap $ is a heuristic, not a forecast. It assumes the missing items would have sold at the same per-item rate the customer already pays — fine for ranking, not for top-line forecasting.

#### Toolbar filters (left to right)

- **Set** — which item set to evaluate against (currently CSD FOUNTAIN; more can be defined in Settings → Item Sets).
- **From / To** — date window.
- **Min set $** — minimum total spend across the set before a customer qualifies.
- **# items ≥ N ≤ M** — minimum and maximum count of items in the set the customer must have bought. Leave M blank for "any". Example: `≥ 5` answers "who buys at least 5 flavors".
- **Hide completionists** — drops customers who bought every item (no voids to surface).

#### Per-item filter chips

Below the toolbar, one chip per item in the selected set. Click to cycle:

- **off** (grey outline) — no filter on this item
- **must buy** (green fill, `+` prefix) — customer must show ≥$0.01 spend on this item
- **must NOT buy** (red fill, `−` prefix) — customer must show $0 spend on this item

Multiple chips AND together. **Clear (N)** button resets all chips.

Example queries:

- "Who buys at least 5 flavors but no Cola" → `# items ≥ 5` + click the Cola chip twice (off → must buy → must NOT buy)
- "Customers missing Cranberry AND Orange Juice" → click both chips to red
- "Customers who buy 3-Gallon Cola AND Diet but nothing else" → all three to green (Cola, Diet), and `# items ≤ 2`

KPI cards (Customers, Coverage, Gap $) recompute from the filtered set, not the full population — so the numbers always describe what's visible.

#### The customer × item grid (DataGrid Pro)

- **Customer** column is pinned left and stays visible when you scroll right.
- Click any column header to sort. Item columns sort by **revenue on that item** — clicking "APT CRANBERRY" orders customers by cranberry spend descending.
- Drag column headers left/right to reorder.
- Burger menu on each header → hide, pin left/right, sort, filter on that column.
- Pagination dropdown at the bottom: 10 / 25 / 50 / 100 / 250 / All.
- Set Total column hidden by default; show via the column visibility menu.

Cell coloring: green with $ when bought, red with `—` when not.

### Other reports

- **Anomalies** — items + customers where YoY change is statistically unusual
- **Health Movers** — customers whose RFM segment shifted (improved or declined) in the last snapshot
- **Inactive Customers** — customers with no invoice in N days, sorted by lifetime revenue
- **AR aging** — open invoices bucketed by 0-30 / 31-60 / 61-90 / 90+

### Custom reports

Build a pivot on the Margin or Compare page, then click **Save view → Save as Report**. Give it a name. It shows up here for everyone.

---

## Tips & shortcuts

- **Saved filter views.** On Margin, Compare, Inventory, and Customers — once you've set filters you like, click **Save view** in the page header. Name it. It's saved in your browser (LocalStorage) and shows in the **Saved views** dropdown next time.
- **DataGrid Pro everywhere.** The Customers, Voids, Items, Compare, and Plans grids all share the same Pro feature set:
  - Click a column header to sort
  - Drag headers to reorder
  - Drag column edges to resize
  - Burger menu (right side of each header) → hide / pin left / pin right / sort / filter
  - Density toggle in the footer area when toolbar is shown
  - Footer pagination — 10 / 25 / 50 / 100 / 250 / All
- **Modals open lower.** Plan Build, BOM detail, and Work Order detail dialogs all open 90 px from the top of the viewport — top of the modal is always visible, body scrolls inside the panel.
- **Keyboard:** `⌘K` / `Ctrl K` doesn't open search inside Refractor yet — only on the Operations Hub. Coming.
- **Deep links:** the URL hash (`#/margin?from=2026-01-01&to=2026-03-31&group=customer`) reflects your filters. Bookmark or share a link and the recipient lands on the same view.
- **Mobile:** the app is usable down to ~1024 px. Below that, the DataGrid gets cramped. Use a laptop.
- **Refresh data:** click the LIVE badge in the header. It re-fetches the materialized view. New invoices appear within seconds of the QBO sync completing.
- **Last-resort refresh:** if the page seems frozen, hard-refresh (`⌘⇧R` / `Ctrl Shift R`). Filter state persists.

---

## In progress — coming next

- **Settings** — sub-screens still maturing: Customers master, Items master, Categories, P&L Alignment editor, Sales Reps assignment. Functional today; section will be added to this guide once the layout freezes.
- **OpEx side of the planner** — Build dialog currently only covers Revenue-side items. Planning OpEx bottom-up (rent, payroll, etc.) is a v0.10 enhancement.
- **Item-level COGS coupling on the plan** — today, Plan Lines stores `unit_cost` per line and the P&L view computes implied COGS = qty × unit_cost. Auto-updating unit_cost from current `qbo_items.purchase_cost` when the item changes is a v0.10 enhancement.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| KPI cards show "—" | First page load — RPCs still warming | Wait 2 sec or hit refresh |
| DataGrid shows "license expired" watermark | MUI X Pro license env var missing on Netlify | Ask Sky to set `VITE_MUI_X_LICENSE` and trigger a redeploy |
| Numbers seem stale | Materialized view hasn't refreshed since last QBO sync | Trigger refresh: `POST /functions/v1/sync-qbo?mode=refresh-mv` (admin only) |
| Numbers don't match QBO P&L for an income account | Account isn't mapped to a revenue line (sits in `(unspecified)`) | Open **Settings → Accounts** and assign a Category. Backfill is automatic on the next 10-min refresh tick. |
| One specific invoice's lines look wrong | Stale lines from before a QBO edit | Wait — the rolling refresh cron sweeps the last 90 days every ~6 hours. Or trigger an immediate refetch via the admin Master Control panel. |
| Health checks say "down" on the Ops Hub | You're not a superadmin → 403 on health endpoints. Cosmetic — systems are fine. | Ignore, or ask Sky to elevate your role |
| Login loops | Browser blocked Supabase third-party cookies | Allow cookies for `gfsdpwiqzshhexkofiif.supabase.co` |

If you hit something not on this list, message Sky on Slack with a screenshot.

---

## What's behind the curtain (for the curious)

The cache reconciles against QBO continuously now:

- **Nightly sync (09:00 UTC)** pulls all four QBO sales-transaction types — Invoices, Sales Receipts, Credit Memos, Refund Receipts — into `ops.qbo_invoices` + `ops.qbo_invoice_lines`. Credit Memos and Refund Receipts are stored as negative amounts so `SUM(amount)` directly equals net revenue.
- **Every 10 minutes**, a rolling refresh re-fetches lines for ~100 invoices in the last 90 days. Over ~6 hours the full window is refreshed once. Edits made to an invoice in QBO propagate within this window — no manual backfill needed.
- **Every 3 minutes**, a line-backfill cron catches any invoice that lost its line cache (rare, but it can happen if the sync function times out mid-loop).
- **Every 5 minutes**, a `pg_net` failure scanner watches for silent cron→HTTP errors so a broken sync can't hide for days like it did in early May 2026.

The Margin app reads from `ops.mv_sales_lines` (materialized view, ~50K rows, sub-100ms response). The view is refreshed automatically after every sync.

If you're ever debugging a number that doesn't match QBO live, the canonical authority order is: **QBO P&L → `ops.pl_snapshots` → `ops.mv_sales_lines` → Margin UI**. Drift between any two layers is a bug worth filing.

---

## Change log

| Date | Change |
|---|---|
| 2026-05-18 | **Big Plans rebuild.** Plan editor is now P&L-shaped end to end. New default tab — **P&L** — renders Revenue → COGS → **Gross Margin** → OpEx → **Net Income** with subtotals. **Plan Lines** tab uses the same P&L grouping with editable cells; section + pl_line headers have ▶/▼ collapse arrows so you can roll up to account level without leaving the editing surface. Account Rollup tab removed (the collapsed Plan Lines view supersedes it). EXPORT CSV repointed to aggregate plan lines client-side by account. New **BUILD…** dialog: pick a category (QBO item parent), see every item with last year's qty / avg price / revenue / customer count, set per-item **Qty %** and **Price %** growth (separate inputs), see live computed plan totals, apply via `fn_plan_build_from_growth`. New schema columns `qty_growth_pct` / `price_growth_pct` / `baseline_year` on `sales_plan_lines` so the assumptions that built a line stay visible. **BOMs** now auto-scale inline: enter "Make 1000 gal" at the top of the BOM modal and every row's **Required** column populates with the scaled quantity in the right UoM (replaces the separate ScaleBomPanel at the bottom). Plan Build, BOM detail, and Work Order detail dialogs all open 90px from the top of the screen — no more clipped headers. **Voids & Cross-sells** converted to DataGrid Pro (sort, drag-reorder, resize, column visibility, pinned Customer); added per-item filter chips (must buy / must NOT buy / off), `# items ≥ N ≤ M` range inputs, fixed the misleading "Require ≥1 item bought" label → "Hide completionists". CSD FOUNTAIN set gained **APT Cranberry**, **APT Orange Juice**, **APT Pineapple**. **Customers tab** customer name now renders `(no name · QBO #1234)` in italic amber when the master record is missing — and the 22 invoice-referenced customers that were deleted in QBO post-billing were backfilled as inactive ghost rows with their QBO-recorded `(deleted)` names. **Customer Detail** address card is now multi-line postal style; sub-customers without their own address fall back to the parent's. |
| 2026-05-17 | App renamed to **BRIX Refractor** — short, on-brand (a refractometer is the instrument that reads degrees Brix), and reflects the broader scope (items / inventory / categories / rollups in addition to margin). Operations page removed; that dashboard lives at `alamedapointbg.com/operations/` now. Hub card on alamedapointbg.com sits alongside a new Brixpense card. Wordmark unified to **BriXRefractor** (single token, **XR** highlighted in brand green). |
| 2026-05-17 | Added **Chain Rollup picker (exclude)** section under Margin — clicking a chip subtracts that chain's revenue from totals. Added **What's behind the curtain** explainer for the new polymorphic sync (Sales Receipts, Credit Memos, Refund Receipts, Discounts) and the self-healing rolling refresh. Added troubleshooting rows for unmapped income accounts and stale lines. |
| 2026-05-11 | Initial scaffold. Covers Getting Started + Overview + Margin + Customers + Customer Detail + Compare + Inventory + Reports + Tips. Operations / Plans / Settings flagged as in progress. |
