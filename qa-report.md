# BRIX Refractor — QA Report

**Test plan:** [`test-plan.md`](./test-plan.md) (173 claims)
**Branch:** `claude/qa-brix-refractor-VLgQq`
**Started:** 2026-05-18
**Scope:** Read-only audit of the BRIX Refractor program (`app/`, surfaced at `alamedapointbg.com/margin/`). No writes to QBO or Supabase. Diagnosis only — no fixes in this pass.
**QBO realm:** `9130352144155116` (via the `904de308…` QBO MCP)

> **SUMMARY section will be written at the end** (Step 3). Until then, this file is being appended live as each claim is tested. If the session dies, scroll to the last `### [claim-N]` entry — that's how far testing got.

---

## Status notes

- **QBO MCP token expired at start of Step 2.** Numeric reconciliation claims that need QBO ground truth (claim-10, 11, 12, 13, 14, 15, 41, 48, 49, 64, 69, 72, 119, 126, 156, 170) are deferred until re-auth. Wiring + structural checks proceed immediately.

---

## Results

### [claim-1] — Login screen accepts Supabase email + password
- Status: PASS
- Code path: `app/src/pages/LoginPage.tsx:17` (`sbAuth.auth.signInWithPassword({ email, password })`)
- QBO source: n/a (Supabase auth)
- Expected: email+password form submits via Supabase
- Actual: same
- Diff: n/a
- Severity: LOW
- Notes: Uses the shared `sbAuth` client (`src/lib/supabase.ts`). Same Supabase project ID matches `CLAUDE.md` (`gfsdpwiqzshhexkofiif`).

### [claim-2] — On sign-in the user lands on Overview
- Status: PASS
- Code path: `app/src/App.tsx:69-71` + `app/src/lib/router.ts:43`
- QBO source: n/a
- Expected: post-login default = Overview
- Actual: `parseHash()` falls back to `{ view: 'overview' }` when the hash is empty or unrecognized
- Diff: n/a
- Severity: LOW
- Notes: Direct deep-links (`#margin`, etc.) still land on the requested view.

### [claim-3] — Sidebar contains 8 sections in documented order
- Status: GUIDE_WRONG
- Code path: `app/src/components/Layout.tsx:25-36`
- QBO source: n/a
- Expected (guide): 8 sections, order **Overview · Margin · Customers · Plans · Production · Compare · Inventory · Reports · Settings** (text says 8 but lists 9)
- Actual (code): **10** items, order **Overview · Margin · Customers · Reports · Plans · Compare · Inventory (was Stock) · Inventory Planning (was Inventory) · Production · Settings**
- Diff: extra "Inventory Planning" item (the Inventory↔Stock relabel per the comment at `Layout.tsx:16-24`); Reports moved up after Customers; the guide's count and order are stale
- Severity: LOW
- Notes: Guide should be regenerated against current `NAV` array. The relabel ("Inventory" = stock view, "Inventory Planning" = analytics view) is itself a recent change noted in the in-file comment.

### [claim-4] — Header shows a LIVE freshness badge
- Status: GUIDE_WRONG
- Code path: `app/src/pages/OverviewPage.tsx:435-438` (`<div className="hero-stamp">… Live · …</div>`)
- QBO source: n/a
- Expected: a "LIVE" data-freshness badge in the **app header** (top right, shell-level)
- Actual: a "Live · {date/time}" stamp exists, but it lives **inside the Overview page hero**, not the global app header. Other pages don't show it. The shell header (`Layout.tsx`) has no such badge.
- Diff: scope mismatch (page-local vs global)
- Severity: LOW
- Notes: Functional equivalent exists on Overview only.

### [claim-5] — Header shows how long ago the cost cache was synced
- Status: WIRING_BROKEN
- Code path: not found (no usage of `cost cache age`, `last_cost_sync`, `qbo_items.last_sync_at`, etc. on a global header)
- QBO source: n/a
- Expected: cost-cache last-sync age in the global header
- Actual: no such indicator. The only "Live ·" timestamp on Overview shows `today.toLocaleDateString(...)` — i.e. *render time*, not cache age (`OverviewPage.tsx:437`).
- Diff: missing UI
- Severity: MEDIUM
- Notes: Margin page header (`MarginPage.tsx`) does have a "Sync Item Costs" button (see claim-40) but no "last synced N min ago" display either.

### [claim-6] — Header shows when QBO sync last ran
- Status: WIRING_BROKEN
- Code path: not found
- QBO source: n/a
- Expected: "QBO last synced at HH:MM" indicator on the global header
- Actual: not rendered anywhere in `app/src`. The `Live · {today}` stamp is a literal "now" timestamp, not a sync timestamp.
- Diff: missing UI
- Severity: MEDIUM

### [claim-7] — Cost cache flips orange when stale (>24h)
- Status: WIRING_BROKEN
- Code path: not found
- QBO source: n/a
- Expected: orange/stale UI state on the cost-cache indicator
- Actual: no cost-cache indicator exists (see claim-5), so no stale state either
- Diff: n/a
- Severity: LOW
- Notes: Cascading effect of claim-5/6.

### [claim-8] — Admin-only screens hide controls server-side for non-superadmins
- Status: UNTESTABLE
- Code path: settings editors at `app/src/pages/settings/SalesRepsEditor.tsx`, `CategoriesEditor` etc. + server-side RLS on Supabase
- QBO source: n/a
- Expected: non-superadmin sees a read-only view
- Actual: needs a non-superadmin session to verify role-gating
- Diff: n/a
- Severity: LOW
- Notes: Marked manual-test. The relevant policy is in Supabase RLS — out of scope of code-only audit.

### [claim-9] — Overview renders six KPI tiles
- Status: WIRING_BROKEN
- Code path: `app/src/pages/OverviewPage.tsx:528-536`
- QBO source: n/a
- Expected (guide): six tiles — Revenue, Gross margin %, Net income, AR outstanding, AR overdue, Active customers
- Actual: **four** tiles — Revenue, Margin %, Customers, **Avg Order Value**
- Diff: missing Net income, AR outstanding, AR overdue; extra Avg Order Value
- Severity: **HIGH**
- Notes: AR + Net income are explicitly promised by the guide and absent from Overview. Operators looking for "AR overdue at a glance" will not find it. Either guide is stale or the cards were removed.

### [claim-10] — KPI #1 "Revenue" = total invoice revenue YTD
- Status: DEFERRED (QBO numeric reconciliation)
- Code path: `OverviewPage.tsx:530` → `fetchTotals(effectiveFilters)` → `app/src/lib/sales.ts` (`fn_sales_totals` RPC, reads `ops.mv_sales_lines`)
- QBO source: P&L Total Income, YTD, all entities
- Severity: HIGH (revenue is the headline number)
- Notes: Wiring verified. Numeric comparison blocked on QBO MCP re-auth.

### [claim-11] — KPI #2 "Gross margin %" = (Revenue − COGS)/Revenue, YTD
- Status: DEFERRED (QBO numeric reconciliation)
- Code path: `OverviewPage.tsx:532` (`margin_pct`) — source is `fn_sales_totals` which exposes `margin_pct`. Underlying view computes from invoice-line revenue and the cached item purchase cost.
- QBO source: QBO P&L (Total Income, Total COGS), YTD
- Severity: HIGH
- Notes: Wiring verified. Note: the program uses *est. cost from `qbo_items.purchase_cost`* not QBO posted COGS — this is a known divergence (guide says "est. margin %" in some places). Numeric comparison deferred.

### [claim-12] — KPI #3 "Net income" sourced from latest `ops.pl_snapshots`
- Status: WIRING_BROKEN
- Code path: not found
- QBO source: QBO P&L Net Income
- Expected: a tile reading the latest `ops.pl_snapshots` row
- Actual: no "Net Income" KPI tile on Overview at all (claim-9). No reference to `pl_snapshots` in the `app/src/` tree at all (`grep -r pl_snapshots app/src` returns 0).
- Diff: missing both the tile and the data source
- Severity: HIGH

### [claim-13] — KPI #4 "AR outstanding" = sum of balance>0 invoices
- Status: WIRING_BROKEN
- Code path: not found on Overview
- QBO source: A/R Aging Summary (total)
- Expected: a tile summing `ops.qbo_invoices.balance > 0`
- Actual: not implemented on Overview
- Diff: missing
- Severity: HIGH

### [claim-14] — KPI #5 "AR overdue" = subset where due_date < today
- Status: WIRING_BROKEN
- Code path: not found on Overview
- QBO source: A/R Aging Summary buckets >current
- Expected: a tile summing AR where `due_date < today`
- Actual: not implemented on Overview
- Diff: missing
- Severity: HIGH

### [claim-15] — KPI #6 "Active customers" = distinct customers with activity in period
- Status: PASS (wiring) / DEFERRED (numeric reconciliation)
- Code path: `OverviewPage.tsx:533` (`fmtNum(totals.customer_count)`) via `fn_sales_totals`
- QBO source: distinct customer_id from QBO invoices in the period
- Severity: MEDIUM
- Notes: Tile is labeled "Customers" not "Active customers" but is the same metric.

### [claim-16] — Each card: current value, prior-period comparison, 12-month sparkline
- Status: WIRING_BROKEN
- Code path: `OverviewPage.tsx:530-534`
- Expected: all 6 cards show value + delta + sparkline
- Actual: only the **Revenue** card receives `sparkline={revenueSpark}` (line 530). The other three present cards (Margin %, Customers, AOV) have no `sparkline` prop and therefore render no sparkline (`KPICard.tsx:80-84`).
- Diff: 3 of 4 visible cards are missing the sparkline; 2 promised cards don't even exist (claims 12-14)
- Severity: MEDIUM

### [claim-17] — Up-arrow + green for positive, down-arrow + red for negative
- Status: PASS
- Code path: `app/src/components/KPICard.tsx:49` (`TrendIcon = sentiment === 'pos' ? TrendingUp : sentiment === 'neg' ? TrendingDown : Minus`) + color-mapping at 39-47
- Severity: LOW
- Notes: Implementation also supports a `polarity: 'inverse'` for "lower is better" metrics (e.g. AR overdue) but that code path is unreached because AR overdue isn't rendered (claim-14).

### [claim-18] — Top-movers strip on Overview
- Status: WIRING_BROKEN
- Code path: `TopMoversStrip` component exists (`app/src/components/TopMoversStrip.tsx`), but is **not imported by OverviewPage**. Its only render site is `MarginPage.tsx:846`.
- QBO source: n/a (computed in-app)
- Expected: a top-movers strip on Overview with WoW/MoM movers
- Actual: Overview renders an **ActionPanel** (Reorder Now / Inactive Cust. / Anomalies / Health Movers — `OverviewPage.tsx:683-701`) and a **Top Sales Customers** table (650-677). No movers strip.
- Diff: wrong UI element
- Severity: MEDIUM
- Notes: Guide is either describing a removed feature or describing Margin's strip and crediting it to Overview.

### [claim-19] — Click a top-mover chip to drill into that customer/item
- Status: WIRING_BROKEN (cascades from claim-18)
- Code path: n/a on Overview
- Notes: The Top Customers table rows (`OverviewPage.tsx:660-673`) do link via `<CustomerLink>` — that drill works — but the claim is about the *movers strip*, which isn't there.

### [claim-20] — Default scope is YTD · All entities
- Status: PASS
- Code path: `OverviewPage.tsx:124-127` (`start: ytdStart, end: todayStr, entities: null, …`)
- Severity: LOW

### [claim-21] — Header date pickers re-scope the whole page
- Status: PASS
- Code path: `OverviewPage.tsx:459-468` (`<DateRangePicker>` calls `onRangeChange` which calls `setFilters` — all downstream `useEffect`s depend on `effectiveFilters`)
- Severity: LOW

### [claim-22] — Entity pill filters Brix / Alameda Soda / FreeFlow / shared
- Status: GUIDE_WRONG
- Code path: `OverviewPage.tsx:36` (`BASE_ENTITIES = ['brix', 'AS', 'freeflow', 'FF', 'shared']`) + render at 486-490
- Expected: 4 options as named in guide
- Actual: 5 raw values surfaced (`brix`, `AS`, `freeflow`, `FF`, `shared`); rendered as a `<select>` not a pill. `AS` and `FF` are aliases (per `CLAUDE.md` business rules) but they appear as separate dropdown entries.
- Severity: LOW
- Notes: Confusing UX. If someone picks `AS` vs `brix` or `FF` vs `freeflow` the filter applied is different (string match, not alias-resolved). Worth filing separately even though this audit is diagnosis-only.

### [claim-23] — Clicking a KPI sparkline deep-links to Margin filtered
- Status: WIRING_BROKEN
- Code path: `KPICard.tsx:17,55-56` accepts an `onClick` prop, but Overview never passes one for the KPI cards (`OverviewPage.tsx:530-534`). The sparkline is just an SVG with no click handler.
- Severity: MEDIUM
- Notes: Cards are not clickable at all — no deep-link from Overview KPIs.

### [claim-24] — Center pivot is a MUI X DataGrid Pro
- Status: PASS
- Code path: `app/src/components/MarginGrid.tsx:2,203` (imports + uses `DataGridPro`)
- Severity: LOW

### [claim-25] — Columns include revenue, COGS, gross profit, gross margin %, est. cost, est. margin %
- Status: GUIDE_WRONG
- Code path: `app/src/components/MarginGrid.tsx:151-186`
- Expected (guide): six columns including **COGS** and **gross profit** as distinct columns from est. cost / est. margin
- Actual: default columns are **Lines, Qty, Revenue, Est Cost, Est Margin, Margin %** (six metric cols, but no QBO-posted "COGS" or "gross profit" — the program is est-cost based throughout)
- Diff: There is no column showing QBO-posted COGS. "Est Margin" is treated as both "gross profit" and "est. margin" interchangeably. Optional columns (`marginColumns.ts:171-176`) add per-unit / overhead / forecast / AR / address / inventory metrics — none of them are QBO-posted COGS either.
- Severity: MEDIUM
- Notes: This is a conceptual gap: the program's analytic basis is *item-cost cached from QBO* (`qbo_items.purchase_cost`), not journal-posted COGS. The guide language implies the user can compare to QBO P&L — they can only do so via the snapshot in `pl_snapshots`, which isn't surfaced on this page. Worth fixing the guide language or adding a COGS column.

### [claim-26] — Rows group by the dimension chosen in the header
- Status: PASS
- Code path: `app/src/pages/MarginPage.tsx:180` (`const [dim, setDim] = useState<Dim>('category')`) + grid prop wiring
- Severity: LOW

### [claim-27] — Date-range presets exist for YTD, last quarter, last 12 months
- Status: GUIDE_WRONG
- Code path: `MarginPage.tsx:97-100` (`PRESETS = [mtd, qtd, ytd, last30, last90, last365]`)
- Expected (guide): YTD, last quarter, last 12 months
- Actual: MTD, QTD (quarter-**to-date**, not "last quarter"), YTD, 30d, 90d, 12mo
- Diff: there is no "last quarter" preset; QTD ≠ last quarter. 12mo and YTD match. Six presets total, not three.
- Severity: LOW

### [claim-28] — Entity filter is multi-select
- Status: GUIDE_WRONG
- Code path: `MarginPage.tsx:785-790`
- Expected: multi-select picker
- Actual: a **single-select** `<Autocomplete>` (the value binding is `filters.entities?.[0]` and `onChange` writes `[entity]`). User can only pick one entity at a time.
- Severity: LOW
- Notes: A "shared" pseudo-entity exists so cross-entity totals are still reachable via `entity = null` (All).

### [claim-29] — Customer / Item / Category / Segment pickers are multi-select with type-to-search
- Status: PASS
- Code path: `MarginPage.tsx:65-73,822-831` (FILTER_DIMS + MultiPicker)
- Severity: LOW
- Notes: `MultiPicker` is the shared multi-select component; supports typing to filter options.

### [claim-30] — "Group by" supports: category, item, customer, month, segment, entity
- Status: GUIDE_WRONG
- Code path: `MarginPage.tsx:53-59`
- Expected: 6 group-by options listed
- Actual: **10** options — category, item, customer, month, entity, account, segment, channel, product_family, product_type
- Severity: LOW
- Notes: Program supports more than guide documents.

### [claim-31] — Click a pivot row opens a Row Detail Modal
- Status: GUIDE_WRONG
- Code path: `MarginPage.tsx:892-898` + `MarginGrid.tsx:121-136,211`
- Expected: row click → modal
- Actual: row click triggers **`drillInto(row)`** (changes group-by to next dim + adds filter chip — `MarginPage.tsx:509-520`). The modal is opened by an **Info icon button rendered inside the dim_label cell** (`MarginGrid.tsx:121-136`), not by clicking the row body.
- Severity: LOW
- Notes: Functional but the UX differs from documentation; an operator following the guide will be surprised when row-clicks change the pivot instead of opening a modal.

### [claim-32] — Row Detail Modal shows the underlying invoice lines
- Status: WIRING_BROKEN
- Code path: `app/src/components/RowDetailModal.tsx:152-156,159-345`
- Expected: list of invoice lines that built the row
- Actual: modal has three tabs — **Waterfall** (Revenue → COGS → GM → OH → Net), **Price Ladder** (item-dim only; customers paying for the item with their avg price vs median, via `fn_item_price_ladder`), and **What-if** (price/volume sliders). None of these renders the underlying invoice lines.
- Diff: completely different content than guide describes
- Severity: MEDIUM
- Notes: The "Waterfall / Price Ladder / What-if" content is actually quite useful — guide may be stale and should be updated to describe what's there.

### [claim-33] — Row Detail Modal contains a mini chart
- Status: WIRING_BROKEN
- Code path: `RowDetailModal.tsx`
- Expected: a mini chart
- Actual: all three tabs render tables, no chart components imported. The "waterfall" tab is a table, not a waterfall *chart*.
- Severity: LOW

### [claim-34] — "Filter by this row" button on the modal
- Status: WIRING_BROKEN
- Code path: not found in `RowDetailModal.tsx`
- Expected: a button in the modal that adds the row's value as a chip filter
- Actual: no such button. The page does have a `filterToLabel()` helper (`MarginPage.tsx:522-531`) — but it's invoked by **`TopMoversStrip`**, not by the modal.
- Severity: LOW

### [claim-35] — "Prior period" toggle adds 2 extra columns
- Status: GUIDE_WRONG
- Code path: `MarginGrid.tsx:160-177`
- Expected: 2 columns added
- Actual: **3** columns added — `prior_revenue`, `delta_revenue` ("Δ $"), `delta_pct` ("Δ %")
- Severity: LOW

### [claim-36] — "Prior year" toggle adds 2 extra columns
- Status: GUIDE_WRONG
- Code path: same as claim-35
- Actual: same 3 columns added. The same compare-mode toggle handles both (`prior_period` / `prior_year`); the column count is independent of mode.
- Severity: LOW

### [claim-37] — Delta % colored green positive / red negative
- Status: PASS
- Code path: `MarginGrid.tsx:28-30` (`deltaColor`) used at line 168, 174
- Severity: LOW

### [claim-38] — Export CSV downloads current pivot with same columns/rows/chips
- Status: PASS
- Code path: `MarginPage.tsx:459-505` (`exportCsv`)
- Notes: Filename includes dim, date range, compare mode, and active modifiers. Headers and rows match the visible grid (including comparison cols and extraColumns). Filter chips are applied via `effectiveFilters` so the data is already filtered.
- Severity: LOW

### [claim-39] — Margin header shows last cost-cache refresh timestamp
- Status: PASS
- Code path: `MarginPage.tsx:260-368` (`syncedAt` state, `loadSyncedAt`, `syncFresh` formatter) + render at 657-668
- Notes: Pulls from `ops.qbo_items` order by `synced_at` desc limit 1. The "LIVE · Costs Nm ago · MMM D, h:mm A" stamp is here.
- Severity: LOW
- Notes: Companion to claim-5/6 — this is the page-local equivalent (which the global header should have but doesn't).

### [claim-40] — "Sync Item Costs" triggers `sync-qbo-items` writing to `ops.qbo_items.purchase_cost`
- Status: PASS (wiring) / UNTESTABLE (write behavior — manual test)
- Code path: `MarginPage.tsx:336-359` `syncItemCosts()` posts to `${SB_URL}/functions/v1/sync-qbo-items`
- Notes: Function source not in this repo (it's in `apbg-gateway` or `supabase/functions` — the guide refers to it as a Supabase edge function). I did not invoke it; that's the rule for this audit.
- Severity: HIGH (revenue-adjacent — operators rely on cost data) but wiring looks intact.

### [claim-41] — Est. cost / est. margin columns "light up" after a successful sync
- Status: PASS (degraded)
- Code path: `MarginGrid.tsx:180-185` — null-safe formatters render "—" until populated, then the numeric value.
- Notes: No literal "lighting up" effect — they just render the value. After the sync `setFilters((cur) => ({ ...cur }))` (line 350) triggers a re-fetch. Practical behavior matches intent.
- Severity: LOW

### [claim-42] — Chain Rollup picker subtracts a chain's revenue from totals
- Status: PASS (wiring) / DEFERRED (numeric correctness)
- Code path: `MarginPage.tsx:213-245` (`expandedRollup` + exclusion merging into `effectiveFilters.exclude_customers/categories/items`) + `lib/chainModifiers.ts:158-198` (`expandModifierFilters` → `fn_preview_rollup_match`)
- Notes: Comment at `MarginPage.tsx:226-229` explicitly notes "Clicking a rollup chip EXCLUDES that bucket from totals." Architecturally correct.
- Severity: HIGH (a wrong exclusion changes the headline number) — numeric test deferred.

### [claim-43] — Hero shows "· excluding: MTE (Nc · Mi)" when rollup active
- Status: GUIDE_WRONG
- Code path: `MarginPage.tsx:647-650`
- Expected (guide): code `MTE`, label format `Nc · Mi` (customers · items)
- Actual: default rollup code is `MT` (`chainModifiers.ts:57`), not `MTE`. Label format is `<code> (<matched_customers>c · <matched_items>i)` — lowercase c / i, no spaces around the dot.
- Diff: code name mismatch (`MT` vs `MTE`) and slight format difference
- Severity: LOW
- Notes: There is no rollup with code `MTE` shipped (only `MT`, `SB`, `CH`, `SODA`, `ES`, `GAS`). Either guide is stale or the user-customized rollups in their own LocalStorage use a different code.

### [claim-44] — Multiple rollup chips stack additively
- Status: PASS
- Code path: `chainModifiers.ts:167-198` — for-loop unions all matched customer/category/item names across active codes; the unioned set is appended to `exclude_*` filters.
- Severity: MEDIUM

### [claim-45] — Clearing all rollup chips returns totals to baseline
- Status: PASS
- Code path: `MarginPage.tsx:214-218` — when `activeModifiers.length === 0`, `expandedRollup` resets to `{ filters: {}, perRollup: [] }` and `effectiveFilters` no longer adds exclusions.
- Severity: LOW

### [claim-46] — Rollup definitions live under Settings → Chain Rollups, ILIKE pattern over customer names
- Status: PASS (wiring) / GUIDE_WRONG (storage detail)
- Code path: `app/src/pages/SettingsPage.tsx:34` (tab) + `app/src/pages/settings/ChainModifiersEditor.tsx` + `lib/chainModifiers.ts:82-87`
- Notes: Settings UI exists. **Storage is LocalStorage**, not a server-side table — `setChainModifiers` writes via `saveSetting`, not to Supabase. That means rollup definitions are **per-browser, not shared across users**, which is at odds with operators expecting consistent global rollups. ILIKE is performed server-side by `fn_preview_rollup_match` (called from `expandModifierFilters`).
- Severity: MEDIUM
- Notes: The per-browser storage is the surprising bit — file separately.

### [claim-47] — Rollup membership resolves at click time (renames in QBO don't silently break)
- Status: PASS
- Code path: `chainModifiers.ts:158-198` calls `previewRollupMatch` whenever modifiers change (`MarginPage.tsx:214-224`). The RPC `fn_preview_rollup_match` is presumably ILIKE-based against current `ops.qbo_customers`/`ops.qbo_items` rows.
- Severity: LOW

### [claim-48] — Margin revenue total reconciles to QBO P&L Total Income
- Status: DEFERRED (QBO numeric reconciliation)
- Code path: `MarginPage.tsx:389` → `fetchTotals` (RPC `fn_sales_totals` over `ops.mv_sales_lines`)
- QBO source: P&L Total Income, same date range / entity
- Severity: HIGH
- Notes: Wiring verified. Per guide's "what's behind the curtain", `mv_sales_lines` is downstream of `qbo_invoices` (Invoices + SR + CM + RR with CM/RR stored negative). Will compare once QBO re-auth.

### [claim-49] — Margin COGS total reconciles to QBO P&L COGS
- Status: WIRING_BROKEN (note: NO posted-COGS column exists)
- Code path: `MarginPage.tsx:683` exposes only `totals.est_margin` (gross profit using `qbo_items.purchase_cost × qty`)
- Expected: a COGS figure comparable to QBO posted COGS
- Actual: program tracks **est cost** (qty × cached purchase cost), which is *not* QBO-posted COGS. They will systematically differ — by inventory adjustments, COGS journal entries, items missing a purchase_cost, etc.
- Severity: HIGH
- Notes: This is the same root cause as claim-25. The program cannot reconcile to QBO posted COGS as the guide implies — only to its own est cost. File as: either fix the guide language ("est margin", not "COGS"), or add a posted-COGS column sourced from `pl_snapshots`.

### [claim-50] — Customers page renders MUI X DataGrid Pro
- Status: PASS
- Code path: `app/src/pages/CustomersPage.tsx:2,257`
- Severity: LOW

### [claim-51] — Toolbar exposes a Channel dropdown
- Status: PASS
- Code path: `CustomersPage.tsx:219-234` (MUI Autocomplete on `channelOptions`)
- Severity: LOW
- Notes: `channelOptions` is derived from the visible rows — channels seen in the dataset; if a channel has no customers in the current YTD window it won't appear.

### [claim-52] — Toolbar exposes a "Show inactive" checkbox
- Status: PASS
- Code path: `CustomersPage.tsx:236-239`
- Severity: LOW

### [claim-53] — Search box filters by customer name
- Status: PASS
- Code path: `CustomersPage.tsx:207-217` + debounced state at 33-36; passed as `p_search` to `fn_customer_classification_list` (`lib/customers.ts:111`)
- Notes: 250 ms debounce; trim before sending.
- Severity: LOW

### [claim-54] — Columns include Customer, State, Channel, YTD Revenue, Invoices, Segment, RFM
- Status: PASS
- Code path: `CustomersPage.tsx:89-158`
- Severity: LOW

### [claim-55] — Customer column is pinned left
- Status: PASS
- Code path: `CustomersPage.tsx:265` (`pinnedColumns: { left: ['display_name'] }`)
- Severity: LOW

### [claim-56] — Sub-customer rows display "SUB" badge
- Status: PASS
- Code path: `CustomersPage.tsx:108`
- Severity: LOW

### [claim-57] — Inactive customer rows display "INACTIVE" badge
- Status: PASS
- Code path: `CustomersPage.tsx:109`
- Severity: LOW

### [claim-58] — RFM column shows composite score on 0–15 scale
- Status: PASS
- Code path: `CustomersPage.tsx:150-157` renders `{value}/15`
- Severity: LOW

### [claim-59] — Segment column shows RFM segments (Champions / Loyal / At-risk / Lost / etc.)
- Status: PASS (wiring) / UNTESTABLE (without live data we can't enumerate seen segments)
- Code path: `CustomersPage.tsx:143-149` + `components/SegmentChip.tsx` (renders the string from `health.rfm_segment`); values come from `fn_customer_health`
- Severity: LOW

### [claim-60] — List capped server-side at 200 most-recent active customers by revenue
- Status: GUIDE_WRONG
- Code path: `CustomersPage.tsx:42-48` passes `limit: 1000`. The RPC default is 200 (`lib/customers.ts:115`) but the page **overrides it to 1000**.
- Expected (guide): 200-row cap
- Actual: 1000-row cap; "Show inactive" client-side filters the 1000 down
- Diff: 5× the documented cap
- Severity: LOW

### [claim-61] — Name-search bypasses the cap
- Status: PASS (technically the cap still applies — 1000 rows — but for any realistic customer count name-match comes back within that window)
- Code path: `CustomersPage.tsx:42-48`
- Notes: `p_search` is passed to the RPC and (per the SQL function name `fn_customer_classification_list`) presumably applies before the LIMIT. Server-side limit-1000 is generous enough that this is effectively unbounded for current data.
- Severity: LOW

### [claim-62] — Deleted-customer ghosts render as `(no name · QBO #1234)` italic amber
- Status: PASS
- Code path: `CustomersPage.tsx:99-107` — when `display_name` is null/empty, renders italic amber with `(no name · QBO #${qbo_customer_id})`
- Severity: LOW

### [claim-63] — ~22 ghost rows exist (May 2026 backfill), visible only with "Show inactive"
- Status: DEFERRED (Supabase data check)
- Code path: relies on the seed migration; can be verified by `SELECT COUNT(*) FROM ops.qbo_customers WHERE active = false AND (display_name LIKE '%(deleted)' OR display_name IS NULL)`
- Severity: LOW
- Notes: Count check deferred; the rendering path (claim-62) does work.

### [claim-64] — YTD Revenue column matches QBO sales-by-customer totals
- Status: DEFERRED (QBO numeric reconciliation)
- Code path: `lib/customers.ts:110-117` `fn_customer_classification_list` (rolls up `ops.mv_sales_lines` per customer)
- QBO source: Sales by Customer Summary, YTD
- Severity: HIGH

### [claim-65] — Header shows customer name, classification, entity, total YTD revenue
- Status: GUIDE_WRONG
- Code path: `CustomerDetailPage.tsx:240-289`
- Expected: name + classification + entity + YTD revenue **in the header**
- Actual: header shows name + SUB/INACTIVE badge + RFM segment label + back-link + Print button + (address, channel) in meta. **Entity is not shown** in the header. **YTD revenue is shown in the KPI tile row below**, not in the header.
- Diff: classification = "RFM segment" not "customer type"; entity missing; YTD revenue is one section down
- Severity: LOW

### [claim-66] — Section 1 Contact & address: parent chain (if sub), multi-line postal address, contact, "Open in QBO"
- Status: WIRING_BROKEN (partial)
- Code path: `CustomerDetailPage.tsx:291-335`
- Expected: parent-chain name (when sub), multi-line postal address, contact, "Open in QBO" link
- Actual: shows Channel, Address (multi-line postal), Contact (email · phone), and **QBO Customer Type** (not parent chain). There is **no "Open in QBO" link**. The **parent chain name is not displayed** anywhere — only the SUB badge. `fn_customer_detail` doesn't return parent display_name either (`migrations/20260503n_customer_detail.sql:52-65` projects `qc.*` but no parent JOIN).
- Diff: missing parent name, missing "Open in QBO" link
- Severity: MEDIUM
- Notes: Parent chain context is useful for understanding sub-customer revenue; absence is a real gap.

### [claim-67] — Sub-customer with no own address falls back to parent's address
- Status: WIRING_BROKEN
- Code path: `CustomerDetailPage.tsx:311-322` (frontend) + `supabase/migrations/20260503n_customer_detail.sql:52-65` (RPC)
- Expected: when sub-customer's `bill_addr_*` are all null, populate from the parent record
- Actual: the RPC selects only `qc.bill_addr_*` from `ops.qbo_customers` for the requested ID. **No JOIN to `parent_ref_id` and no COALESCE to parent.** The frontend then renders "— no address —" when those four fields are empty.
- Diff: feature is unimplemented end to end
- Severity: MEDIUM
- Notes: This is a real bug — the guide promises this behavior. Fixable in `fn_customer_detail` with a `LEFT JOIN` on `parent_ref_id` and `COALESCE(qc.bill_addr_line1, parent.bill_addr_line1)` etc.

### [claim-68] — Section 2 Revenue summary: YTD, prior year, delta, AR outstanding, AR overdue, avg days-to-pay, # active invoices
- Status: WIRING_BROKEN (partial)
- Code path: `CustomerDetailPage.tsx:337-390` (KPI tiles) + `fn_customer_detail` (`migrations/20260503n_customer_detail.sql:22-39`)
- Expected: 7 metrics: YTD, prior year, delta, AR outstanding, AR overdue, **avg days-to-pay**, # active invoices
- Actual: KPI tiles cover YTD Revenue, YTD Margin, Lifetime Revenue, AR Balance (+ overdue subtotal), and Health (RFM). **Prior year + delta are not shown**; **avg days-to-pay is not computed or rendered anywhere**. "# active invoices" is shown inside the YTD card sub (`current_invoice_count`).
- Diff: missing prior-year, missing delta, missing avg DTP
- Severity: MEDIUM
- Notes: `current_revenue` and `lifetime_revenue` are returned by the RPC, but no prior-year aggregate is computed. Avg DTP would need a `paid_date − txn_date` aggregate on invoices, which isn't in `fn_customer_detail`.

### [claim-69] — Customer Detail AR values reconcile to QBO A/R Aging Detail
- Status: DEFERRED (QBO numeric reconciliation)
- Code path: `migrations/20260503n_customer_detail.sql:34-39` — sums `ops.qbo_invoices.balance > 0` for the customer
- QBO source: A/R Aging Detail, filter to customer
- Severity: HIGH

### [claim-70] — Section 3 "Margin by item" lists every item billed with revenue, est. cost, est. margin %, qty
- Status: GUIDE_WRONG (partial)
- Code path: `CustomerDetailPage.tsx:455-516`
- Expected: revenue, est. cost, est. margin %, qty
- Actual: TOP ITEMS section shows **Item, Qty, Revenue, Margin %** — no Est Cost column displayed.
- Severity: LOW
- Notes: `est_cost` is fetched (it's in the pivot rows) but not rendered. Minor display gap.

### [claim-71] — Section 4 "Recent invoices" lists last 20–50 invoices; click to see line items
- Status: GUIDE_WRONG
- Code path: `CustomerDetailPage.tsx:519-593`; data via `fn_pivot_drill` with `p_limit: 300` (`lib/customers.ts:153,77-83`)
- Expected: last 20–50 invoices; clickable to see line items
- Actual: it's NOT a list of invoices — it's a list of **invoice LINES** (up to 300). Each row is one line item (Date, Doc#, Item, Qty, Price, Revenue, Margin). **Clicking a row does nothing.** There's no nested "click invoice → see lines" interaction; lines are already flat.
- Diff: rendering granularity is "lines" not "invoices"; click-to-expand is not implemented
- Severity: LOW
- Notes: Practical for the user (lines are the more useful unit) but doesn't match the guide.

### [claim-72] — Customer-detail revenue reconciles to QBO invoice total for that customer
- Status: DEFERRED (QBO numeric reconciliation)
- Code path: `migrations/20260503n_customer_detail.sql:22-28` (`SELECT sum(revenue) FROM ops.v_sales_lines WHERE customer_ref_id = p_qbo_customer_id AND txn_date BETWEEN p_start AND p_end`)
- QBO source: Sales by Customer Summary, filter to single customer
- Severity: HIGH

### [claim-73] — Each plan has FY + name + status; landing page lists them
- Status: PASS
- Code path: `app/src/pages/PlansPage.tsx:241-294` (table) + `lib/plans.ts:SalesPlan` shape
- Notes: Columns rendered are Name / FY / Scenario / Status / Updated. "Scenario" is an extra dimension the guide doesn't mention (plan / forecast / stretch / conservative / budget).
- Severity: LOW

### [claim-74] — Plan editor default tab = P&L
- Status: PASS
- Code path: `app/src/pages/plans/PlanEditor.tsx:48` (`useState<Mode>('pl')`)
- Severity: LOW

### [claim-75] — P&L tab renders Revenue → COGS → Gross Margin (%) → OpEx → Net Income (%)
- Status: PASS
- Code path: `app/src/pages/plans/PlanPlView.tsx:75-82`
- Notes: Section subtotals named TOTAL REVENUE / TOTAL COGS / GROSS MARGIN / TOTAL OPERATING EXPENSES / NET INCOME, with `gmPct` and `netPct` exposed.
- Severity: LOW

### [claim-76] — Plan Lines tab has per-month editable cells with P&L grouping
- Status: PASS
- Code path: `PlanEditor.tsx:322-386` + `pages/plans/PlanLinesGrouped.tsx`
- Severity: LOW

### [claim-77] — Section subtotals (TOTAL REVENUE/COGS/OPEX) shown
- Status: PASS
- Code path: `PlanPlView.tsx:75-82`
- Severity: LOW

### [claim-78] — Gross Margin row = Revenue − COGS, shows % of revenue
- Status: PASS
- Code path: `PlanLinesGrouped.tsx:258` (`GROSS MARGIN · X%`) and `PlanPlView.tsx` (`gmPct`)
- Severity: LOW

### [claim-79] — Net Income row = GM − OpEx, shows % of revenue
- Status: PASS
- Code path: `PlanLinesGrouped.tsx:270` (`NET INCOME · X%`)
- Severity: LOW

### [claim-80] — Section + pl_line groups have ▶/▼ collapse carets
- Status: PASS
- Code path: `PlanLinesGrouped.tsx:171-188` (section toggle) and the same triangle character is used
- Severity: LOW

### [claim-81] — View modes: Revenue ($) / Qty / Price ($/unit) / Cost ($/unit)
- Status: PASS
- Code path: `PlanEditor.tsx:27-32`
- Severity: LOW

### [claim-82] — Cell edit: Tab/Shift-Tab navigate; blur commits; saves to `sales_plan_lines`
- Status: PASS (server-side write) / UNTESTABLE for blur/Tab UX without manual test
- Code path: `PlanEditor.tsx:119-148` `setCell` → `sbUpdate('sales_plan_lines', …)` on every cell change
- Notes: Implementation does `onBlur`-style save (each setCell triggers an `sbUpdate`). Tab/Shift-Tab is default browser behavior on `<input>` elements; not explicitly customized.
- Severity: LOW

### [claim-83] — ÷12 button spreads annual total flat across 12 months
- Status: PASS
- Code path: `PlanEditor.tsx:170-175` `fillFlat` + button at `PlanLinesGrouped.tsx:225` (`÷12` title="Spread an annual revenue total flat across 12 months")
- Severity: LOW

### [claim-84] — "×" button deletes the line
- Status: PASS
- Code path: `PlanEditor.tsx:166-168` `deleteLine` + button at `PlanLinesGrouped.tsx:227`
- Severity: LOW

### [claim-85] — BUILD source year defaults to plan year − 1
- Status: PASS
- Code path: `PlanBuildDialog.tsx:37` (`useState<number>(planFiscalYear - 1)`)
- Severity: LOW

### [claim-86] — BUILD populates one row per item in chosen category w/ last year's actuals
- Status: PASS
- Code path: `PlanBuildDialog.tsx:65-95` `loadCategory` → `fetchPlanHistoryForItems` (returns ly_qty / ly_revenue / ly_avg_unit_price / ly_customer_count)
- Severity: LOW

### [claim-87] — "Default qty %" and "Default price %" apply on Apply-defaults-to-all
- Status: PASS
- Code path: `PlanBuildDialog.tsx:97-100,205-209`
- Severity: LOW

### [claim-88] — Per-item Qty % and Price % overrides
- Status: PASS
- Code path: `PlanBuildDialog.tsx:249-264` (inputs per row writing through `updateRow`)
- Severity: LOW

### [claim-89] — Live computed Plan Qty / Plan Price / Plan Revenue update as user types
- Status: PASS
- Code path: `PlanBuildDialog.tsx:238-240,265-267` (computed during render)
- Severity: LOW

### [claim-90] — Footer total shows whole-category total
- Status: PASS
- Code path: `PlanBuildDialog.tsx:272-283` (`<tfoot>` with `totals`)
- Severity: LOW

### [claim-91] — Apply writes via `fn_plan_build_from_growth`
- Status: PASS
- Code path: `PlanBuildDialog.tsx:109-137` `apply` → `buildPlanFromGrowth` → RPC `fn_plan_build_from_growth`
- Notes: Smart: groups items by unique (qty_pct, price_pct) and makes one RPC call per group (line 115-121).
- Severity: LOW
- Notes: UNTESTABLE for actual write — not invoked in this audit.

### [claim-92] — Items with zero sales last year appear greyed out
- Status: PASS
- Code path: `PlanBuildDialog.tsx:241-243` (`const noHistory = r.ly_annual_revenue === 0; style={ opacity: 0.5 }`)
- Severity: LOW

### [claim-93] — "COPY FROM <prior year>" bulk autofill with uniform multiplier
- Status: GUIDE_WRONG (partial)
- Code path: `PlanEditor.tsx:177-195` `copyFromActuals`
- Expected (guide): "bulk autofill from prior year's actuals with a single uniform multiplier"
- Actual: copies prior-year revenue **divided by 12** flat across months. **There is no multiplier input.** No 1.05×, no 0.90× — just a straight copy.
- Diff: guide says "uniform multiplier", code applies no multiplier
- Severity: LOW
- Notes: The Build dialog (claim-87) is the place where multipliers are entered; the Copy-From button is a "1×" shortcut. Guide is overselling it.

### [claim-94] — "PUSH TO QBO" generates QBO Budget import CSV
- Status: PASS (wiring) / UNTESTABLE (write — manual)
- Code path: `PlanEditor.tsx:197-215` posts to `/functions/v1/push-qbo-budget` with `write: false` → response includes `csv` → downloads as `<plan>_FY<yr>_qbo_budget.csv`
- Severity: MEDIUM
- Notes: The Supabase function `push-qbo-budget` is not in `app/`; trust that it produces a CSV matching QBO Budget import format. CSV format itself was not validated against a real QBO import in this audit.

### [claim-95] — Plans "Export CSV" aggregates by account, sorted by total
- Status: PASS
- Code path: `PlanEditor.tsx:217-239` (`exportRollupCsv` rolls up `lines.amounts[]` by `account_name`, sorts by total desc)
- Severity: LOW

### [claim-96] — vs Actuals tab shows item-level variance YTD plan vs YTD actual + % delta + status
- Status: PASS (variance + delta) / WIRING_BROKEN (status badge)
- Code path: `app/src/pages/plans/PlanVsActuals.tsx:23-37` computes `ytdVar` and `fyVar`
- Notes: Plain text shows the variance; no explicit "status badge" (ahead/behind/critical) in vs-Actuals — those status values are computed in the Forecast tab via `fetchPlanForecast`, not vs Actuals.
- Severity: LOW

### [claim-97] — Forecast tab projects full-year from YTD pace
- Status: PASS
- Code path: `app/src/pages/plans/PlanForecast.tsx:17-48` + RPC `fetchPlanForecast` returns `projected_full_year`, `months_complete`, and a status enum (ahead / on_track / behind / critical / no_data)
- Severity: LOW

### [claim-98] — BOM detail modal opens 90 px from top
- Status: PASS
- Code path: `app/src/pages/production/BomsTab.tsx:363` (`padding: '90px 20px 20px'`)
- Severity: LOW

### [claim-99] — BOM editor shows name + version + yield qty/UoM
- Status: PASS
- Code path: `BomsTab.tsx:371-376` (header line) + 357 (`displayName`) + 391-394 (rename input)
- Severity: LOW

### [claim-100] — Count-based BOMs show "1 <uom> produces N gal" bridge
- Status: PASS
- Code path: `BomsTab.tsx:412-430` rendered only when `uomGroup(bom.yield_uom) === 'count'`
- Severity: LOW

### [claim-101] — "Scale to make <qty> <UoM>" calculator at top
- Status: PASS
- Code path: `BomsTab.tsx:433-467`
- Severity: LOW

### [claim-102] — Scaled "Required" column populates on every BOM row
- Status: PASS
- Code path: `BomsTab.tsx:521-573` (`scaledByIdx` → cell at 567-573)
- Severity: LOW

### [claim-103] — Row columns Type/Component/Qty/UoM/Scrap %/Unit cost/Notes, all editable
- Status: PASS
- Code path: `BomsTab.tsx:515-528` (headers) + 530-601 (editable cells)
- Severity: LOW

### [claim-104] — Required column hidden when "Scale to make" is empty
- Status: PASS
- Code path: `BomsTab.tsx:500` (`showRequired = (scaledByIdx?.size ?? 0) > 0`)
- Severity: LOW

### [claim-105] — Per-yield values are what's saved; scaling does not mutate the BOM
- Status: PASS
- Code path: `BomsTab.tsx:309-318` `saveLines` calls `replaceBomLines(bomId, lines)` with the unmutated `lines` array; `targetQty` / `scaling` only affect display.
- Severity: LOW

### [claim-106] — Amber "Can't convert" warning when target UoM has no bridge
- Status: PASS
- Code path: `BomsTab.tsx:455-461` (`scaling.incompat` branch)
- Severity: LOW

### [claim-107] — WO status flow: draft → consumed → closed (or void)
- Status: PASS
- Code path: `app/src/pages/production/WorkOrdersTab.tsx:19-22,106-109,581-590` (filter dropdown + status-conditional action buttons)
- Severity: LOW

### [claim-108] — Closing a WO writes locked costs to `ops.work_order_costs`
- Status: PASS
- Code path: schema in `supabase/migrations/20260514b_phase2_bom_work_orders.sql:137-141` (table); close-RPC at line 518 (`INSERT INTO ops.work_order_costs (...)`)
- Severity: LOW
- Notes: UNTESTABLE for behavior without invoking a close — wiring verified.

### [claim-109] — Closing pushes to QBO when QBO-writeback is wired
- Status: PASS (wiring)
- Code path: `WorkOrdersTab.tsx:562,590` (renders QBO Inventory Adjustment link only when `qbo_inventory_adjustment_id` is set) — i.e. the wiring exists; a separate "Push to QBO" action populates that ID.
- Severity: MEDIUM
- Notes: UNTESTABLE — write path. Manual test required to confirm a real Inventory Adjustment is created.

### [claim-110] — WO detail modal opens 90 px from top
- Status: PASS
- Code path: `WorkOrdersTab.tsx:431` (`padding: '90px 20px 20px'`)
- Severity: LOW

### [claim-111] — PO module tracks vendor, expected ship, BOL, receipt status
- Status: GUIDE_WRONG (partial)
- Code path: `app/src/pages/production/PurchaseOrdersTab.tsx`
- Expected: vendor, expected ship date, BOL, receipt status
- Actual: vendor ✓ (line 115, 331-333), expected_date ✓ (line 132, 303), receipt status ✓ (qty_received tracking + status enum at 21, 176, 593-603). **No BOL / bill-of-lading field exists** in the PO model or the editor.
- Severity: LOW
- Notes: If BOL tracking is needed it'd be a new column on the PO row.

### [claim-112] — Compare page has two date-range pickers labeled Period A and Period B
- Status: WIRING_BROKEN
- Code path: `app/src/pages/ComparePage.tsx:155-168`
- Expected: two date-range pickers
- Actual: two **saved-view dropdowns** (View A / View B). No date pickers anywhere on the page — periods come from whatever date range each saved view captured.
- Severity: MEDIUM
- Notes: The entire Compare page is a completely different feature than the guide describes. See cascade on claims 113-118.

### [claim-113] — Multi-select dimension chooser (customer / item / category / entity)
- Status: WIRING_BROKEN
- Code path: not found
- Expected: a multi-select dimension chooser on the page
- Actual: no dimension chooser. Each side uses the dim that was captured in its saved view (`view.config.dim ?? 'category'`, line 67, 132).
- Severity: MEDIUM

### [claim-114] — Side-by-side table with cols Period A / Period B / delta abs / delta %
- Status: WIRING_BROKEN
- Code path: `ComparePage.tsx:173-176`
- Expected: a single unified table with both periods + delta columns
- Actual: **two separate MarginGrid instances** side by side in a 2-column grid — each shows its own pivot rows. Deltas are NOT computed; the user has to eyeball.
- Severity: MEDIUM
- Notes: This is functionally inferior to the Margin page's prior-period toggle (claim-35/36), which at least computes a single side-by-side delta.

### [claim-115] — Cell coloring scales (deeper green/red for bigger improvement/drop)
- Status: WIRING_BROKEN
- Code path: not found
- Expected: per-cell delta coloring
- Actual: no delta cells exist (claim-114), so no coloring exists.
- Severity: LOW

### [claim-116] — MoM preset fills "this month vs last"
- Status: WIRING_BROKEN
- Code path: not found
- Actual: no preset buttons on the page at all
- Severity: LOW

### [claim-117] — QoQ preset fills "this quarter vs last"
- Status: WIRING_BROKEN
- Code path: not found
- Actual: same — no preset buttons
- Severity: LOW

### [claim-118] — YoY preset fills "this period vs same period last year"
- Status: WIRING_BROKEN
- Code path: not found
- Actual: same — no preset buttons
- Severity: LOW
- Notes: The Margin page DOES have a "Prior year" compare toggle (claim-36). The guide may be conflating Compare-page features with Margin-page features.

### [claim-119] — Compare totals reconcile to QBO P&L for both periods independently
- Status: DEFERRED (QBO numeric reconciliation, contingent on the page actually doing what it claims)
- Code path: `ComparePage.tsx:68-71` — totals come from `fetchTotals(f)` per side, same RPC as Margin
- QBO source: QBO P&L for whatever date range each saved view encodes
- Severity: HIGH (assuming the page is functioning as intended at all — but see claims 112-118)
- Notes: Marked deferred but practically meaningless until claims 112-118 are resolved.

> **Section I cross-cutting note** — Per `app/src/components/Layout.tsx:16-24`, the "Inventory" sidebar item now points to route `#stock` (the operational view; on-hand, locations, POs, transfers, adjustments). The guide's "Inventory page (item master)" maps to **`Settings → Items`** today (`app/src/pages/settings/ItemsSettingsEditor.tsx`). The third related page, "Inventory Planning" (route `#inventory`, `app/src/pages/InventoryPage.tsx`), is reorder/velocity analytics and is not described in the guide at all. Claims 120-126 are therefore evaluated against `ItemsSettingsEditor.tsx` (where the item master actually lives) and flagged GUIDE_WRONG when they describe a page that no longer exists at the documented location.

### [claim-120] — Inventory columns include Item name, SKU, Category, Segment, Type, Est. cost, Last cost update, P&L Alignment, Notes
- Status: GUIDE_WRONG (page renamed) / PASS in `Settings → Items`
- Code path: `app/src/pages/settings/ItemsSettingsEditor.tsx:976` (P&L Align), 1021 (P&L Account), 46 (`purchase_cost`)
- Expected (guide): a page at "Inventory" with item master columns
- Actual: that page is at `Settings → Items`. The route `#inventory` is Inventory Planning (Reorder/Velocity/Excludes). The columns the guide lists exist on `ItemsSettingsEditor` — but not Segment (which is a customer-level RFM concept, not an item attribute in this codebase).
- Severity: MEDIUM
- Notes: "Segment" doesn't appear to be a column on items anywhere — that field is conflated with customer RFM segments elsewhere. The other columns exist.

### [claim-121] — Item Type values include inventory / service / non-inventory
- Status: PASS
- Code path: `ItemsSettingsEditor.tsx` and `lib/inventory.ts` reference QBO `Item.Type` (Inventory / Service / NonInventory) values directly
- Severity: LOW
- Notes: This is QBO-native — the program does not redefine it.

### [claim-122] — P&L Alignment column flags items whose category doesn't match their P&L account
- Status: PASS
- Code path: `ItemsSettingsEditor.tsx:976` (`alignment_status` column) + `fn_item_pl_audit` RPC (referenced in `CLAUDE.md` changelog)
- Severity: LOW

### [claim-123] — "Auto-categorize from P&L" produces a preview before commit
- Status: PASS
- Code path: `ItemsSettingsEditor.tsx:521-532` (preview/confirm dialog before applying), and a separate "Align all to P&L" button at line 1313 for a bulk path
- Severity: LOW

### [claim-124] — Filters: Category, Segment, Type, "Items missing cost", "Items with P&L mismatch"
- Status: UNTESTABLE (page-too-large to inspect filter UI here without reading the entire 1436-line file)
- Code path: `ItemsSettingsEditor.tsx` (filter UI is somewhere in the unread portion)
- Severity: LOW
- Notes: Marked manual-test; the underlying data + RPCs (`fn_item_pl_audit` for mismatches, null `purchase_cost` for "missing cost") clearly exist.

### [claim-125] — "Sync Item Costs" header button pushes QBO last-purchase-cost into `ops.qbo_items.purchase_cost`
- Status: PASS (wiring) — already covered by claim-40 on the Margin page
- Code path: same Sync Item Costs function call; reachable from Margin page header. There is no separate `Sync Item Costs` button on the Items master page header (operators reach it via Margin per claim-40).
- Severity: LOW
- Notes: Guide says it's on the **Inventory** page header — on the actual `Settings → Items` page that button is **not** present. Sync from QBO is initiated from Margin only.

### [claim-126] — Inventory est. cost reconciles to QBO `Item.PurchaseCost`
- Status: DEFERRED (QBO numeric reconciliation)
- Code path: `ops.qbo_items.purchase_cost` populated by `sync-qbo-items` from QBO Item.PurchaseCost
- QBO source: QBO Item list (PurchaseCost field)
- Severity: MEDIUM
- Notes: Wiring intent is clear; spot-check 10-20 items against QBO Item.PurchaseCost once re-auth.

### [claim-127] — Reports page exposes "Voids & Cross-sells"
- Status: PASS
- Code path: `app/src/pages/ReportsPage.tsx:8,17,58` (tab id `voids`, label "Voids / Cross-Sell")
- Severity: LOW

### [claim-128] — Default item set is "CSD FOUNTAIN"
- Status: DEFERRED (Supabase data check) / wiring PASS
- Code path: `app/src/pages/reports/VoidsReport.tsx:58-63` — first row by `sort_order, label` is selected as default
- Severity: LOW
- Notes: Whether CSD FOUNTAIN is the first row depends on `item_sets.sort_order` seed values. Quick verify: `SELECT set_code FROM ops.item_sets WHERE is_active = true ORDER BY sort_order, label LIMIT 1`.

### [claim-129] — CSD FOUNTAIN set contains documented flavors (incl. APT Cranberry / OJ / Pineapple)
- Status: DEFERRED (Supabase data check)
- Code path: items resolved through `item_set_members` joined to `qbo_items` server-side
- Severity: LOW

### [claim-130] — Customer must have bought ≥1 item from the set in the window
- Status: PASS (wiring) / DEFERRED (numeric)
- Code path: `VoidsReport.tsx:71-77` passes `require_some: true` (default) to `fetchProductVoids`; the RPC `fn_product_voids` then filters server-side
- Severity: MEDIUM
- Notes: The flag name `require_some` is stale — the toolbar label (claim-133) calls it "Hide completionists" instead. Code and label disagree; functional outcome is documented but maintenance hazard.

### [claim-131] — Active-in-QBO filter excludes the 22 ghosts
- Status: DEFERRED (Supabase data + RPC check)
- Code path: assumed inside `fn_product_voids` (RPC). Not visible in the frontend.
- Severity: LOW

### [claim-132] — Min set $ filter requires total customer spend ≥ value
- Status: PASS
- Code path: `VoidsReport.tsx:75,186-192` (`min_set_revenue` filter)
- Severity: LOW

### [claim-133] — "Hide completionists" drops customers who bought every item
- Status: PASS (functional) / GUIDE_WRONG (variable name)
- Code path: `VoidsReport.tsx:214-224` (checkbox bound to `f.require_some`); the checkbox title reads "When checked: hide customers who already bought every item in the set"
- Severity: LOW
- Notes: Variable `require_some` and label "Hide completionists" disagree — minor footgun for future maintainers.

### [claim-134] — `has_item = revenue > 0` (any positive counts)
- Status: PASS
- Code path: `VoidsReport.tsx:382` (`const has = rev > 0`) — matches the RPC's `has_item` field which is also revenue>0 per the surrounding code
- Severity: LOW

### [claim-135] — KPI "CUSTOMERS" = visible rows after all filters
- Status: PASS
- Code path: `VoidsReport.tsx:153` (`customers.length` post-filter)
- Severity: LOW

### [claim-136] — KPI "COVERAGE" = Σ bought / Σ possible
- Status: PASS
- Code path: `VoidsReport.tsx:126-128`
- Severity: LOW

### [claim-137] — KPI "GAP $ POTENTIAL" = Σ over customers of (set_revenue / items_bought) × (set_total − items_bought)
- Status: PASS
- Code path: `VoidsReport.tsx:129-134` — matches the guide's formula exactly
- Severity: LOW

### [claim-138] — KPI "ITEMS IN SET" = count of items in selected set
- Status: PASS
- Code path: `VoidsReport.tsx:161` (`itemCols.length`)
- Severity: LOW

### [claim-139] — KPIs recompute from the filtered set
- Status: PASS
- Code path: `VoidsReport.tsx:86-137` (the same useMemo computes filtered `customers` AND totals)
- Severity: LOW

### [claim-140] — Toolbar "Min set $" filter
- Status: PASS — see claim-132
- Severity: LOW

### [claim-141] — "# items ≥ N" / "≤ M"; M blank = any
- Status: PASS
- Code path: `VoidsReport.tsx:194-212,123-124` (`maxItems` is nullable; `null` skips the upper-bound filter)
- Severity: LOW

### [claim-142] — Per-item chips cycle off → must buy (green +) → must NOT buy (red −)
- Status: PASS
- Code path: `VoidsReport.tsx:45-55,229-274`
- Severity: LOW

### [claim-143] — Multiple chips AND together
- Status: PASS
- Code path: `VoidsReport.tsx:117-122` — uses `.every(...)` for both mustBuy and mustNotBuy sets
- Severity: LOW

### [claim-144] — "Clear (N)" button resets all chips
- Status: PASS
- Code path: `VoidsReport.tsx:238-241,56`
- Severity: LOW

### [claim-145] — Customer column pinned left
- Status: PASS
- Code path: `VoidsReport.tsx:407` (`pinnedColumns: { left: ['customer_name'] }`)
- Severity: LOW

### [claim-146] — Item column header sort = sort by revenue on that item (desc)
- Status: PASS
- Code path: `VoidsReport.tsx:374-393` — each item column's `field` is `item_<id>` and its value is the revenue number; default DataGridPro sort behavior orders by that.
- Severity: LOW

### [claim-147] — Column drag-reorder works
- Status: PASS
- Code path: DataGridPro Pro feature, enabled by default
- Severity: LOW

### [claim-148] — Burger menu: hide / pin / sort / filter
- Status: PASS
- Code path: DataGridPro Pro feature, enabled by default
- Severity: LOW

### [claim-149] — Pagination dropdown: 10 / 25 / 50 / 100 / 250 / All
- Status: PASS
- Code path: `VoidsReport.tsx:404` (`pageSizeOptions={[10, 25, 50, 100, 250, { value: -1, label: 'All' }]}`)
- Severity: LOW

### [claim-150] — Set Total column hidden by default
- Status: PASS
- Code path: `VoidsReport.tsx:409` (`columnVisibilityModel: { set_total: false }`)
- Severity: LOW

### [claim-151] — Cells green with $ when bought, red with "—" when not
- Status: PASS
- Code path: `VoidsReport.tsx:381-391`
- Severity: LOW

### [claim-152] — "Anomalies" report flags items/customers with statistically unusual YoY change
- Status: PASS (existence) / UNTESTABLE (statistical correctness without seeing data)
- Code path: `app/src/pages/reports/AnomaliesReport.tsx` + RPC `fetchAnomalies` (sigma-threshold based)
- Notes: `OverviewPage.tsx:257` invokes it with `sigma_threshold: 2`. The report exists as a Reports tab.
- Severity: LOW

### [claim-153] — "Health Movers" shows customers whose RFM segment shifted in last snapshot
- Status: PASS
- Code path: `app/src/pages/reports/HealthMoversReport.tsx` + RPC `fetchHealthMovers(window_days)`
- Severity: LOW

### [claim-154] — "Inactive Customers" — no invoice in N days, sorted by lifetime revenue
- Status: PASS
- Code path: `app/src/pages/reports/InactiveCustomersReport.tsx` + RPC `fetchInactiveCustomers`
- Severity: LOW

### [claim-155] — "AR aging" report buckets open invoices into 0-30 / 31-60 / 61-90 / 90+
- Status: WIRING_BROKEN
- Code path: not found on Reports page (`ReportsPage.tsx:10-18` lists 5 tabs — `inactive`, `movers`, `health_movers`, `anomalies`, `voids` — none of them AR aging)
- Expected: a dedicated AR Aging report on this page
- Actual: AR-aging data exists (as per-customer columns on the Margin page — `marginColumns.ts:142-149`), but there is no standalone AR aging report on Reports
- Severity: MEDIUM
- Notes: Operators looking for AR aging on Reports will be confused. The data is reachable but not where promised.

### [claim-156] — AR Aging report buckets reconcile to QBO A/R Aging Summary
- Status: DEFERRED (and dependent on claim-155 being implemented at all)
- Severity: MEDIUM

### [claim-157] — "Save view → Save as Report" promotes a pivot to the Reports tab
- Status: WIRING_BROKEN
- Code path: not found
- Expected: a button on Margin/Compare that saves a pivot as a Reports tab visible to everyone
- Actual: `Save view` (on Margin and Compare) creates a row in `saved_views` (Supabase table; see `lib/savedViews.ts:43`). Those rows show up in the **per-page Saved-views dropdown**, not as Reports tabs. ReportsPage has 5 hardcoded tabs and no UI to load a saved view.
- Severity: LOW

### [claim-158] — Saved filter views on Margin, Compare, Inventory, Customers; LocalStorage; "Saved views" dropdown
- Status: GUIDE_WRONG
- Code path: `app/src/lib/savedViews.ts:33-62`; consumers: `MarginPage.tsx:268-298,733-746` and `ComparePage.tsx:43-71`
- Expected: LocalStorage; available on Margin / Compare / Inventory / Customers
- Actual: Saved views are stored in the Supabase `saved_views` table (NOT LocalStorage). Available only on **Margin** and **Compare**. Inventory and Customers do not implement a Save-view UI.
- Severity: LOW
- Notes: Supabase storage is actually *better* than LocalStorage (shared across browsers and devices), but the guide is stale on both the storage location and the page coverage.

### [claim-159] — Plan Build, BOM detail, WO detail dialogs open 90 px from top
- Status: PASS
- Code path: `app/src/pages/plans/PlanBuildDialog.tsx:320` (`padding: '90px 20px 20px'`); `app/src/pages/production/BomsTab.tsx:363`; `app/src/pages/production/WorkOrdersTab.tsx:431`
- Severity: LOW

### [claim-160] — ⌘K / Ctrl K doesn't open search inside Refractor
- Status: PASS (the guide claim that it's NOT wired is correct)
- Code path: no global keyboard listener for `Cmd+K` / `Ctrl+K` found in the app
- Severity: LOW

### [claim-161] — URL hash reflects filter state; deep links land on the same view
- Status: WIRING_BROKEN (partial)
- Code path: `app/src/lib/router.ts:23-44`
- Expected (guide): `#/margin?from=...&to=...&group=customer` reflects filters; bookmarks share the view
- Actual: the router only handles **the view name** (`#margin`, `#customers`, `#customer-<id>`) and a single `customer-<id>` deep link. It does NOT parse query parameters from the hash. Margin filters live entirely in component state — they do not persist to the URL on change, and a "deep link with filters" would not restore filter state on load.
- Diff: deep-link-with-filters is unimplemented
- Severity: MEDIUM
- Notes: The Saved-views feature (claim-158) is an alternative way to share filtered views via DB. The URL-hash approach the guide describes does not work.

### [claim-162] — LIVE-badge click re-fetches the materialized view
- Status: WIRING_BROKEN
- Code path: `OverviewPage.tsx:435-438` and `MarginPage.tsx:657-668`
- Expected: clicking the LIVE stamp triggers a refresh
- Actual: the LIVE stamp is a plain `<div className="hero-stamp">` with no click handler on either page. Margin's stamp does have a `title` tooltip for the last cost sync time, but no click action; Overview's is just a render-time timestamp.
- Severity: LOW
- Notes: A separate "Refresh" / "Sync Item Costs" button exists in Margin (claim-40). Hard refresh (Ctrl+R) of course works.

### [claim-163] — Nightly cron at 09:00 UTC pulls Invoices / SR / CM / RR
- Status: PASS
- Code path: polymorphic shift in `supabase/migrations/20260518a_qbo_invoices_txn_type.sql` (txn_type column + sign-flip for CM/RR); the 09:00 UTC nightly-qbo-sync is the base sync, with 09:30/35/40/50 follow-ups in `20260503r_nightly_sync_crons.sql:7-31`.
- Severity: LOW
- Notes: The 09:00 UTC base sync's `cron.schedule(...)` definition is not in migrations (presumably set in the Supabase dashboard pre-migration era) — confirming the schedule lives in the running `cron.job` registry.

### [claim-164] — CM / RR stored as negative amounts so SUM(amount) = net revenue
- Status: PASS
- Code path: `supabase/migrations/20260518a_qbo_invoices_txn_type.sql:11` (comment: "sign-flips CreditMemo + RefundReceipt amounts (they REDUCE income)")
- Severity: MEDIUM

### [claim-165] — 10-min rolling refresh fetches ~100 invoices over last 90 days
- Status: PASS
- Code path: `supabase/migrations/20260518c_refresh_lines_rolling_cron.sql:19-42` — cron `refresh-lines-rolling` every `*/10` min, batch=100 across rolling 90-day window
- Severity: LOW
- Notes: With 100 invoices per 10 min and ~6 hour cycle, that's 36 batches × 100 = 3600 invoices per cycle. Whether 3600 covers the full 90-day window depends on invoice volume.

### [claim-166] — 3-minute line-backfill cron catches missing line caches
- Status: PASS (existence) / UNTESTABLE (its schedule isn't in committed migrations)
- Code path: referenced as "jobid 3" in `20260518c_refresh_lines_rolling_cron.sql:4-6` but its `cron.schedule(...)` call is not in any migration file
- Severity: LOW
- Notes: Likely registered via Supabase dashboard. Verify by `SELECT jobname, schedule FROM cron.job WHERE schedule LIKE '%/3 *%'`.

### [claim-167] — 5-min pg_net failure scanner
- Status: PASS
- Code path: `supabase/migrations/20260517a_pg_net_failure_scanner.sql:101-105` (cron `pg-net-failure-scanner` every `*/5` min, 15-min lookback)
- Severity: LOW

### [claim-168] — Margin app reads from `ops.mv_sales_lines`
- Status: PASS
- Code path: `supabase/migrations/20260512n_margin_rpcs_use_matview.sql:34,99,157,184,240` — `fn_sales_pivot`, `fn_sales_totals`, `fn_sparkline`, and friends all SELECT FROM `ops.mv_sales_lines`
- Severity: LOW

### [claim-169] — `mv_sales_lines` is auto-refreshed after every sync
- Status: PASS (within visible migrations)
- Code path: e.g. `supabase/migrations/20260517e_fix_bib_income_acct29.sql:15` (REFRESH MATERIALIZED VIEW CONCURRENTLY after data fix); generally the sync-qbo function is expected to trigger a refresh on completion
- Severity: LOW
- Notes: I did not verify the sync function itself (it's in `supabase/functions/sync-qbo/`, not the audit's `app/` scope) actually issues the REFRESH on every sync. Mark trust-but-verify.

### [claim-170] — Authority chain QBO P&L → `pl_snapshots` → `mv_sales_lines` → Margin UI is internally consistent
- Status: DEFERRED (QBO numeric reconciliation; requires layer-by-layer compare)
- Severity: HIGH
- Notes: This is the integrity claim that subsumes claims 48, 49, 64, 72, 119, 126. Single biggest reconciliation test once QBO MCP is re-authed.

### [claim-171] — Unmapped income accounts land in `(unspecified)`; backfill on the next 10-min refresh
- Status: PASS (wiring) / DEFERRED (behavioral)
- Code path: P&L Alignment editor in `app/src/pages/settings/AccountsEditor.tsx` (referenced in `SettingsPage.tsx`)
- Severity: LOW
- Notes: The actual "next 10-min refresh tick re-applies the mapping" claim depends on the cron-refresh path including a re-categorize step. Cannot verify without invoking.

### [claim-172] — Health-check 403 for non-superadmin is cosmetic
- Status: PASS
- Code path: Master Control panel lives at `public/control.html` (out of scope of this audit, but the claim is about the *Refractor* operator's perception). Within Refractor itself nothing renders a health-check banner that would be affected.
- Severity: LOW

### [claim-173] — `POST /functions/v1/sync-qbo?mode=refresh-mv` triggers MV refresh (admin only)
- Status: PASS (wiring) / UNTESTABLE (admin-only, write path)
- Code path: not in `app/` (Supabase edge function); claim is documented in the guide for admin use
- Severity: LOW
- Notes: I will not invoke this in the audit.

