# PACER Margin Dashboard — Handoff

Status snapshot for cowork. Sky owns the product; this doc lets the next session/agent pick up without spelunking.

Last updated: 2026-05-03.

---

## What this is

A Margin Minder–style sales analytics dashboard for PACER Group (Brix Beverage + FreeFlow Beverage Solutions), built on QBO data living in Supabase.

Two URLs in production:

| URL | What | Status |
|---|---|---|
| `https://apbg-billing.netlify.app/sales/` | Legacy single-file React+Babel SPA | Source of truth, all features, still used daily |
| `https://apbg-billing.netlify.app/sales-next/` | New Vite + React + TypeScript app | Migration in progress; some pages live, others link back to legacy |

Both share the same Supabase backend and ship in the same Netlify deploy.

---

## Repos and where things live

```
skypace/apbg-billing                      ← this repo
├── public/
│   ├── sales/index.html                  ← legacy single-file SPA (~5500 lines)
│   ├── sales-next/                       ← built bundle of new Vite app (committed; see below)
│   ├── index.html, approve.html, etc.    ← Whitney's billing tool — DO NOT TOUCH
├── netlify/functions/                    ← billing tool serverless fns — DO NOT TOUCH
├── app/                                  ← new Vite + React + TS app (source)
│   ├── src/
│   │   ├── App.tsx, main.tsx
│   │   ├── lib/                          ← supabase client, RPC wrappers, formatters,
│   │   │                                   typed rpc-shim modules per concern
│   │   ├── components/
│   │   │   ├── KPICard.tsx
│   │   │   ├── PivotTable.tsx
│   │   │   ├── MultiPicker.tsx
│   │   │   ├── SegmentChip.tsx
│   │   │   ├── CustomerLink.tsx
│   │   │   ├── Sparkline.tsx
│   │   │   └── charts/                   ← BarChart, AreaChart, DonutChart, Tooltip, util
│   │   ├── pages/
│   │   │   ├── OverviewPage.tsx          ← default landing
│   │   │   ├── MarginPage.tsx
│   │   │   ├── CustomersPage.tsx
│   │   │   ├── CustomerDetailPage.tsx
│   │   │   ├── ReportsPage.tsx + reports/<5 tabs>
│   │   │   ├── PlansPage.tsx + plans/<3 modes>
│   │   │   ├── RepsPage.tsx + reps/<book>
│   │   │   ├── ComparePage.tsx
│   │   │   ├── InventoryPage.tsx
│   │   │   ├── SettingsPage.tsx + settings/<5 editors>
│   │   │   └── PlaceholderPage.tsx       ← used for not-yet-ported tabs
│   │   ├── styles/theme.css
│   │   └── types/supabase.ts             ← 2,958 lines, generated from ops schema
│   ├── package.json, vite.config.ts, tsconfig.json
└── supabase/migrations/*.sql             ← every schema change, applied + checked in

Other repos referenced:
- skypace/apbg-gateway                    ← alamedapointbg.com gateway, sets apbg_session
- activespacescience/Skilliosis_Mytosis_Architecture   ← master arch handbook
- skypace/pacerfinance                    ← QBO MCP server, Zoho MCP
```

---

## Backend (Supabase project `gfsdpwiqzshhexkofiif`)

All schema is in the `ops` schema. Reads use `Accept-Profile: ops` header.

### Auth

Supabase Auth (email/password). The legacy `/sales/` reads `apbg_session` from localStorage when served through the gateway; the new `/sales-next/` does NOT yet — that's a Phase 6 todo.

### Key tables

| Schema.table | What |
|---|---|
| `ops.qbo_invoices` | 11,843 invoices |
| `ops.qbo_invoice_lines` | 46,855 lines |
| `ops.qbo_items` | item master, populated by sync-qbo-items |
| `ops.qbo_customers` | customer master |
| `ops.qbo_expenses`, `ops.qbo_expense_lines` | Bills/POs for actual COGS |
| `ops.qbo_inventory_adjustments` + `_lines` | shrinkage, damage, count adjustments |
| `ops.v_sales_lines` | flat join of invoices + lines + items + classifications. Source of truth for almost every analytics RPC. |
| `ops.channels`, `ops.customer_channels` | M2M channel taxonomy |
| `ops.segments`, `ops.customer_segments`, `ops.item_segments` | segment taxonomy |
| `ops.sales_reps`, `ops.customer_sales_reps`, `ops.commission_rules` | rep + commissions |
| `ops.expense_buckets`, `ops.account_buckets` | P&L bucket assignment for OH allocation |
| `ops.item_sets`, `ops.item_set_items` | product sets for void/cross-sell |
| `ops.sales_plans`, `ops.sales_plan_lines` | budgeting |
| `ops.inventory_settings`, `ops.inventory_velocity_excludes` | inventory analytics knobs |
| `ops.customer_health_snapshots` | weekly RFM snapshots (8 weeks backfilled, more added every Monday by cron) |
| `ops.saved_views` | persisted filter combos |
| `ops.digest_subscriptions`, `ops.digest_log` | email digest config + send history |
| `ops.qbo_token_cache` | OAuth tokens + refresh lease (DO NOT modify directly) |
| `ops.sf_token_cache` | ServiceFusion tokens (DO NOT modify directly) |

### Key RPCs

All `STABLE SECURITY DEFINER` with `search_path = ops, public` and `GRANT EXECUTE TO anon, authenticated`.

| Function | What |
|---|---|
| `fn_sales_pivot(dim, start, end, …filters, limit)` | The core pivot. dim = category/item/customer/month/entity/account/segment/channel/rep |
| `fn_sales_totals(start, end, …filters)` | Headline KPIs: revenue, est_margin, margin_pct, customer_count, item_count, cost_coverage_pct |
| `fn_sales_dim_values(dim, start, end, limit)` | Dimension value list with revenue (powers MultiPicker dropdowns) |
| `fn_pivot_drill(dim, dim_label, start, end, …filters, limit)` | Drill-through to invoice lines |
| `fn_sparkline(dim, labels[], end, …filters)` | Per-label 12-mo monthly revenue |
| `fn_customer_health(window_days)` | RFM scoring, returns segment + scores |
| `fn_customer_health_asof(asof_date, window_days)` | Same but anchored to a past date — used for backfilling snapshots |
| `fn_take_health_snapshot()` | Idempotent: insert today's snapshot from fn_customer_health |
| `fn_health_movers(max_age_days)` | Diff today's RFM vs latest snapshot |
| `fn_customer_detail(qbo_customer_id, start, end)` | One-row customer dossier (KPIs, AR, lifetime totals) |
| `fn_customer_scorecard(qbo_customer_id, window_days)` | One-row data for the printable scorecard |
| `fn_customer_classification_list(search, channel, start, end, limit, offset)` | Customer list with revenue + channels + reps |
| `fn_inactive_customers(current_*, prior_*, min_prior_rev, max_current_rev)` | Lost / inactive customers report |
| `fn_top_movers(dim, start, end, prev_*)` | Top gainers + decliners |
| `fn_revenue_anomalies(baseline_months, recent_months, min_baseline, sigma_threshold)` | Z-score-based spike/drop detection |
| `fn_product_voids(set_code, start, end, min_set_revenue, require_some)` | Pivot of customer × items in a set |
| `fn_item_copurchase(anchor_item_id, start, end, min_support, limit)` | Apriori-style co-occurrence with lift/confidence |
| `fn_inventory_health(lookback_days, managed_only)` | Reorder/velocity analytics with shrinkage |
| `fn_set_inventory_settings(qbo_item_id, …)` | Per-item managed/target/lead-time/notes editor |
| `fn_plan_account_rollup(plan_id)` | Rollup plan lines to QBO accounts × month |
| `fn_plan_alerts(plan_id, threshold)` | YTD plan lines >threshold% behind |
| `fn_plan_forecast(plan_id)` | Project full-year via linear extrapolation, status buckets |
| `fn_rep_scorecard(start, end)` | Per-rep totals + commission |
| `fn_rep_book(rep_code, start, end)` | Customer breakdown for one rep |
| `qbo_token_claim_refresh / qbo_token_persist / qbo_token_release_failed` | Lease-based token rotation. All sync-qbo-* edge functions use these. |

### Edge functions (Supabase)

| Function | Trigger | What |
|---|---|---|
| `sync-qbo-invoices` | nightly cron 09:00 UTC | core invoice + P&L pull (existing) |
| `sync-qbo-items` | cron 09:30 UTC | item master + purchase_cost |
| `sync-qbo-customers` | cron 09:35 UTC | customer master + addresses |
| `sync-qbo-expenses` | cron 09:40 UTC | Bills/POs → ops.qbo_expenses for actual COGS |
| `sync-qbo-inventory-adjustments` | cron 09:50 UTC | shrinkage / damage / count adjustments |
| `digest-email` | hourly cron `0 * * * *` | scans digest_subscriptions, sends via Resend if due |
| `export-csv` | manual | public CSV endpoint for IMPORTDATA into Google Sheets |
| `admin-users` | dashboard | auth admin wrapper (list/create/delete users) |
| `push-qbo-customer-types` | dashboard | writes Customer.CustomerTypeRef from primary channel |
| `push-qbo-sales-rep` | dashboard | writes Customer "Sales Rep" custom field from primary rep |
| `push-qbo-budget` | dashboard | reads fn_plan_account_rollup → CSV/JSON for QBO Budget import |

All sync-qbo-* functions use the lease-based refresh pattern. Tokens live in `ops.qbo_token_cache`; never modify directly.

### Cron schedule (pg_cron)

```
nightly-qbo-sync           09:00 UTC  daily   sync-qbo-invoices (existing)
nightly-sync-qbo-items     09:30 UTC  daily   sync-qbo-items
nightly-sync-qbo-customers 09:35 UTC  daily   sync-qbo-customers
nightly-sync-qbo-expenses  09:40 UTC  daily   sync-qbo-expenses
nightly-sync-qbo-inv-adj   09:50 UTC  daily   sync-qbo-inventory-adjustments
weekly-health-snapshot     Mon 10:00 UTC      fn_take_health_snapshot()
digest-email-hourly        :00 every hour     digest-email (mode=scheduled)
```

---

## Frontend — what's where

### Legacy `/sales/` (one big file)

`public/sales/index.html` is a React 18 + Babel CDN SPA. Every page in one file. Auth: reads `apbg_session` from localStorage if available, otherwise renders own login. Source of truth for everything until Phase 6 cutover.

### New `/sales-next/` (Vite + TS)

Source in `app/`. Build artifact in `public/sales-next/`. The artifact **is committed to git** because Netlify isn't running our build command — see "Deploy gotcha" below.

Per-page status:

| Tab (#hash) | Status | Notes |
|---|---|---|
| `#overview` | NEW (PR #20) | Default landing; KPIs with deltas, monthly area chart, action panel, top categories donut, top customers w/ sparklines |
| `#margin` | DONE | Full pivot, multi-select filters, drill, sparklines, compare, charts (PR #7 + #20) |
| `#customers` | DONE | Searchable list w/ RFM badges (PR #17 merged) |
| `#customer-<id>` | DONE | KPIs, 12-mo chart, top items, recent invoices, PRINT SCORECARD (PR #17) |
| `#reports` | PR #18 (draft) | 5 tabs: inactive / movers / health movers / anomalies / voids |
| `#plans` | PR #18 (draft) | Lines / Rollup / vs Actuals / Forecast modes; PUSH TO QBO |
| `#reps` | PR #19 (draft) | Scorecard + book + commissions + push to QBO |
| `#compare` | PR #19 (draft) | A/B side-by-side of two saved_views |
| `#inventory` | PR #19 (draft) | Reorder / Velocity / Settings / Velocity Excludes |
| `#settings` | PR #21 (draft) | 5 of 8 sub-tabs ported; 3 still link to legacy |

### Open PRs (in stack order)

```
main
├── #18  Phase 4 — Reports + Plans
├── #19  Phase 5 part 1 — Reps + Compare + Inventory
├── #20  Overview landing + chart system + design tokens
└── #21  Phase 5d — Settings (5 of 8 sub-tabs)
```

PR #20 introduces the chart primitives + Overview; PRs #18/#19/#21 stack on top. Recommend merging in order #18 → #19 → #20 → #21. They're all draft pending Sky's review.

### Design system (introduced in PR #20)

- `app/src/styles/theme.css` defines tokens: `--bg/--sf/--sf2/--sf3` surfaces, `--bd/--bd2` borders, `--tx/--tx2/--mt` text, `--ac/--ac2` accent, `--success/--warning/--danger/--info` semantic, `--shadow/--shadow-lg`, `--r-sm/md/lg`, `--grad-acc/--grad-card`.
- Tables auto-zebra + hover state.
- Top nav is sticky w/ backdrop-blur; logo uses gradient text fill.
- `.skeleton` shimmer keyframe available.
- `g4` collapses to 2 columns at 900px.

Charts:
- `<BarChart>` — vertical bars, gridlines, axis ticks, hover tooltip, optional prior-period overlay, optional onSelect.
- `<AreaChart>` — multi-series, gradient fill, crosshair, per-series tooltip, auto-legend.
- `<DonutChart>` — center label/value, side legend, hover dim.
- `<KPICard>` — title, value, optional `deltaPct` + ▲/▼ + sentiment color, optional `sparkline` micro-chart, optional `polarity='inverse'` for "lower is better" metrics.

Use these for any new pages — don't roll your own SVG.

---

## Deploy gotcha — IMPORTANT

Netlify's UI build command appears to override `netlify.toml`. The first deploy after merging PR #7 ran in 14s and didn't run `npm run build --prefix app`, leaving `/sales-next/` empty.

**Workaround currently in use:** the built bundle at `public/sales-next/{index.html, assets/*}` is checked into git. Each PR that touches `app/` rebuilds and commits the bundle alongside source.

**Permanent fix needed (next person):**
1. In Netlify UI → Site Settings → Build & Deploy → Build settings: set Build command to `npm install --prefix app && npm run build --prefix app` (matches `netlify.toml`).
2. Once verified working, restore the gitignore entries (uncomment `public/sales-next` in root `.gitignore`).
3. Document the rationale in a tiny `app/README.md`.

---

## Manual setup tasks for Sky (none of these are code)

These are the only things that BLOCK end-to-end value from what's already shipped:

1. **Resend API key.** Set `RESEND_API_KEY` env var on the Supabase project. Without it, the email digest only does dry-runs. Get the key from resend.com → Settings → API Keys.

2. **QBO "Sales Rep" custom field.** In QuickBooks Online → Settings (gear) → Custom Fields → Add Field. Name = exactly `Sales Rep`. Type = Text. Mark "All Customers". Without it, the push-qbo-sales-rep function reports `skipped_no_field` for every customer.

3. **Customer ↔ rep assignments.** The Reps page is empty until at least a few customers have a primary rep set. Do this in Settings → Customer Classification (legacy `/sales/` for now).

4. **Channel and segment classification.** Same — channels and segments are taxonomies you've defined, but customers/items still need to be tagged. Margin pivot's channel/segment slices light up once enough customers/items are tagged.

5. **Gateway routing for /sales-next/.** The new app at `/sales-next/` doesn't read `apbg_session` from localStorage yet, so users have to sign in twice (once on alamedapointbg.com, once at /sales-next/). Either:
   - Build gateway-session integration into `/sales-next/` (Phase 6 task — see Phase 6 below), or
   - Keep `/sales-next/` direct-access only, no gateway, until cutover.

6. **Verify QBO Budget CSV import flow.** Once you have a real plan in `#plans`, click PUSH TO QBO. Confirm the downloaded CSV imports cleanly via QBO Web → Settings → Tools → Budgeting → Add Budget → Import. Account names must match QBO exactly.

---

## What's still un-ported (Phase 5e + Phase 6)

### Phase 5e: 3 Settings sub-tabs

These currently link back to legacy `/sales/#settings` from the SettingsPage stub:

| Editor | Source in legacy | Tables/RPCs |
|---|---|---|
| Customer Classification | UsersEditor / customer_channels / customer_sales_reps editors | `fn_set_customer_channels`, `fn_set_customer_sales_reps`, `fn_customer_classification_list` |
| Expense Buckets | account_buckets editor | `ops.account_buckets`, `ops.expense_buckets`, `fn_set_account_bucket`, `fn_list_pl_accounts`, `fn_period_cost_buckets` |
| Users | UsersEditor | `admin-users` edge function (list/create/delete) |

All three follow the same pattern as the editors that ARE ported. Look at `SalesRepsEditor.tsx` and `DigestEditor.tsx` as templates.

### Phase 6: cutover

1. **Wire `apbg_session` into `app/src/lib/supabase.ts`.** On boot, check localStorage for `apbg_session`; if present and valid, hydrate `sbAuth` with that JWT instead of starting fresh. Reference: legacy `public/sales/index.html` around the `// Auth: bootstrap from apbg_session if available` block.
2. **Smoke-test every page on `/sales-next/`.** All 9 tabs, plus customer detail drill-through.
3. **Update `netlify.toml` redirect:** swap `/sales/*` → `/sales-next/:splat` (keep both working for ~7 days).
4. **Archive legacy** by renaming `public/sales/index.html` → `public/sales-legacy/index.html`. Add a 301 from `/sales-legacy/` for completeness.
5. **Delete the redirect** after 30 days of stable use.

---

## Recent migration history

Up to 2026-05-03 the legacy single-file SPA accumulated these slices (alphabetical for find-ability):

```
A-N   sort/total/regroup, Reports, User admin, Charts, Plans + Budget,
      Voids, Email Digest, Customer Detail, A/B Compare, Export CSV
O     Inventory analytics
P     Plan-vs-Actuals
Q     Customer Health RFM
R     Inventory adjustments factor into velocity
S     Bulk classify CSV import + reorder order sheet
T     Health Movers + Plan Alerts in digest
U     Co-purchase + Anomaly detection
V     Plan Forecast + Customer Scorecard
W     push-qbo-budget edge function
X     Reps + Commissions + push-qbo-sales-rep + 8-week snapshot backfill
```

Then the Vite migration began:

```
Phase 1   scaffold + login + Margin smoke test          (PR #7, merged)
Phase 2   full Margin pivot                             (PR #7, merged)
Phase 3   Customers + Customer Detail + scorecard        (PR #17, merged)
Phase 4   Reports + Plans                                (PR #18, draft)
Phase 5a  Reps + Compare + Inventory                     (PR #19, draft)
UI/UX     Overview landing + chart primitives + tokens   (PR #20, draft)
Phase 5d  Settings (5 of 8)                              (PR #21, draft)
Phase 5e  Settings remaining 3                           ← TODO
Phase 6   /sales/ cutover + gateway integration          ← TODO
```

---

## How to pick this up

```bash
git clone https://github.com/skypace/apbg-billing
cd apbg-billing/app
npm install
npm run dev    # localhost:5173/sales-next/
```

Talking to Supabase requires no setup — anon key is hardcoded in `app/src/lib/supabase.ts` (it's a public anon key, that's by design).

For SQL changes:
- Use the Supabase MCP `apply_migration` tool with a name parameter
- Always ALSO check the SQL into `supabase/migrations/<datestamp>_<name>.sql` so the repo has history
- Functions: `STABLE SECURITY DEFINER SET search_path = ops, public` + `GRANT EXECUTE TO anon, authenticated`

For frontend changes:
1. Edit files under `app/src/`
2. Run `npm run build --prefix app` from repo root
3. Commit BOTH the source and `public/sales-next/` (until the deploy gotcha is fixed)

---

## Known issues / nice-to-haves

- **No saved-view editor in the new app.** Compare page can pick saved views, but they have to be created in legacy `/sales/`.
- **Mobile responsive pass deferred.** Sky said skip it — flagging for completeness. Theme breakpoint at 900px collapses 4-col to 2-col but pages haven't been audited beyond that.
- **No tests.** Type-checking via `tsc -b` is the only verification. Adding Vitest + Playwright is reasonable when scale demands.
- **Bundle 135 KB gz on the new app.** Approaching the point where code-splitting (React.lazy on settings sub-editors, customer detail, etc.) is worth doing.
- **Gateway login-once flow** — see Phase 6.

---

## Contacts / authority

- **Sky** — product owner, sole decision-maker. Anything ambiguous → ask Sky.
- **Whitney** — runs the legacy billing tool at `public/index.html` etc. NEVER touch her files or netlify functions.

---

## TL;DR if you only read one thing

The dashboard is at `apbg-billing.netlify.app/sales/` (legacy) and `apbg-billing.netlify.app/sales-next/` (new). PRs #18/#19/#20/#21 are draft and need merge in order. Set `RESEND_API_KEY` on Supabase. Create a "Sales Rep" custom field in QBO. Then Phase 5e (3 settings editors) and Phase 6 (gateway session + cutover) are the only code work left.
