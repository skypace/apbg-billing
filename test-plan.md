# BRIX Refractor — QA Test Plan

**Source guide:** `docs/margin-control/user-guide.md` (commit on branch `claude/qa-brix-refractor-VLgQq`)
**Repo:** `skypace/apbg-billing`
**App root:** `app/` (React/Vite SPA, builds to `public/sales-next/`)
**Live URL:** `alamedapointbg.com/margin/`
**Data backend:** Supabase project `gfsdpwiqzshhexkofiif`, schema `ops`
**QBO realm under test:** `9130352144155116` (APBG_Billing)
**Ground-truth connector:** QB Connector MCP (`pacerfinance.netlify.app/qbo`) — used read-only

Each claim below is a single, independently testable statement extracted from the user guide. Claims are grouped by section for review readability; the `claim-N` identifier is what will appear in `qa-report.md`.

> Scope note: this plan covers what the **user guide** says the program does. Claims about other surfaces in the same repo (Brixpense, 3rd-party billing, ResQ-SF sync, Master Control) are out of scope.

---

## A. Getting started & shell

- **claim-1** — App login screen accepts the same Supabase email+password used elsewhere in APBG.
- **claim-2** — On successful sign-in the user lands on the **Overview** page (not Margin / Login / blank).
- **claim-3** — Sidebar contains exactly these sections in order: **Overview · Margin · Customers · Plans · Production · Compare · Inventory · Reports · Settings**. (Guide text says "8 sections" then lists 9 — discrepancy to flag.)
- **claim-4** — Header (top right) displays a "LIVE" data-freshness badge.
- **claim-5** — Header shows how long ago the **cost cache** was synced.
- **claim-6** — Header shows when the **QBO sync** last ran.
- **claim-7** — Cost-cache freshness flips to an "orange / stale" state when older than 24 h.
- **claim-8** — Admin-only screens (Settings → Sales Reps, Settings → Categories) hide controls server-side for non-superadmins.

## B. Overview page

- **claim-9** — Overview renders six KPI tiles.
- **claim-10** — KPI #1 "Revenue" = total invoice revenue YTD per QBO.
- **claim-11** — KPI #2 "Gross margin %" = (Revenue − COGS) / Revenue, YTD.
- **claim-12** — KPI #3 "Net income" comes from the latest `ops.pl_snapshots` row (matches QBO P&L net income).
- **claim-13** — KPI #4 "AR outstanding" = sum of invoices where `balance > 0`.
- **claim-14** — KPI #5 "AR overdue" = subset of AR where `due_date < today`.
- **claim-15** — KPI #6 "Active customers" = distinct customers with activity in the selected period.
- **claim-16** — Each card displays: current value, comparison vs prior period, and a 12-month sparkline.
- **claim-17** — Green up-arrow + % when latest value > prior; red down-arrow + % when <.
- **claim-18** — Top-movers strip shows biggest WoW / MoM movers (up and down) and is clickable.
- **claim-19** — Clicking a top-mover chip drills into that customer or item.
- **claim-20** — Default Overview scope is **YTD · All entities**.
- **claim-21** — Header date pickers re-scope the whole page.
- **claim-22** — Entity pill filters values: Brix · Alameda Soda · FreeFlow · shared.
- **claim-23** — Clicking a KPI sparkline deep-links to the Margin page filtered to whatever moved the number.

## C. Margin page

- **claim-24** — Center pivot is a MUI X DataGrid Pro instance.
- **claim-25** — Pivot columns include: revenue, COGS, gross profit, gross margin %, est. cost, est. margin %.
- **claim-26** — Pivot rows group by the dimension chosen in the header.
- **claim-27** — Date-range presets exist for YTD, last quarter, last 12 months.
- **claim-28** — Entity filter is multi-select (Brix / Alameda Soda / FreeFlow / shared).
- **claim-29** — Customer / Item / Category / Segment pickers are multi-select with type-to-search.
- **claim-30** — "Group by" supports: category, item, customer, month, segment, entity.
- **claim-31** — Clicking a pivot row opens a Row Detail Modal.
- **claim-32** — Row Detail Modal shows the underlying invoice lines.
- **claim-33** — Row Detail Modal contains a mini chart.
- **claim-34** — Row Detail Modal "filter by this row" button adds the row's value as a chip filter on the page.
- **claim-35** — "Prior period" toggle adds 2 extra columns (compare + delta %).
- **claim-36** — "Prior year" toggle adds 2 extra columns (compare + delta %).
- **claim-37** — Delta % colors are green for positive, red for negative.
- **claim-38** — Export CSV button downloads the pivot with the same columns / rows / chips visible.
- **claim-39** — Margin page header shows last cost-cache refresh timestamp.
- **claim-40** — "Sync Item Costs" button triggers `sync-qbo-items` and writes to `ops.qbo_items.purchase_cost`.
- **claim-41** — Est. cost / est. margin % columns populate after a successful Sync Item Costs run.
- **claim-42** — Chain Rollup picker subtracts a chain's revenue from totals (e.g. clicking `MTE` drops totals by Melt's amount).
- **claim-43** — Hero line displays "· excluding: MTE (Nc · Mi)" when a rollup chip is active.
- **claim-44** — Multiple rollup chips stack (additive subtraction).
- **claim-45** — Clearing all rollup chips returns totals to baseline.
- **claim-46** — Rollup definitions are stored under Settings → Chain Rollups as ILIKE patterns over customer names.
- **claim-47** — Rollup membership is resolved at click time (renames in QBO don't silently break the math).
- **claim-48** — Margin page revenue total reconciles to QBO P&L total income for the same date range / entity within tolerance.
- **claim-49** — Margin page COGS total reconciles to QBO P&L COGS for the same date range / entity within tolerance.

## D. Customers list

- **claim-50** — Customers page renders an MUI X DataGrid Pro list.
- **claim-51** — Toolbar exposes a Channel dropdown.
- **claim-52** — Toolbar exposes a "Show inactive" checkbox.
- **claim-53** — Search box filters by customer name.
- **claim-54** — Columns include: Customer, State, Channel, YTD Revenue, Invoices, Segment, RFM.
- **claim-55** — Customer column is pinned left.
- **claim-56** — Sub-customer rows display a "SUB" badge.
- **claim-57** — Inactive customer rows display an "INACTIVE" badge.
- **claim-58** — RFM column shows a composite score on a 0–15 scale.
- **claim-59** — Segment column shows RFM segments (Champions / Loyal / At-risk / Lost / etc.).
- **claim-60** — List is capped server-side at 200 most-recent active customers by revenue.
- **claim-61** — Name-search bypasses the 200-row cap.
- **claim-62** — Deleted-customer ghosts render as `(no name · QBO #1234)` in italic amber.
- **claim-63** — Approximately 22 ghost rows exist (May 2026 backfill) and are visible only with "Show inactive" on.
- **claim-64** — YTD Revenue column matches `ops.mv_sales_lines` sum per customer, which matches QBO sales-by-customer totals.

## E. Customer Detail page

- **claim-65** — Header shows customer name, classification, entity, total YTD revenue.
- **claim-66** — Section 1 "Contact & address" shows parent chain (if sub), billing address multi-line postal style, contact info, and an "Open in QBO" link.
- **claim-67** — Sub-customer with no own address falls back to parent's address.
- **claim-68** — Section 2 "Revenue summary" shows: YTD revenue, prior year, delta, AR outstanding, AR overdue, avg days-to-pay, # active invoices.
- **claim-69** — AR-outstanding and AR-overdue values on Customer Detail reconcile to QBO A/R Aging Detail for that customer.
- **claim-70** — Section 3 "Margin by item" lists every item billed to this customer in range with revenue, est. cost, est. margin %, qty.
- **claim-71** — Section 4 "Recent invoices" lists the last 20–50 invoices, newest first; clicking shows line items.
- **claim-72** — Customer-detail revenue for a single customer reconciles to that customer's QBO invoice total in the same window.

## F. Plans page

- **claim-73** — Each plan has fiscal year, name, status; landing page lists all plans.
- **claim-74** — Plan editor default tab is **P&L**.
- **claim-75** — P&L tab renders Revenue → COGS → Gross Margin (with %) → OpEx → Net Income (with %), grouped by P&L line then item.
- **claim-76** — Plan Lines tab shows the same data with per-month editable cells.
- **claim-77** — Section headers (TOTAL REVENUE, TOTAL COGS, TOTAL OPERATING EXPENSES) display subtotals.
- **claim-78** — Gross Margin row = Revenue − COGS and shows % of revenue.
- **claim-79** — Net Income row = GM − OpEx and shows % of revenue.
- **claim-80** — Section and pl_line groups have ▶/▼ collapse carets.
- **claim-81** — View modes toggle between Revenue ($), Qty, Price ($/unit), Cost ($/unit).
- **claim-82** — Monthly cell edit: Tab/Shift-Tab navigates; blur commits; writes to `sales_plan_lines`.
- **claim-83** — "÷12" button spreads an annual total flat across 12 months.
- **claim-84** — "×" button deletes the line.
- **claim-85** — BUILD dialog source year defaults to plan year − 1.
- **claim-86** — BUILD dialog populates one row per item in the chosen category from last year's actuals.
- **claim-87** — "Default qty %" and "Default price %" apply to every row on "Apply defaults to all".
- **claim-88** — Per-item Qty % and Price % overrides are accepted.
- **claim-89** — Live-computed Plan Qty / Plan Price / Plan Revenue columns update as the user types.
- **claim-90** — Footer total in BUILD shows the whole-category total.
- **claim-91** — Apply writes plan lines via `fn_plan_build_from_growth`.
- **claim-92** — Items with zero sales last year appear greyed out in BUILD.
- **claim-93** — "COPY FROM <prior year>" applies a single uniform multiplier from prior-year actuals.
- **claim-94** — "PUSH TO QBO" generates a QBO Budget import CSV in the format QBO accepts.
- **claim-95** — Plans "Export CSV" aggregates plan lines by account, sorted by total.
- **claim-96** — vs-Actuals tab shows item-level variance: YTD plan vs YTD actual, % delta, status badge.
- **claim-97** — Forecast tab projects full-year totals from YTD pace.

## G. Production page

- **claim-98** — BOM detail modal opens 90 px from the top of the viewport.
- **claim-99** — BOM editor shows name + version + yield qty/UoM per batch run.
- **claim-100** — Count-based BOMs show a "1 <yield-uom> produces N gal" bridge field.
- **claim-101** — "Scale to make <qty> <UoM>" calculator at top of every BOM modal accepts target volume + UoM.
- **claim-102** — When scaled, a "Required" column appears on every BOM row with the scaled qty in the correct UoM.
- **claim-103** — BOM row columns: Type / Component / Qty per yield / UoM / Scrap % / Unit cost / Notes; all editable.
- **claim-104** — "Required" column is hidden when "Scale to make" is empty / zero.
- **claim-105** — Per-yield values are what's saved; scaling does not mutate the BOM.
- **claim-106** — Amber "Can't convert" warning shown when target UoM has no bridge to the BOM's natural family.
- **claim-107** — Work-order status transitions: draft → consumed → closed (or void).
- **claim-108** — Closing a work order writes locked costs to `ops.work_order_costs`.
- **claim-109** — Closing a work order pushes to QBO when QBO-writeback is wired.
- **claim-110** — Work-order detail modal opens 90 px from top.
- **claim-111** — PO module tracks vendor, expected ship date, BOL, receipt status.

## H. Compare page

- **claim-112** — Compare page has two date-range pickers labeled Period A and Period B.
- **claim-113** — A multi-select dimension chooser is present (customer / item / category / entity).
- **claim-114** — Output is a side-by-side table with cols: Period A, Period B, delta absolute, delta percent.
- **claim-115** — Cell coloring scales — bigger green = bigger improvement, deeper red = bigger drop.
- **claim-116** — MoM preset fills "this month vs last".
- **claim-117** — QoQ preset fills "this quarter vs last".
- **claim-118** — YoY preset fills "this period vs same period last year".
- **claim-119** — Compare totals reconcile to QBO P&L for both periods independently within tolerance.

## I. Inventory page

- **claim-120** — Columns: Item name, SKU, Category, Segment, Type, Est. cost, Last cost update, P&L Alignment, Notes.
- **claim-121** — Item Type values include inventory, service, non-inventory.
- **claim-122** — P&L Alignment column flags items whose category doesn't match their P&L account.
- **claim-123** — "Auto-categorize from P&L" produces a preview before commit.
- **claim-124** — Filters available: Category, Segment, Type, "Items missing cost", "Items with P&L mismatch".
- **claim-125** — Inventory page "Sync Item Costs" header button pushes QBO last-purchase-cost into `ops.qbo_items.purchase_cost`.
- **claim-126** — Inventory est. cost values reconcile to QBO Item.PurchaseCost for the same items.

## J. Reports — Voids & Cross-sells

- **claim-127** — Reports page exposes a "Voids & Cross-sells" report.
- **claim-128** — Default item set is "CSD FOUNTAIN".
- **claim-129** — CSD FOUNTAIN set contains the documented fountain flavors (with APT Cranberry, APT Orange Juice, APT Pineapple as recent additions).
- **claim-130** — Eligibility rule #1: customer bought ≥1 item from the set in the selected window.
- **claim-131** — Eligibility rule #2: customer is active in QBO (the 22 ghost rows are filtered out).
- **claim-132** — Eligibility rule #3: total customer spend on the set ≥ "Min set $" (toolbar value).
- **claim-133** — "Hide completionists" drops customers who bought every item in the set.
- **claim-134** — `has_item` is computed as `revenue > 0` (any positive spend counts).
- **claim-135** — KPI card "CUSTOMERS" = count of visible rows after filters.
- **claim-136** — KPI card "COVERAGE" = Σ items_bought / Σ items_possible (filtered).
- **claim-137** — KPI card "GAP $ POTENTIAL" = Σ over customers of `(set_revenue / items_bought) × (set_total − items_bought)`.
- **claim-138** — KPI card "ITEMS IN SET" = count of items in the selected set.
- **claim-139** — KPI cards recompute from the currently filtered set, not the full population.
- **claim-140** — Toolbar field "Min set $" filters by total set spend.
- **claim-141** — Toolbar fields "# items ≥ N" and "≤ M" filter by item count; M blank = "any".
- **claim-142** — Per-item chips cycle off → must-buy (green +) → must-NOT-buy (red −).
- **claim-143** — Multiple chips AND together.
- **claim-144** — "Clear (N)" button resets all chips.
- **claim-145** — Customer column pinned left.
- **claim-146** — Item column header sort is by revenue on that item (desc).
- **claim-147** — Column drag-reorder works.
- **claim-148** — Burger menu on each header: hide / pin / sort / filter.
- **claim-149** — Pagination dropdown: 10 / 25 / 50 / 100 / 250 / All.
- **claim-150** — Set Total column is hidden by default.
- **claim-151** — Cells colored green w/ $ when bought, red w/ "—" when not.

## K. Reports — other

- **claim-152** — "Anomalies" report exists and flags items/customers with statistically unusual YoY change.
- **claim-153** — "Health Movers" report shows customers whose RFM segment shifted in the last snapshot.
- **claim-154** — "Inactive Customers" report lists customers with no invoice in N days, sorted by lifetime revenue.
- **claim-155** — "AR Aging" report buckets open invoices into 0-30 / 31-60 / 61-90 / 90+.
- **claim-156** — AR Aging report buckets reconcile to QBO A/R Aging Summary for the same as-of date.
- **claim-157** — "Save view → Save as Report" surfaces the saved pivot in Reports for everyone.

## L. Cross-cutting UI claims

- **claim-158** — Saved filter views available on Margin, Compare, Inventory, Customers; persisted in LocalStorage; show in a "Saved views" dropdown.
- **claim-159** — Plan Build, BOM detail, Work Order detail dialogs all open 90 px from top.
- **claim-160** — ⌘K / Ctrl K does NOT open search inside Refractor (documented as not-yet-wired).
- **claim-161** — URL hash reflects filter state (e.g. `#/margin?from=...&to=...&group=customer`); deep links land on same view.
- **claim-162** — LIVE-badge click re-fetches the materialized view.

## M. Data-pipeline & ground-truth claims

- **claim-163** — Nightly cron at 09:00 UTC pulls Invoices, Sales Receipts, Credit Memos, and Refund Receipts from QBO into `ops.qbo_invoices` + `ops.qbo_invoice_lines`.
- **claim-164** — Credit Memos and Refund Receipts are stored as negative `amount` so `SUM(amount)` directly equals net revenue.
- **claim-165** — A 10-minute rolling refresh re-fetches lines for ~100 invoices over the last 90 days (full window every ~6 h).
- **claim-166** — A 3-minute line-backfill cron catches invoices that lost their line cache.
- **claim-167** — A 5-minute `pg_net` failure scanner watches for cron→HTTP errors.
- **claim-168** — Margin app reads from `ops.mv_sales_lines` (materialized view).
- **claim-169** — `ops.mv_sales_lines` is auto-refreshed after every sync.
- **claim-170** — Authority chain QBO P&L → `ops.pl_snapshots` → `ops.mv_sales_lines` → Margin UI is internally consistent (no drift between any two layers for a sampled period).

## N. Troubleshooting / behavior claims

- **claim-171** — Unmapped QBO income accounts land in `(unspecified)` until assigned a Category in Settings → Accounts, and backfill happens on the next 10-min refresh.
- **claim-172** — Admin-only health-check 403 for non-superadmins (Master Control "down" reading) is cosmetic, not a real outage.
- **claim-173** — `POST /functions/v1/sync-qbo?mode=refresh-mv` triggers a materialized-view refresh (admin only).

---

## Test method summary

For each claim above I will:

1. Grep `app/src/**` (and Supabase migrations / edge functions where relevant) for the implementing code path. Record `file:line` or mark `WIRING_BROKEN`.
2. For numeric claims (revenue / COGS / margin / AR / item cost / etc.) pull the QBO ground-truth via the QB Connector MCP for the same date window the program is showing, then compare.
3. For pure UI/structure claims (column existence, header text, dialog position, etc.) inspect the source and, where feasible, render the page in a headless build (no Netlify deploy) to verify the DOM.
4. For workflow claims that require a write (Push to QBO, Sync Item Costs, plan save), I will NOT execute the write — I'll trace the call site and mark `UNTESTABLE — write path, manual test`.
5. Append every result to `qa-report.md` with status, code path, QBO source, expected, actual, diff, severity, notes.

## Out of scope

- Brixpense (`app-expense/`), 3rd-party billing (`netlify/functions/process-inbound.mjs` etc.), ResQ-SF sync (`netlify/functions/resq-sf-sync*.mjs`), Master Control (`public/control.html`), OAuth setup (`public/setup.html`).
- Any production write to QBO or Supabase `ops.*` tables.

---

**Total testable claims: 173.**

Ready for review. Will not begin Step 2 until approved.
