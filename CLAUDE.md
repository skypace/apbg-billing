> **Architecture handbook:** This repo is part of a multi-repo system documented in [`activespacescience/Skilliosis_Mytosis_Architecture`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md). When work in this repo touches architecture (new external service, new cross-repo dependency, new deploy target, new MCP/connector, new env-var category, new/renamed/archived repo, new gateway proxy route), update `ARCHITECTURE.md` in the same change via the GitHub MCP (`asm-mcp-tools.netlify.app/github`, tool `github_create_or_update_file`). Brand-new projects should be planned in that repo's `projects/<project-name>/` folder before any code is written here.

---

# apbg-billing — Claude orientation

## TL;DR

This repo hosts **five surfaces** that share one Netlify deploy at `apbg-billing.netlify.app`, all fronted through the parent gateway at `alamedapointbg.com`:

1. **3rd-Party Billing** — the original AI vendor-bill processing tool (AP)
2. **BRIX Margin Control** — React/Vite SPA for sales / margin / customer analytics (`app/`, builds to `public/sales-next/`, surfaced at `/margin/` on the gateway)
3. **Brixpense** — React/Vite SPA for internal expense + purchase requests; expenses auto-approve, PRs route to an approver (chosen by the submitter) who logs in to the same Supabase auth and approves in-app (`app-expense/`, builds to `public/expense/`, surfaced at `/expense/`)
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

1. **[`README.md`](README.md)** — repo map.
2. **[`architecture/MARGIN-CONTROL.md`](architecture/MARGIN-CONTROL.md)** — Margin Control architecture.
3. **[`architecture/BRIXPENSE.md`](architecture/BRIXPENSE.md)** — Brixpense architecture.
4. **[`architecture/README.md`](architecture/README.md)** — sync orchestration manifest.
5. **[`docs/margin-control/user-guide.md`](docs/margin-control/user-guide.md)** — end-user guide for BRIX.
6. **[`activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md)** — master cross-repo handbook.

## Tech stack at a glance

- **AP tool:** Vanilla HTML + JS in `public/`, served as-is by Netlify.
- **BRIX Margin Control:** React 18 + Vite 5 + TypeScript 5 + MUI v6 + MUI X v7 Pro.
- **Brixpense:** React 18 + Vite 5 + TypeScript 5 + Radix UI + shadcn-style wrappers + Tailwind 3 (dark navy glass-morphism theme).
- **Backend (Netlify Functions):** ESM `.mjs` files. Bill processing, ResQ-SF sync, OAuth callbacks, expense requests, OCR (Claude API), QBO bill creation.
- **Backend (Supabase Edge Functions):** Deno runtime. `sync-qbo` and `push-qbo-item`.
- **Data:** Supabase `ops.*` schema. Brixpense uses `ops.expense_requests/_attachments/_approvals/_settings`.

## Build pipeline (`netlify.toml`)

```
git push main
  └─▶ Netlify build
       1. node architecture/lint-manifest.mjs       ← sync-manifest gate
       2. mkdir -p public/docs && cp -r docs/. public/docs/
       3. npm install --prefix app                  ← Margin Control deps
       4. npm run build --prefix app                ← tsc -b && vite build
       5. npm install --prefix app-expense          ← Brixpense deps
       6. npm run build --prefix app-expense        ← tsc + vite build
       Publishes public/ as static + netlify/functions/ as Lambdas
```

## Brixpense approval model (live)

Final design after two passes:

| Request type | Flow |
|---|---|
| `expense` | Auto-approved on submit. No email. No approval workflow. Recorded in `expense_approvals` as `decided_by='system (auto-approve)'`. |
| `purchase_request` | Submitter picks an approver from `expense_settings.manager_emails` (required). `expense-request-notify` validates the choice, flips status to `pending`, and sends a notification email pointing at `/expense/queue`. The approver logs into Supabase (same auth as alamedapointbg) and approves in-app at `/expense/review/:id`. `expense-request-decide` requires Bearer JWT, checks caller != submitter and `lower(caller.email) == lower(manager_email)`. RLS enforces the same. |

No magic-link tokens. No anonymous approval path. The email is a notification, not an authorization.

## Credentials

- **Supabase URL:** `https://gfsdpwiqzshhexkofiif.supabase.co`
- **Supabase anon key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY`
- **Schema:** `ops` (use `Accept-Profile: ops` header or Supabase client `{ db: { schema: 'ops' } }`)
- **QBO Realm ID:** `9130352144155116` (APBG_Billing Intuit app)
- **MUI X Pro license:** required at build time via `VITE_MUI_X_LICENSE` env var on Netlify.
- **Anthropic API key:** required for receipt OCR (`process-inbound`). Env var `ANTHROPIC_API_KEY`.
- **Email provider:** `RESEND_API_KEY` or `SENDGRID_API_KEY` (Brixpense notification emails only).
- **Netlify site:** linked to this repo, auto-deploys on push to `main`. Publish dir: `public/`.

## What's actively being worked on

As of 2026-05-12:

- **BRIX Margin Control polish + features.** Sub-screens maturing: Customers master, Items master, Categories, P&L Alignment editor, Sales Reps.
- **Brixpense post-launch polish.** Approval model finalized: expense=auto, PR=in-app authed approval. Active gaps: mobile sidebar, admin settings UI for `ops.expense_settings`, entity → department → COGS cascade on the form, edit-flow data load on `/expense/edit/:id`.
- **QBO writeback expansion.** `push-qbo-item` + Brixpense `expense-request-link-bill` cover Item.Active, Category ParentRef, and AccountBasedExpenseLineDetail bill creation.

## Business rules (preserved verbatim)

### Entity split

- `entity = 'brix'` or `'AS'` = Alameda Soda / Brix Beverage (CA S-corp)
- `entity = 'freeflow'` or `'FF'` = FreeFlow Beverage Solutions (MA S-corp)
- `entity = 'shared'` = split between both

### Department-to-COGS mapping

| Department | QBO Account ID | Account Name |
|---|---|---|
| delivery | 1150040011 | B2B - Direct Labor (COGS) |
| service | 1150040012 | Service - Direct Labor (COGS) |
| reman | 1150040013 | Reman - Direct Labor (COGS) |
| ops (shared) | 1150040007 | Direct Labor |

Legacy AP-tool mappings (Service COGS 101, Equipment Sales COGS 42) are the default fallback in Brixpense's `expense-request-link-bill` when `cogs_account_id` is null.

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

- **`activespacescience/Skilliosis_Mytosis_Architecture`** — master architecture handbook.
- **`skypace/apbg-gateway`** (alamedapointbg.com) — parent gateway. Proxies `/billing/*`, `/margin/*`, and `/expense/*` here.
- **`skypace/melt-dashboard`** (`/melt/`) — Melt equipment portal.
- **`skypace/APBG-OPS`** (`/operations/`) — PACER operational KPI dashboard.
- **`skypace/APBG-Leasing-Rental`** — separate Railway-backed equipment leasing stack.
- **`skypace/pacerfinance`** (`pacerfinance.netlify.app`) — QBO + Zoho MCP server.
- **`skypace/Pacer-outlook`** (`pacer-outlook.netlify.app`) — Outlook MCP.

## Do not

- **Break the existing billing tool** (`public/*.html` + `netlify/functions/`). Daily-driver for AP.
- **Break Brixpense** (`app-expense/` + `netlify/functions/expense-request-*.mjs`).
- **Expose the Supabase service_role key in client code** — anon key only.
- **Hard-delete staff records** — set `status='inactive'` instead.
- **Modify `ops.qbo_token_cache` or `ops.sf_token_cache` directly** — use the lease RPCs / Netlify Blobs.
- **Add new writers to `ops.*` tables without updating `architecture/sync-manifest.json`.** The lint will fail the build.

---

## Historical context (kept for reference)

Originally framed as "build the PACER Ops Dashboard." Most of that agenda shipped or split out:

| Original priority | Status |
|---|---|
| **P1 — Upgrade to a real app** | ✓ Shipped. `app/` is the v0.9.27 SPA. |
| **P2 — Roster CRUD** | → Moved to `APBG-OPS`. |
| **P3 — Sync gaps** | Partial. `sync-qbo` v35 + materialized view refresh; FleetComplete + HR moved to APBG-OPS. |
| **P4 — Dashboard KPIs** | Split between BRIX and APBG-OPS. |
| **P5 — Auth** | ✓ Shipped. Supabase Email/Password. |

Full original brief: [`PACER-KPI-SPEC.md`](PACER-KPI-SPEC.md), [`FLEET-HR-INTEGRATION.md`](FLEET-HR-INTEGRATION.md), [`PACER-OPS-README.md`](PACER-OPS-README.md).

---

## Change log

| Date | Version | Change |
|---|---|---|
| 2026-05-11 | v0.9.22 | Items active/managed toggles, customers parent/sub + address, Margin hero-stamp polish. |
| 2026-05-11 | v0.9.23 | **P&L alignment audit shipped.** `fn_item_pl_audit` + `fn_apply_pl_category_suggestions`. Items master gets a P&L Alignment column + bulk auto-categorize. |
| 2026-05-11 | v0.9.24 | **Per-customer entity + FIRST QBO WRITEBACK PATH.** New `push-qbo-item` edge function. |
| 2026-05-11 | v0.9.25 | **Category writeback.** `push-qbo-item v2` adds `bulkSyncCategories`. |
| 2026-05-11 | — | **Docs + arch shipped.** Focused architecture doc, user guide, sidebar link. |
| 2026-05-11 | — | **TS build fix in `app/src/pages/settings/ItemsSettingsEditor.tsx`.** Index signature for MUI X DataGrid Pro v7. |
| 2026-05-12 | v0.9.26 | **Data hygiene + chain rollups preview.** `fn_item_hygiene_summary` + `fn_preview_rollup_match`. |
| 2026-05-12 | v0.9.27 | **Runtime fuzzy match for Chain Rollups.** `expandModifierFilters`. |
| 2026-05-12 | — | **`CLAUDE.md` rewritten** to a living current-state doc. |
| 2026-05-12 | brixpense v0.1.0 | **Brixpense backend shipped.** Migration `20260512_create_expense_tables.sql` (4 tables + RLS + triggers + base seed). Four Netlify functions: `expense-request-notify`, `expense-request-decide`, `expense-request-link-bill`, `process-inbound`. |
| 2026-05-12 | brixpense | **Migration reconciliation (20260512o + 20260512p).** Dropped orphan plural-named approvals table; finished `expense_settings` seed (cogs_accounts, manager_emails, tags); re-aligned departments to entity/COGS taxonomy. `sync-manifest.json` corrected to reference `ops.expense_approvals` (singular). |
| 2026-05-12 | brixpense | **`expense-request-link-bill` now creates QBO bill end-to-end.** Modes: `create` (default, vendor match + POST /bill), `preview` (dry-run), `link` (legacy passive). Falls back to Service COGS (101). |
| 2026-05-12 | brixpense | **Approval model finalized — in-app auth, no magic-link.** Sequence: migration `20260512q` (in-app), `20260512r` (reverted to magic-link), `20260512s` (final: drop anon RLS, install self/manager UPDATE pair, deprecate `approval_token`). Net effect: anon RLS gone, two UPDATE policies (self + manager-by-email). Final flow — expense auto-approves on submit; PR sends a notification email (via Resend/SendGrid) to the chosen approver from `manager_emails` and points at `/expense/queue`. Approver authenticates via Supabase, approves at `/expense/review/:id`. `expense-request-notify` validates the approver against the allowlist. `expense-request-decide` is Bearer-only; takes `{ requestId, action, notes?, signatureUrl? }`; guards self-approval + email match. Frontend route swap: `/approve/:token` (public) removed; `/review/:id` (auth-gated) added. ManagerQueue links to `/review/:id`. ApprovalPage rewired to use `:id` + session + Bearer. |
