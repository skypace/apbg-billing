# APBG System Architecture — Joint Draft (ops + billing)

> **Status:** Draft.
> - Ops side filled in by Claude in `apbg-ops` (2026-05-03).
> - Billing-side answers filled in 2026-05-04 from `apbg-billing` (this repo).
> - Apbg-ops update folded in 2026-05-06 (three rounds of verification + the APBG rebrand).
>
> Final home is
> `activespacescience/Skilliosis_Mytosis_Architecture/projects/apbg/ARCHITECTURE.md`.
>
> **How to read this:** `[BILLING:` blocks are answers from this repo.
> `[OPS-2026-05-06:` blocks are the apbg-ops verification round.
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
| Forward-facing brand | mixed: PACER Ops Dashboard / APBG Ops Dashboard | **APBG.** PACER brand removed from all forward-facing apbg-ops surfaces in apbg-ops PR #53. Backend table/column names (which reference `pacer_*` in a couple places) unchanged — internal-only. |
| Architecture handoff doc | `docs/PACER-OPS-ARCHITECTURE-HANDOFF.md` | `docs/APBG-OPS-ARCHITECTURE-HANDOFF.md` (renamed in apbg-ops PR #53) |
| KPI spec | `docs/PACER_KPI_Dashboard_Metrics.docx` | `docs/APBG_KPI_Dashboard_Metrics.docx` (renamed in apbg-ops PR #53) |
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
2. **Margin Minder / sales analytics dashboard** — single-file React+Babel SPA at `public/sales/index.html` (legacy), with a Vite + React + TS replacement at `public/sales-next/`. Both mount on `apbg-billing.netlify.app/`. `dev` branch deploys to `dev--apbg-billing.netlify.app`. Reads the `ops.*` margin-minder tables (channels, segments, expense_buckets, sales_plans, etc.) added in the `20260429*` / `20260502*` / `20260503*` migrations. Old `/ops/*` URLs 301 to `/sales/*` (see `netlify.toml`).

Both surfaces mount under `apbg-billing.netlify.app/*`. They are **not** the operational KPI dashboard described in §1 step 3 — that one lives in `apbg-ops`. The two dashboards share the Supabase project but read different table sets. `]`

---

## 2. Repository inventory

| Repo | Purpose | Deploy target | URL | Owner of |
|---|---|---|---|---|
| `apbg-ops` | APBG Ops KPI dashboard (read-mostly) | Netlify (`apbg-ops.netlify.app`) | `alamedapointbg.com/operations/` | All `src/pages/executive/*`, `ops.team_members` write path via gateway-issued JWT, `ops.third_party_crews` Settings panel, `ops.db_health_snapshots` cron, `ops.revenue_categories` Settings editor (auth-write) |
| `apbg-gateway` | SSO gateway, root site, proxy | Netlify | `alamedapointbg.com` | `apbg_session` cookie/token, `/operations/*` rewrite, login UI |
| `apbg-billing` (this repo) | Billing tool UI + margin-minder dashboard + Netlify functions for vendor-bill / ResQ-SF flows + most of the Supabase edge function source for QBO/SF sync | Netlify (`apbg-billing.netlify.app`) + Supabase Edge Functions | `apbg-billing.netlify.app` | `[BILLING:` Netlify functions: see §7. Supabase edge functions deployed from this repo's developer workflow (some sources committed under future `supabase/functions/`, others applied directly via Supabase dashboard — drift to be reconciled): `sync-qbo`, `sync-sf`, `sf-oauth-callback`, `stale-invoice-alert`, `sf-tech-probe`, `sync-qbo-items`, `melt-requests-forward`, `send-melt-welcome`, `nightly-qbo-sync`. **Not in this repo's tree (source location unknown):** `sync-qbo-customers`, `sync-qbo-expenses`, `sync-qbo-inventory-adjustments`, `digest-email`, `push-qbo-budget` — see §7. Also writes the entire `ops.*` schema except the bits ops-side claims, plus `public.*` billing tables (`public.customers`, vendor approval tokens, etc.). The wider 42-table `public.*` equipment portal schema is owned by **neither** repo today — see §13. `]` |
| `melt-dashboard` | Brix Melt equipment dashboard | Netlify | `[BILLING:` `melt-dashboard.netlify.app`; not domain-mapped under `alamedapointbg.com` today. `]` | Out of scope here — co-tenant on the shared DB |
| `Skilliosis_Mytosis_Architecture` (ASM) | Architecture handbook | n/a (docs) | GitHub | This file's final home |

> Note from ops side: `apbg-ops` has two edge functions of its own under
> `supabase/functions/` (`health-alert` and `sync-qbo-employees`).
> `[BILLING:` Confirmed — those two functions live in `apbg-ops`, not
> here. They both touch `ops.qbo_token_cache` though, so the lease-RPC
> contract in §4 / §9 applies between them and the Supabase edge
> functions deployed from this repo. `]`

---

## 3. Shared infrastructure

**Supabase project (single, shared):**
- Name: `APBG-BILLING`
- ID: `gfsdpwiqzshhexkofiif`
- Region: `us-east-2`
- URL: `https://gfsdpwiqzshhexkofiif.supabase.co`
- Schemas:
  - `ops` — operational KPIs, margin-minder analytics, classification taxonomies. Written primarily by sync edge functions (this repo) plus a few ops-side functions. Read by both dashboards. **§4b verification (2026-05-05):** all 23 billing-side tables that show up in margin-minder confirmed present in `ops.*`, none in `public.*`.
  - `public` — `[BILLING:` Owned partly by `apbg-billing` (this repo): `public.customers` and the vendor / bill / approval-token tables backing `netlify/functions/approve-bill.mjs`, `approve-customer.mjs`, `onboard-customer.mjs`, `create-invoice.mjs`, `create-vendor.mjs`, `process-inbound.mjs`. Also referenced by `ops.qbo_invoices.public_customer_id` (FK into `public.customers`). **The other 42 tables (jobs, POs, vendors, customer_contracts, equipment_requests, warranties, knowledge_base, etc.) are not owned by this repo** — see §13. The Melt equipment-portal tables are also in `public` and served by the `melt-*` edge functions deployed from this repo. `]`
- Tenants: `apbg-ops`, `apbg-billing`, `apbg-gateway`, `melt-dashboard`

**Domain:** `alamedapointbg.com` is owned by `apbg-gateway`. No other Netlify project should add it. Cross-repo auth/proxy contracts go through the gateway.

**Margin Minder mount paths (this repo):** `apbg-billing.netlify.app/sales/` (legacy single-file SPA) + `apbg-billing.netlify.app/sales-next/` (Vite/TS migration target). Branch `dev` → `dev--apbg-billing.netlify.app`.

**Email sender:** `alerts@alamedapointbg.com` via Resend. Used by `health-alert` (apbg-ops) and `stale-invoice-alert` (this repo). `[BILLING:` Confirmed — Resend account is owned by Sky. `RESEND_API_KEY` is set both as a Supabase function secret (for edge functions) and as a Netlify environment variable (for `netlify/functions/email-helpers.mjs`, which is dual-mode and prefers `SENDGRID_API_KEY` if both are set). Default `EMAIL_FROM` for the billing tool is `Pacer Billing <billing@brixbev.com>`; Sky's ops alerts use `alerts@alamedapointbg.com`. Both senders are verified in the same Resend account. `]`

---

## 4. Data ownership matrix (the critical section)

For every `ops.*` table: who writes, who reads. Disagreements here are bugs.

| Table / RPC | Migration | Writer | Readers | Cadence |
|---|---|---|---|---|
| `ops.team_members` | apbg-ops | `apbg-ops` (Staff Roster page, gateway-issued JWT) | `apbg-ops` everywhere; `[BILLING:` this repo does **not** read `ops.team_members` from any UI surface today. Confirm with ops which of `staff` vs `team_members` is the canonical roster table. `]` | On-demand |
| `ops.qbo_invoices` | sync side | `apbg-billing` `sync-qbo` (and the `nightly-qbo-sync` cron) | `apbg-ops` (§1A–§1D, AR aging); `apbg-billing` margin-minder dashboard | Nightly 09:00 UTC + every 3 min backfill |
| `ops.qbo_invoice_lines` | sync side | `apbg-billing` `sync-qbo` | `apbg-ops`; `apbg-billing` margin-minder (the core fact table for margin-minder). Real columns: `item_ref_id`, `item_name`, `quantity`, `unit_price`. **Migration 0016 (`qbo_item_id` / `qty` / `unit_cost_cents`) was never applied — apbg-ops realigned to the actual columns in PR #50 (f5e5d72).** `unit_cost` is computed downstream from `ops.qbo_expense_lines` via `fn_actual_cost_switchover` (`20260503h`) for true weighted-avg landed cost. | Nightly + backfill |
| `ops.qbo_items` (master) | sync side | `apbg-billing` `sync-qbo-items` | `apbg-ops` Settings → System review panel (joins via `item_ref_id == qbo_item_id` since PR #52 / `65f4ac1`); `apbg-billing` margin-minder | Nightly 09:30 UTC (`20260503r`). **Note:** `ops.qbo_items_cache` (migration 0015) was deleted on the apbg-ops side in PR #52; the master `ops.qbo_items` is now the single source. |
| `ops.qbo_pto_cache` | 0014 | (none — empty) | (none today) | **NOT wired.** Header comment in `0014_qbo_pto_cache.sql` notes the dead-but-acceptable status. Apbg-ops §3 utilization KPI gated behind population. |
| `ops.pl_snapshots` | sync side | `apbg-billing` `sync-qbo` | `apbg-ops` (§1A trend, §1E reconciliation) | Nightly |
| `ops.balance_sheet_snapshots` | apbg-ops | `[BILLING:` **NOT yet wired.** Table exists, zero rows. Plan: extend `sync-qbo` to call QBO `BalanceSheet` report nightly. ETA not committed. `]` | `apbg-ops` (future KPIs) | TBD |
| `ops.delivery_stops` | sync side | `apbg-billing` `sync-sf` | `apbg-ops` §2; `apbg-billing` `stale-invoice-alert` | Every 30 min |
| `ops.service_jobs` | sync side | `apbg-billing` `sync-sf` | `apbg-ops` §3; `apbg-billing` `stale-invoice-alert` | Every 30 min |
| `ops.reman_jobs` | sync side | `apbg-billing` `sync-sf` | `apbg-ops` §4; `apbg-billing` `stale-invoice-alert`. **No `customer_name` column on this table — only `customer_ref_id`.** Apbg-ops's old assumption broke `getStaleInvoices`; fixed in PR #51 (`449fe5a`) to surface `"QBO ref <id>"` until a customer-name resolution join lands. | Every 30 min |
| `ops.reman_jobs.warranty_returned_at` / `field_failure_at` | 0017 | `apbg-billing` `sync-sf` | `apbg-ops` §4 (gated) | Columns exist after Phase 1 apply; **population status TBD on billing side.** Decision needed: SF custom-field route vs status-route (recommend custom-field). |
| `ops.revenue_categories` | 0013 + 0025 (v2 taxonomy seed) + 0027 (auth-write policy) | Manual SQL **OR** apbg-ops Settings → System editor (auth-write, PR #47) | `apbg-ops` (Revenue Breakdown, Settings); `apbg-billing` margin-minder Settings panel | On-demand |
| `ops.third_party_crews` | 0026 | `apbg-ops` Settings → System "3rd-party crews" panel (auth-write policy) | `apbg-ops` Delivery / Service / Reman KPI rollup | On-demand |
| `ops.db_health_snapshots` | 0019 | `ops.snapshot_db_health()` cron `db_health_daily` (06:00 UTC) | `apbg-ops` Settings → System DB Health panel | Daily |
| `ops.customer_health_snapshots` | apbg-billing | DB function `ops.fn_take_health_snapshot()` (SECURITY DEFINER), cron `weekly-health-snapshot` Mon 10:00 UTC | `apbg-billing` margin-minder customer-health panel | Weekly. **Not an edge function — pure DB-side cron.** |
| RPC `ops.qbo_token_diagnostics()` | 0023 | n/a (read-only over `qbo_token_cache`) | `apbg-ops` `health-alert` edge function | n/a |
| RPC `ops.unmatched_sf_names(p_since_days)` | 0026 | n/a | `apbg-ops` Settings → System "3rd-party crews" panel | n/a |
| RPC `ops.db_health_now()` | 0019 + 0024 (pgss schema-lookup fix, PR #37) | n/a | `apbg-ops` DB Health panel + cron | n/a |
| `ops.qbo_employees_cache` | apbg-ops | `apbg-ops` `sync-qbo-employees` (in-repo function) | `apbg-ops` (roster matching); occasionally `apbg-billing` for vendor-bill `employee_name` validation | Hourly |
| `ops.qbo_token_cache` | apbg-ops | `apbg-billing` Supabase edge syncs (`sync-qbo`, `sync-qbo-items`, etc.); `apbg-ops` `sync-qbo-employees` — all via the lease RPC `ops.qbo_token_claim_refresh()` | Both | On refresh |
| `ops.sf_token_cache` | apbg-billing | `apbg-billing` `sync-sf` + `sf-oauth-callback` | Both | On refresh |
| `ops.sync_log` | shared | All sync functions append; nobody else writes | `apbg-ops` SyncHealthBanner, `health-alert`; `apbg-billing` `master-health` Netlify function | On every sync run |
| `ops.health_alerts_sent` | 0020 | `apbg-ops` `health-alert` | `apbg-ops` `health-alert` (dedupe) | On every alert |
| `ops.qbo_expenses` | 0014 | `apbg-billing` `sync-qbo-expenses` (source location unknown — see §7) | `apbg-billing` margin-minder; `apbg-ops` (future expense KPIs) | Nightly 09:40 UTC, `since=2025-01-01` |
| `ops.qbo_expense_lines` | 0503g | `apbg-billing` `sync-qbo-expenses` | `apbg-billing` `fn_item_avg_cost`; `fn_actual_cost_switchover` | Nightly with parent expenses |
| `ops.channels` / `ops.segments` / `ops.expense_buckets` / `ops.customer_channels` / `ops.category_segments` / `ops.item_segments` | 0502b–g | `apbg-billing` margin-minder Settings UI (writes via `authenticated` JWT — see RLS migration `20260503b`) | `apbg-billing` margin-minder dashboard | On-demand |
| `ops.sales_plans` / `ops.sales_reps` / `ops.saved_views` / `ops.item_sets_voids` | 0503e/f/k/l | `apbg-billing` margin-minder UI | `apbg-billing` only | On-demand |
| `ops.digest_subscriptions` / `ops.digest_log` | 0503m | `apbg-billing` Settings UI (subscriptions); `digest-email` edge function (log) | `digest-email` reads subscriptions hourly | On-demand subs / hourly log |
| `public.customers` and the rest of the apbg-billing-owned `public.*` tables | apbg-billing | `apbg-billing` Netlify functions only (`approve-customer.mjs`, `onboard-customer.mjs`, `create-invoice.mjs`, `create-vendor.mjs`, `process-inbound.mjs`) using service-role | `apbg-billing` UI; `apbg-ops` reads `public.customers` only via the FK from `ops.qbo_invoices.public_customer_id` (rare) | On-demand by Whitney |

**Two-writer note on `ops.qbo_token_cache`** (revised per billing's 2026-05-05 verification): the **billing-side Netlify functions do not touch `ops.qbo_token_cache` at all** — they use Netlify Blobs + their own QBO connection (`netlify/functions/qbo-helpers.mjs`, store `qbo-tokens`). The two-writer concern is purely between **Supabase Edge Functions**: billing's edge syncs (`sync-qbo`, `sync-qbo-items`, etc.) and apbg-ops's `sync-qbo-employees`. All of those serialize through `ops.qbo_token_claim_refresh()` (a row-lock + 20s lease RPC). If any edge function bypasses the lease, refresh-token rotation will race. **All edge functions must use the lease RPC, never read/write the cache directly.** The Netlify Blobs `qbo-tokens` store is a separate, billing-tool-only token cache and is exempt — it doesn't share a refresh token with the edge functions (see §6 for the parallel-app rationale).

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
- HR tables anon-readable bug closed by apbg-ops PR #34 / migration 0022.
- `[BILLING:` This repo's margin-minder Settings panel does need writes from the browser to `ops.channels`, `ops.segments`, `ops.expense_buckets`, etc. Migration `20260503b_tighten_rls.sql` (this repo) restricts those writes to the `authenticated` role. **The browser does not have an `authenticated` JWT today** because the billing-side dashboard isn't gated by the SSO. Until the gateway mints Supabase-auth-compatible JWTs, Settings UI in this repo should gracefully degrade to read-only with a banner. `]`

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
| QuickBooks Online | Invoices, P&L, items, employees, PTO, expenses, customers, inventory adjustments, balance sheet (planned) | `apbg-billing` (primary, all sync functions); `apbg-ops` (employees only via its own `sync-qbo-employees`) | Supabase secrets (edge functions read `ops.qbo_token_cache` via lease RPC). Netlify Blobs `qbo-tokens` is a **separate** token store (and a separate QBO connection / app) used by this repo's Netlify functions for Whitney's billing flow. |
| Service Fusion | Delivery stops, service jobs, reman jobs | `apbg-billing` | Supabase secrets + `ops.sf_token_cache`; OAuth callback served by both `netlify/functions/sf-oauth-callback.mjs` and the Supabase edge function `sf-oauth-callback` (Supabase one canonical; Netlify one supports the legacy ResQ→SF sync path) |
| ResQ | Source of vendor-managed kitchen-equipment service tickets, forwarded into SF | `apbg-billing` (Netlify functions `resq-sf-sync*` only) | Netlify env vars |
| Resend | Outbound email (alerts, billing approvals, ops digests) | Both repos send | `RESEND_API_KEY` Supabase secret per function; `RESEND_API_KEY` Netlify env var for `email-helpers.mjs` |
| SendGrid | Outbound email (legacy fallback for billing-tool emails) | `apbg-billing` only | `SENDGRID_API_KEY` Netlify env var |
| Sentry | Error tracking | `apbg-ops` only (write-side wired in PR #27, source maps in #28). **`apbg-billing` not wired** (confirmed billing 2026-05-05). | `apbg-ops`: `VITE_SENTRY_DSN`, build-time auth token |
| Fleetmatics / Verizon Connect / Powerfleet | Driver telematics (planned) | `apbg-billing` (the `sync-fleetcomplete` function will live here once the API token is in hand). Tables (`ops.fleet_*`) are deployed and empty. | Will land in Supabase secrets + `ops.fc_token_cache` |
| Bambee / BambooHR | HR (planned) | `apbg-billing` if BambooHR is chosen (REST API). If Bambee, it's manual-entry forms. Tables (`ops.hr_*`) deployed and empty. | TBD |
| Zoho CRM | Pipeline (planned) | `[BILLING:` Per Sky, the Zoho MCP server lives in the `skypace/pacerfinance` repo and is consumed by Claude / agents, not by this dashboard. If Zoho is ever wired into a sync, it should land in `apbg-billing`. `]` | TBD |
| Netlify | Hosting | Per-repo | Per-repo Netlify env vars |
| Supabase | Database + edge functions + cron + auth | Shared project, see §3 | Per-repo Supabase env vars |

---

## 7. Edge function inventory

| Function | Repo / source location | Schedule | Tables touched | Purpose |
|---|---|---|---|---|
| `sync-qbo` | `apbg-billing` | Nightly 09:00 UTC + every 3 min backfill | `qbo_invoices`, `qbo_invoice_lines`, `pl_snapshots`, `qbo_token_cache`, `sync_log` | Pull QBO invoices, lines, P&L (current v29) |
| `sync-qbo-items` | `apbg-billing` | Nightly 09:30 UTC (`20260503r`) | `ops.qbo_items` (master), `sync_log` | Pull QBO `Item` for cost / margin enrichment. Note: `qbo_items_cache` no longer exists — apbg-ops PR #52 deleted it. |
| `sync-qbo-customers` | **unknown — source not in either repo** | Nightly 09:35 UTC (`20260503r` schedules it) | `qbo_customers_cache`, `public.customers`, `sync_log` | Pull QBO `Customer`. **Action item: locate the function source.** |
| `sync-qbo-expenses` | **unknown — source not in either repo** | Nightly 09:40 UTC, `since=2025-01-01` (`20260503r` schedules it) | `qbo_expenses`, `qbo_expense_lines`, `sync_log` | Pull QBO `Purchase` + `Bill` for true weighted-avg landed cost. **Action item: locate the function source.** |
| `sync-qbo-inventory-adjustments` | **unknown — source not in either repo** | Nightly 09:50 UTC (`20260503r` schedules it) | `qbo_inventory_adjustments`, `sync_log` | Pull QBO `InventoryAdjustment`. **Action item: locate the function source.** |
| `digest-email` | **unknown — source not in either repo** | Hourly `0 * * * *` (`20260503m` schedules it) | reads `digest_subscriptions`, writes `digest_log` | Send weekly/daily margin-minder digests. **Action item: locate the function source.** |
| `push-qbo-budget` | **unknown — source not in either repo** | On-demand (`20260503v` adds the wrapper RPC) | reads `sales_plans`; calls QBO Budget API | Push annual sales-plan to QBO Budget. **Action item: locate the function source.** |
| `nightly-qbo-sync` (legacy) | `apbg-billing` | Nightly 09:00 UTC | superset of `sync-qbo` | Pre-`20260503r` nightly job; kept for now |
| `sync-sf` | `apbg-billing` | Every 30 min | `delivery_stops`, `service_jobs`, `reman_jobs`, `sf_token_cache`, `sync_log` | Pull SF jobs |
| `sf-oauth-callback` | `apbg-billing` | n/a (HTTP only) | `sf_token_cache` | OAuth redirect target for SF |
| `sf-tech-probe` | `apbg-billing` | On-demand | `service_jobs.tech_name` (backfill) | Backfill tech name on jobs missing it |
| `stale-invoice-alert` | `apbg-billing` | Daily 7am PT | reads `delivery_stops` / `service_jobs` / `reman_jobs` | Email Sky when SF $$ has no QBO match >5d |
| `melt-requests-forward` | `apbg-billing` | On-demand | `public.melt_*` (Melt portal tables) | Forward customer service requests from Melt portal |
| `send-melt-welcome` | `apbg-billing` | On trigger | reads `public.customers` | Welcome email when a Melt customer is onboarded |
| `sync-qbo-employees` | `apbg-ops` | Hourly (planned) | `qbo_employees_cache`, `qbo_token_cache` | Pull QBO employee list for roster matching |
| `health-alert` | `apbg-ops` | Every 15 min | reads `sync_log`, calls RPC `qbo_token_diagnostics`; writes `health_alerts_sent` | Email Sky on sync_health red/yellow. **Confirmed deployed and live as of 2026-05-04** with real credentials, verify-JWT off, function uses its own `x-health-alert-secret` gate. PRs #38 / #49 (latter closed the stale "no edge functions in this repo" claim in apbg-ops's CLAUDE.md / README.md). |

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
- Branch `main` → `apbg-billing.netlify.app` (publish dir `public/`)
- Branch `dev` → `dev--apbg-billing.netlify.app` (per `[context.branch-deploy]` in `netlify.toml`; same env + blob stores as production)
- Build: `npm install --prefix app && npm run build --prefix app`. The legacy single-file SPA at `public/sales/index.html` remains the source of truth for the dashboard until the Vite migration in `app/` (publishes to `public/sales-next/`) reaches feature parity.
- Required Netlify env vars:
  - QBO: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `NETLIFY_SITE_ID`, `NETLIFY_ACCESS_TOKEN` (last two are for the Netlify Blobs token store)
  - Service Fusion: `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_REDIRECT_URI`
  - ResQ: `RESQ_API_KEY`, `RESQ_BASE_URL`
  - Email: `RESEND_API_KEY` and/or `SENDGRID_API_KEY`, `EMAIL_FROM`, `APPROVAL_EMAIL`
  - Supabase (for the few Netlify functions that hit it directly): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - Sentry: not wired today
- Required Supabase secrets (for edge functions): `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `RESEND_API_KEY`, plus the standard `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` injected by the Edge Functions runtime.
- Function timeouts and crons declared in `netlify.toml` (`resq-sf-sync-background` 900s, `resq-sf-sync-cron` 900s every 5min, `master-health-cron` 60s every 15min, etc.).

**`apbg-gateway`:**
- `[BILLING-SIDE: gateway-side to fill in. From this repo's perspective, all we need is for the gateway to (a) own DNS for alamedapointbg.com, (b) route /operations/* to apbg-ops, (c) eventually mint Supabase-auth-compatible JWTs for the authenticated role so the margin-minder Settings UI in this repo can write taxonomy tables without per-user Supabase logins.]`

---

## 9. Cross-repo contracts (the actual hand-off rules)

These are the promises one repo makes to the other. Breaking any of them silently breaks the other side.

1. **Schema migrations live in two places.** `ops.*` migrations split between `apbg-ops/supabase/migrations/` (the `0001`–`0027` series — roster, RLS, cache columns, classification scaffolding, third-party crews, db-health, auth-write policies) and `apbg-billing/supabase/migrations/` (the `20260429*` and `20260502*–20260503*` series — margin minder, channels/segments, expense buckets, sales plans, digest, sync crons, RPCs). **Apply order:** any migration that one side's sync function depends on must land in the same PR as the function change, and apply to the live DB before merging a UI consumer.
2. **Sync writes use service-role.** No client writes from any UI to a sync-owned table. `apbg-ops` writes `ops.team_members`, `ops.third_party_crews`, `ops.revenue_categories` (via gateway JWT / authenticated). This repo's UI writes margin-minder taxonomy tables (channels/segments/expense_buckets/etc.) under `authenticated`, plus the apbg-billing-owned `public.*` tables via Netlify functions (service-role).
3. **`revenue_line` and `revenue_categories.category` are stamped at sync time, not at read time.** Both dashboards never re-classify. If the sync-side classifier drifts, both dashboards drift silently — coordinate changes in this repo.
4. **Token caches use the lease RPC.** All Supabase Edge Functions that touch `ops.qbo_token_cache` (billing's edge syncs + apbg-ops's `sync-qbo-employees`) must use `ops.qbo_token_claim_refresh()` to refresh. **Billing-side Netlify functions are exempt** — they use a parallel Netlify Blobs token store (`qbo-tokens`) backed by a separate QBO connection, and don't share a refresh token with the edge functions.
5. **Domain ownership.** `alamedapointbg.com` lives on `apbg-gateway` only.
6. **Anon-key changes** require a redeploy of every consumer. Coordinate before rotating.
7. **`public.customers` schema changes** must be coordinated: this repo's billing tool writes it, apbg-ops reads via the FK from `ops.qbo_invoices`. Migrations land here. (The other 42 `public.*` equipment-portal tables are unowned today — see §13.)

---

## 10. Open questions / drift log

Things flagged across rounds of verification that still need decisions.

| Item | Owner | Notes |
|---|---|---|
| §13: 42 `public.*` equipment-portal tables — owner unknown | Sky | Source not in either repo. Whitney's Netlify functions read/write some; ownership investigation pending. |
| `qbo_customers` exposed to anon `SELECT` (PII risk on customers) | billing | RLS / GRANT review needed. Apbg-ops surfaced this 2026-05-06. |
| `qbo_items` and `qbo_inventory_*` exposed to anon `SELECT` | billing | Same review pass as above; less PII-sensitive. |
| `expense_bucket_types` had RLS off entirely (anon read+write) | billing | Surfaced 2026-05-06. RLS lockdown needed. |
| §12 #6b destructive (notes / memo redaction) sweep | Sky | Both sides audited clean; awaits Sky's greenlight. |
| `balance_sheet_snapshots` sync wiring | billing | Plan: extend `sync-qbo` to call QBO `BalanceSheet` nightly. ETA not committed. |
| Reman warranty / field-failure SF custom fields — populator path | Sky / billing | Columns exist (0017). Recommend Sky add SF custom date fields, `sync-sf` reads `customFields[]`. |
| Sentry instrumentation in `apbg-billing` | billing | Not wired. Confirmed 2026-05-05. Action item, not blocking. |
| `ops.team_members` vs `ops.staff` canonical roster | ops | apbg-ops side calls `team_members` "LEGACY"; FKs from `delivery_stops` / `service_jobs` / `reman_jobs` / `kpi_daily` still target it. Decide: migrate FKs, or keep `team_members` synced from `staff` via trigger. |
| Locate source for `sync-qbo-customers`, `sync-qbo-expenses`, `sync-qbo-inventory-adjustments`, `digest-email`, `push-qbo-budget` | Sky / billing | Scheduled by billing-side migrations but the function source isn't in either repo's tree today. Needs separate routing. |
| `qbo_pto_cache` populator | billing | Kept as dead-but-acceptable schema. Header comment in `0014_qbo_pto_cache.sql` notes status. Apbg-ops §3 utilization KPI gated. |

**Resolved this round (2026-05-06) — moved out of drift log into numbered sections:**

- ~~"Sync writing `qbo_item_id` / `qty` / `unit_cost_cents`?"~~ — migration 0016 not actually wanted; apbg-ops realigned to real columns (`item_ref_id` / `quantity`). PR #50.
- ~~"`qbo_items_cache` populated nightly?"~~ — table dropped from apbg-ops. PR #52.
- ~~"`qbo_pto_cache` populated weekly?"~~ — accepted dead schema; documented in §4 + drift log.
- ~~"`customer_first_seen_at` populated on insert?"~~ — column never landed; apbg-ops uses JS-scan path with PostgREST pagination. PR #41.
- ~~"HR tables anon-readable"~~ — closed by apbg-ops PR #34 / migration 0022.
- ~~"Stale 'no edge functions in this repo' claim in apbg-ops `CLAUDE.md` / `README.md`"~~ — closed by PR #49.
- ~~"`qbo_token_diagnostics` RPC missing"~~ — closed by PR #35 / 0023.
- ~~"`db_health_now` pgss bug"~~ — closed by PR #37 / 0024.
- ~~"Avg billable hr/job stuck at 0"~~ — closed by PR #39.
- ~~"First-invoice / rolling-12 cohort under-counting"~~ — closed by PR #41.
- ~~"Bucket taxonomy locked"~~ — closed by PR #40 / 0025 + PR #47 / 0027.
- ~~"3rd-party crews tagging system"~~ — closed by PRs #45 / 0026 + #46.
- ~~"Cross-role tech badges"~~ — closed by PR #44.
- ~~"`reman_jobs.customer_name` silent-fail bug"~~ — closed by PR #51 / `449fe5a`.
- ~~"PACER → APBG forward-facing rebrand"~~ — closed by apbg-ops PR #53.
- ~~"`CUSTOMER-NET-PROFIT-HANDOFF.md` is stale"~~ — sync-side path goes via `qbo_expense_lines` + `fn_actual_cost_switchover`; functionally equivalent. Mark closed once ops-side RPC reads from the actual-cost path.

---

## 11. How both builders should keep this doc honest

- Any change that touches a row in §4 (data ownership) or §7 (edge function inventory) updates this doc in the same PR.
- New external service, new repo, new env-var category, new gateway proxy route → update §2, §3, §6 in the same PR.
- The "Open questions" table in §10 is the working drift log. When something is resolved, move it out of the table and into the relevant numbered section (or strike it through under "Resolved this round").
- This file's home is `Skilliosis_Mytosis_Architecture/projects/apbg/ARCHITECTURE.md`. Both repos link to it; neither keeps a divergent copy. (Until that move happens, this draft lives at `apbg-billing/APBG-ARCHITECTURE.md` for review.)

---

## 12. Sky-pending decisions

These are joint decisions Sky owes from the cross-repo discussion. Apbg-ops's vote (where it has one) is recorded so the doc reflects current alignment without pre-empting Sky.

| # | Decision | Apbg-ops vote | Notes |
|---|---|---|---|
| #1 | `v_sales_lines` collapse | **(a)** — apbg-ops agrees with billing's recommendation | Apbg-ops doesn't read the view; no blocker either way. |
| #5 | Taxonomy sprawl (channels × segments × buckets × revenue_categories) | no opinion | Apbg-ops has zero usage of these taxonomies; defer to billing. |
| #6 (a / a′ / b / c) | UI / data structure cleanup options | no block; **(a′) directory view** cleanest from apbg-ops side | None of the four options conflict with apbg-ops reads. |
| #6b | Destructive redaction sweep on notes / memo fields | both sides clear | Awaits Sky's greenlight — no changes pending in either repo. |
| §13 | Investigate ownership of the 42 `public.*` equipment-portal tables | n/a | See §13 below. |

---

## 13. Equipment-portal tables in `public.*` (owner unknown)

42 tables in `public.*` schema (jobs, POs, vendors, customer_contracts, equipment_requests, warranties, knowledge_base, etc.). Whitney's billing-tool Netlify functions in this repo read/write some of them via QBO + Supabase clients, but **the schema source (CREATE TABLE migrations) is in neither apbg-ops nor apbg-billing**. Apbg-ops grep confirmed zero references to `pacerfinance` / `pacer-finance` / `pacer.finance`, so the original speculation that these came from `skypace/pacerfinance` is unverified.

**Scope of impact:**
- `apbg-ops` Supabase client is hardwired to `db: { schema: 'ops' }`, so the dashboard never sees these tables. No risk on the apbg-ops surface.
- `apbg-billing` (this repo) Netlify functions do touch some of these tables (jobs, vendors, POs around Whitney's vendor-bill workflow). If a schema change happens upstream, those functions break silently.
- RLS posture on these tables is not audited here. Anon read on customer-facing tables (jobs, equipment_requests, customer_contracts) would be a PII issue.

**Action items:**
- Sky to identify the owning repo / migration source for the 42 tables.
- Once identified, either (a) add that repo to the §2 inventory and §9 contracts, or (b) lift the migrations into one of the existing repos.
- Run an RLS audit on the 42 tables independent of the ownership question — it's likely some have anon `SELECT` they shouldn't.
