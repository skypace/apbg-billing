# BRIX Margin Control — User Guide

> **Live URL:** `alamedapointbg.com/margin/`
> **This guide:** `alamedapointbg.com/margin/docs/margin-control/`
> **Editable source:** `apbg-billing/docs/margin-control/user-guide.md` on GitHub. The viewer fetches this file at runtime — edit it, push, and the guide updates on the next Netlify deploy.

BRIX Margin Control is the internal margin / sales / customer analytics tool. It reads QuickBooks invoice and item data through a curated `ops.*` schema in Supabase and renders 9 dashboards around it. This guide covers what each page does, the controls on it, and the workflows people use it for.

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

9 sections, in order: **Overview · Margin · Operations · Customers · Reports · Plans · Compare · Inventory · Settings**. Click any item to jump.

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

The Customers page is a searchable list. Use the search box at the top to filter by name. Filter chips down the side scope to:

- **Classification** (active / prospect / inactive / churned)
- **Entity** (which billing entity owns the record)
- **Parent only** (hide sub-locations, show only chain parents)

The list shows: name, classification chip, parent chain (if a sub), entity, last invoice date, last 90-day revenue.

### Click a row

Opens the **Customer Detail** page. The list remembers your filters when you come back.

### Adding / editing customers

Customer master edits happen in **Settings → Customers**. The Customers page itself is read-only — it's the "view from the field" surface.

---

## Customer Detail

**What it's for:** everything about one customer in one place.

Header: customer name + classification + entity + total YTD revenue. Below the header, four sections:

### 1. Contact & address

Parent chain (if a sub), billing/shipping address, contact info pulled from QBO. "Open in QBO" link sends you to the customer record on QuickBooks.

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

**What it's for:** save and export reusable report templates. If you find yourself building the same pivot every Monday, save it as a Report.

### Available templates

- **Monthly margin recap** — Margin pivot, last month, group by category, prior-period on
- **Customer margin** — Margin pivot, last 90 days, group by customer
- **Item margin** — Margin pivot, last quarter, group by item
- **AR aging** — Open invoices bucketed by 0-30 / 31-60 / 61-90 / 90+
- **YoY by category** — Compare page, YoY, group by category

### Run a report

Click a template card. Reports run in a side panel — you can tweak filters before committing. **Export** drops a CSV. **Schedule** (coming) will email the report on a cadence.

### Custom reports

Build a pivot on the Margin or Compare page, then click **Save view → Save as Report**. Give it a name. It shows up here for everyone.

---

## Tips & shortcuts

- **Saved filter views.** On Margin, Compare, Inventory, and Customers — once you've set filters you like, click **Save view** in the page header. Name it. It's saved in your browser (LocalStorage) and shows in the **Saved views** dropdown next time.
- **Keyboard:** `⌘K` / `Ctrl K` doesn't open search inside Margin Control yet — only on the Operations Hub. Coming.
- **Deep links:** the URL hash (`#/margin?from=2026-01-01&to=2026-03-31&group=customer`) reflects your filters. Bookmark or share a link and the recipient lands on the same view.
- **Mobile:** the app is usable down to ~1024 px. Below that, the DataGrid gets cramped. Use a laptop.
- **Refresh data:** click the LIVE badge in the header. It re-fetches the materialized view. New invoices appear within seconds of the QBO sync completing.
- **Last-resort refresh:** if the page seems frozen, hard-refresh (`⌘⇧R` / `Ctrl Shift R`). Filter state persists.

---

## In progress — coming next

The following pages exist but are still maturing. They'll be added to this guide as they freeze:

- **Operations** — KPIs for delivery / service / reman (some content currently lives in APBG-OPS).
- **Plans** — plan-based pricing model editors. Schema is settling.
- **Settings** — sub-screens still moving (Customers master, Items master, Categories, P&L Alignment editor, Sales Reps assignment).

Each will get its own section in this guide as soon as the screen is stable.

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
| 2026-05-17 | Added **Chain Rollup picker (exclude)** section under Margin — clicking a chip subtracts that chain's revenue from totals. Added **What's behind the curtain** explainer for the new polymorphic sync (Sales Receipts, Credit Memos, Refund Receipts, Discounts) and the self-healing rolling refresh. Added troubleshooting rows for unmapped income accounts and stale lines. |
| 2026-05-11 | Initial scaffold. Covers Getting Started + Overview + Margin + Customers + Customer Detail + Compare + Inventory + Reports + Tips. Operations / Plans / Settings flagged as in progress. |
