# BRIX Margin Control — Architecture

> **Where this fits.** This is the architecture doc for the React/Vite app at
> `apbg-billing/app/`. For the cross-repo picture (Supabase projects, RLS,
> sync-qbo edge function modes, Intuit apps), see
> [`activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md).
> For the sync orchestration manifest (which functions write which `ops.*`
> tables), see [`./README.md`](./README.md) in this directory.

---

## What it is

**BRIX Margin Control** is APBG's internal margin / sales / customer
analytics application. It reads QuickBooks invoice and item data
projected into a curated `ops.*` schema in Supabase, and renders a
multi-page operator dashboard around it.

- **Surface URL (production):** `https://alamedapointbg.com/margin/`
  (proxied by `apbg-gateway` to `apbg-billing.netlify.app/sales-next/`).
- **Build output:** `apbg-billing/public/sales-next/` (Vite bundle).
- **Source root:** `apbg-billing/app/`.
- **npm package name:** `apbg-margin-app` (version tracked in
  `app/package.json` — currently `0.9.24`).
- **Replaces:** the legacy single-file SPA at `public/sales/index.html`
  (~300 KB monolith — still served at `/sales/` for now, will be
  decommissioned).

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | React 18.3 + TypeScript 5.5 | strict TS, ESM |
| Build | Vite 5.4 (`@vitejs/plugin-react`) | no SSR, static build |
| UI components | MUI v6 (`@mui/material`) + MUI X v7 | DataGrid Pro, X Charts, Date Pickers Pro |
| MUI X license | `@mui/x-license` v7 | Pro license key required (env-injected at build) |
| Icons | `lucide-react` 0.460 | one icon library, project-wide |
| Data client | `@supabase/supabase-js` v2 | RPC + table reads, anon key |
| Dates | `dayjs` | replaces moment for footprint |
| Routing | Hand-rolled (`app/src/lib/router.ts`) | hash-based, no React Router dependency |
| State | React hooks + LocalStorage via `settingsStore.ts` | no Redux/Zustand |
| Tables | MUI X DataGrid Pro | replaces hand-rolled tables for large grids |
| Charts | MUI X Charts + custom `Sparkline.tsx` | inline SVG for KPI cards |
| Pivot | Custom `components/PivotTable.tsx` | covers margin breakdowns |

The CLAUDE.md instruction to "use Tremor + shadcn" applies to the
APBG-OPS Operations KPI Dashboard. **BRIX uses MUI X** because the
MarginPage needs DataGrid Pro for large pivot tables with sort/filter/
export/pin — Tremor doesn't ship a comparable grid. The license is
already paid (`@mui/x-license` 7.28 in `package.json`).

---

## Build pipeline

```
git push main
       │
       ▼
Netlify build  (defined in apbg-billing/netlify.toml)
  1. node architecture/lint-manifest.mjs          ← sync-manifest gate
  2. npm install --prefix app                     ← React app deps
  3. npm run build --prefix app                   ← tsc + vite build
        ↓ outputs to ../public/sales-next/
  4. Netlify publishes `public/`                  ← serves the whole site
       │
       ▼
apbg-billing.netlify.app/sales-next/   (raw netlify URL)
       │
       ▼
apbg-gateway netlify.toml proxy
  /margin/*   → apbg-billing.netlify.app/:splat
  /margin/.netlify/functions/*  → apbg-billing functions
       │
       ▼
alamedapointbg.com/margin/   (branded URL surfaced on the Ops Hub)
```

Two important things about the Vite config (`app/vite.config.ts`):

1. `base: '/sales-next/'` — the bundle assumes it's mounted at that
   path. Don't move the output directory without updating both
   `base` and the netlify.toml proxy.
2. `emptyOutDir: true` — Vite cleans `../public/sales-next/` on every
   build. Don't drop static assets in there manually.

When the legacy `/sales/` is retired, the migration is:
- Switch `base` and `outDir` to `/sales/`.
- Delete `public/sales/index.html` (the legacy monolith).
- Re-point the `/margin/*` proxy (no change to user-facing URL).

---

## Directory layout

```
apbg-billing/
└── app/                              ← BRIX Margin Control source root
    ├── package.json                  ← "apbg-margin-app"
    ├── vite.config.ts                ← base=/sales-next/, outDir=../public/sales-next
    ├── tsconfig.json
    ├── index.html                    ← Vite entry HTML
    ├── public/                       ← Vite static assets (favicons, fonts)
    └── src/
        ├── main.tsx                  ← ReactDOM.createRoot, mounts <App/>
        ├── App.tsx                   ← top-level router + auth gate
        ├── vite-env.d.ts
        ├── styles/                   ← global CSS + design tokens
        ├── types/                    ← shared TypeScript types
        ├── components/
        │   ├── Layout.tsx            ← sidebar + topbar shell
        │   ├── BrixMark.tsx          ← animated brand mark
        │   ├── KPICard.tsx           ← hero metric tile
        │   ├── Sparkline.tsx         ← inline SVG line chart
        │   ├── PivotTable.tsx        ← custom pivot grid
        │   ├── MarginGrid.tsx        ← DataGrid Pro wrapper for margin tables
        │   ├── ReportGrid.tsx        ← DataGrid Pro wrapper for report exports
        │   ├── RowDetailModal.tsx    ← drilldown modal for grid rows
        │   ├── TopMoversStrip.tsx    ← horizontal "biggest movers" strip
        │   ├── MultiPicker.tsx       ← multi-select filter
        │   ├── ModifierPicker.tsx    ← chain-modifier picker (Margin page)
        │   ├── SegmentChip.tsx       ← segment filter pill
        │   ├── CustomerLink.tsx      ← link to /customers/:id
        │   ├── Skeletons.tsx         ← loading skeletons
        │   └── charts/               ← chart wrappers (MUI X Charts)
        ├── pages/
        │   ├── LoginPage.tsx + .css  ← Supabase email/password
        │   ├── OverviewPage.tsx      ← hero KPIs + sparklines + top movers
        │   ├── MarginPage.tsx        ← THE heavyweight: pivot + DataGrid Pro
        │   ├── OperationsPage.tsx    ← ops KPIs (delivery / service / reman)
        │   ├── CustomersPage.tsx     ← customer list
        │   ├── CustomerDetailPage.tsx← per-customer drilldown
        │   ├── ReportsPage.tsx       ← + reports/ subfolder for report types
        │   ├── PlansPage.tsx         ← + plans/ subfolder for plan editors
        │   ├── ComparePage.tsx       ← prior-period / prior-year comparison
        │   ├── InventoryPage.tsx     ← item master + P&L alignment
        │   ├── SettingsPage.tsx      ← + settings/ subfolder for sub-screens
        │   ├── FleetPage.tsx         ← LEGACY — not in nav, moving to APBG-OPS
        │   └── PlaceholderPage.tsx   ← for not-yet-built nav items
        └── lib/
            ├── supabase.ts           ← Supabase client (anon key, ops schema)
            ├── rpc.ts                ← typed wrappers around ops.* RPCs
            ├── router.ts             ← hash router
            ├── sales.ts              ← sales/margin queries
            ├── salesReps.ts          ← sales-rep assignment + commission
            ├── customers.ts          ← customer queries + chain detection
            ├── inventory.ts          ← item master + P&L alignment helpers
            ├── kpi.ts                ← KPI computation
            ├── marginColumns.ts      ← column definitions for MarginGrid
            ├── chainModifiers.ts     ← chain-of-stores modifier logic
            ├── overhead.ts           ← overhead allocation math
            ├── plans.ts              ← plan model + helpers
            ├── reports.ts            ← report templates + export
            ├── fleet.ts              ← LEGACY — moving to APBG-OPS
            ├── savedViews.ts         ← user filter persistence
            ├── settings.ts           ← settings persistence (Supabase)
            ├── settingsStore.ts      ← LocalStorage view-state cache
            ├── taxonomy.ts           ← category/segment taxonomy
            ├── formatters.ts         ← currency / date / percent
            ├── csv.ts                ← CSV export
            ├── styles.ts             ← inline style tokens
            ├── muiTheme.ts           ← MUI theme override (Brix palette)
            └── toast.tsx             ← toast notification system
```

### Page → route map (hand-rolled router, hash-based)

| Route | Page | Notes |
|---|---|---|
| `#/` | OverviewPage | Default landing — hero KPIs |
| `#/margin` | MarginPage | Pivot + DataGrid Pro (heaviest screen) |
| `#/operations` | OperationsPage | Delivery / service / reman KPIs |
| `#/customers` | CustomersPage | Customer master + filter |
| `#/customers/:id` | CustomerDetailPage | Per-customer drilldown |
| `#/reports` | ReportsPage | Report templates |
| `#/plans` | PlansPage | Plan editors |
| `#/compare` | ComparePage | Period vs period comparison |
| `#/inventory` | InventoryPage | Item master + P&L alignment column |
| `#/settings` | SettingsPage | Multi-sub-screen settings |

Sidebar in `Layout.tsx` exposes 9 items (Overview, Margin, Operations,
Customers, Reports, Plans, Compare, Inventory, Settings). Fleet was
removed from the nav 2026-05-10 and the underlying page + lib will be
deleted once APBG-OPS picks it up.

---

## Data layer

### Supabase project

- **Project ref:** `gfsdpwiqzshhexkofiif`
- **URL:** `https://gfsdpwiqzshhexkofiif.supabase.co`
- **Schema accessed:** `ops` (read-only from this app)
- **Auth:** anon key embedded in bundle (`app/src/lib/supabase.ts`).
  RLS on `public.*` is the protection layer; `ops.*` exposes only
  SECURITY DEFINER RPCs and read views.
- **User auth:** Supabase Email/Password via `LoginPage.tsx`. Session
  stored under the Supabase client's default storage key. **Not** the
  `apbg_session` key used by the gateway (the two systems have parallel
  auth right now — see "Known gaps" below).

### Data flow (read path)

```
public.qbo_invoices  /  public.qbo_invoice_lines  /  public.qbo_items
                              │  (RLS on, written by sync-qbo edge fn)
                              ▼
ops.qbo_invoices  /  ops.qbo_invoice_lines  /  ops.qbo_items
                              │  (projection views over public.*)
                              ▼
            ops.mv_sales_lines  (MATERIALIZED VIEW)
            47 k rows · 21 MB · 9 indexes
                              │
                              ▼
ops.fn_sales_totals  /  ops.fn_sales_pivot  /  ops.fn_sparkline  /  ops.fn_sales_dim_values
                              │  (SECURITY DEFINER RPCs)
                              ▼
                  app/src/lib/rpc.ts  →  pages
```

Direct table reads from the bundle are avoided. Everything goes
through the four RPCs above. This is what makes RLS on the underlying
`public.*` tables non-breaking for this app.

### Refresh

`ops.mv_sales_lines` is refreshed via `ops.refresh_sales_lines()` which
runs `REFRESH MATERIALIZED VIEW CONCURRENTLY` so reads never block.
Triggered automatically by `sync-qbo` edge function v35 at the end of
every successful sync. Manual refresh available via
`POST /functions/v1/sync-qbo?mode=refresh-mv`.

### Indexes on `ops.mv_sales_lines`

| Index | Purpose |
|---|---|
| `mv_sales_lines_pk` (UNIQUE on `line_id`) | Required for CONCURRENT refresh |
| `mv_sales_lines_txn_date_idx` | Date range filters (every RPC) |
| `mv_sales_lines_txn_month_idx` | Month dimension grouping |
| `mv_sales_lines_customer_idx` | Customer filter + group-by |
| `mv_sales_lines_item_idx` | Item filter + group-by |
| `mv_sales_lines_category_idx` | Category filter + group-by |
| `mv_sales_lines_segment_idx` | Segment filter + group-by |
| `mv_sales_lines_entity_idx` | Brix vs Alameda Soda entity filter |
| `mv_sales_lines_invoice_idx` | Joining back to invoice headers |
| `mv_sales_lines_channels_gin` (GIN) | Array filter on `channels` |

### Performance

Before materialization (pre 2026-05-10), `fn_sales_totals` for YTD on a
regular view rebuilt 47 k rows from 7-table joins + a LATERAL subquery
on every call. Latency was 8000+ ms and hit `statement_timeout` on
OverviewPage. After materialization: ~34 ms. ~250× speedup. The 60 s
statement timeout on anon/authenticated roles is now a safety net only.

---

## Brand & visual system

Inherited from the gateway refresh (see
[`apbg-gateway/public/index.html`](https://github.com/skypace/apbg-gateway/blob/main/public/index.html)
for the matching palette tokens on the parent surface).

- **Primary navy:** `#1F4E79` (Brix anchor)
- **Bright accent:** `#3B82F6` (links, active states, focus rings)
- **Base:** `#0F172A` slate-900 (matches margin control loader)
- **Surface:** `#1E293B` slate-800
- **Display type:** Bricolage Grotesque (Google Fonts)
- **Body type:** Inter Tight (Google Fonts)
- **Numerics:** JetBrains Mono (tabular numerals for $ and %)
- **Icons:** Lucide React only — no mixing icon libraries
- **MUI theme override:** `lib/muiTheme.ts` translates the above into
  MUI's theme tokens so DataGrid and Charts inherit it.

---

## Auth & access

| Surface | Mechanism | Allowed roles |
|---|---|---|
| LoginPage → Supabase | Email + password | All authenticated users; superadmin-only screens gate themselves in-page |
| `ops.*` RPCs | SECURITY DEFINER — no JWT check inside | Anyone with the anon key can call (intentional; data is non-sensitive operational metrics) |
| Future: superadmin-only screens | Check `session.user.user_metadata.role` or call a `requireRole()` helper | Currently TODO |

The gateway's own auth (`apbg_session` in localStorage, written by
`/auth.js`) is **separate** from this app's Supabase auth. A user
logged into the gateway is not automatically logged into Margin
Control. Both sessions land on the same Supabase project and ultimately
the same user record — they just maintain independent JWTs. Unifying
them is a future task.

---

## What's in scope vs. out

### In scope for BRIX Margin Control

- All sales / margin / customer / item / report screens served from
  `/margin/`.
- Sales analytics (pivot, drill, compare, export).
- Margin math (cost-of-goods, overhead allocation, plan-based pricing).
- Customer master (parent/sub chain, contact, address, classification).
- Inventory master (P&L alignment, category, segment).
- Report templates + CSV export.

### Out of scope (lives elsewhere)

| Concern | Where it lives |
|---|---|
| Vendor bill processing (AP) | `apbg-billing/public/*.html` (the legacy AP tool that shares this repo) |
| ResQ ↔ Service Fusion sync | `apbg-billing/netlify/functions/resq-sf-sync*.mjs` |
| Health checks, OAuth callbacks | `apbg-billing/netlify/functions/` (back-end only) |
| Operations KPI dashboard (delivery/service/reman/fleet/HR/roster) | `skypace/APBG-OPS` — separate Netlify project at `/operations/` on the gateway |
| Pacer Finance MCP endpoints (QBO/Zoho MCP) | `skypace/pacerfinance` — separate Netlify project |
| Equipment leasing / rental | `skypace/APBG-Leasing-Rental` — separate stack on Railway |
| Melt equipment portal | `skypace/melt-dashboard` |

---

## Known gaps + open items

1. **Two auth sessions.** Gateway uses `apbg_session` localStorage key;
   Margin Control uses the Supabase client's default key. Same Supabase
   project, but no SSO yet. A user logs in twice (once at the gateway,
   once at Margin Control on first visit). Low impact today since
   Supabase keeps the session sticky; worth unifying when convenient.

2. **Fleet page + `lib/fleet.ts` are dead code.** Removed from
   sidebar 2026-05-10 because the Operations KPI Dashboard
   (`APBG-OPS`) now owns fleet. Files still in the repo —
   safe to delete in a follow-up PR.

3. **Legacy `public/sales/` SPA still serves at `/sales/` and
   `/billing/sales/`.** Vite output goes to `/sales-next/`. Until the
   migration is complete, two SPAs exist. Confusing for new
   contributors. Plan: switch `vite.config.ts` `base` to `/sales/`
   after a final feature-parity check, delete the legacy monolith.

4. **No `MarginGrid` row-level export.** DataGrid Pro has the export
   feature; just need to wire it. Useful for "send me last quarter's
   margin for these 12 customers."

5. **`SettingsPage.tsx` is mostly a router shell** to sub-screens
   under `pages/settings/`. The sub-screens themselves are still
   maturing — Customers (master), Items (master), Categories,
   P&L Alignment, Sales Reps. Treat the layout as the contract, the
   contents as in-progress.

6. **No mobile-first design pass yet.** App is responsive enough at
   1024 px and above; below that DataGrid Pro becomes cramped. Not a
   priority — every user is on a 1440+ laptop.

7. **MUI X Pro license** must be present at build time via
   `VITE_MUI_X_LICENSE` env var. Without it, DataGrid Pro renders a
   "license expired" watermark. License is paid through `activespacescience`
   — keep the env var set on both the production and `dev` branch
   deploys in Netlify.

---

## Where to look next

| Need to … | Go to … |
|---|---|
| Add a new chart to a page | `components/charts/` + use MUI X Charts |
| Add a new column to the margin pivot | `lib/marginColumns.ts` |
| Add a new RPC and call it from the app | Postgres function in Supabase, then add a typed wrapper in `lib/rpc.ts` |
| Change the materialized view schema | Migration + add an index + bump `sync-qbo` if refresh shape changes |
| Add a new page | `pages/NewPage.tsx`, register in `lib/router.ts` and the sidebar in `components/Layout.tsx` |
| Add an `ops.*` table | Update `architecture/sync-manifest.json` (writer or orphan), run lint |
| Touch cross-repo architecture | Update `Skilliosis_Mytosis_Architecture/ARCHITECTURE.md` in the same change |

---

## Change log

| Date | Change |
|---|---|
| 2026-05-11 | Initial dedicated MARGIN-CONTROL.md. Covers structure, data flow, RPCs, brand, build pipeline, and known gaps. Cross-references master handbook and sync-manifest README so each doc stays single-purpose. |
