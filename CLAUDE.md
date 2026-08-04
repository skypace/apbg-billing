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
6. **APBG Master Handbook** — company-wide user guide (every app) + Operations SOP Manual. Chapters in `docs/handbook/*.md` + `manifest.json` (chapter registry: owners, `last_reviewed`, source docs), viewer at `public/docs/handbook/index.html` (served at `/docs/handbook/`, via gateway `/margin/docs/handbook/`). Freshness: Master Control → APBG Handbook → **Run sweep** (`netlify/functions/handbook-sweep.mjs`, superadmin; compares source-file commit dates vs `last_reviewed`, needs `GITHUB_TOKEN` env for the private repos).

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

## Service Fusion OAuth (READ before touching any SF connect flow)

There are **three separate Service Fusion Connected Apps** against the one SF account, each with its own `client_id`, its own registered redirect URI, and its own token row. Mixing them up is how you get `invalid redirect URL` (authorize step) or `invalid_client` (token-exchange step). This map cost a multi-hour scavenger hunt on 2026-07-24 because it was written nowhere — do not delete it.

| App | client_id | Registered redirect URI | Token row | Used by |
|---|---|---|---|---|
| **Billing / Brixpense** | `TNpu3bVz9XAIgey_7e` | `https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sf-oauth-callback` (Supabase edge fn) | `ops.sf_token_cache` (id=1) | `sync-sf` (job mirror), `sf-receipt-sync` (Brixpense expenses), apbg-billing SF reads |
| **ResQ sync** | `PP8LobxMYi-SZFhI1t` (`ops.resq_sync_config.sf_app_client_id`) | `https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sf-connect` | `ops.resq_sf_token_cache` | `skypace/apbg-resq-sync` only |
| **OLD ResQ updater (dead)** | `f8cqiTHnjoFS-QMeuc` ("MEUC") | (legacy Netlify redirect) | — | nothing — retired |

**Re-authing the billing app** (the one Brixpense expenses depend on): sign into SF in a browser, then open
`https://api.servicefusion.com/oauth/authorize?response_type=code&client_id=TNpu3bVz9XAIgey_7e&redirect_uri=https%3A%2F%2Fgfsdpwiqzshhexkofiif.supabase.co%2Ffunctions%2Fv1%2Fsf-oauth-callback`
→ approve → the Supabase `sf-oauth-callback` exchanges the code (using Supabase env `SF_CLIENT_ID` + `SF_CLIENT_SECRET`, which **must match `TNpu3bVz9XAIgey_7e`**) and writes tokens to `ops.sf_token_cache`. `setup.html` + `control.html` reconnect buttons now point here (were wrongly hardcoded to the dead MEUC id + Netlify redirect until 2026-07-24).

**Gotchas:**
- `invalid redirect URL` = the redirect in your authorize link isn't registered on that app. `invalid_client` = the **Supabase env** `SF_CLIENT_ID`/`SF_CLIENT_SECRET` don't match the app whose code you're exchanging.
- **QBO app-sharing trap (2026-07-24):** Intuit invalidates prior refresh tokens when the same app+realm gets re-authorized. pacerfinance's QBO was aligned to the billing Netlify app (`ABCV3BJb…`) on 7/15 — so re-authorizing either surface kills the other's refresh token. This is the likely cause of the serial QBO token deaths. Until pacerfinance gets its OWN Intuit app, expect its QBO token to die whenever the billing app is reconnected (and vice versa); the `qbo_netlify_chain` health check + break-glass fallback in `qbo-helpers.mjs` limit the blast to an email instead of an outage. **Master Control → Connections & Reconnect** (`control.html` + `netlify/functions/connections.mjs`) lists every SF/QBO app with its client id, its own health light, and the correct authorize link — use it instead of hunting for reconnect URLs.
- SF access tokens last ~1h; the refresh token auto-rotates on each refresh. Token refresh is lease-guarded (`fn_sf_token_claim_refresh`) so concurrent functions don't race-rotate it.
- SF rate-limits aggressively (429). SF-hitting crons are deliberately throttled: `sf-job-sync` daily 09:00 UTC, `sf-receipt-sync-fresh` 3×/day (03:00/15:00/21:00 UTC). Don't add high-frequency SF pollers or parallel SF scans — that's what caused the 2026-06/07 expense-sync 429 outage.
- **`sf-receipt-sync-crawl` is DISABLED (2026-08-04)** — `cron.job.active=false`, not deleted. Its only job was the historical catch-up after the epoch-gate outage, and that is finished. Left running it would keep dredging up pre-outage expenses that were already keyed into QBO by hand, which is a duplicate-bill generator, not a safety net. Re-enable only for a deliberate, supervised backfill (`select cron.alter_job(jobid, active := true) from cron.job where jobname='sf-receipt-sync-crawl'`) and check `ops.fn_sf_expense_duplicates()` before the next autopost.
- **The expense pipeline is event-driven now.** Invoiced-status email → `pullJobExpenses` → `sf-receipt-sync?landJob=` lands the receipt in seconds. `sf-receipt-sync-fresh` stays as the backstop for the one case the hook cannot see: **an expense added to a job that is ALREADY invoiced** (no status change → no email → no hook), plus any email that gets filtered or a status template that quietly stops firing.
- The pacerfinance MCP (`pacerfinance.netlify.app/servicefusion`) is a **separate** SF integration; its token is not `ops.sf_token_cache`. Under 429 pressure its `sf_get_job` silently drops the `expenses` array (returns the job with no expenses) — don't trust it for bulk expense reads.
- **SF returns the UNIX EPOCH, not null, for empty date fields (2026-08-04).** An SF expense that has never been EDITED comes back with `updated_at: "1970-01-01T00:00:00+00:00"`, and `date` is epoch unless a human typed one. `sf-receipt-sync`'s date gate read `ex.updated_at || ex.created_at`, so epoch won the `||`, tested as 1970 < `SF_SWEEP_START_DATE`, and **every never-edited expense was silently skipped for two months** — 10 landed since the 2026-06-03 cutoff, every sweep reported `drafts: 0`, and nothing went red. Never trust an SF date field without an epoch guard (`realDateMs()` / `newestRealDate()`).
- **ALWAYS pass an explicit `sort` on SF `GET /jobs`.** Without one SF falls into a query plan that hangs 20s–2min+ on our ~22k-row jobs table (brix-order learned this in its session 1.18; `sf-receipt-sync`'s pageCount probe re-learned it the hard way — it was eating ~100s of the 150s edge wall by itself and killing the sweep before it could log). Also: the page-size param is **`per-page`** (hyphen). SF silently ignores `per_page` and uses its default page size.
- **Supabase edge functions are hard-killed at 150s with no chance to log.** Any budgeted loop must start its clock before the FIRST network call, check the deadline per unit of work (not per batch), and cap individual fetches with `AbortSignal.timeout`. A run killed mid-flight writes nothing to `ops.sync_log`, and any cursor that resumes from "the last success row" then never advances — that is how the daily receipt crawl sat dead for 9 days while its cron fired normally.
- **~97% of SF "expenses" are blank rows** (no vendor, amount, notes, or category) — SF creates them on ordinary delivery jobs. `isEmptyExpense()` drops them. A blank vendor WITH an amount still lands.
- **If you add a filter to `landJob`, add a counter next to it.** Every sweep logs `expensesSeen / skippedEmpty / skippedByDate / drafts / alreadyLanded / elapsedMs`, and `ops.fn_sf_receipt_coverage()` goes RED when informative expenses are seen but none land. `drafts: 0` alone is what let the epoch bug hide — it reads the same whether SF had nothing new or the gate was discarding everything.
- **Invoiced-status emails to `sf-status@alamedapointbg.com` pull that job's expenses immediately** (`vendor-email-intake.mjs` → `pullJobExpenses` → `sf-receipt-sync?landJob=`). SF has no webhooks; its notification email IS the event. The crons are the safety net for jobs whose email never arrives, not the primary path.
- **Expense-sync scope is `status=Invoiced` jobs only** (`sf-receipt-sync`). An SF expense on a job that never reaches Invoiced never lands in Brixpense — the ops workflow must close jobs out to Invoiced (the ResQ 🔒 Close flow does). Fixing a blank `purchased_from` in SF after a draft landed creates a NEW draft (the dedup key includes the vendor) — the old blank draft stays behind as an orphan; archive it from the SF Expenses tab.
- **SF expense rows are staff-only + archivable (2026-07-24).** RLS `expense_requests_select_sf` requires `ops.fn_is_staff()` (gateway `user_metadata.role` superadmin/admin) — the old policy leaked internal vendors/amounts to every authenticated login on the shared project (brix-order customers, boelter, thehubdesign). Archive = `archived_at`/`archived_by` soft-hide (row + `sf_expense_id` dedup kept so the sync can't re-land it); autopost auto-archives pre-cutoff (`SF_AUTOPOST_MIN_RECEIPT_DATE`) historical drafts on each daily run — QBO is the source of truth for those, edit them there. QBO-error rows retry automatically on every daily run (the `autopost_notified_at` stamp only dedups the alert email, not the retry).

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
- **Add a new credential/token store without a health check.** Three silent multi-week outages (SF token 6/29→7/24, Netlify-blob QBO token ~6/10→7/24) happened because each integration minted its own token store and none got monitored — the credential that died was never the one being watched. Any new token/session/credential store MUST ship, in the same change, with a check in `ops.fn_sync_health_extra()` (part of `ops.sync_health()`, which the 15-min `health-alert` pg_cron emails on red/yellow). Currently watched: qbo_token, sf_token, resq_sf_token, sf_portal_cookie + the pipeline checks (receipt sync, autopost, jobs sync, employees cache). NOT watchable from this DB: pacerfinance / melt-dashboard / Pacer-outlook tokens (live in those sites' own stores — need an HTTP probe if ever monitored).
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
| 2026-08-04 | brixpense sync repair | **SF→Brixpense expense sync was dropping almost everything; fixed, instrumented, and made event-driven.** Reported as "job 1093536433 didn't kick its expense". Root cause: SF returns the **UNIX epoch** (not null) in `updated_at` for a never-edited expense, so the sweep's `ex.updated_at || ex.created_at` date gate tested 1970 < cutoff and **silently skipped every never-edited expense** — 10 landed in two months, every run logged `drafts: 0`, nothing alerted. Its sibling job 1093537348 landed only because someone had edited that expense. Deploying the fix exposed three more: (1) the `pageCount` probe called `GET /jobs` with **no explicit sort**, hanging ~100s of the 150s edge wall (the brix-order 1.18 rule) — and `t0` started after it, so the budget never saw it; the daily crawl was killed before logging for 9 days and its cursor never advanced. Probe deleted; `sort=-id` + hyphenated `per-page=50` make page 1 the newest and an empty page the end of history. (2) Nothing bounded a single job or fetch — added a per-EXPENSE deadline + `AbortSignal` caps; budget 110s→60s. (3) **216 of 222 SF "expenses" are blank rows** — `isEmptyExpense()` drops them (14 that landed were archived). **Prevention:** every run now logs `expensesSeen/skippedEmpty/skippedByDate/drafts/alreadyLanded/elapsedMs`, new `ops.fn_sf_receipt_coverage()` (migration `20260804a`, applied live, wired into `ops.sync_health()`) goes RED when informative expenses are seen but none land, and **`sf-status@` invoiced emails now trigger `sf-receipt-sync?landJob=<id>` directly** (`vendor-email-intake.mjs`) so an expense lands when the job is invoiced instead of when a cron reaches it. New `?landJob=<sfJobId>` repair endpoint (the old `?job=` scan 504'd). Edge fn v18→v21. |
| 2026-07-26 | compliance drag-drop | **Drag-and-drop filing on Compliance & Safety + first co-packer documents filed.** Drop files anywhere on the tab → a pre-filled New Document form per file (multi-file drops queue, "N more queued"); drop a file **onto a grid row** → uploads and attaches to that document in one gesture (row resolved from MUI's `data-id`, hovered row highlights). The edit modal's file picker is now a drop zone too, with a **Download** button for the attached file; the grid File column is a download link, or "drop a file to attach" when empty. New `guessFromFilename()` in `lib/compliance.ts` infers category + doc type from the filename (audit report / cert / corrective actions / permit / COI / W-9 / resale / CERS-CUPA / FDA…) so a dropped file lands ~80% filled in. Data: the seeded co-packer party was corrected to its real legal identity **Quantum J's Canning LLC** (3540 State Hwy 52 Unit A2, Frederick CO; audit lists the site as Erie CO) and its documents filed — PJRFSI GMP certificate **C2025-06124** (eff 2025-10-30, exp 2026-10-29, 21 CFR 117 subpart B, scope "manufacturing and canning of beverages"), full 46-page GMP audit report **A2025-13406** (2025-09-18, zero major/critical NCRs, ~15 minors all closed 2025-10-24; its `expiration_date` is the ANNUAL RE-AUDIT DUE DATE), the F212 corrective-action log, CDPHE manufacturing registration **MFE24913 (EXPIRED 2026-06-30 — renewal needed before the Compass upload)**, and FDA registration **10289932698** (exp 2026-12-31, document not yet supplied). |
| 2026-07-26 | copack retired | **Co-Pack (Legacy) tab removed from Production** (operator decision — superseded by the formula-driven work-order pipeline since 2026-07-21). Deleted `CopackOrdersTab.tsx`, `CopackOrderWorksheetPanel.tsx`, `formulaReadiness.ts`, `FormulaReadinessPanel.tsx` (last two were copack-only) + the copack types/CRUD in `lib/production.ts`. **Data untouched**: `ops.copack_orders`/`_costs` + the `fn_*_copack_order` RPCs stay live, moved to manifest orphans (read-only historical cost data; drop in a future cleanup). |
| 2026-07-26 | compliance vault | **Compliance & Safety document vault (Phase 1).** New Refractor tab **Production → Compliance & Safety** (`app/src/pages/production/ComplianceTab.tsx` + `lib/compliance.ts`): tracks the company's own compliance paper (insurance COIs, health permits, CERS/CUPA, FDA registrations, food-safety audit reports) AND third parties' documents we must keep current (co-packer GMP audits, contractor COIs) — born out of the Compass Group/Foodbuy supplier-QA onboarding. New tables `ops.compliance_documents` + `ops.insured_parties` (migration `20260726a`, applied live; staff-only RLS via `ops.fn_is_staff()` in both directions — shared-project logins must not read insurance limits/audit corrective actions) + private staff-gated Storage bucket **`compliance-docs`**. Expiration status (expired / expiring ≤60d / current) is computed where displayed, nothing stored. Weekly cron `compliance-expiry-cron.mjs` (Mondays 15:30 UTC) emails an expired/expiring digest to `COMPLIANCE_ALERT_TO` (default service@brixbev.com); silent when current. Seeded party: Alameda Quantum Canning (co-packer). Phase 2 (planned, not built): contractor COI upload portal — per-party coverage requirements, token-gated public upload page, Claude ACORD extraction, auto-chase emails. |
| 2026-07-22 | vendor intake | **Vendor email → SF ticket automation (Red Bull + Freshpet), zero crons.** New `netlify/functions/vendor-email-intake.mjs` — Resend inbound webhook (Svix-verified via `RESEND_INBOUND_SECRET`): emails forwarded to `rbfreeflow@`/`freshpet@alamedapointbg.com` are Claude-parsed (per-route hints) and become SF jobs under the route's `sf_customer_name`; SF's own job-status notification emails pointed at `sf-status@alamedapointbg.com` are parsed (regex + Claude fallback) and relayed to the route's `send_list` — SF has no API webhooks, its notification email IS the event. New tables `ops.vendor_email_routes/_email_tickets/_ticket_events` (migration `20260722a`, service-role only, seeded routes; `sf_customer_name` NULL = record-but-don't-create + alert). Category attach retries without on 422; dedup on Resend email id; setup checklist in `architecture/VENDOR-EMAIL-INTAKE.md`. |
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
| 2026-07-22 | handbook v1.1 | **Architecture & Data section + automatic Change Log + one-button auto-update.** New handbook parts: *Architecture & Data* (`12-architecture-overview.md` — Mermaid diagrams of the system map, QBO-mirror pipeline, order flow, payment rails, ResQ sync, cron inventory; the viewer now renders ```mermaid fences) and a **Live Architecture Mirror** chapter (`handbook-architecture.mjs` fetches `Skilliosis_Mytosis_Architecture/ARCHITECTURE.md` from GitHub at view time — can't drift). New *Change Log* tab (`handbook-changelog.mjs` — commits across 12 APBG repos composed into a dated markdown feed; git is the logger, nothing hand-entered). Live chapters are `remote` entries in `manifest.json`; the viewer calls them with the `apbg_session` Bearer (admin/superadmin) and shows a sign-in notice otherwise. **Auto-update**: `handbook-autoupdate-background.mjs` — Master Control button; re-sweeps, has Claude (`HANDBOOK_UPDATE_MODEL`, default sonnet) rewrite each stale chapter against its changed sources, commits to a `handbook/auto-update-*` branch and opens a DRAFT PR — never merges (SOP-0 policy). Needs `GITHUB_WRITE_TOKEN` (or write-scoped `GITHUB_TOKEN`) + `ANTHROPIC_API_KEY`. Shared GitHub helpers in `netlify/functions/lib/handbook.mjs`; sweep refactored onto it and skips remote chapters. **Weekly drift cron**: `handbook-sweep-cron.mjs` (Mondays 15:00 UTC) re-runs the sweep and emails a stale-chapter digest to `HANDBOOK_ALERT_TO` (default service@brixbev.com) via the existing Resend helper; silent when fresh. ⚠ Env still needed on Netlify: `GITHUB_TOKEN` (classic PAT, `repo` scope — read for sweep/mirror/changelog, write enables Auto-update; or split write into `GITHUB_WRITE_TOKEN`). Known blocker: the ASM GitHub MCP stack-overflows on files >~60KB, so the companion ARCHITECTURE.md rows for this release are pinned in PR #307 pending manual apply / asm-mcp-tools fix. |
| 2026-07-22 | handbook | **APBG Master Handbook shipped.** 22 chapters in `docs/handbook/` — Part I Master User Guide (one chapter per app: gateway, brix-order portal + /admin, driver audit PWA, AI assistants, Refractor, Brixpense, AP tool, Master Control, Production, companion apps) + Part II Operations SOP Manual (SOP-0…9: governance, security/access, customer lifecycle, orders, billing/payments, cylinders, service/incidents, expenses, production, data/engineering; new policies drafted are marked `Draft policy — pending owner approval`). Multi-chapter HTML viewer at `public/docs/handbook/index.html` (hash routing, grouped sidebar, search, print). New **Master Control → APBG Handbook** panel + `handbook-sweep.mjs`: compares each chapter's manifest-registered source files' GitHub commit dates against `last_reviewed`, renders fresh/stale, and generates a copy-paste Claude update prompt per stale chapter (set `GITHUB_TOKEN` on Netlify for private-repo sources). Content sourced from the same KB the bots use + per-app guides; internal chapters may be RAG-ingested only with `customer_visible=false` (SOP-0). |
| 2026-07-21 | production redesign | **Formula-driven BOM → Work Order → PO pipeline (Production rebuilt).** The product spec sheet / formula is now the driver: new `ops.product_formulas` + `_ingredients` + `_revisions` (seeded with the seven Alameda Quantum Canning batching sheets — Hangar 25 Cola/Diet Cola, Cable Car Lemon-Lime, Lost Island Ginger Beer, Old Fountain Cream Soda, Golden Gate Orange, Oaktown Root Beer; % by weight, QC specs, batching instructions, revision history) + private Storage bucket **`product-formulas`** for the original spreadsheets. BOM became a pure parts list (`product_bom.formula_id`, `product_bom_lines.preferred_qbo_vendor_id`; new `fn_bom_save_v2`) — **all quantity/cost calcs moved to the work order**: `fn_wo_create_pipeline` snapshots per-vendor material requirements into new `ops.work_order_materials`; `fn_wo_generate_pos` creates ONE PO PER VENDOR from the WO (`purchase_orders.work_order_id`); `fn_wo_advance` drives the new status pipeline draft → ordered → at_copacker → in_production → yield_recorded (posts yield movement + cost snapshot incl. yield %, co-pack fee/freight) → in_transit (creates + ships a real BOL transfer co-packer → warehouse) → received (finished goods land in inventory) → closed. New `ops.work_order_events` audit trail + `v_work_orders` view; `v_purchase_orders` exposes the WO link. Legacy in-house consume/close flow retired (tables were empty live); Co-Pack Orders tab kept as "Co-Pack (Legacy)". Frontend: new Formulas & Spec Sheets tab (interactive batch scaler, printable batching sheet, attachment upload), rebuilt BOMs + Work Orders tabs (pipeline stepper, per-stage actions). Manifest/snapshot: all production tables registered (`brix-production:app-and-rpcs`, `push-qbo-item:vendors`). Migrations 20260721a/b applied live; pipeline smoke-tested end-to-end (rolled back). ⚠ RPC overload trap struck twice: `fn_create_transfer`/`fn_ship_transfer`/`fn_receive_transfer` have live legacy overloads — `fn_wo_advance` calls the longest signatures explicitly. |
