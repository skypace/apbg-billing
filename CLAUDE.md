# CLAUDE.md — Build Instructions for Claude Code

You are building the PACER Ops Dashboard — an operational KPI platform for PACER Group (Brix Beverage + FreeFlow Beverage Solutions). All backend data already exists in Supabase. Your job is to build the frontend app and wire up the remaining sync functions.

## Architecture

```
Supabase (Postgres)          Netlify (this repo)
───────────────────          ──────────────────
ops.* schema (31 tables)     public/         → static HTML (existing billing tool)
  - QBO invoices (11,843)    public/sales/   → THIS DASHBOARD (React SPA shell exists)
  - QBO invoice lines (46K)  netlify/functions/ → existing billing + ResQ-SF sync
  - P&L snapshots (1,130)
  - SF delivery stops (297)  Supabase Edge Functions (separate deploy)
  - SF service jobs (179)    ──────────────────────────────────────
  - SF reman jobs (5)        sync-qbo       → nightly QBO pull
  - staff roster (20)        sync-sf        → every 30min SF pull
  - staff_roles (12)         stale-invoice-alert → daily 7am email
  - fleet tables (empty)     sync-qbo-employees → on-demand
  - HR tables (empty)
```

## Credentials

- **Supabase URL**: `https://gfsdpwiqzshhexkofiif.supabase.co`
- **Supabase anon key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY`
- **Schema**: `ops` (use `Accept-Profile: ops` header or Supabase client `{ db: { schema: 'ops' } }`)
- **QBO Realm ID**: `9130352144155116`
- **Netlify site**: linked to this repo, auto-deploys on push to `main`
- **Publish dir**: `public/`

## Current state of `public/sales/index.html`

Single-file React 18 + Babel CDN SPA, scoped to **Margin Minder-style sales analytics only**. Other ops modules (Delivery, Service, Reman, Fleet, HR, Roster) were removed from this dashboard — their data remains in Supabase if a separate dashboard is built later.

- Margin pivot: drill by category, item, customer, month, or entity over `qbo_invoice_lines`
- Filters: date range, entity, plus row-click drill-down with chip filters
- Compare: prior period / prior year columns + Δ %
- Export: CSV of the current pivot
- Sync: "Sync Item Costs" triggers `netlify/functions/sync-qbo-items` to populate `ops.qbo_items.purchase_cost`, which lights up the est. cost / est. margin / margin % columns

(Old multi-tab content kept here for historical reference:)
- Executive page: pulls live QBO invoices, P&L snapshots, AR aging, top customers
- Delivery page: pulls live SF delivery stops, driver summary
- Service page: pulls live SF service jobs, tech summary
- Reman page: pulls live reman jobs
- Fleet page: placeholder (schema exists, no data yet — AT&T FleetComplete API pending)
- HR page: placeholder (schema exists, no data yet — Bambee/BambooHR pending)
- Roster page: pulls live staff + staff_roles + role_types

## What you need to build

### Priority 1: Upgrade to a real app
Replace the single HTML file with a proper Next.js (or Vite + React) app. Keep it deployable to Netlify as a static site. The existing `netlify/functions/` directory must stay intact — don't break Whitney's billing tool.

Recommended structure:
```
/app/                    ← new Next.js or Vite app
  /src/
    /pages/              ← or /routes/
      executive.tsx
      delivery.tsx
      service.tsx
      reman.tsx
      fleet.tsx
      hr.tsx
      roster.tsx
      settings.tsx
    /components/
      Layout.tsx         ← sidebar nav + header
      KPICard.tsx
      DataTable.tsx
      ARAgingChart.tsx
    /lib/
      supabase.ts        ← client init with ops schema
      formatters.ts      ← currency, date, percent helpers
  /public/
    ...
public/                  ← keep existing billing HTML files here
  billing/               ← or move them under a subpath
netlify/functions/       ← DO NOT TOUCH these
netlify.toml             ← update publish dir if needed
```

### Priority 2: Roster CRUD
The roster is the backbone — every KPI depends on staff-to-department-to-COGS mapping.

Tables involved:
- `ops.staff` (staff_id UUID PK, display_name, department, entity, annual_wage, status, qbo_employee_id)
- `ops.staff_roles` (staff_id, role_code, is_primary, effective_from, effective_to)
- `ops.role_types` (role_code PK, label, business_unit, sort_order)
- `ops.cogs_accounts` (department PK, qbo_account_id, qbo_account_name)
- `ops.qbo_employees_cache` (qbo_employee_id PK — read-only mirror from QBO Payroll)

CRUD operations:
- Add staff member (name must match SF tech name exactly for job attribution)
- Edit department, entity, wage, status
- Assign/remove roles via staff_roles (dated — set effective_to to retire)
- Deactivate (set status='inactive', preserve history)
- View linked QBO employee data from cache
- View job history per person (join to delivery_stops, service_jobs, reman_jobs)

### Priority 3: Fix sync gaps

**A. QBO Expenses sync (ops.qbo_expenses is empty)**
The existing `sync-qbo` edge function (Supabase, v29) only pulls invoices + P&L. It needs to also query:
```
SELECT * FROM Purchase WHERE TxnDate >= '2025-01-01' MAXRESULTS 1000
```
And upsert into `ops.qbo_expenses` with columns: qbo_txn_id, qbo_txn_type, txn_date, account_ref_id, account_name, amount, vendor_name, employee_name, memo, department, entity, expense_category.

To read the current sync-qbo function, use the Supabase Management API or check the edge function logs. The function uses QBO OAuth tokens stored in `ops.qbo_token_cache`.

**B. KPI daily rollup (ops.kpi_daily is empty)**
Create a Postgres function + pg_cron job that runs nightly after sync-qbo completes. It should:
1. For each active team_member with department = 'delivery':
   - Count delivery_stops for that day
   - Sum sf_total as delivery_revenue
   - Compute daily labor cost = annual_wage / 260
   - cost_per_stop = daily_cost / stops
   - revenue_per_stop = revenue / stops
2. Same pattern for 'service' (service_jobs) and 'reman' (reman_jobs)
3. Upsert into ops.kpi_daily keyed on (kpi_date, team_member_id)

**C. AT&T FleetComplete / Powerfleet integration**
- API docs: `https://tlshosted.fleetcomplete.com/Integration/v8_5_0/Help`
- Auth: API token (free, request from support@powerfleet.com or Powerfleet portal)
- Token stored in `ops.fc_token_cache` (api_token, account_id, base_url)
- Tables ready: `ops.fleet_vehicles`, `ops.fleet_trips`, `ops.fleet_fuel_transactions`, `ops.fleet_maintenance`
- Build a `sync-fleetcomplete` Supabase edge function
- Sky uses this for fuel cost, mileage, driving behavior tracking
- This is the ONLY integration that needs full API review from scratch

**D. HR / Bambee integration**
- Bambee (bambee.com) = outsourced HR manager service, $99/mo. NO public API. Data entry is manual or CSV import.
- BambooHR (bamboohr.com) = HRIS with full REST API. Docs: `https://documentation.bamboohr.com/reference`
- Tables ready: `ops.hr_employees`, `ops.hr_time_off`, `ops.hr_documents`, `ops.hr_performance`, `ops.hr_onboarding`
- `hr_employees.staff_id` FKs to `ops.staff.staff_id` for linking
- Build CRUD forms for manual HR data entry (works without any API)
- If BambooHR is chosen later, build a sync edge function

### Priority 4: Dashboard KPIs (from PACER-KPI-SPEC.md)

That file has 108 KPIs. For the CEO dashboard, prioritize these 15:

**Executive (always visible):**
1. Total Revenue (monthly, from pl_snapshots)
2. Gross Margin % (from pl_snapshots)
3. Net Income (from pl_snapshots)
4. AR Outstanding (from qbo_invoices WHERE balance > 0)
5. AR Overdue (due_date < today)
6. Revenue per Employee (revenue / active staff count)

**Delivery tab:**
7. Stops per day (from delivery_stops)
8. Cost per stop (from kpi_daily)
9. Revenue per stop (from kpi_daily)
10. Stale invoices count (sf_total > 0, no QBO match > 5d)

**Service tab:**
11. Jobs per tech per day (from service_jobs)
12. Revenue per job (from service_jobs)
13. First-time fix rate (from service_jobs.first_time_fix)
14. Non-invoiced jobs (sf_total > 0, qbo_invoice_matched = false)

**Fleet tab (once connected):**
15. Fuel cost per stop (fleet_fuel_transactions.total_cost / delivery_stops.count)

### Priority 5: Auth
Add basic auth. Options:
- Supabase Auth (email/password, simplest)
- Simple shared password stored in Netlify env var
- Keep it internal-only for now

## Key business rules

### Entity split
- `entity = 'brix'` or `'AS'` = Alameda Soda / Brix Beverage (California S-corp)
- `entity = 'freeflow'` or `'FF'` = FreeFlow Beverage Solutions (Massachusetts S-corp)
- `entity = 'shared'` = split between both (officers, shared ops)

### Department to COGS mapping
| Department | QBO Account ID | Account Name |
|---|---|---|
| delivery | 1150040011 | B2B - Direct Labor (COGS) |
| service | 1150040012 | Service - Direct Labor (COGS) |
| reman | 1150040013 | Reman - Direct Labor (COGS) |
| ops (shared) | 1150040007 | Direct Labor |

### Payroll split (confirmed)
TO FREEFLOW 100%: Nadell $47K, Feliciano $44K, Eric V $55K, Benavides $52K, Anthony V $72K, Andrade $37K = $305K
SPLIT 50/50: Marco $105K, Joel $75K = $90K each side
TO ALAMEDA SODA (drivers): Onate $46K, McGee $43K = $89K
Officers at AS: Sky $132K, Sloan $112K (eliminated mid-2027)

### Melt store economics
- Avg equipment $247K/store at 7.7% margin
- Install labor $4K/store
- Service $12K/store/yr + PM $6K/store/yr
- 26 existing + 8 new starting June 2026 = 34 EOY 2026
- Target 58 total by EOY 2028

## Files in this repo

```
CLAUDE.md              ← YOU ARE HERE
PACER-KPI-SPEC.md      ← full 108 KPI specification
PACER-OPS-README.md    ← quick reference / table inventory
README.md              ← original billing tool readme
USER-GUIDE.md          ← billing tool user guide
public/                ← Netlify publish dir
  index.html           ← billing tool landing page (Whitney's)
  approve.html         ← vendor bill approval
  customer-approve.html
  control.html         ← admin control panel
  sync.html            ← ResQ-SF sync dashboard
  setup.html
  sales/index.html     ← PACER Ops Dashboard (prototype shell; old /ops/ path 301-redirects here)
netlify/functions/     ← billing + ResQ-SF functions (DO NOT BREAK)
netlify.toml           ← build config + function schedules
package.json
```

## Cross-repo references
- `activespacescience/Skilliosis_Mytosis_Architecture` — master architecture handbook
- `skypace/pacerfinance` (pacerfinance.netlify.app) — QBO MCP server, Zoho MCP
- `skypace/Pacer-outlook` (pacer-outlook.netlify.app) — Outlook MCP

## Do not

- Break the existing billing tool (public/*.html + netlify/functions/)
- Expose the Supabase service_role key in client code (anon key only)
- Hard-delete staff records (set status to 'inactive' instead)
- Modify ops.qbo_token_cache or ops.sf_token_cache directly — the edge functions manage those

---

## Current state (as of 2026-05-12)

**The Priority 1–5 build agenda above is mostly historical.** Most of it has shipped:

- **P1 (real app):** Done. `app/` is the React 18 + Vite 5 + TypeScript Margin Control SPA, npm package `apbg-margin-app`, current version **v0.9.27**. Builds to `public/sales-next/` and is served at **`alamedapointbg.com/margin/`** via the gateway proxy.
- **P2 (Roster CRUD):** Moved to `APBG-OPS` (mounted at `/operations/` on the gateway). Removed from the BRIX nav 2026-05-10.
- **P3 (sync gaps):** Most landed — `sync-qbo` is now v35 with `ops.mv_sales_lines` refresh; Fleet + HR/Bambee work moved to `APBG-OPS`.
- **P4 (Dashboard KPIs):** BRIX surfaces the sales/margin/customer KPIs. The operational delivery / service / reman KPIs moved to `APBG-OPS`.
- **P5 (Auth):** Supabase Email/Password shipped via `LoginPage.tsx`.

**For up-to-date architecture and the current four-surface structure of this repo, read:**

- [`architecture/MARGIN-CONTROL.md`](architecture/MARGIN-CONTROL.md) — focused architecture doc for the BRIX app: pages, components, lib modules, RPC contract, build pipeline, known gaps.
- [`README.md`](README.md) — repo map: AP tool + Margin Control + sync-manifest tooling + user-guide docs.
- [`docs/margin-control/user-guide.md`](docs/margin-control/user-guide.md) — end-user guide for BRIX (rendered interactively at `alamedapointbg.com/margin/docs/margin-control/`).
- [`activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md) — master cross-repo handbook.

The Priority 1–5 sections above are kept for historical context (payroll splits, store economics, COGS mapping are still accurate; the build-task framing is not).

## Change log

| Date | Version | Change |
|---|---|---|
| 2026-05-11 | v0.9.22 | Items active/managed toggles, customers gain parent/sub + address fields, Margin hero-stamp polish (LIVE + costs-ago + sync time). |
| 2026-05-11 | v0.9.23 | **P&L alignment audit shipped.** New Postgres `fn_item_pl_audit` + `fn_apply_pl_category_suggestions`. Items master gets a P&L Alignment column (aligned / misaligned / isolated / no_account / unclassified_account) + "Auto-categorize from P&L" bulk action for high-confidence (≥60% consensus) suggestions. Legacy Customer Classification tab retired. `fn_list_categories()` renamed `fn_list_category_options` to dodge PG overload ambiguity. |
| 2026-05-11 | v0.9.24 | **Per-customer entity + FIRST QBO WRITEBACK PATH.** New `entity` column on customers + `fn_list_entities` + `fn_customers_master` returning `entity_resolved`. Entity dropdowns app-wide now source from this RPC instead of a hardcoded Brix/Alameda/FreeFlow/shared list. **New `push-qbo-item` edge function** — `setActive` action lets the Items master Active toggle flip both BRIX and QBO in one click. First Supabase → QBO direction in this stack (sync-qbo was read-only before today). |
| 2026-05-11 | v0.9.25 | **Category writeback.** `push-qbo-item v2` adds `bulkSyncCategories` — creates QBO Category items (Item.Type = Category) and sets each child item's ParentRef. Surfaced as the **Push to QBO** button on Items master, with dry-run preview. `bulkSyncCategoriesToQbo` lib helper wraps the edge call. |
| 2026-05-11 | — | **Docs + arch shipped.** Focused architecture doc at [`architecture/MARGIN-CONTROL.md`](architecture/MARGIN-CONTROL.md). Repo `README.md` rewritten to cover the four surfaces (AP + Margin Control + sync-manifest + user-guide docs). Interactive user guide at `docs/margin-control/user-guide.md` (source) + `public/docs/margin-control/index.html` (viewer, fetches markdown at runtime via marked.js + DOMPurify). `netlify.toml` build step `mkdir -p public/docs && cp -r docs/. public/docs/` wired in. Sidebar User Guide link in `app/src/components/Layout.tsx`. |
| 2026-05-11 | — | **TS build fix in `app/src/pages/settings/ItemsSettingsEditor.tsx`.** Added `[key: string]: unknown` index signature to the `GridRow` interface so MUI X DataGrid Pro v7's `rows: readonly Record<string, unknown>[]` constraint is satisfied. |
| 2026-05-12 | v0.9.26 | **Data hygiene + chain rollups preview.** New Postgres `fn_item_hygiene_summary` + `fn_preview_rollup_match` (live ILIKE counts). Items page gets a data hygiene banner with click-to-filter. Rollups picker shows live preview of matching item / customer names. |
| 2026-05-12 | v0.9.27 | **Runtime fuzzy match for Chain Rollups.** `expandModifierFilters` lib helper pre-resolves ILIKE patterns to exact name lists before query time. Rollup filters in Margin now expand to real underlying names at runtime via `fn_preview_rollup_match` — silent mismatches when naming drifts are now visible and auditable. |
