# APBG · 3rd-Party Billing + BRIX Margin Control

This repository hosts **three independent surfaces** that share one Netlify
deploy at `apbg-billing.netlify.app`, fronted through the parent gateway at
`alamedapointbg.com`:

| # | Surface | Lives in | Mounted at |
|---|---------|----------|------------|
| 1 | **3rd-Party Billing** — AI vendor-bill processing (the original AP tool) | `public/*.html` + `netlify/functions/` | `alamedapointbg.com/billing/` |
| 2 | **BRIX Margin Control** — sales / margin / customer analytics SPA | `app/` (React + Vite, built to `public/sales-next/`) | `alamedapointbg.com/margin/` |
| 3 | **Cross-repo sync orchestration** — lint-checked manifest of `ops.*` table writers | `architecture/` | (build-time CI only) |

> **Architecture handbook.** The cross-repo source of truth lives at
> [`activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md).
> When you change architecture here, update the handbook in the same change.

---

## Repo map

```
apbg-billing/
├── README.md                ← you are here
├── CLAUDE.md                ← build instructions for Claude
├── USER-GUIDE.md            ← AP tool user guide
├── PACER-OPS-README.md      ← legacy: historical KPI dashboard notes
├── PACER-KPI-SPEC.md        ← legacy: 108 KPI spec (mostly migrated to APBG-OPS)
├── FLEET-HR-INTEGRATION.md  ← legacy: fleet/HR integration plan
├── CLAUDE-CODE-HANDOFF.md   ← session handoff notes
│
├── public/                  ← Netlify publish dir (everything below is served)
│   ├── index.html           ← AP tool: PDF drop zone
│   ├── approve.html         ← AP tool: bill approval form
│   ├── setup.html           ← AP tool: OAuth setup
│   ├── sync.html            ← ResQ ↔ Service Fusion sync dashboard
│   ├── control.html         ← Master control (health + tokens)
│   ├── dashboard.html       ← PACER Ops legacy dashboard
│   ├── sales/index.html     ← LEGACY 300 KB Margin Control monolith (being retired)
│   └── sales-next/          ← Vite build output → THIS is BRIX Margin Control
│
├── app/                     ← BRIX Margin Control SOURCE (React 18 + Vite 5 + TS)
│   ├── package.json         ← "apbg-margin-app"
│   ├── vite.config.ts       ← base=/sales-next/, outDir=../public/sales-next
│   └── src/
│       ├── pages/           ← 10+ pages (Overview, Margin, Operations, etc.)
│       ├── components/      ← Layout, KPICard, MarginGrid, PivotTable, …
│       └── lib/             ← Supabase client, RPCs, formatters, …
│
├── architecture/            ← CROSS-REPO sync orchestration
│   ├── README.md            ← how the sync-manifest lint works
│   ├── MARGIN-CONTROL.md    ← BRIX Margin Control architecture (focused)
│   ├── sync-manifest.json   ← which function writes which ops.* table
│   ├── schema-snapshot.json ← static schema dump for offline lint
│   ├── lint-manifest.mjs    ← validator (runs in CI before any build)
│   └── refresh-snapshot.mjs ← helper to refresh the schema dump
│
├── netlify/
│   └── functions/           ← serverless backend (AP + ResQ-SF + health)
│       ├── process-inbound.mjs   ← Claude AI PDF scanning
│       ├── approve-bill.mjs
│       ├── resq-sf-sync*.mjs     ← ResQ ↔ Service Fusion sync workers
│       ├── health-watchdog.mjs   ← cross-system health
│       ├── pacer-health.mjs
│       ├── master-health.mjs
│       └── lib/auth.mjs          ← shared Supabase JWT verifier
│
└── netlify.toml             ← build runs: lint → npm install --prefix app → vite build
```

---

## Build pipeline

```
git push main
       │
       ▼
Netlify build  (defined in netlify.toml)
  1. node architecture/lint-manifest.mjs        ← sync-manifest gate
  2. npm install --prefix app                   ← React app deps
  3. npm run build --prefix app                 ← tsc -b && vite build → public/sales-next/
       │
       ▼
Netlify publishes public/ as static + netlify/functions/ as Lambdas
       │
       ▼
apbg-billing.netlify.app
       │
       ▼
apbg-gateway proxies
  /billing/* → apbg-billing.netlify.app/:splat        (AP tool + everything else)
  /margin/*  → apbg-billing.netlify.app/:splat        (BRIX Margin Control)
       │
       ▼
alamedapointbg.com/billing/   and   alamedapointbg.com/margin/
```

A failing manifest lint stops the build before Vite runs — drift can't ship.

---

## (1) 3rd-Party Billing

The original tool. AI-powered bill processing and approval system for APBG.
Vendor bills arrive via email or web upload, Claude AI scans and extracts data,
then routes through an approval workflow before creating entries in QuickBooks
Online.

### Workflow

```
Vendor bill arrives (email or web upload)
         │
Claude AI scans the PDF — extracts vendor, line items, amounts
         │
Approval email sent with signed review link
         │
Approver opens link — edits vendor, account, location, job number
         │
Clicks "Approve & Create Bill"
         │
Bill created in QBO — system searches invoices for job number
         │
MATCH    → Confirmation email with margin calculation
NO MATCH → Warning email: "No invoice on file"
```

### Functions

#### Core bill processing

| Function | Purpose |
|---|---|
| `process-inbound.mjs` | Receives vendor bills (email/web upload), scans PDF with Claude AI, extracts vendor/amount/items, sends approval email with signed URL |
| `approve-bill.mjs` | Creates bill in QBO from approval form, matches against invoices, calculates margin |
| `create-vendor.mjs` | Creates vendor in QBO on the fly |
| `create-invoice.mjs` | Creates QBO invoice |
| `decode-token.mjs` | Decodes HMAC-signed approval URL tokens |

#### Query endpoints

| Function | Purpose |
|---|---|
| `get-vendors.mjs` | Lists QBO vendors |
| `get-customers.mjs` | Lists QBO customers |
| `get-departments.mjs` | Lists QBO departments |

#### ResQ ↔ Service Fusion sync

| Function | Purpose |
|---|---|
| `resq-sf-sync.mjs` | Dispatcher for bidirectional ResQ-to-Service-Fusion sync |
| `resq-sf-sync-background.mjs` | Long-running (15 min timeout) background worker |
| `resq-sf-sync-cron.mjs` | Scheduled every 5 min, triggers background sync |
| `sf-fix-numbers.mjs` | Finds recent SF jobs with R-code numbers |

#### Health & monitoring

| Function | Purpose |
|---|---|
| `health-watchdog.mjs` | Checks QBO/SF/ResQ connectivity, alerts on failure |
| `master-health.mjs` | Health dashboard API for `control.html` |
| `master-health-cron.mjs` | 12-hour keep-alive |
| `pacer-health.mjs` | Proxy health check for Pacer Finance |

#### OAuth & shared helpers

| Module | Purpose |
|---|---|
| `oauth-callback.mjs` | QBO OAuth callback |
| `sf-oauth-callback.mjs` | Service Fusion OAuth callback |
| `sf-token-debug.mjs` | SF token diagnostic |
| `qbo-helpers.mjs` | QBO token management (refresh, cache, API wrapper) |
| `sf-helpers.mjs` | Service Fusion API wrapper |
| `resq-helpers.mjs` | ResQ API helpers (CSRF + GraphQL) |
| `email-helpers.mjs` | Email sending + HTML templates |
| `token-helpers.mjs` | HMAC-signed stateless tokens for approval URLs |
| `lib/auth.mjs` | Shared Supabase JWT verifier (used by health endpoints) |
| `lib/master-health-core.mjs` | Core health check logic |

### HTML pages

| Page | Purpose |
|---|---|
| `index.html` | PDF drop zone for uploading vendor bills |
| `approve.html` | Bill approval form (vendor, line items, account, job number) |
| `setup.html` | OAuth connection management (QBO + Service Fusion) |
| `sync.html` | ResQ ↔ SF sync dashboard with status, work orders, and logs |
| `control.html` | Master control dashboard (health, token monitoring) |

### Scheduled functions

| Function | Schedule | Purpose |
|---|---|---|
| `resq-sf-sync-cron` | Every 5 min | Triggers bidirectional ResQ-SF sync |
| `health-watchdog` | Scheduled | Cross-system connectivity check + email alerts |
| `master-health-cron` | 12 h | Keep-alive ping |

### QBO account mapping (legacy mapping for AP tool)

| COGS account | Account ID | Use for |
|---|---|---|
| Service COGS | 101 | Labor, service calls, repairs, consulting |
| Equipment Sales COGS | 42 | Parts, materials, equipment, supplies |

Newer department-level COGS routing (Margin Control) is documented in the
master handbook under "Department to COGS mapping."

### Invoice matching

The AP tool searches QBO invoices for the job number in:

1. Invoice number (DocNumber)
2. Private notes
3. Customer memo
4. Line item descriptions

Searches across the selected customer plus THE MELT, THE MELT MAIN, and THE
MELT-EQUIPMENT (PAYMENT PLAN).

### Environment variables (AP tool)

| Variable | Purpose |
|---|---|
| `QBO_CLIENT_ID` | QuickBooks OAuth client ID |
| `QBO_CLIENT_SECRET` | QuickBooks OAuth client secret |
| `QBO_REALM_ID` | QuickBooks company ID (`9130352144155116`) |
| `QBO_REFRESH_TOKEN` | QuickBooks refresh token (auto-managed) |
| `QBO_ENVIRONMENT` | `production` or `sandbox` |
| `ANTHROPIC_API_KEY` | Claude API key for PDF scanning |
| `SENDGRID_API_KEY` | SendGrid email API key |
| `RESEND_API_KEY` | Resend email API key (alternative to SendGrid) |
| `APPROVAL_EMAIL` | Recipient for approval emails |
| `EMAIL_FROM` | Sender address for outbound emails |
| `TOKEN_SECRET` | HMAC secret for signing approval URLs |
| `RESQ_EMAIL` | ResQ login email |
| `RESQ_PASSWORD` | ResQ login password |
| `SF_CLIENT_ID` | Service Fusion OAuth client ID |
| `SF_CLIENT_SECRET` | Service Fusion OAuth client secret |
| `SF_REFRESH_TOKEN` | Service Fusion refresh token (auto-managed) |
| `NETLIFY_SITE_ID` | Netlify site ID (for env var updates) |
| `NETLIFY_ACCESS_TOKEN` | Netlify API token (for env var updates) |

---

## (2) BRIX Margin Control

The React/Vite app at `app/` — internal margin / sales / customer analytics
used by APBG ops and finance.

- **URL:** `https://alamedapointbg.com/margin/`
  (proxied to `apbg-billing.netlify.app/sales-next/`)
- **Source:** `app/` · npm package `apbg-margin-app`
- **Stack:** React 18 · Vite 5 · TypeScript 5 · MUI v6 · MUI X v7 Pro
  (DataGrid Pro, Charts, Date Pickers) · `@supabase/supabase-js` v2 ·
  Lucide React · dayjs
- **Reads from:** the `ops.mv_sales_lines` materialized view via four
  SECURITY DEFINER RPCs (`ops.fn_sales_totals`, `fn_sales_pivot`,
  `fn_sparkline`, `fn_sales_dim_values`).
- **Auth:** Supabase email/password via `LoginPage.tsx`. Independent
  from the gateway's `apbg_session`.

### Sidebar (9 pages)

Overview · Margin · Operations · Customers · Reports · Plans · Compare ·
Inventory · Settings.

(Fleet was moved to `APBG-OPS` 2026-05-10 — file still in code, removed
from nav.)

### Deeper architecture

See [`architecture/MARGIN-CONTROL.md`](architecture/MARGIN-CONTROL.md) for:

- Page → route map
- Component / lib module inventory
- Build pipeline detail
- Data flow (public.* → ops.* → mv_sales_lines → RPCs)
- Materialized view indexes and refresh policy
- Brand tokens and MUI theme override
- Known gaps and open items

### Required env vars (Margin Control)

| Variable | Purpose |
|---|---|
| `VITE_MUI_X_LICENSE` | MUI X Pro license key (paid through activespacescience) — without this, DataGrid Pro renders a watermark |

The Supabase URL and anon key are currently hard-coded in
`app/src/lib/supabase.ts` (anon key only — RLS is the protection layer).

---

## (3) Sync orchestration manifest

`architecture/` holds machine-checkable contracts about which function or
human writes which `ops.*` table across the multi-repo APBG system.

- **`sync-manifest.json`** — the contract. Every `ops.*` table either has a
  `writers[]` entry or appears in `orphans[]` with a reason.
- **`schema-snapshot.json`** — static dump of `information_schema.tables` for
  the `ops` schema. Lint runs without DB credentials.
- **`lint-manifest.mjs`** — Node script (no deps). Enforces 4 rules. Wired
  into Netlify CI as the first build step; a dirty manifest fails the build
  before Vite runs.
- **`refresh-snapshot.mjs`** — calls the `ops.fn_list_ops_tables()` RPC and
  rewrites `schema-snapshot.json` after migrations.

Full detail in [`architecture/README.md`](architecture/README.md).

---

## Local development

No build step is required for the AP tool. To run the whole site locally:

```bash
npm install                  # if any root-level deps exist
netlify dev                  # serves public/ + netlify/functions/ on :8888
```

To work on Margin Control:

```bash
cd app
npm install
npm run dev                  # Vite dev server on :5173
```

The Vite dev server runs against production Supabase. To work locally
without affecting prod data, point at a Supabase branch (not yet wired).

---

## Branch deploys

- **`main`** → production (`apbg-billing.netlify.app`)
- **`dev`** → testing (`dev--apbg-billing.netlify.app`)

Both branches share environment variables and blob storage.

---

## Cross-repo references

| Repo | What it owns |
|---|---|
| `activespacescience/Skilliosis_Mytosis_Architecture` | Master architecture handbook (cross-repo source of truth) |
| `skypace/apbg-gateway` | Parent gateway at `alamedapointbg.com` (proxies `/billing/*` and `/margin/*` here) |
| `skypace/APBG-OPS` | PACER Operations KPI dashboard (mounted at `/operations/`) |
| `skypace/melt-dashboard` | Melt Equipment Portal (mounted at `/melt/`) |
| `skypace/pacerfinance` | QBO + Zoho MCP server (mounted at `/finance/`) |
| `skypace/APBG-Leasing-Rental` | Equipment leasing + rental (Railway-backed) |
| `skypace/Pacer-outlook` | Outlook MCP |
