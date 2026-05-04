# APBG System Architecture — Joint Draft (ops + billing)

> **Status:** Draft, billing-side answers filled in 2026-05-04 from
> `apbg-billing` (this repo). Ops side filled in by Claude in `apbg-ops`
> (2026-05-03). Final home is
> `activespacescience/Skilliosis_Mytosis_Architecture/projects/apbg/ARCHITECTURE.md`.
>
> **How to read this:** `[BILLING:` blocks are answers from this repo.
> `[BILLING-SIDE: ...]` markers that remain unanswered need follow-up.
>
> **Why this doc exists:** APBG runs across multiple repos that all read
> and write the same Supabase project. Without one shared map it's easy
> for two builders to make conflicting assumptions about who owns what.
> This is the source of truth for cross-repo contracts.

---

## 0. Naming — pick once, propagate everywhere

| Concept | Names found in current docs | Decision |
|---|---|---|
| Supabase project (id `gfsdpwiqzshhexkofiif`) | "APBG-BILLING" (project name in Supabase dashboard) | keep as `APBG-BILLING` |
| Edge-function repo | `apbg-edge`, `APBG-BILLING`, `apbg-billing` | **`apbg-billing`** (matches `package.json` `"name"` and the GitHub repo `skypace/apbg-billing`). All other variants are stale. |
| Operations dashboard repo | `apbg-ops` | `apbg-ops` |
| Auth gateway repo | `apbg-gateway` | `apbg-gateway` |
| Public site / customer portal | not referenced from this repo | `[BILLING:` There is no separate customer portal repo. The Melt equipment portal is a small surface served by the `melt-requests-forward` and `send-melt-welcome` Supabase edge functions plus the `melt-dashboard` Netlify project. Whitney's vendor / customer billing flow is served from this repo (`public/approve.html`, `public/customer-approve.html`) at `apbg-billing.netlify.app`. There is no `customer-portal` repo to add. `]` |

Both repos search-and-replace stale variants in their own docs.

---

## 1. System overview

**Who it serves:** Sky Pace + Brix Beverage / FreeFlow Beverage Solutions ops team and Whitney's billing team.

**What the system does, end-to-end:**
1. **Ingest** — Supabase edge functions (`sync-qbo`, `sync-sf`, `sync-qbo-items`, `sync-qbo-customers`, `sync-qbo-expenses`, `sync-qbo-inventory-adjustments`) pull from QBO and Service Fusion into the shared Supabase project under `ops.*`. Source for these functions is deployed directly to Supabase (not all of it lives in this repo's tree — see §7).
2. **Classify** — sync code stamps `revenue_line`, `revenue_categories.category`, expense-bucket mappings, etc., so dashboards never re-classify on the client.
3. **Display** — `apbg-ops` reads `ops.*` and renders the operational KPI dashboard at `alamedapointbg.com/operations/`. `apbg-billing` (this repo) also renders two UI surfaces (see below).
4. **Authenticate** — `apbg-gateway` owns the root domain, issues `localStorage.apbg_session`, proxies `/operations/*` → `apbg-ops.netlify.app`. The billing UI in this repo is **not** behind the gateway today; it's reached directly at `apbg-billing.netlify.app/*` with per-page token-bearing URLs (`approve.html?token=…`, `customer-approve.html?token=…`).
5. **Alert** — edge functions email Sky/Whitney via Resend (or SendGrid as a fallback) on stale invoices, sync-health red, vendor-bill approvals, etc.

`[BILLING:` This repo **does** have a UI surface, two of them:
1. **Whitney's billing tool** — static HTML at `public/index.html`, `public/approve.html`, `public/customer-approve.html`, `public/control.html`, `public/sync.html`, `public/setup.html`. Backed by the Netlify functions in `netlify/functions/` (vendor-bill approval, customer onboarding, ResQ→SF sync). This is production and is used daily.
2. **Margin Minder / sales analytics dashboard** — single-file React+Babel SPA at `public/sales/index.html`, with a Vite + React + TS replacement being built into `app/` and published to `public/sales-next/`. This reads the new `ops.*` margin-minder tables (channels, segments, expense_buckets, sales_plans, etc.) added in the `20260429*` / `20260502*` / `20260503*` migrations. Old `/ops/*` URLs 301 to `/sales/*` (see `netlify.toml`).

Both surfaces mount under `apbg-billing.netlify.app/*`. They are **not** the operational KPI dashboard described in §1 step 3 — that one lives in `apbg-ops`. The two dashboards share the Supabase project but read different table sets. `]`

---

## 2. Repository inventory

| Repo | Purpose | Deploy target | URL | Owner of |
|---|---|---|---|---|
| `apbg-ops` | Ops KPI dashboard (read-mostly) | Netlify (`apbg-ops.netlify.app`) | `alamedapointbg.com/operations/` | All `src/pages/executive/*`, `ops.team_members` write path via gateway-issued JWT |
| `apbg-gateway` | SSO gateway, root site, proxy | Netlify | `alamedapointbg.com` | `apbg_session` cookie/token, `/operations/*` rewrite, login UI |
| `apbg-billing` (this repo) | Billing tool UI + margin-minder dashboard + Netlify functions for vendor-bill / ResQ-SF flows + most of the Supabase edge function source for QBO/SF sync | Netlify (`apbg-billing.netlify.app`) + Supabase Edge Functions | `apbg-billing.netlify.app` | `[BILLING:` Netlify functions: see §7. Supabase edge functions deployed from this repo's developer workflow (some sources committed under future `supabase/functions/`, others applied directly via Supabase dashboard — drift to be reconciled): `sync-qbo`, `sync-sf`, `sf-oauth-callback`, `stale-invoice-alert`, `sf-tech-probe`, `sync-qbo-items`, `sync-qbo-customers`, `sync-qbo-expenses`, `sync-qbo-inventory-adjustments`, `melt-requests-forward`, `send-melt-welcome`, `digest-email`, `nightly-qbo-sync`. Also writes the entire `ops.*` schema except the bits ops-side claims, plus all of `public.*` billing tables (`public.customers`, vendor approval tokens, etc.). `]` |
| `melt-dashboard` | Brix Melt equipment dashboard | Netlify | `[BILLING:` `melt-dashboard.netlify.app`; not domain-mapped under `alamedapointbg.com` today. `]` | Out of scope here — co-tenant on the shared DB |
| `Skilliosis_Mytosis_Architecture` (ASM) | Architecture handbook | n/a (docs) | GitHub | This file's final home |

> Note from ops side: `apbg-ops` has two edge functions of its own under
> `supabase/functions/` (`health-alert` and `sync-qbo-employees`).
> `[BILLING:` Confirmed — those two functions live in `apbg-ops`, not
> here. They both touch `ops.qbo_token_cache` though, so the lease-RPC
> contract in §4 / §9 applies to both repos. `]`

---

## 3. Shared infrastructure

**Supabase project (single, shared):**
- Name: `APBG-BILLING`
- ID: `gfsdpwiqzshhexkofiif`
- Region: `us-east-2`
- URL: `https://gfsdpwiqzshhexkofiif.supabase.co`
- Schemas:
  - `ops` — operational KPIs, margin-minder analytics, classification taxonomies. Written primarily by sync edge functions (this repo) plus a few ops-side functions. Read by both dashboards.
  - `public` — `[BILLING:` Owned by `apbg-billing` (this repo). Contains the billing-tool tables: `public.customers`, vendor / bill / approval-token tables backing `netlify/functions/approve-bill.mjs`, `approve-customer.mjs`, `onboard-customer.mjs`, `create-invoice.mjs`, `create-vendor.mjs`, `process-inbound.mjs`. Also referenced by `ops.qbo_invoices.public_customer_id` (FK into `public.customers`). The Melt equipment-portal tables, if any, are also in `public` and owned by this repo for now. `]`
- Tenants: `apbg-ops`, `apbg-billing`, `apbg-gateway`, `melt-dashboard`

**Domain:** `alamedapointbg.com` is owned by `apbg-gateway`. No other Netlify project should add it. Cross-repo auth/proxy contracts go through the gateway.

**Email sender:** `alerts@alamedapointbg.com` via Resend. Used by `health-alert` (apbg-ops) and `stale-invoice-alert` (this repo). `[BILLING:` Confirmed — Resend account is owned by Sky under the PACER Group org. `RESEND_API_KEY` is set both as a Supabase function secret (for edge functions) and as a Netlify environment variable (for `netlify/functions/email-helpers.mjs`, which is dual-mode and prefers `SENDGRID_API_KEY` if both are set). Default `EMAIL_FROM` for the billing tool is `Pacer Billing <billing@brixbev.com>`; Sky's ops alerts use `alerts@alamedapointbg.com`. Both senders are verified in the same Resend account. `]`

---

## 4. Data ownership matrix (the critical section)

For every `ops.*` table: who writes, who reads. Disagreements here are bugs.

| Table | Writer | Readers | Write cadence |
|---|---|---|---|
| `ops.team_members` | `apbg-ops` (Staff Roster page, gateway-issued JWT) | `apbg-ops` everywhere; `[BILLING:` this repo does **not** read `ops.team_members` from any UI surface today. The margin-minder dashboard reads `ops.staff` / `ops.staff_roles` / `ops.role_types` indirectly (via the `customer_classification_rpcs` and `sales_reps_taxonomy` migrations) but not `team_members`. Confirm with ops which of `staff` vs `team_members` is the canonical roster table — `CLAUDE-CODE-HANDOFF.md` calls `team_members` "LEGACY" and says FKs from `delivery_stops` / `service_jobs` / `reman_jobs` / `kpi_daily` still point at it. `]` | On-demand |
| `ops.qbo_invoices` | `apbg-billing` `sync-qbo` (and the `nightly-qbo-sync` cron) | `apbg-ops` (§1A–§1D, AR aging); `apbg-billing` margin-minder dashboard (revenue rollups) | Nightly 2am PT + every 3 min backfill (per ops-side claim — billing-side note: backfill cadence not currently visible in `supabase/migrations/` here, scheduled via Supabase pg_cron directly) |
| `ops.qbo_invoice_lines` | `apbg-billing` `sync-qbo` | `apbg-ops`; `apbg-billing` margin-minder (this is the core fact table for margin-minder) | Nightly + backfill |
| `ops.qbo_invoice_lines.qbo_item_id` / `qty` / `unit_cost_cents` (cols added in 0016) | `apbg-billing` `sync-qbo` | `apbg-ops` `getCustomerItemHistory`, future `getCustomerNetProfit`; `apbg-billing` margin-minder estimated-cost columns | `[BILLING:` **Status: partially wired.** `qbo_item_id` and `qty` (mapped from QBO `Qty` on each line) are stamped on every `qbo_invoice_lines` upsert by `sync-qbo` (the existing v29 function, source not in this repo's tree, applied directly to Supabase). `unit_cost_cents` is **not** yet populated by `sync-qbo` — it is computed downstream by `ops.fn_actual_cost_switchover` (migration `20260503h`) joining to `ops.qbo_expense_lines` for true weighted-average landed cost. The "estimated unit cost" path that the margin-minder UI uses today reads from `ops.qbo_items.purchase_cost`, populated by `sync-qbo-items` (cron migration `20260503r`, runs nightly at 09:30 UTC). Probe: `select count(*) filter (where qbo_item_id is null), count(*) filter (where qty is null) from ops.qbo_invoice_lines where invoice_id in (select id from ops.qbo_invoices where txn_date >= '2025-01-01');` — both counts should be ~0; if not, flag to Sky. `]` | Per-invoice on sync |
| `ops.qbo_items_cache` (table added in 0015) | `apbg-billing` `sync-qbo-items` | `apbg-ops` Settings → System review panel; `apbg-billing` margin-minder | `[BILLING:` **Status: scheduled and presumed working.** `sync-qbo-items` is scheduled nightly at 09:30 UTC by `supabase/migrations/20260503r_nightly_sync_crons.sql` (committed 2026-05-03). The function pulls `Item` from QBO and upserts into `ops.qbo_items_cache` and the legacy `ops.qbo_items` (which also stores `purchase_cost`). Sky to run `select count(*), max(qbo_synced_at) from ops.qbo_items_cache;` to confirm. `]` | Nightly |
| `ops.qbo_pto_cache` (0014) | `apbg-billing` `sync-qbo` (or a dedicated function — see below) | `apbg-ops` §3 utilization (gated until populated) | `[BILLING:` **Status: NOT yet wired.** No `sync-qbo-pto` cron exists in `supabase/migrations/20260503r_nightly_sync_crons.sql`, and there is no migration in this repo's tree that adds a PTO-pull cadence. `ops.qbo_pto_cache` exists as an empty table. To wire it: either (a) extend the existing `sync-qbo` function to call QBO's `TimeActivity` endpoint nightly, or (b) build a `sync-qbo-pto` edge function and add a cron entry to migration `20260503r`. Recommend (b) so it can run at a different hour from invoice/P&L sync. Action item for Sky / billing side. `]` | Weekly |
| `ops.qbo_invoices.customer_first_seen_at` (0018) | `apbg-billing` `sync-qbo` | `apbg-ops` §1D rolling-12 (perf path) | `[BILLING:` **Status: NOT yet wired in `sync-qbo`.** Migration 0018 (in `apbg-ops/supabase/migrations/`) adds the column but no in-repo migration here adds a populator. The ops-side JS scan path will keep working, but to switch to the perf path, add either a per-invoice upsert in `sync-qbo` (cheap if doable) or a Postgres trigger on `ops.qbo_invoices` that backfills `customer_first_seen_at` from `min(txn_date) by customer_ref_id`. Recommend the trigger route — keeps sync-side code unchanged and survives backfills. `]` | Per-invoice |
| `ops.pl_snapshots` | `apbg-billing` `sync-qbo` | `apbg-ops` (§1A trend, §1E reconciliation) | Nightly |
| `ops.balance_sheet_snapshots` | `[BILLING:` **Status: NOT yet wired.** Table exists (added by `apbg-ops` migration), zero rows, no sync function deployed. Plan: extend `sync-qbo` to call QBO's `BalanceSheet` report endpoint at month-end (or nightly with `accountingMethod=Accrual` + `summarize_column_by=Total`) and upsert one row per period × entity × account. Implementer: this repo. ETA: not committed. `]` | `apbg-ops` (future KPIs) | TBD |
| `ops.delivery_stops` | `apbg-billing` `sync-sf` | `apbg-ops` §2; `apbg-billing` `stale-invoice-alert` | Every 30 min |
| `ops.service_jobs` | `apbg-billing` `sync-sf` | `apbg-ops` §3; `apbg-billing` `stale-invoice-alert` | Every 30 min |
| `ops.reman_jobs` | `apbg-billing` `sync-sf` | `apbg-ops` §4; `apbg-billing` `stale-invoice-alert` | Every 30 min |
| `ops.reman_jobs.warranty_returned_at` / `field_failure_at` (0017) | `apbg-billing` `sync-sf` | `apbg-ops` §4 (gated) | `[BILLING:` **Status: NOT yet wired.** SF doesn't expose these in its standard job schema; they need to come from a custom field. Decision needed: (a) **SF custom-field route** — Sky adds two custom-date fields on the Reman job type in Service Fusion and `sync-sf` reads them out of the `customFields[]` array on each job; or (b) **Status route** — derive `warranty_returned_at` from a status transition into `intake` after a job has previously hit `complete`/`shipped`, and `field_failure_at` from a flag like `is_callback`. (a) is more accurate but requires SF UI work; (b) is zero-touch but noisy. Recommend (a). Action item for Sky. `]` | Per-job |
| `ops.revenue_categories` (0013) | Manual SQL (no sync); seeded by migration | `apbg-ops` (Revenue Breakdown, Settings); `apbg-billing` margin-minder Settings panel | On-demand |
| `ops.qbo_employees_cache` | `apbg-ops` `sync-qbo-employees` (in-repo function) | `apbg-ops` (roster matching); occasionally `apbg-billing` for vendor-bill `employee_name` validation | Hourly |
| `ops.qbo_token_cache` | `apbg-billing` `sync-qbo` (primary writer); `apbg-ops` `sync-qbo-employees` (also writes via the same lease RPC) | Both | On refresh |
| `ops.sf_token_cache` | `apbg-billing` `sync-sf` + `sf-oauth-callback` | Both | On refresh |
| `ops.sync_log` | All sync functions append; nobody else writes | `apbg-ops` SyncHealthBanner, `health-alert`; `apbg-billing` `master-health` Netlify function reads it for the cross-system health page | On every sync run |
| `ops.health_alerts_sent` (0020) | `apbg-ops` `health-alert` | `apbg-ops` `health-alert` (dedupe) | On every alert |
| `ops.qbo_expenses` (0014) | `apbg-billing` `sync-qbo-expenses` | `apbg-billing` margin-minder (overhead allocation, expense buckets); `apbg-ops` (future expense KPIs) | Nightly 09:40 UTC, `since=2025-01-01` |
| `ops.qbo_expense_lines` (0503g) | `apbg-billing` `sync-qbo-expenses` | `apbg-billing` `fn_item_avg_cost` for true weighted-avg landed cost; the "actual cost" switchover RPCs (`20260503h`) | Nightly with parent expenses |
| `ops.channels` / `ops.segments` / `ops.expense_buckets` / `ops.customer_channels` / `ops.category_segments` / `ops.item_segments` (margin-minder taxonomies, 0502b–g) | `apbg-billing` margin-minder Settings UI (writes via `authenticated` JWT — see RLS migration `20260503b_tighten_rls.sql`) | `apbg-billing` margin-minder dashboard everywhere | On-demand by user |
| `ops.sales_plans` / `ops.sales_reps` / `ops.saved_views` / `ops.item_sets_voids` (0503e/f/k/l) | `apbg-billing` margin-minder UI | `apbg-billing` only | On-demand |
| `ops.digest_subscriptions` / `ops.digest_log` (0503m) | `apbg-billing` Settings UI (subscriptions); `apbg-billing` `digest-email` edge function (log) | `apbg-billing` `digest-email` reads subscriptions hourly | On-demand subs / hourly log |
| `public.customers` and the rest of `public.*` billing tables | `apbg-billing` Netlify functions only (`approve-customer.mjs`, `onboard-customer.mjs`, `create-invoice.mjs`, `create-vendor.mjs`, `process-inbound.mjs`) using service-role | `apbg-billing` UI; `apbg-ops` reads `public.customers` only via the FK from `ops.qbo_invoices.public_customer_id` (rare) | On-demand by Whitney |

**Two-writer warning on `ops.qbo_token_cache`:** both `sync-qbo` (this repo) and `sync-qbo-employees` (apbg-ops) refresh the same QBO refresh token. They serialize through `ops.qbo_token_claim_refresh()` (a row-lock + 20s lease RPC). If either side bypasses the lease, refresh-token rotation will race. **Both repos must use the lease RPC, never read/write the cache directly.** `[BILLING:` **Status: in this repo, the live `sync-qbo` edge function (v29) uses the lease RPC. The Netlify function `netlify/functions/qbo-helpers.mjs` does NOT — it has its own token-store path using Netlify Blobs (`getStore({ name: "qbo-tokens" })`) plus env vars as fallback. That code path is used by Whitney's billing tool (`approve-bill.mjs`, `create-invoice.mjs`, etc.) and is independent of `ops.qbo_token_cache`. So we have effectively two QBO token stores: (a) Supabase `ops.qbo_token_cache` for edge functions, (b) Netlify Blobs `qbo-tokens` for Netlify functions. They share the same QBO app credentials but refresh independently. This is the intended split for now (the billing tool predates the ops Supabase project) — flagging it because it surprised me, and the handbook should mention it. If we ever want a single source of truth, the Netlify functions would need to migrate to call the Supabase lease RPC. `]`

---

## 5. Auth & security model

**Layer 1 — UI gate (cosmetic):**
- `apbg-ops/src/lib/auth.ts` reads `localStorage.apbg_session`. No session → bounce to `https://alamedapointbg.com/`.
- This is cosmetic only — the anon key is in the bundle and is public.
- `[BILLING:` The billing tool UI in this repo (`public/approve.html`, `public/customer-approve.html`) uses **per-link tokens** instead — Whitney's emails contain a unique `?token=…` URL and `netlify/functions/decode-token.mjs` validates it server-side. This pre-dates the gateway and isn't behind it. The margin-minder dashboard at `public/sales/index.html` is also not behind the gateway; it relies entirely on Supabase RLS (Layer 2). `]`

**Layer 2 — RLS in `ops.*` (the real boundary):**
- Migration `0009_rls_lockdown.sql` + `0010_rls_extended_lockdown.sql` + `0021_rls_audit_reassert.sql` (in `apbg-ops`) lock down every `ops.*` table.
- `anon` and `authenticated` get permissive `SELECT`.
- `INSERT / UPDATE / DELETE` revoked from `anon` and `authenticated` on every existing + future table.
- `ops.qbo_token_cache`, `ops.sf_token_cache` have RLS ON with **no** anon policy → 0 rows for anyone but service-role.
- `[BILLING:` This repo's margin-minder Settings panel does need writes from the browser to `ops.channels`, `ops.segments`, `ops.expense_buckets`, etc. Migration `20260503b_tighten_rls.sql` (this repo) restricts those writes to the `authenticated` role. **The browser does not have an `authenticated` JWT today** because the billing-side dashboard isn't gated by the SSO. So those Settings writes effectively work only when the user has a Supabase auth session — which today happens only via the dev-only login flow on `setup.html`, or by a user who has manually signed in. To make Settings writable for all internal users, the gateway needs to mint Supabase-auth-compatible JWTs (already on the roadmap in §5 of the original draft). Until then, Settings UI in this repo should gracefully degrade to read-only with a banner. `]`

**Layer 3 — service-role key:**
- Lives only in edge function env vars + Supabase dashboard + this repo's Netlify environment vars (for the few Netlify functions that touch Supabase directly, e.g. `master-health.mjs`). Never in any repo's bundle. Never in git.

**Roster writes (the one exception to "no client writes"):**
- `apbg-ops` Staff Roster page calls Supabase with a JWT minted by `apbg-gateway` alongside `apbg_session`. Migration `0011_roster_writes.sql` defines the policy.
- `[BILLING:` Confirmed: this repo's UI does **not** write to `ops.team_members` or `ops.staff`. All client-side writes from the billing tool go through Netlify functions (which use service-role); all client-side writes from the margin-minder dashboard go to the classification taxonomy tables (channels/segments/buckets) under `authenticated`. So there is exactly one cross-repo client-side-write surface (`ops.team_members` from apbg-ops) plus a few authenticated-write taxonomy tables (this repo). `]`

**Roadmap (not yet wired):** swap the permissive `USING (true)` `SELECT` policies for `auth.jwt()->>'role' IN ('superadmin','admin','ops-super',...)` once the gateway mints Supabase-compatible JWTs for SELECT too.

---

## 6. External integrations

| Service | Purpose | Owned by | Secrets location |
|---|---|---|---|
| QuickBooks Online | Invoices, P&L, items, employees, PTO, expenses, customers, inventory adjustments, balance sheet (planned) | `apbg-billing` (primary, all sync functions); `apbg-ops` (employees only via its own `sync-qbo-employees`) | Supabase secrets (both repos' edge functions read the same `ops.qbo_token_cache` via the lease RPC). Netlify Blobs `qbo-tokens` is a separate token store used by this repo's Netlify functions for Whitney's billing flow (see §4 two-writer note). |
| Service Fusion | Delivery stops, service jobs, reman jobs | `apbg-billing` | Supabase secrets + `ops.sf_token_cache`; OAuth callback served by both `netlify/functions/sf-oauth-callback.mjs` and the Supabase edge function `sf-oauth-callback` (the Supabase one is canonical; the Netlify one supports the legacy ResQ→SF sync path) |
| ResQ | Source of vendor-managed kitchen-equipment service tickets, forwarded into SF | `apbg-billing` (Netlify functions `resq-sf-sync*` only) | Netlify env vars |
| Resend | Outbound email (alerts, billing approvals, ops digests) | Both repos send | `RESEND_API_KEY` Supabase secret per function; `RESEND_API_KEY` Netlify env var for `email-helpers.mjs` |
| SendGrid | Outbound email (legacy fallback for billing-tool emails) | `apbg-billing` only | `SENDGRID_API_KEY` Netlify env var |
| Sentry | Error tracking | `apbg-ops` (write-side wired in PR #27, source maps in #28) | `[BILLING:` **Not yet wired in this repo.** No Sentry SDK in `app/`, no DSN in `netlify.toml`. Recommended: add `@sentry/react` to `app/`, add `Sentry.init` to the Netlify functions, set `VITE_SENTRY_DSN` and `SENTRY_DSN` env vars. Action item — not blocking for the architecture-doc merge. `]` |
| Fleetmatics / Verizon Connect / Powerfleet | Driver telematics (planned) | `apbg-billing` (the `sync-fleetcomplete` function will live here once the API token is in hand). Note: per `CLAUDE.md` and `FLEET-HR-INTEGRATION.md` Sky still needs to obtain the API token from Powerfleet support. Tables (`ops.fleet_*`) are deployed and empty. | Will land in Supabase secrets + `ops.fc_token_cache` |
| Bambee / BambooHR | HR (planned) | `apbg-billing` if BambooHR is chosen (REST API). If Bambee, it's manual-entry forms in the dashboard, no integration. Tables (`ops.hr_*`) are deployed and empty. | TBD |
| Zoho CRM | Pipeline (planned) | `[BILLING:` Per Sky, the Zoho MCP server lives in the `skypace/pacerfinance` repo and is consumed by Claude / agents, not by this dashboard. If Zoho is ever wired into a sync, it should land in `apbg-billing` to keep the "all third-party syncs in one repo" invariant. `]` | TBD |
| Netlify | Hosting | Per-repo | Per-repo Netlify env vars |
| Supabase | Database + edge functions + cron + auth | Shared project, see §3 | Per-repo Supabase env vars |

---

## 7. Edge function inventory

| Function | Repo | Schedule | Tables touched | Purpose |
|---|---|---|---|---|
| `sync-qbo` | `apbg-billing` | Nightly 09:00 UTC + every 3 min backfill (per ops-side) | `qbo_invoices`, `qbo_invoice_lines`, `pl_snapshots`, `qbo_token_cache`, `sync_log` | Pull QBO invoices, lines, P&L (current v29) |
| `sync-qbo-items` | `apbg-billing` | Nightly 09:30 UTC (`20260503r`) | `qbo_items_cache`, `qbo_items`, `sync_log` | Pull QBO `Item` for cost / margin enrichment |
| `sync-qbo-customers` | `apbg-billing` | Nightly 09:35 UTC (`20260503r`) | `qbo_customers_cache`, `public.customers`, `sync_log` | Pull QBO `Customer` for `customer_classification_rpcs` |
| `sync-qbo-expenses` | `apbg-billing` | Nightly 09:40 UTC, `since=2025-01-01` (`20260503r`) | `qbo_expenses`, `qbo_expense_lines`, `sync_log` | Pull QBO `Purchase` + `Bill` for true weighted-avg landed cost |
| `sync-qbo-inventory-adjustments` | `apbg-billing` | Nightly 09:50 UTC, `since=2024-01-01` (`20260503r`) | `qbo_inventory_adjustments` (per `20260503q`), `sync_log` | Pull QBO `InventoryAdjustment` for shrink/waste tracking |
| `nightly-qbo-sync` (legacy) | `apbg-billing` | Nightly 09:00 UTC | superset of `sync-qbo` | Existing pre-`20260503r` nightly job; kept for now |
| `sync-sf` | `apbg-billing` | Every 30 min | `delivery_stops`, `service_jobs`, `reman_jobs`, `sf_token_cache`, `sync_log` | Pull SF jobs |
| `sf-oauth-callback` | `apbg-billing` | n/a (HTTP only) | `sf_token_cache` | OAuth redirect target for SF |
| `sf-tech-probe` | `apbg-billing` | On-demand | `service_jobs.tech_name` (backfill) | Backfill tech name on jobs missing it |
| `stale-invoice-alert` | `apbg-billing` | Daily 7am PT | reads `delivery_stops` / `service_jobs` / `reman_jobs` | Email Sky when SF $$ has no QBO match >5d |
| `digest-email` | `apbg-billing` | Hourly (`20260503m`) | reads `digest_subscriptions`, writes `digest_log` | Send weekly/daily margin-minder digests |
| `melt-requests-forward` | `apbg-billing` | On-demand | `public.melt_*` (Melt portal tables) | Forward customer service requests from Melt portal |
| `send-melt-welcome` | `apbg-billing` | On trigger | reads `public.customers` | Welcome email when a Melt customer is onboarded |
| `sync-qbo-employees` | `apbg-ops` | Hourly (planned) | `qbo_employees_cache`, `qbo_token_cache` | Pull QBO employee list for roster matching |
| `health-alert` | `apbg-ops` | Every 15 min | reads `sync_log`, `qbo_token_diagnostics`; writes `health_alerts_sent` | Email Sky on sync_health red/yellow |

`[BILLING:` **Netlify functions** in this repo (`netlify/functions/`) are a separate execution surface from Supabase edge functions and serve Whitney's billing tool + ResQ→SF integration. Listed here for completeness; they do **not** touch the `ops.*` schema except `master-health.mjs` and `master-health-cron.mjs` which read `ops.sync_log` for the cross-system health page.

| Netlify function | Schedule | Purpose |
|---|---|---|
| `approve-bill`, `approve-customer`, `create-invoice`, `create-vendor`, `decode-token`, `expense-to-bill`, `get-customers`, `get-departments`, `get-vendors`, `oauth-callback`, `onboard-customer`, `process-inbound`, `sf-fix-numbers`, `sf-oauth-callback`, `sf-token-debug` | On-demand (HTTP) | Whitney's vendor-bill / customer-approval / QBO+SF admin flows. Each ties to a UI page in `public/`. |
| `resq-sf-sync`, `resq-sf-sync-background` | On-demand | Pull from ResQ, post into SF |
| `resq-sf-sync-cron` | Every 5 min (`netlify.toml`) | Cron driver for the above |
| `health-watchdog`, `master-health`, `master-health-cron`, `pacer-health` | `master-health-cron` every 15 min via `netlify.toml`; others on-demand | Cross-system health rollup; reads `ops.sync_log` and the Netlify-side QBO/SF token caches |

`]`

---

## 8. Deploy & environments

**`apbg-ops`:**
- Branch `main` → `apbg-ops.netlify.app` → proxied at `alamedapointbg.com/operations/`
- Branch `dev` → `dev--apbg-ops.netlify.app`
- Build: Vite, `base: '/operations/'` (must stay set in `vite.config.ts`)
- Required env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GATEWAY_URL` (override for dev), `VITE_SENTRY_DSN` (optional)

**`apbg-billing` (this repo):**
- `[BILLING:`
- Branch `main` → `apbg-billing.netlify.app` (publish dir `public/`)
- Branch `dev` → `dev--apbg-billing.netlify.app` (per `[context.branch-deploy]` in `netlify.toml`; same env + blob stores as production)
- Build: `npm install --prefix app && npm run build --prefix app`. The legacy single-file SPA at `public/sales/index.html` remains the source of truth for the dashboard until the Vite migration in `app/` (publishes to `public/sales-next/`) reaches feature parity.
- Required Netlify env vars:
  - QBO: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `NETLIFY_SITE_ID`, `NETLIFY_ACCESS_TOKEN` (last two are for the Netlify Blobs token store)
  - Service Fusion: `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_REDIRECT_URI`
  - ResQ: `RESQ_API_KEY`, `RESQ_BASE_URL`
  - Email: `RESEND_API_KEY` and/or `SENDGRID_API_KEY`, `EMAIL_FROM`, `APPROVAL_EMAIL`
  - Supabase (for the few Netlify functions that hit it directly): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - Sentry (planned): `SENTRY_DSN`, `VITE_SENTRY_DSN`
- Required Supabase secrets (for edge functions): `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `RESEND_API_KEY`, plus the standard `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` injected by the Edge Functions runtime.
- Function timeouts and crons declared in `netlify.toml` (`resq-sf-sync-background` 900s, `resq-sf-sync-cron` 900s every 5min, `master-health-cron` 60s every 15min, etc.).
- `]`

**`apbg-gateway`:**
- `[BILLING-SIDE: gateway-side to fill in. From this repo's perspective, all we need is for the gateway to (a) own DNS for `alamedapointbg.com`, (b) route `/operations/*` to apbg-ops, (c) eventually mint Supabase-auth-compatible JWTs for the `authenticated` role so the margin-minder Settings UI in this repo can write taxonomy tables without per-user Supabase logins.]`

---

## 9. Cross-repo contracts (the actual hand-off rules)

These are the promises one repo makes to the other. Breaking any of them silently breaks the other side.

1. **Schema migrations live in two places.** `ops.*` migrations split between `apbg-ops/supabase/migrations/` (the 0001–0021 series — roster, RLS, cache columns, classification scaffolding) and `apbg-billing/supabase/migrations/` (the `20260429*` and `20260502*–20260503*` series — margin minder, channels/segments, expense buckets, sales plans, digest, sync crons, RPCs). **Apply order:** any migration that one side's sync function depends on must land in the same PR as the function change, and apply to the live DB before merging a UI consumer. When in doubt, migrations land in this repo if they're for sync-touched tables or margin-minder; in `apbg-ops` if they're for roster, RLS, or ops-only KPI scaffolding.
2. **Sync writes use service-role.** No client writes from any UI to a sync-owned table. `apbg-ops` only writes `ops.team_members` (via gateway JWT). This repo's UI only writes the margin-minder taxonomy tables (channels/segments/expense_buckets/etc.) under `authenticated`, plus the entire `public.*` billing schema via Netlify functions (service-role).
3. **`revenue_line` and `revenue_categories.category` are stamped at sync time, not at read time.** `apbg-ops` and `apbg-billing` margin-minder both never re-classify. If the sync-side classifier drifts, both dashboards drift silently — coordinate changes in this repo.
4. **Token caches use the lease RPC.** Both repos share `ops.qbo_token_cache` and must use `ops.qbo_token_claim_refresh()` to refresh. (Netlify Blobs `qbo-tokens` is a separate, billing-tool-only token store and is exempt from this rule but also not shared cross-repo.)
5. **Domain ownership.** `alamedapointbg.com` lives on `apbg-gateway` only.
6. **Anon-key changes** require a redeploy of every consumer. Coordinate before rotating.
7. **`public.customers` schema changes** must be coordinated with both repos: this repo's billing tool writes it, apbg-ops reads via the FK from `ops.qbo_invoices`. Migrations land here.

---

## 10. Open questions / drift log

Things flagged while drafting this doc that need either confirmation or cleanup. Each builder should update its column.

| Item | Ops view | Billing view |
|---|---|---|
| Edge-function repo canonical name | mixed: `apbg-edge`, `APBG-BILLING`, `apbg-billing` | `[BILLING:` **`apbg-billing`** (matches `package.json` and the GitHub repo). Resolved — moved to §0. `]` |
| Is `sync-qbo` writing `qbo_item_id` / `qty` / `unit_cost_cents` on `qbo_invoice_lines` yet? | Code is defensive (graceful fallback if column empty). Status unknown from there. | `[BILLING:` Partial — `qbo_item_id` and `qty` yes, `unit_cost_cents` no (computed downstream from `qbo_expense_lines`). Probe query in §4. `]` |
| Is `qbo_items_cache` being populated nightly? | Same: defensive code. | `[BILLING:` Yes — scheduled by `20260503r` at 09:30 UTC. Confirm with `select count(*), max(qbo_synced_at) from ops.qbo_items_cache;` `]` |
| Is `qbo_pto_cache` being populated weekly? | §3 utilization KPI gated; not displayed yet. | `[BILLING:` **No.** Not yet wired. Action item to add `sync-qbo-pto` function + cron entry in `20260503r`. `]` |
| Reman warranty / field-failure SF custom field — chosen path? | §4 cards gated. | `[BILLING:` **Decision needed.** Recommend Sky add custom date fields in SF UI and `sync-sf` reads `customFields[]`. Status-route fallback is noisy. `]` |
| `customer_first_seen_at` populated on insert? | `apbg-ops` still uses the JS-side scan path. | `[BILLING:` **No.** Recommend adding a Postgres trigger on `ops.qbo_invoices` rather than touching `sync-qbo`. `]` |
| `balance_sheet_snapshots` sync wiring | Table exists, empty. | `[BILLING:` Not yet wired. Plan: extend `sync-qbo` to call QBO `BalanceSheet` report endpoint nightly. ETA not committed. `]` |
| `CUSTOMER-NET-PROFIT-HANDOFF.md` is stale | steps 1-2 SQL landed in PR #25; doc still says "to do" | `[BILLING:` Steps 1-2 sync-side: `qbo_item_id` and `qty` are wired (see row above), `unit_cost_cents` path goes via `qbo_expense_lines` + `fn_actual_cost_switchover` rather than direct stamping. Functionally equivalent for the customer-net-profit RPC. Mark closed once ops side confirms the RPC reads from the actual-cost path. `]` |
| Sentry instrumentation | Wired in apbg-ops PR #27 | `[BILLING:` **No.** Not wired. Action item. `]` |
| Equipment portal tables in `public` schema | Out of scope for ops dashboard | `[BILLING:` Owned by this repo. The Melt portal tables (subset of `public.*`) are written by `melt-requests-forward` / `send-melt-welcome` edge functions and read by `melt-dashboard`. The vendor-billing portal tables (`public.customers`, vendor / bill approval-token tables) are written by Whitney's Netlify functions in this repo. `]` |
| Two QBO token stores (Supabase `qbo_token_cache` vs Netlify Blobs `qbo-tokens`) | Not previously documented | `[BILLING:` Newly surfaced. Intentional split for now (billing tool predates Supabase ops project). Documented in §4 two-writer note. Long-term, migrating Netlify functions onto the Supabase lease RPC would unify the two; not urgent. `]` |
| `ops.team_members` vs `ops.staff` canonical roster | apbg-ops side claims `team_members` is legacy with FKs from sync tables still pointing at it | `[BILLING:` From this repo's reading of `CLAUDE-CODE-HANDOFF.md`, `team_members` (13 rows) is the legacy table and `staff` (20 rows) is canonical. FKs from `delivery_stops`/`service_jobs`/`reman_jobs`/`kpi_daily` still target `team_members`. Either: (a) migrate FKs to `staff`, or (b) keep `team_members` synced from `staff` via trigger. Decision needed before any KPI joins go live. Action for ops side. `]` |

---

## 11. How both builders should keep this doc honest

- Any change that touches a row in §4 (data ownership) or §7 (edge function inventory) updates this doc in the same PR.
- New external service, new repo, new env-var category, new gateway proxy route → update §2, §3, §6 in the same PR.
- The "Open questions" table in §10 is the working drift log. When something is resolved, move it out of the table and into the relevant numbered section.
- This file's home is `Skilliosis_Mytosis_Architecture/projects/apbg/ARCHITECTURE.md`. Both repos link to it; neither keeps a divergent copy. (Until that move happens, this draft lives at `apbg-billing/APBG-ARCHITECTURE.md` for review.)
