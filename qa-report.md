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

