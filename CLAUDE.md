> **Architecture handbook:** This repo is part of a multi-repo system documented in [`activespacescience/Skilliosis_Mytosis_Architecture`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md). When work in this repo touches architecture (new external service, new cross-repo dependency, new deploy target, new MCP/connector, new env-var category, new/renamed/archived repo, new gateway proxy route), update `ARCHITECTURE.md` in the same change via the GitHub MCP (`asm-mcp-tools.netlify.app/github`, tool `github_create_or_update_file`). Brand-new projects should be planned in that repo's `projects/<project-name>/` folder before any code is written here.

---

# apbg-billing — Claude orientation

## TL;DR

This repo hosts **five surfaces** that share one Netlify deploy at `apbg-billing.netlify.app`, all fronted through the parent gateway at `alamedapointbg.com`:

1. **3rd-Party Billing** — the original AI vendor-bill processing tool (AP)
2. **BRIX Margin Control** — React/Vite SPA for sales / margin / customer analytics (`app/`, builds to `public/sales-next/`, surfaced at `/margin/` on the gateway)
3. **Brixpense** — React/Vite SPA for internal expense + purchase requests with magic-link approvals and QBO bill posting (`app-expense/`, builds to `public/expense/`, surfaced at `/expense/`)
4. **Sync orchestration manifest** — cross-repo lint contract for the `ops.*` schema (`architecture/sync-manifest.json`)
5. **Interactive user guide** — markdown source in `docs/`, viewer in `public/docs/`, surfaced at `/margin/docs/margin-control/`

Plus **two Supabase edge functions** whose source lives here but which deploy separately to the Supabase project:

- `sync-qbo` (v35) — QBO → Supabase reads
- `push-qbo-item` (v2) — Supabase → QBO writebacks (Item.Active + Category ParentRef)

## What's deployed today

| Surface | Lives in | URL |
|---|---|---|
| AP / 3rd-Party Billing | `public/*.html` + `netlify/functions/` | `alamedapointbg.com/billing/` |
| BRIX Margin Control (v0.9.27) | `app/` → built into `public/sales-next/` | `alamedapointbg.com/margin/` |
| Brixpense (v0.1.0) | `app-expense/` → built into `public/expense/` | `alamedapointbg.com/expense/` |
| User Guide | `docs/margin-control/` + viewer in `public/docs/margin-control/` | `alamedapointbg.com/margin/docs/margin-control/` |
| Master Control admin panel | `public/control.html` | `alamedapointbg.com/control` |
| ResQ ↔ Service Fusion sync dashboard | `public/sync.html` + `netlify/functions/resq-sf-sync*.mjs` | `alamedapointbg.com/billing/sync.html` |
| QBO + Service Fusion OAuth setup | `public/setup.html` | `alamedapointbg.com/billing/setup.html` |

## Where to look first

If you're picking up work in this repo, read these in order:

1. **[`README.md`](README.md)** — repo map: what each folder is, what each Netlify function does, the build pipeline (lint → cp docs → vite build), environment variables.
2. **[`architecture/MARGIN-CONTROL.md`](architecture/MARGIN-CONTROL.md)** — focused architecture for the BRIX Margin Control SPA: pages, components, lib modules, RPC contract, brand tokens, known gaps.
3. **[`architecture/BRIXPENSE.md`](architecture/BRIXPENSE.md)** — focused architecture for Brixpense: pages, lifecycle, magic-link flow, function contracts, migration history.
4. **[`architecture/README.md`](architecture/README.md)** — the sync orchestration manifest (which function writes which `ops.*` table). Lint runs in CI as the first build step; a dirty manifest fails the build.
5. **[`docs/margin-control/user-guide.md`](docs/margin-control/user-guide.md)** — end-user guide for BRIX. Renders live at `alamedapointbg.com/margin/docs/margin-control/`.
6. **[`activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md)** — master cross-repo handbook. Source of truth for Supabase IDs, Intuit apps, RLS posture, MCP servers, and the rest of the wired system.

## Tech stack at a glance

- **AP tool:** Vanilla HTML + JS in `public/`, served as-is by Netlify. Approval flow + bill scanning.
- **BRIX Margin Control:** React 18 + Vite 5 + TypeScript 5 + MUI v6 + MUI X v7 Pro (DataGrid Pro, Charts, Date Pickers) + `@supabase/supabase-js` + Lucide React + dayjs. Custom hand-rolled router (`app/src/lib/router.ts`).
- **Brixpense:** React 18 + Vite 5 + TypeScript 5 + Radix UI + shadcn-style wrappers + `react-hook-form` + `zod` + `react-router-dom` v6 + `react-signature-canvas` + Tailwind 3 (dark navy glass-morphism theme).
- **Backend (Netlify Functions):** ESM `.mjs` files in `netlify/functions/`. Handles bill processing, ResQ-SF sync, health checks, OAuth callbacks, expense requests, OCR (Claude API), QBO bill creation.
- **Backend (Supabase Edge Functions):** Deno runtime. `sync-qbo` and `push-qbo-item`. Source tracked here, deployed separately to the Supabase project (`gfsdpwiqzshhexkofiif`).
- **Data:** Supabase `ops.*` schema, with the `ops.mv_sales_lines` materialized view as the curated read surface backing BRIX. Brixpense uses `ops.expense_requests/_attachments/_approvals/_settings`.

## Build pipeline (`netlify.toml`)

```
git push main
  └─▶ Netlify build
       1. node architecture/lint-manifest.mjs       ← sync-manifest gate
       2. mkdir -p public/docs && cp -r docs/. public/docs/
       3. npm install --prefix app                  ← Margin Control deps
       4. npm run build --prefix app                ← tsc -b && vite build
            ↓
            public/sales-next/
       5. npm install --prefix app-expense          ← Brixpense deps
       6. npm run build --prefix app-expense        ← tsc + vite build
            ↓
            public/expense/
       Publishes public/ as static + netlify/functions/ as Lambdas
```

A failing manifest lint stops the build before Vite runs. A TS error in either `app/` or `app-expense/` stops the build before publish. There's no Vercel involved — Netlify is the only deploy target for this repo.

## Credentials

- **Supabase URL:** `https://gfsdpwiqzshhexkofiif.supabase.co`
- **Supabase anon key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY`
- **Schema:** `ops` (use `Accept-Profile: ops` header or Supabase client `{ db: { schema: 'ops' } }`)
- **QBO Realm ID:** `9130352144155116` (APBG_Billing Intuit app)
- **MUI X Pro license:** required at build time via `VITE_MUI_X_LICENSE` env var on Netlify (paid through activespacescience). Without it, DataGrid Pro renders a watermark.
- **Anthropic API key:** required for receipt OCR (`process-inbound`) and AP-tool bill scanning. Env var `ANTHROPIC_API_KEY`.
- **Email provider:** `RESEND_API_KEY` or `SENDGRID_API_KEY`. `email-helpers.mjs` picks whichever is set.
- **Netlify site:** linked to this repo, auto-deploys on push to `main`. Publish dir: `public/`.

For the full env-var inventory (QBO, SF, ResQ, SendGrid, Resend, etc.), see [`README.md`](README.md) and the `netlify.toml`.

## What's actively being worked on

This section is intentionally short — short enough that drift is obvious. As of 2026-05-12:

- **BRIX Margin Control polish + features.** Track 1 data hygiene (rollup preview + items hygiene banner) shipped v0.9.26; runtime fuzzy-match for chain rollups shipped v0.9.27. Active sub-screens still maturing: Settings → Customers master, Settings → Items master, Settings → Categories, Settings → P&L Alignment editor, Settings → Sales Reps.
- **Brixpense post-launch polish.** Frontend (7 pages) + 4 Netlify functions + 4 migrations all live. Active gaps: mobile sidebar, admin settings UI for `ops.expense_settings`, entity → department → COGS cascade on the form, edit-flow data load on `/expense/edit/:id`, magic-token TTL.
- **QBO writeback expansion.** `push-qbo-item` currently covers `setActive` + `bulkSyncCategories`. Brixpense `expense-request-link-bill` now posts AccountBasedExpenseLineDetail bills end-to-end. Future: name changes, account-routing changes, new-item creation. Each needs an explicit confirmation flow because of tax/reporting implications.
- **User-guide coverage growth.** Stable pages have user-guide entries. Operations / Plans / Settings entries pending until each sub-screen freezes. Brixpense user-guide entry pending.

## Business rules (preserved verbatim — these don't go stale)

### Entity split

- `entity = 'brix'` or `'AS'` = Alameda Soda / Brix Beverage (California S-corp)
- `entity = 'freeflow'` or `'FF'` = FreeFlow Beverage Solutions (Massachusetts S-corp)
- `entity = 'shared'` = split between both (officers, shared ops)

As of v0.9.24 (2026-05-11), customer-level entity is overridable in the Customers settings master, and `fn_customers_master` returns `entity_resolved` (override > derived). Entity dropdowns app-wide source from `fn_list_entities` — no more hardcoded list.

### Department-to-COGS mapping

| Department | QBO Account ID | Account Name |
|---|---|---|
| delivery | 1150040011 | B2B - Direct Labor (COGS) |
| service | 1150040012 | Service - Direct Labor (COGS) |
| reman | 1150040013 | Reman - Direct Labor (COGS) |
| ops (shared) | 1150040007 | Direct Labor |

(Legacy AP-tool mappings — Service COGS 101, Equipment Sales COGS 42 — are still in the AP approval-bill flow and are the default fallback in Brixpense's `expense-request-link-bill` when `cogs_account_id` is null.)

### Payroll split (confirmed)

- **To FreeFlow 100%:** Nadell $47K, Feliciano $44K, Eric V $55K, Benavides $52K, Anthony V $72K, Andrade $37K = $305K
- **Split 50/50:** Marco $105K, Joel $75K = $90K each side
- **To Alameda Soda (drivers):** Onate $46K, McGee $43K = $89K
- **Officers at AS:** Sky $132K, Sloan $112K (eliminated mid-2027)

### Melt store economics

- Avg equipment $247K/store at 7.7% margin
- Install labor $4K/store
- Service $12K/store/yr + PM $6K/store/yr
- 26 existing + 8 new starting June 2026 = 34 EOY 2026
- Target 58 total by EOY 2028

## Cross-repo references

- **`activespacescience/Skilliosis_Mytosis_Architecture`** — master architecture handbook. Update it when anything cross-repo changes.
- **`skypace/apbg-gateway`** (alamedapointbg.com) — parent gateway. Proxies `/billing/*`, `/margin/*`, and `/expense/*` here.
- **`skypace/melt-dashboard`** (`/melt/`) — Melt equipment portal. Reads the same Supabase project.
- **`skypace/APBG-OPS`** (`/operations/`) — PACER operational KPI dashboard. Reads the same Supabase project. Was formerly part of this repo (`public/sales/`); split out.
- **`skypace/APBG-Leasing-Rental`** — separate Railway-backed equipment leasing stack.
- **`skypace/pacerfinance`** (`pacerfinance.netlify.app`) — QBO + Zoho MCP server.
- **`skypace/Pacer-outlook`** (`pacer-outlook.netlify.app`) — Outlook MCP.

## Do not

- **Break the existing billing tool** (`public/*.html` + `netlify/functions/`). It's still used daily for vendor bill processing.
- **Break Brixpense** (`app-expense/` + `netlify/functions/expense-request-*.mjs`). Active internal workflow.
- **Expose the Supabase service_role key in client code** — anon key only. RLS protects `public.*`; `ops.*` is read-only via SECURITY DEFINER RPCs (Margin Control) or permissive RLS (Brixpense, gated on `approval_token` for anon access).
- **Hard-delete staff records** — set `status='inactive'` instead. Preserve history.
- **Modify `ops.qbo_token_cache` or `ops.sf_token_cache` directly** — the edge functions (`sync-qbo`, `push-qbo-item`) manage those via the claim/persist/release_failed RPCs. Direct writes break the lease and cause concurrent-refresh storms. The Netlify functions use a separate Netlify Blobs token store (`qbo-tokens`) — same principle, different mechanism.
- **Don't extend `push-qbo-item` to mutate item names or account-routing assignments without an explicit confirmation flow.** Those have tax/reporting implications.
- **Don't add new writers to `ops.*` tables without updating `architecture/sync-manifest.json`.** The lint will fail the build.

---

## Historical context (kept for reference)

The repo originally framed itself as "build the PACER Ops Dashboard." Most of that build agenda has shipped or been split out:

| Original priority | Status |
|---|---|
| **P1 — Upgrade to a real app** | ✓ Shipped. `app/` is the React 18 + Vite 5 + TypeScript SPA at v0.9.27. |
| **P2 — Roster CRUD** | → Moved to `APBG-OPS` (mounted at `/operations/`). Removed from BRIX nav 2026-05-10. |
| **P3 — Fix sync gaps (QBO Expenses, KPI daily rollup, FleetComplete, HR/Bambee)** | Partial. `sync-qbo` is now v35 with materialized view refresh; FleetComplete + HR moved to `APBG-OPS`. |
| **P4 — Dashboard KPIs (15 high-priority from PACER-KPI-SPEC.md)** | Split. Sales / margin / customer KPIs in BRIX; delivery / service / reman / fleet / HR / roster KPIs in `APBG-OPS`. |
| **P5 — Auth** | ✓ Shipped. Supabase Email/Password via `LoginPage.tsx`. |

The full original brief — including the 108-KPI specification, FleetComplete API notes, and BambooHR planning — lives at [`PACER-KPI-SPEC.md`](PACER-KPI-SPEC.md), [`FLEET-HR-INTEGRATION.md`](FLEET-HR-INTEGRATION.md), and [`PACER-OPS-README.md`](PACER-OPS-README.md). Useful when porting concerns to `APBG-OPS`.

---

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
| 2026-05-12 | — | **`CLAUDE.md` rewritten** from a build-task agenda to a living current-state doc. Original framing was misleading new readers (Priority 1-5 were mostly done). Historical context preserved at the bottom; git retains the previous version. |
| 2026-05-12 | brixpense v0.1.0 | **Brixpense backend shipped.** Five-surface repo now. Frontend (`app-expense/`, 7 pages, dark glass-morphism theme) was already live; this ships the backend: migration `20260512_create_expense_tables.sql` (4 tables + RLS + triggers + base seed), and four Netlify functions — `expense-request-notify` (auto-approve under threshold + magic-link email via Resend/SendGrid), `expense-request-decide` (GET token → request, POST token → record decision in `expense_approvals` with IP/UA/signature), `expense-request-link-bill` (3 modes: `create` builds vendor match + AccountBasedExpenseLineDetail and posts /bill end-to-end via `qbo-helpers`; `preview` for dry-run; `link` for legacy passive linking), and `process-inbound` (Claude Sonnet 4 OCR; same JSON contract feeds the form pre-fill). |
| 2026-05-12 | brixpense | **Migration reconciliation.** Two migrations dated 2026-05-12 both ran `CREATE TABLE IF NOT EXISTS ops.expense_requests` with conflicting shapes. The no-suffix file won the race; the `o` suffix file created an orphan `ops.expense_request_approvals` (plural) that no code reads. New `20260512p_expense_cleanup.sql` drops the orphan, finishes the seed (`cogs_accounts` with the two QBO accounts wired + seven new buckets pending IDs, `manager_emails`, `tags`), and re-aligns `departments` to the Brix entity/COGS taxonomy (delivery/service/reman/ops/freeflow/melt). `architecture/sync-manifest.json` `brix-expense:app-and-functions` writer entry corrected to reference `ops.expense_approvals` (singular). |
| 2026-05-12 | brixpense | **`architecture/BRIXPENSE.md` updated to live state.** Removed false "NOT YET CREATED" warnings on Data layer and Netlify functions sections. Documented actual function contracts. Replaced the build backlog with real remaining gaps: mobile sidebar, admin settings UI, entity→department→COGS cascade on the form, `/edit/:id` data load, magic-token TTL, QBO department reconciliation, completing the COGS account IDs. |
