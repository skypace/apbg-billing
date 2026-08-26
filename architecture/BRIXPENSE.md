# Brixpense — Architecture

> **Where this fits.** This is the architecture doc for the React/Vite app at
> `apbg-billing/app-expense/`. For the cross-repo picture (Supabase projects,
> RLS, Intuit apps, MCP servers), see
> [`activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md).
> For the sync orchestration manifest (which functions write which `ops.*`
> tables), see [`./README.md`](./README.md) in this directory.
> For the sibling Margin Control surface, see
> [`./MARGIN-CONTROL.md`](./MARGIN-CONTROL.md).

---

## What it is

**Brixpense** is APBG's internal expense request and purchase-request
tool. Employees submit receipts or purchase requests; managers approve
via magic-link email (no login required); approved expenses can be
posted to QBO as Bills with one click.

- **Surface URL (production):** `https://alamedapointbg.com/expense/`
  (proxied by `apbg-gateway` to `apbg-billing.netlify.app/expense/`).
- **Build output:** `apbg-billing/public/expense/` (Vite bundle).
- **Source root:** `apbg-billing/app-expense/`.
- **npm package name:** `brix-expense` (version `0.1.0`).
- **Auth:** Supabase Email/Password for submitters; public magic-link
  route for manager approvals.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | React 18 + TypeScript 5 | strict TS, ESM |
| Build | Vite 5 (`@vitejs/plugin-react`) | no SSR, static build |
| UI components | Radix UI primitives + shadcn-style wrappers | Card, Button, Badge, Input, Label, Textarea, Select |
| Variant styling | `class-variance-authority` (CVA) | Button: 7 variants × 4 sizes; Badge: 6 variants |
| Icons | `lucide-react` | same icon library as Margin Control |
| Data client | `@supabase/supabase-js` v2 | RPC + table reads, anon key |
| Forms | `react-hook-form` + `zod` | schema-validated form state |
| Routing | `react-router-dom` v6 | basename="/expense" |
| Signatures | `react-signature-canvas` | approval signature capture (pen color #1F4E79) |
| Animation | `motion` (Framer Motion) | page transitions |
| Dates | `date-fns` | date formatting |
| CSS | Tailwind CSS 3 + custom globals.css | glass morphism dark theme |
| Utility | `clsx` + `tailwind-merge` | `cn()` class merging helper |

---

## Build pipeline

```
git push main
       │
       ▼
Netlify build  (defined in apbg-billing/netlify.toml)
  1. node architecture/lint-manifest.mjs          ← sync-manifest gate
  2. mkdir -p public/docs && cp -r docs/. public/docs/
  3. npm install --prefix app                     ← Margin Control deps
  4. npm run build --prefix app                   ← Margin Control build
  5. npm install --prefix app-expense             ← Brixpense deps
  6. npm run build --prefix app-expense            ← tsc + vite build
        ↓ outputs to ../public/expense/
  7. Netlify publishes `public/`                  ← serves the whole site
       │
       ▼
apbg-billing.netlify.app/expense/   (raw Netlify URL)
       │
       ▼
apbg-gateway netlify.toml proxy
  /expense/*  → apbg-billing.netlify.app/expense/:splat
       │
       ▼
alamedapointbg.com/expense/   (branded URL)
```

Vite config (`app-expense/vite.config.ts`):

- `base: '/expense/'` — bundle path prefix.
- `outDir: '../public/expense'` — writes build output alongside Margin
  Control's `public/sales-next/`.
- Dev server: port `5174` (Margin Control uses 5173).
- `@` alias resolves to `src/`.

`netlify.toml` also defines a SPA fallback so any `/expense/*` path that
doesn't hit a static file rewrites to `/expense/index.html`.

---

## Directory layout

```
apbg-billing/
└── app-expense/                          ← Brixpense source root
    ├── package.json                      ← "brix-expense" v0.1.0
    ├── vite.config.ts                    ← base=/expense/, outDir=../public/expense
    ├── tsconfig.json
    ├── tailwind.config.ts                ← dark navy glass morphism theme
    ├── postcss.config.js
    ├── index.html                        ← Vite entry HTML
    ├── public/                           ← Vite static assets (brand images)
    └── src/
        ├── main.tsx                      ← ReactDOM.createRoot + BrowserRouter
        ├── App.tsx                       ← route definitions + auth gate
        ├── vite-env.d.ts
        ├── styles/
        │   └── globals.css               ← Tailwind + glass morphism + component overrides
        ├── types/
        │   └── expense.ts                ← ExpenseRequest, LineItem, Approval, Settings types
        ├── components/
        │   ├── AppShell.tsx              ← sidebar shell (collapsible, 3 nav items)
        │   ├── BrixMark.tsx              ← brand logo (BrixMark, BrixWordmark, AlamedaMark)
        │   └── ui/                       ← shadcn-style primitives
        │       ├── button.tsx            ← CVA: default/destructive/outline/secondary/ghost/link/success
        │       ├── card.tsx              ← Card, CardHeader, CardTitle, CardContent, CardFooter
        │       ├── badge.tsx             ← default/success/warning/destructive/info/secondary
        │       ├── input.tsx
        │       ├── label.tsx
        │       ├── textarea.tsx
        │       └── select-field.tsx      ← native <select> styled to match
        ├── pages/
        │   ├── LoginPage.tsx             ← Supabase email/password
        │   ├── LandingPage.tsx           ← dashboard: mode cards + recent submissions
        │   ├── ExpenseForm.tsx           ← multi-step wizard: upload → details → submit
        │   ├── PurchaseRequestForm.tsx   ← PR form (always requires approval)
        │   ├── PendingList.tsx           ← user's submission history
        │   ├── ManagerQueue.tsx          ← manager's approval inbox
        │   └── ApprovalPage.tsx          ← PUBLIC magic-link approval + signature
        └── lib/
            ├── supabase.ts               ← Supabase client + getAccessToken()
            ├── hooks.ts                  ← useSession(), useExpenseSettings()
            └── utils.ts                  ← cn(), formatCurrency(), formatDate()
```

---

## Page → route map

| Route | Page | Auth | Notes |
|---|---|---|---|
| `/expense/` | LandingPage | required | Mode cards (Expense vs PR) + recent submissions |
| `/expense/new` | ExpenseForm | required | Multi-step: receipt upload → OCR → details → submit |
| `/expense/new-pr` | PurchaseRequestForm | required | Purchase request (no receipt, always needs approval) |
| `/expense/pending` | PendingList | required | User's own submissions, all statuses |
| `/expense/queue` | ManagerQueue | required | Requests pending the logged-in manager's approval |
| `/expense/edit/:id` | ExpenseForm | required | Edit/view existing request |
| `/expense/approve/:token` | ApprovalPage | **public** | Magic-link approval with signature capture |

The `App.tsx` auth gate uses `useSession()` — unauthenticated users see
`LoginPage` for all routes except `/approve/:token`, which is
deliberately public (managers approve without logging in).

Sidebar (`AppShell.tsx`) shows three nav items: Dashboard (index),
My Pending, Approvals (manager queue).

---

## Service Fusion receipts — the `SF_FETCH_RECEIPTS` switch (2026-08-25)

SF-landed expenses arrive **data-only**: vendor, amount, date, job number,
customer, and the SF# deep link come from SF's REST API (reliable); the bill
document is **attached by a human in Brixpense** via the attach controls on the
expense edit form. The receipt file itself only ever existed on the
admin.servicefusion.com job page, and that cookie-authenticated scrape was the
flakiest link in the whole pipeline (intermittent 20s+ hangs on SF's side).

The scrape is not deleted — it's behind a switch:

- **`SF_FETCH_RECEIPTS`** env var on the **Supabase project** (edge-function
  env, NOT Netlify — `sf-receipt-sync` is a Supabase edge function).
- Default/unset/`0` = data-only landing (current mode). Set to `1` to restore
  receipt auto-attach; takes effect on the next sweep, no deploy needed.
- Every sweep logs `fetchReceipts` in its `ops.sync_log` metadata, so which
  mode a run used is always on record.
- The `?receipts=<job#>` diagnostic endpoint always resolves receipt URLs
  regardless of the flag (for one-off manual retrieval).

With the flag off, attachment-less SF drafts get `ocr_status='no_attachment'`
and a one-time email — that's the "go attach the bill" nudge, not an error.

## Pay run — several bills, one payment, one remittance (2026-08-26)

**Brixpense → Accounts payable → Pay Bills** (`/expense/pay-run`, superadmin).
Every posted, unpaid bill grouped by vendor; tick a selection, and each
vendor's picked bills go out as **one payment** — a Stripe bank transfer or a
recorded manual payment (check / Venmo / Zelle / QBO Bill Pay) — which books
**one multi-line QBO BillPayment** covering all of them and emails the vendor
**one remittance advice** listing every bill, so their AR desk can apply a
single deposit across invoices.

How it hangs together:

- **`/api/vendor-pay-run`** (`vendor-pay-run.mjs`, superadmin — the same gate
  as the single-bill `/api/vendor-pay`): `list` / `pay_stripe` / `record` /
  `remit` (resend the advice).
- **The ledger stays per-bill.** `ops.vendor_payments` keeps one row per bill
  (its partial unique index — one LIVE payment per `qbo_bill_id` — is the
  duplicate guard, and it must survive batching). A parent
  **`ops.vendor_payment_groups`** row carries what is singular about the
  payment: the one Stripe payout id, the one BillPayment id, the check #, the
  chosen remittance recipient (`remit_to`) and the send record
  (`remittance_sent_at/_to/_error`).
- **Ledger before money.** Group + per-bill rows insert BEFORE any payout or
  QBO write; a collision (a race with a single-bill Pay click) aborts the
  whole batch with nothing paid.
- **Remittance timing:** manual rails send the advice immediately (the money
  already moved); Stripe sends it from `stripe-payout-webhook.mjs`'s
  `settleGroup()` at settlement — an in-flight payout is not yet a payment.
  A failed send never fails a payment; it's stamped on the group and the
  Pay Bills page offers a resend. Template lives in `lib/remittance.mjs`
  (everything escaped — vendor names come off OCR'd PDFs).
- **Watcher:** none added, deliberately — batch rows are ordinary
  `vendor_payments` rows, so `ops.fn_vendor_payments_health()` already goes
  red on a stuck (initiated >48h) or failed pay run.

Migration `20260826d_pay_run.sql` (applied live). Tests in
`tests/pay-run.test.mjs` pin the multi-line BillPayment payload and the
remittance document.

## Expense lifecycle

```
                  ┌──────────────────────────────┐
                  │        User submits           │
                  └──────────┬───────────────────┘
                             │
                    ┌────────▼────────┐
                    │  amount > $250? │       (auto_approve_threshold
                    │  (or type=PR)   │        from ops.expense_settings)
                    └───┬─────────┬───┘
                    yes │         │ no
                        │         │
               ┌────────▼──┐  ┌──▼──────────────────┐
               │  pending   │  │ approved (auto)      │
               │            │  │ auto_approved=true   │
               └────┬───┬──┘  └──────┬───────────────┘
          approve   │   │ deny       │
         ┌──────────▼┐  ▼            │
         │ approved   │ denied       │
         │  (or       │              │
         │   awaiting │              │
         │  _invoice  │              │
         │   if PR)   │              │
         └─────┬─────┘               │
               │                     │
               ▼                     ▼
     ┌──────────────────────────────────┐
     │ link-bill (mode=create) posts to │
     │ QBO; status flips to 'posted'    │
     └──────────────────────────────────┘
```

### Status definitions

| Status | Meaning |
|---|---|
| `draft` | New submission, before notify is called. |
| `pending` | Awaiting manager approval. Magic-link sent. |
| `approved` | Manager approved via magic link (or auto-approved expense under threshold). |
| `denied` | Manager denied. Terminal unless re-submitted. |
| `awaiting_invoice` | Approved PR; waiting for the vendor's invoice. |
| `fulfilled` | Invoice received, QBO bill to be posted. |
| `posted` | QBO bill created (or linked). Terminal. |

### Request types

| Type | Receipt required | Approval rule |
|---|---|---|
| `expense` | Yes (receipt upload + OCR) | Auto-approved if `total_amount ≤ auto_approve_threshold`; otherwise manager approval required. |
| `purchase_request` | No | Always requires manager approval; approval moves to `awaiting_invoice`, not `approved`. |

### Approval threshold

Configurable via the `ops.expense_settings` table (key:
`auto_approve_threshold`, seeded default: `250`). Read by
`expense-request-notify.mjs` and by the frontend `useExpenseSettings()`
hook.

---

## Magic-link approval flow

```
Employee clicks Submit on ExpenseForm / PurchaseRequestForm
       │
       ▼
POST /api/expense-request-notify   { requestId }
  1. Look up the request
  2. If expense ≤ auto_approve_threshold → auto-approve, return
  3. Otherwise generate a 32-byte hex token, store it on the request
     row (expense_requests.approval_token), set status='pending'
  4. Render the Brixpense-branded HTML email with a Review & Approve
     button pointing at /expense/approve/{token}
  5. Send via Resend or SendGrid (whichever is configured in env)
       │
       ▼
Manager clicks link (NO login required)
       │
       ▼
ApprovalPage.tsx
  1. GET /api/expense-request-decide?token={token}
     → validates token, returns request + attachments for display,
       or already_decided=true if the request is past 'pending'
  2. Manager reviews and either Approves or Denies (deny requires note)
  3. (optional) Signs on the signature pad (react-signature-canvas)
       │
       ▼
POST /api/expense-request-decide
     { token, action: 'approved'|'denied', decidedBy, decidedByEmail,
       notes?, signatureUrl? }
  4. Insert audit row in ops.expense_approvals with IP + UA
  5. Update ops.expense_requests:
       - status → 'approved' (expense) | 'awaiting_invoice' (PR) | 'denied'
       - approved_by + approved_at on approval
       - denial_reason on denial
```

### Audit trail

Every approval/denial decision is one row in `ops.expense_approvals`
(singular). Captured fields: `action`, `decided_by`,
`decided_by_email`, `signature_url`, `ip_address`, `user_agent`,
`notes`, `token_used`. Auto-approvals are also logged here with
`decided_by = 'system (auto-approve)'`.

---

## Data layer

### Supabase project

- **Project ref:** `gfsdpwiqzshhexkofiif` (shared with Margin Control,
  Melt, APBG-OPS)
- **URL:** `https://gfsdpwiqzshhexkofiif.supabase.co`
- **Schema:** `ops` (same as Margin Control)
- **Auth:** anon key embedded in bundle (`app-expense/src/lib/supabase.ts`).
- **User auth:** Supabase Email/Password. `@brixbev.com` credentials.

### Migrations

| File | Role |
|---|---|
| `supabase/migrations/20260512_create_expense_tables.sql` | Source of truth. Creates the 4 tables, RLS policies, updated_at trigger, and base seed (`auto_approve_threshold=250`, `approval_email`, generic `departments`). |
| `supabase/migrations/20260512o_brix_expense_requests.sql` | Earlier spec. Mostly no-oped (CREATE TABLE IF NOT EXISTS) against the first migration, except it created an orphan `ops.expense_request_approvals` (plural) that no code reads. Retained in history; superseded by the next file. |
| `supabase/migrations/20260512p_expense_cleanup.sql` | Reconciliation pass. Drops the orphan plural-named approvals table, finishes the seed (`cogs_accounts`, `manager_emails`, `tags`), and re-aligns `departments` to the Brix entity → COGS taxonomy (delivery/service/reman/ops/freeflow/melt). |

### Tables (ops schema, live shapes)

#### `ops.expense_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, default `gen_random_uuid()` |
| `request_type` | text | `'expense'` or `'purchase_request'` |
| `status` | text | `draft/pending/approved/denied/awaiting_invoice/fulfilled/posted` |
| `entity` | text | `'brix' / 'freeflow' / 'shared'` |
| `submitted_by` | uuid | FK to `auth.users.id` |
| `submitter_name` | text | snapshot at submit time |
| `submitter_email` | text | snapshot at submit time |
| `vendor_name` | text | |
| `total_amount` | numeric(12,2) | |
| `currency` | text | default `'USD'` |
| `receipt_date` | date | expense receipt date / PR needed-by date |
| `cogs_account_id` | text | QBO account ID (nullable; link-bill falls back to Service COGS=101) |
| `cogs_account_label` | text | human-readable account name |
| `tag` | text | business tag (project/event/vehicle/customer/store/general) |
| `department` | text | delivery / service / reman / ops / freeflow / melt |
| `customer_name` | text | optional |
| `job_number` | text | optional |
| `description`, `notes` | text | free-form |
| `line_items` | jsonb | array of `{ description, quantity, unit_price, amount, account?, category? }` |
| `manager_email` | text | set when approval required (informational; not enforced in RLS yet) |
| `approval_token` | text UNIQUE | magic-link token; anon SELECT/UPDATE gated on this being set |
| `approved_by`, `approved_at`, `denial_reason`, `auto_approved` | mixed | decision tracking |
| `qbo_bill_id` | text | QBO Bill.Id after link-bill posts |
| `posted_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz | trigger-maintained |

#### `ops.expense_request_attachments`

`id`, `request_id` (FK, ON DELETE CASCADE), `file_name`, `file_url`,
`storage_path`, `file_type`, `file_size`, `ocr_result` (jsonb),
`created_at`.

#### `ops.expense_approvals` (singular — the live audit table)

`id`, `request_id` (FK, ON DELETE CASCADE), `action`
(`approved/denied`), `decided_by`, `decided_by_email`,
`signature_url`, `ip_address`, `user_agent`, `notes`, `token_used`,
`created_at`.

> **Note:** an older migration tried to create `expense_request_approvals`
> (plural). It was dropped in `20260512p_expense_cleanup.sql`. All
> code targets the singular table.

#### `ops.expense_settings`

Key/value config. Seeded keys (post-cleanup migration):

| Key | Value shape | Default |
|---|---|---|
| `auto_approve_threshold` | number | `250` |
| `approval_email` | string | `"wgrandell@brixbev.com"` |
| `departments` | string[] | `["delivery","service","reman","ops","freeflow","melt"]` |
| `cogs_accounts` | `{ id, label }[]` | Service COGS (101), Equipment Sales COGS (42) + 7 new buckets with null IDs |
| `manager_emails` | string[] | the 6 current managers |
| `tags` | string[] | `["project","event","vehicle","customer","store","general"]` |

### RLS posture

`expense_requests`: authenticated SELECT all (the queue UIs need it),
INSERT requires `submitted_by = auth.uid()`, UPDATE requires
`submitted_by = auth.uid()`. Anon SELECT/UPDATE allowed only when
`approval_token IS NOT NULL` (the magic-link approval page is
anonymous).

`expense_request_attachments`: authenticated full access; anon SELECT
gated through the parent request's `approval_token`.

`expense_approvals`: authenticated SELECT all; INSERT allowed from
authenticated and anon (the decide function writes from either
context).

`expense_settings`: SELECT public; UPDATE authenticated only.

### Storage

The base migration does not declare a private bucket; attachments are
referenced by `file_url`. The earlier migration declared an
`expense-attachments` bucket with submitter-scoped folder policies —
that bucket still exists if it was applied to the project, but is not
required by current frontend code.

---

## Netlify functions

All functions live at `netlify/functions/` and use ESM (`.mjs`) with
the Netlify v2 handler signature. CORS is wide-open for the gateway
proxy.

### `expense-request-notify`

`POST /api/expense-request-notify { requestId }`

1. Fetches the request (must be in `'draft'`).
2. Reads `auto_approve_threshold` and `approval_email` from
   `ops.expense_settings`.
3. **Auto-approve path** — expense ≤ threshold:
   sets `status='approved'`, `auto_approved=true`, logs to
   `expense_approvals`, returns.
4. **Manual-approval path** — generates a 32-byte hex token,
   stores it as `expense_requests.approval_token`, sets
   `status='pending'`, sends a Brixpense-branded HTML email to the
   configured approver via `email-helpers.mjs` (Resend / SendGrid).

### `expense-request-decide`

`GET /api/expense-request-decide?token={token}` — validates the
token by looking up `expense_requests.approval_token`. Returns the
request + attachments (or `already_decided` if past `pending`).
410-style behavior is folded into a 404 with `error` message; expired
tokens are not separately distinguished in the current build.

`POST /api/expense-request-decide` — body:
`{ token, action, decidedBy, decidedByEmail?, notes?, signatureUrl? }`.
Records the decision in `expense_approvals`, updates the request to
`approved` / `awaiting_invoice` (if PR) / `denied`, stamps
`approved_by`, `approved_at`, or `denial_reason`. Captures the
caller's IP + user agent for audit.

### `expense-request-link-bill`

`POST /api/expense-request-link-bill` (Bearer auth required).

Three modes:

| Mode | Behavior |
|---|---|
| `create` (default) | Matches vendor in QBO (`findQBOVendor`), looks up optional `DepartmentRef`, builds `AccountBasedExpenseLineDetail` lines (one per `line_items` entry; falls back to a single line at `total_amount` if empty), POSTs `/bill` to QBO via `qbo-helpers.qboRequest`. On success: stamps `qbo_bill_id`, `status='posted'`, `posted_at`. Falls back to Service COGS (101) when `cogs_account_id` is null. |
| `preview` | Returns the payload that *would* be sent to QBO. No write. Used by the UI for dry-run review. |
| `link` | Legacy passive mode: caller already created the bill elsewhere, just records `qbo_bill_id`. |

Allowed starting statuses: `approved`, `awaiting_invoice`,
`fulfilled`. Returns 207 (multi-status) if QBO succeeded but the
local row update failed — never rolls back the QBO bill.

### `process-inbound`

`POST /api/process-inbound` — receipt and inbound-email OCR.

Accepts JSON (custom forwarder / direct file upload) or
multipart/form-data (SendGrid Inbound Parse, Mailgun Routes). Pulls a
PDF or image attachment, sends it to **Claude Sonnet 4** via
`anthropic.com/v1/messages` with a strict JSON-only system prompt,
parses the response into `{ vendorName, billNumber, billDate, dueDate,
lineItems[], subtotal, tax, total, notes }`, and (for the AP-tool
flow) creates a signed approval token + emails the AP approver. The
same JSON contract feeds the Brixpense form pre-fill.

> **OCR provider note:** the build is Claude-based, not Veryfi /
> Mindee / Google Document AI / OpenAI Vision (which the earlier doc
> listed as TBD). The relevant env var is `ANTHROPIC_API_KEY`.

### Shared helpers

- `qbo-helpers.mjs` — `qboRequest`, `qboQuery`, OAuth token cache via
  Netlify Blobs (`qbo-tokens` store) with refresh-lock to prevent
  concurrent-refresh storms.
- `email-helpers.mjs` — `sendEmail({to, subject, html, replyTo})`,
  `approvalEmailHtml(...)`, `APPROVAL_EMAIL`, `EMAIL_FROM`. Picks
  Resend if `RESEND_API_KEY` is set; otherwise SendGrid.
- `token-helpers.mjs` — `createToken({...})` for legacy AP-tool
  approval URLs (HMAC-signed payload). Brixpense uses the database
  column `approval_token` instead — a 32-byte hex string — to avoid
  HMAC-secret coupling.
- `lib/auth.mjs` — `requireAuth(req, allowedRoles)` for service-role
  endpoints; not currently used by Brixpense functions.

---

## Brand & visual system

Brixpense uses a **dark navy glass morphism** theme, distinct from
Margin Control's MUI-themed look but sharing the same brand palette
roots.

### Color tokens (from tailwind.config.ts)

| Token | Value | Use |
|---|---|---|
| background | `#06121F` | page background |
| foreground | `#E6EEF7` | primary text |
| primary | `#5BB5F0` | interactive elements, links |
| primary-hover | `#7CC5F5` | hover states |
| surface-1 | `#0C1E2F` | card backgrounds |
| surface-2 | `#122A3F` | elevated surfaces |
| surface-3 | `#18364F` | highest elevation |
| border | `#1A3550` | card/input borders |
| border-focus | `#5BB5F0` | focus rings |
| success | `#22C55E` | approved status, success actions |
| warning | `#F59E0B` | pending status, caution |
| danger | `#EF4444` | denied status, destructive actions |

### Glass morphism

Defined in `globals.css` via CSS custom properties:

- `--glass-bg-card`: `rgba(12, 30, 47, 0.6)` — translucent card fill
- `--glass-bg-side`: `rgba(6, 18, 31, 0.85)` — sidebar fill
- `--glass-blur`: `16px` — backdrop blur radius
- `--glass-edge-line`: `rgba(91, 181, 240, 0.08)` — subtle border glow

Body has a radial glow backdrop (`::before` pseudo-element) creating
a vignette effect.

### Typography

| Role | Font | Notes |
|---|---|---|
| Display / headings | Bricolage Grotesque | Google Fonts, same as Margin Control |
| Body | Inter Tight | Google Fonts |
| Monospace / numbers | JetBrains Mono | tabular numerals for amounts |

### Icons

Lucide React only — same as Margin Control. No mixing icon libraries.

---

## Auth & access

| Surface | Mechanism | Who |
|---|---|---|
| Submitter pages | Supabase Email/Password | Any `@brixbev.com` employee |
| Manager queue | Supabase Email/Password | Authenticated user; row visibility currently broad (RLS allows authenticated SELECT all). Tighten later if needed. |
| Magic-link approval | Token-based, no auth | Managers clicking the email link |
| `expense-request-link-bill` | Supabase Bearer JWT | Authenticated user with a valid session |

---

## What's in scope vs. out

### In scope for Brixpense

- Expense receipt submission with OCR pre-fill.
- Purchase request submission (no receipt).
- Threshold-based auto-approval vs manager approval.
- Magic-link manager approval with signature capture.
- QBO bill creation for approved expenses (one-click via link-bill).
- Submission history (per-user) and manager approval queue.
- Configurable settings (threshold, approval routing, COGS accounts,
  tags, departments) — currently DB-edit only; admin UI pending.

### Out of scope (lives elsewhere)

| Concern | Where it lives |
|---|---|
| Vendor bill processing (AP) | `apbg-billing/public/*.html` (legacy AP tool) |
| Sales / margin analytics | `apbg-billing/app/` (BRIX Margin Control) |
| Operations KPIs | `skypace/APBG-OPS` |
| QBO sync (read path) | `sync-qbo` Supabase edge function |
| QBO writeback (items / categories) | `push-qbo-item` Supabase edge function |

---

## Known gaps + backlog (as of 2026-05-12)

1. **No mobile sidebar.** `globals.css` hides the sidebar below 768px
   but provides no hamburger menu or alternative navigation. Mobile
   users see only the main content area with no nav.

2. **No admin settings UI.** The `expense_settings` key/value table is
   read by `useExpenseSettings()` but there's no admin page to manage
   threshold, approval email, COGS accounts, manager emails, tags, or
   departments. Currently requires direct Supabase edits.

3. **Entity → Department → COGS cascade not enforced on the form.**
   The `tag`/`entity`/`department` fields are independent dropdowns;
   the cascade documented in CLAUDE.md's "Business rules →
   Department-to-COGS mapping" (delivery → 1150040011, service →
   1150040012, etc.) isn't wired into the submit flow yet. Bills will
   route to the right COGS account *if the user picks the right
   `cogs_account_id`*, but the form doesn't help them.

4. **`/edit/:id` doesn't load existing request data.** The route is
   registered and `ExpenseForm.tsx` renders, but the form always
   starts fresh — no fetch-by-id, no re-hydrate. Edit/resubmit flow
   needs a `useEffect` load + `react-hook-form` `reset()`.

5. **`manager_email` routing is informational only.** RLS doesn't gate
   visibility on `manager_email = lower(jwt.email)` — any
   authenticated user can SELECT every row. Tighten when role-based
   visibility becomes a requirement.

6. **Magic-token TTL not enforced.** The token is generated and stored
   on the request row, but there's no `token_expires_at` column or
   TTL check. Re-use is implicitly prevented by status transition
   (the decide function refuses requests not in `'pending'`), but a
   leaked link is valid until status changes.

7. **No QBO Department auto-create.** `expense-request-link-bill`
   looks up a QBO Department by name. If it doesn't exist, the bill
   still posts (without DepartmentRef). Departments listed in
   `expense_settings` should ideally be reconciled with QBO at
   onboarding time.

8. **`cogs_accounts` settings list has 7 null IDs.** Until those
   QBO accounts are created (or mapped to existing accounts), bills
   for Fuel / Office Supplies / Working Meals / Travel /
   R&M Building / New Fountain Installs / Ice Machine Rental will
   fall back to Service COGS (101). Workable, but each bucket should
   eventually point at the right account for proper P&L reporting.

---

## File ownership rules

These files belong to Brixpense. **Do not modify files outside this
list** when working on Brixpense:

| Path pattern | What it is |
|---|---|
| `app-expense/**` | All frontend source |
| `public/expense/**` | Vite build output (committed) |
| `netlify/functions/expense-request-*.mjs` | Backend functions |
| `netlify/functions/process-inbound.mjs` | OCR receipt processing (also used by AP tool — coordinate changes) |
| `supabase/migrations/*expense*.sql` | Database migrations |
| `architecture/BRIXPENSE.md` | This document |

**Do not touch** when working on Brixpense:

- `app/` — BRIX Margin Control source
- `public/sales-next/` — Margin Control build output
- `public/sales/` — legacy SPA
- `public/*.html` — AP billing tool
- `netlify/functions/` (non-expense functions, except `expense-to-bill.mjs` which is the AP-side SF-job receipt scanner)
- Any other `architecture/` files (unless `sync-manifest.json` needs an entry)

---

## Where to look next

| Need to … | Go to … |
|---|---|
| Add the mobile sidebar | `app-expense/src/components/AppShell.tsx` + breakpoint CSS in `globals.css` |
| Build the admin settings UI | New page under `pages/`, new route in `App.tsx`, new sidebar item in `AppShell.tsx`; reads/writes `ops.expense_settings` via supabase client |
| Wire the entity→COGS cascade | `app-expense/src/pages/ExpenseForm.tsx` (the controlled cascade) + `lib/hooks.ts` for the lookup table |
| Implement edit flow | `ExpenseForm.tsx` — add `useParams<{id?: string}>()`, fetch on mount, `reset(data)` into the form |
| Enforce magic-token TTL | Add `token_expires_at` column to `expense_requests` + check in `expense-request-decide` GET handler |
| Update sync-manifest | `architecture/sync-manifest.json` — already lists the four tables Brixpense writes |
| Change theme tokens | `app-expense/tailwind.config.ts` + `src/styles/globals.css` |

---

## Change log

| Date | Change |
|---|---|
| 2026-05-12 | **Initial BRIXPENSE.md.** Documented frontend architecture (7 pages, component tree, routing, types, hooks, theme), planned database schema (4 tables), Netlify function contracts (4 endpoints), expense lifecycle, magic-link approval flow. Backend was speced but not yet built. |
| 2026-05-12 | **Backend shipped.** Migration `20260512_create_expense_tables.sql` creates the four tables with RLS + updated_at trigger + base seed. All four Netlify functions live at `netlify/functions/expense-request-*.mjs` + `process-inbound.mjs`. OCR uses Claude (Anthropic API) via `ANTHROPIC_API_KEY`. Email uses Resend or SendGrid via `email-helpers.mjs`. `netlify.toml` build command appends `app-expense` install + build. SPA fallback for `/expense/*` configured. |
| 2026-05-12 | **Migration reconciliation.** A second migration (`20260512o_brix_expense_requests.sql`) tried to create the tables a second way, but `CREATE TABLE IF NOT EXISTS` no-oped on the live shape — except it created an orphan `ops.expense_request_approvals` (plural) table no code reads. New `20260512p_expense_cleanup.sql` drops the orphan, finishes the seed (`cogs_accounts`, `manager_emails`, `tags`), and re-aligns `departments` to the Brix entity/COGS taxonomy. `architecture/sync-manifest.json` updated to reference `ops.expense_approvals` (singular). |
| 2026-05-12 | **`expense-request-link-bill` now creates the QBO bill end-to-end.** New modes: `create` (default — vendor match + payload build + POST /bill + status='posted'), `preview` (dry-run, returns payload only), `link` (legacy passive). Falls back to Service COGS (101) when `cogs_account_id` is null. Uses `qbo-helpers.qboRequest` with the Netlify Blobs token cache. |
| 2026-05-12 | **BRIXPENSE.md updated to live state.** Removed "NOT YET CREATED" warnings, documented actual function contracts, updated backlog to reflect real remaining gaps (mobile nav, admin settings UI, entity-COGS cascade, edit-flow data load, token TTL). |
