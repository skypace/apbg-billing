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
| Master Control admin panel (incl. ResQ Sync controls) | `public/control.html` | `alamedapointbg.com/control` |
| QBO + Service Fusion OAuth setup | `public/setup.html` | `alamedapointbg.com/billing/setup.html` |

> **ResQ ↔ Service Fusion sync moved out (2026-06-28).** The old in-repo sync (`public/sync.html` + `resq-sf-sync*.mjs` + the 5-min cron) was decommissioned and replaced by the focused edge-function sync in **`skypace/apbg-resq-sync`** (Supabase, 15-min pg_cron, state-machine idempotency). Operators now manage it from **Master Control → ResQ Sync** (`control.html`), which calls `netlify/functions/resq-sync-control.mjs` → `ops.resq_sync_*` RPCs. Linked-customer mapping (`ops.sync_customers`) stays here (shared by both repos + `expense-to-bill`).

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
- **Backend (Netlify Functions):** ESM `.mjs` files. Bill processing, OAuth callbacks, expense requests, OCR (Claude API), QBO bill creation, ResQ-sync control proxy (`resq-sync-control.mjs`). (The ResQ↔SF sync engine itself moved to `skypace/apbg-resq-sync`.)
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
- **QBO Realm ID:** `9130352144155116` — **one shared QuickBooks company, but MULTIPLE distinct Intuit apps connect to it.** Each surface (apbg-billing, pacerfinance MCP, melt-dashboard's primary + secondary app, etc.) is its own Intuit Developer app with its **own `client_id`/app id and its own registered redirect URI**. Same realm ≠ same app. Do NOT assume a redirect URI you don't recognize is an orphan of "the" app — it likely belongs to another app pointed at this same realm. Known QBO redirect URIs in use:
  - apbg-billing (AP tool): `https://apbg-billing.netlify.app/.netlify/functions/oauth-callback` (`public/setup.html`)
  - pacerfinance QBO MCP: `https://pacerfinance.netlify.app/qbo-oauth-callback` (`pacerfinance/src/shared/oauth.ts`)
  - melt-dashboard: `oauth-callback.mjs` on `melt-dashboard.netlify.app`
  - `https://apbg-finance.netlify.app/callback` — a separate Intuit app's callback pointed at the same realm (a distinct app, not an orphaned billing redirect).
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
- **`skypace/apbg-resq-sync`** — the ResQ ↔ Service Fusion ↔ QBO sync engine (Supabase edge functions; 15-min pg_cron). Replaced the old in-repo `resq-sf-sync*` (decommissioned here 2026-06-28). Managed from this repo's Master Control → ResQ Sync.
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
- **Commit build output (`public/expense/`, `public/sales-next/`) via the GitHub MCP `github_create_or_update_file` tool with pre-encoded base64.** The MCP base64-encodes whatever you pass — if you hand it pre-encoded base64, it gets double-encoded and stored as literal text on disk. Netlify then serves base64 text instead of HTML/JS and the SPA never loads. Either (a) run `npm run build --prefix app-expense` locally and commit via normal `git add/commit`, or (b) if you must use the MCP, pass the raw decoded content as a UTF-8 string. PR #61 was a full-day debug of this exact mistake.
- **Default-schema bug in Supabase Edge Functions.** `createClient(url, key)` defaults the JS data client to schema `public`. All our tables live in `ops`. If you write an edge function that does `sb.from('qbo_invoices').insert(...)`, the insert silently no-ops (PostgREST returns an error, supabase-js doesn't throw). Always pass `{ db: { schema: 'ops' } }` to `createClient`, or use `.schema('ops').from(...)` per query. RPC calls (`.rpc(...)`) are name-based and not affected by this.

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
| 2026-06-02 | sync v2 P3 | **On-demand single-job ResQ↔SF sync.** `resq-sf-sync-background.mjs` exports `syncSingleByCode(resqCode)` (same create/dedup + status/invoice logic as the cron, for one WO). New `sf-webhook.mjs` (secret-gated, `{resq_code}`/`{sf_job_id}` — internal/manual trigger; **not** Zapier — SF has no native webhook). Authed `resq-sf-sync?syncOne=<code>` + dashboard "⚡ Sync this WO now" button. Cron unchanged as the safety-net reconciler. (PR #127) |
| 2026-06-02 | sync customers | **Customer matching moved to SF-record linking by id.** `ops.sync_customers` gains `sf_customer_id`; Master Control → Linked Customers (`control.html`) gets a live SF customer **search** (`sync-customers?sfSearch=`) that links a row to the real SF record + a manual "SF #" field. `resolveSfCustomerName` resolves a linked id by matching it inside the SF list-search (the by-id GET endpoint is unreliable). Hardcoded the two live names as a backstop: **`THE MELT RESQ`**, **`STARBIRD CHICKEN: RESQ`** (note the colon the seeded row had dropped — root cause of the Melt/Starbird "matched no SF customer" outage). Unlinked the `BRIX WAREHOUSE EQUIPMENT` row whose broad `brix` keyword (sorts first) was hijacking matches. SF job creation uses `customer_name` (SF rejects `customer_id`, 422). (PRs #128, #130, #131, #132, #133) |
| 2026-06-03 | sync v2 P4 | **SF job photos auto-push to ResQ.** New `lib/sf-assets.mjs`: lists a SF job's pictures, fetches bytes host-aware (public S3 anon / `api`→Bearer / `admin`→Cookie via the `orders.sf_portal_session` cookie that Make refreshes), and **relays each through the new public Storage bucket `resq-photo-relay`** (short filename) because ResQ stores the image ref in a `varchar(100)` — inline base64 data-URLs overflow it. Pushed as after-images to the WO's ResQ **visit** (`addAfterImagesToVisit`); starts a visit via the WO appointment when none exists. Wired into the sync lifecycle in the existing `needsPhotoTransfer` slot — **after** visit-complete, **before** invoice-submit. Manual photo UI removed from `sync.html` (button + upload modal + Photos column). (PRs #134–#139) |
| 2026-06-03 | SF→Brixpense | **SF expense + QBO bill lands in Brixpense.** `expense-to-bill` (the sync.html 💰 Bill action), after creating the QBO bill, inserts an `ops.expense_requests` row (`request_type=expense`, `status=posted`, `as_bill`, `tag='Service Fusion'`, `qbo_bill_id`, `job_number`, vendor, amount, `line_items`, customer; `submitted_by`=the operator). Non-fatal — never undoes the bill. New separate **🔒 Close** button (per WO row) sets the SF job to **`Invoiced`** (`resq-sf-sync?closeJob=`) — the close-out step once the 3rd-party bill is entered, which then triggers the existing ResQ invoice submission. SF workflow: *Completed - Service* (→ ResQ visit + photos) → 💰 Bill (→ QBO bill + Brixpense landing) → 🔒 Close (→ Invoiced → ResQ invoice). Payment features on `expense_requests` (`payment_account_*`) are the next step. (PRs #140, #141) |
| 2026-06-03 | infra | **`SUPABASE_SERVICE_ROLE_KEY` now used by apbg-billing functions** (previously anon-only): reads the `orders.sf_portal_session` cookie, uploads to the `resq-photo-relay` public bucket, and writes the Brixpense expense-landing row. New public Storage bucket **`resq-photo-relay`**. ResQ is no longer read-only — we now write back via GraphQL mutations (`startVisit`, `addAfterImagesToVisit`). |
| 2026-06-28 | control panel | **Linked Customers restored + per-app Service/Maintenance UI.** Re-added the **Linked Customers** section to `control.html` — the live ResQ sync (`apbg-resq-sync` `_shared/customers.ts`) DEPENDS on `ops.sync_customers` (a WO whose facility matches no linked customer is skipped, no SF job), so the add/manage UI is needed to onboard new facilities. New **Service & Maintenance** section: per-app **banner** or full **lockout** with a service note, written via the gateway `POST /api/maintenance` (superadmin) and rendered in every app by `appswitcher.js`. (Net: this reverses the same-day removal of these two sections — Maintenance is now per-app + lockout instead of a single global flag.) |
| 2026-06-28 | control panel | **Master Control trimmed + APBG app switcher embedded.** Removed the Maintenance Mode and Linked Customers sections from `public/control.html` (the `site-settings` + `sync-customers` functions and `ops.sync_customers` data are untouched — `ops.sync_customers` is still read by the live ResQ sync + `expense-to-bill`; edit it via SQL if a facility needs relinking). Embedded the gateway's `appswitcher.js` (top-right waffle + shared light/dark toggle keyed on `localStorage.apbg_theme`) into `control.html`, `dashboard.html`, `setup.html`, `index.html`, and the two Vite app templates (`app/index.html`, `app-expense/index.html`). Full light/dark theming of these surfaces (control.html is dark-only today) is a follow-up. |
| 2026-07-04 | proposal builder | **Brandox retired → Supabase brand library.** Brandox is a Meteor DDP single-page app (empty HTML shell, assets delivered over a WebSocket after JS runs) — it can't be read server-side, which is why the scrape only ever returned the local logo fallbacks. Cut it entirely: deleted `proposal-brandox.mjs`, added new public Storage bucket **`brand-assets`** + `netlify/functions/proposal-brand-assets.mjs` (GET lists the bucket, POST uploads base64, DELETE removes; service-key backed, roles superadmin/admin/sales). The Proposal Builder's "Brandox Assets" panel became **"Brand Library"** with in-app upload (type-tagged: logo/can/equipment/hero/testimonial/sell-sheet/other) + delete; the 4 built-in Brix/Alameda logos still merge in as a never-empty fallback. Client: `getBrandAssets` repointed to the new endpoint, added `uploadBrandAsset`/`deleteBrandAsset`/`fileToBase64` (env override `VITE_BRAND_ASSETS_URL`, was `VITE_BRANDOX_PROXY_URL`). **`BRANDOX_*` env vars are now dead and the subscription can be cancelled.** |
| 2026-07-04 | proposal builder | **Refractor Proposal Builder — product images, Brandox scrape, venue templates.** (1) `proposal-products.mjs` now joins `ops.qbo_items` → `orders.catalog` by `qbo_item_id` and serves the catalog's real public image URLs (`image_url`/`image_thumb_url`/`bib_image_url` in the `brix-catalog-images` bucket) instead of guessing non-existent buckets off `contract_items.image_key` — the "bad connection" that left product images blank (37 beverage rows now resolve). Added `brix-catalog-images`/`brix-order-files` to the bucket fallback lists. (2) `proposal-brandox.mjs` extraction broadened well beyond `src`/`href` image-extension matches: `data-*` lazy attrs, `srcset`, `poster`, `og:image`, CSS `background-image`, embedded hydration JSON (`<script>`/`__NEXT_DATA__`), extension-less DAM/CDN URLs (host/path hinting), a wider JSON key set, and more DAM API candidate endpoints — so a JS-rendered Brandox portal yields its full library, not just the 4 local logo fallbacks. **Brandox still requires `BRANDOX_WORKSPACE_URL` (+ optional `BRANDOX_EMAIL`/`BRANDOX_PASSWORD` for private portals, or `BRANDOX_ASSET_URLS` for a manual list) set on Netlify to pull anything beyond the local brand art.** (3) New venue templates (Restaurants, Corporate Cafes, Bars, Fast Casual, Grocery) in `proposalBuilder.ts` (`PROPOSAL_TEMPLATES` + `selectTemplateProducts`) with a "Start from a Template" gallery on `ProposalBuilderPage.tsx` that pre-fills business type, lease terms, service plan, and a suggested beverage lineup. |
| 2026-07-09 | qbo writeback | **`qbo-customer-lookup` edge function shipped (v1 lookup → v2 +deactivate same day).** Live QBO Customer query by exact display name for brix-order's onboarding queue — `ops.qbo_customers` only refreshes daily (sync-qbo), which left "Finish onboarding" greyed up to ~24h after a new customer's first $0 setup invoice posted. On a hit the function upserts the customer into `ops.qbo_customers` (same conflict key as sync-qbo) so the mirror self-heals. Same INTERNAL_PAY_SECRET + token-lease pattern; verify_jwt=false. v2 adds `action: 'deactivate'` (SyncToken fetch → sparse `Active=false` → mirror flip) for brix-order's account-closure final step — QBO-side customer inactivation; the SF side has no API archived flag and is handled by a close-out ticket in brix-order. |
| 2026-07-09 | qbo writeback | **`qbo-return-order` edge function shipped (v1).** Books a customer RETURN ORDER as a QBO Credit Memo for brix-order's account-closure refund flow — SF's jobs API hard-rejects negative amounts (multiplier min 1, rate min 0, verified live), so the negative order lives in QBO. Same INTERNAL_PAY_SECRET + qbo_token lease pattern as `qbo-charge`; read-only `preview` mode; on create, instant-mirrors the credit memo into `ops.qbo_invoices` (txn_type='CreditMemo', same conflict keys as sync-qbo, which already mirrors credit memos). Caller passes catalog `qbo_item_id` lines. Deployed to the shared Supabase project (v1), verify_jwt=false. |
| 2026-07-09 | qbo writeback | **`qbo-returned-payment` edge function shipped (v1 void → v2 expense-swap same day).** Books a returned/bounced customer payment for brix-order's admin "Record returned payment" action using QBO's official bounced-payment bookkeeping: creates an Expense (Check) to the customer against A/R on the deposit bank account (the bank-feed match for Intuit's clawback), re-links the original Payment from the invoice to that expense (deposit stays reconciled, invoice reopens), and creates the $35 "Returned Payment Fee" invoice (item/account find-or-created). v1's plain void was replaced because it orphans both real bank events. Same INTERNAL_PAY_SECRET + qbo_token lease pattern as `qbo-charge`; read-only `preview` resolves the bank + A/R accounts; refuses (needs_manual) when the payment spans multiple invoices or the deposit bank can't be resolved. Deployed to the shared Supabase project (v2), verify_jwt=false. |
| 2026-06-28 | resq-sync decommission | **Legacy ResQ↔SF sync removed from this repo.** Deleted `public/sync.html` + 8 functions/libs (`resq-sf-sync`, `-background`, `-cron`, `resq-sf-links`, `sf-webhook`, `lib/resq-sf-links`, `lib/resq-job-notify`) and the 5-min `resq-sf-sync-cron` from `netlify.toml`. Replaced by the edge-function sync in **`skypace/apbg-resq-sync`** (already live). New **Master Control → ResQ Sync** panel (`control.html`) with two switches (Write mode, Sync enabled) + controls (drive a WO, run a tick, live status), backed by new `netlify/functions/resq-sync-control.mjs` → `ops.resq_sync_set_write/_set_active/_status` RPCs. Kept (still used elsewhere): `sf-helpers`, `sync-customers` + `ops.sync_customers` (now shared with apbg-resq-sync), `sf-oauth-callback`, `lib/sf-assets` (Brixpense receipts via `lib/sf-expense`), `resq-helpers` (health-watchdog), the Brixpense `sf-receipt-*`/`sf-expense-sweep` Phase-3 expense landing. Manifest: `resq-sf-sync` writer removed; `ops.resq_sf_links` + `ops.sync_events` moved to orphans (retained read-only). |
