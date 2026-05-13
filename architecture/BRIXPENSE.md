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
via magic-link email (no login required); approved expenses auto-create
QBO bills for AP processing.

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
  2. npm install --prefix app                     ← Margin Control deps
  3. npm run build --prefix app                   ← Margin Control build
  4. npm install --prefix app-expense             ← Brixpense deps
  5. npm run build --prefix app-expense            ← tsc + vite build
        ↓ outputs to ../public/expense/
  6. Netlify publishes `public/`                  ← serves the whole site
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

**Important:** `public/expense/` must be committed alongside source
changes. Netlify publishes `public/` as-is — the Vite build writes
directly into it.

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

## Expense lifecycle

```
                  ┌──────────────────────────────┐
                  │        User submits           │
                  └──────────┬───────────────────┘
                             │
                    ┌────────▼────────┐
                    │  amount > $500? │
                    │  (or type=PR)   │
                    └───┬─────────┬───┘
                    yes │         │ no
                        │         │
               ┌────────▼──┐  ┌──▼──────────┐
               │  pending   │  │   draft      │
               │            │  │ (auto-appv.) │
               └────┬───┬──┘  └──────┬───────┘
          approve   │   │ deny       │
         ┌──────────▼┐  ▼            │
         │ approved   │ denied       │
         └─────┬─────┘               │
               │                     │
               ▼                     ▼
     ┌─────────────────┐   ┌─────────────────┐
     │ awaiting_invoice │   │ QBO bill created │
     └────────┬────────┘   │ (auto via fn)    │
              │             └─────────────────┘
              ▼
     ┌────────────────┐
     │   fulfilled    │
     └───────┬────────┘
             ▼
     ┌────────────────┐
     │    posted       │
     └────────────────┘
```

### Status definitions

| Status | Meaning |
|---|---|
| `draft` | Auto-approved expense (under threshold). QBO bill creation attempted immediately. |
| `pending` | Awaiting manager approval. Magic-link email sent. |
| `approved` | Manager approved via magic link. |
| `denied` | Manager denied. Terminal unless re-submitted. |
| `awaiting_invoice` | Approved but vendor invoice not yet received (purchase requests). |
| `fulfilled` | Invoice received, QBO bill to be created. |
| `posted` | QBO bill created and posted. Terminal. |

### Request types

| Type | Receipt required | Approval rule |
|---|---|---|
| `expense` | Yes (receipt upload + OCR) | Auto-approved if total ≤ threshold (default $500); otherwise manager approval required. |
| `purchase_request` | No | Always requires manager approval regardless of amount. |

### Approval threshold

Configurable via the `expense_settings` table (key: `approval_threshold`,
default: `500`). Stored as a key/value pair, parsed as number in
`useExpenseSettings()`.

---

## Magic-link approval flow

```
Employee submits expense (amount > threshold or PR)
       │
       ▼
expense-request-notify function
  1. Generate unique magic token (stored in expense_approvals table)
  2. Build approval URL: /expense/approve/{token}
  3. Send email to manager_email via SendGrid/Resend
       │
       ▼
Manager clicks link (NO login required)
       │
       ▼
ApprovalPage.tsx
  1. GET expense-request-decide?token=...
     → validates token, checks expiry, returns request details
  2. Manager reviews: vendor, amount, category, line items, memo
  3. Signs on signature pad (react-signature-canvas, pen #1F4E79)
  4. Clicks Approve or Deny (deny requires reason_note)
       │
       ▼
  5. POST expense-request-decide
     → { token, decision, reason_note?, signature_data (base64 PNG) }
     → records: decided_by, decided_at, ip_address, user_agent
       │
       ▼
  6. If approved → status='approved', trigger QBO bill creation
     If denied  → status='denied', notify submitter
```

### Audit trail

Every approval/denial records: decision, decided_by (email),
decided_at (timestamp), signature_url (PNG stored in Supabase Storage),
ip_address, user_agent, reason_note. This is the `ExpenseApproval` type
in `types/expense.ts`.

---

## Data layer

### Supabase project

- **Project ref:** `gfsdpwiqzshhexkofiif` (shared with Margin Control,
  Melt, APBG-OPS)
- **URL:** `https://gfsdpwiqzshhexkofiif.supabase.co`
- **Schema:** `ops` (same as Margin Control)
- **Auth:** anon key embedded in bundle (`app-expense/src/lib/supabase.ts`).
- **User auth:** Supabase Email/Password. `@brixbev.com` credentials.

### Database tables (ops schema)

> **Status: NOT YET CREATED.** The frontend is built against these table
> shapes but no Supabase migrations exist yet. These are the first
> migrations to write.

#### `ops.expense_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, default gen_random_uuid() |
| `type` | text | 'expense' or 'purchase_request' |
| `status` | text | draft/pending/approved/denied/awaiting_invoice/fulfilled/posted |
| `submitted_by` | uuid | FK to auth.users.id |
| `vendor_name` | text | |
| `total_amount` | numeric(12,2) | |
| `receipt_date` | date | expense: receipt date; PR: needed-by date |
| `cogs_account_id` | text | QBO account ID |
| `cogs_account_label` | text | human-readable account name |
| `tag` | text | business tag (e.g. entity) |
| `department` | text | conditional on tag |
| `customer_name` | text | optional |
| `job_number` | text | optional |
| `memo` | text | |
| `line_items` | jsonb | array of { description, qty, unit_price, amount } |
| `manager_email` | text | set when approval required |
| `approval_threshold` | numeric | threshold at time of submission |
| `linked_pr_id` | uuid | nullable; links expense to originating PR |
| `qbo_bill_id` | text | QBO Bill DocNumber after posting |
| `margin_result` | jsonb | nullable; margin analysis data |
| `created_at` | timestamptz | default now() |
| `updated_at` | timestamptz | default now(), trigger on update |

RLS policy: users see only their own requests (`submitted_by = auth.uid()`)
plus requests where they are the `manager_email`. The `/approve/:token`
path uses a Netlify function (server-side, service_role key) to bypass
RLS.

#### `ops.expense_request_attachments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `request_id` | uuid | FK to expense_requests.id |
| `file_name` | text | original filename |
| `file_type` | text | MIME type |
| `file_size` | integer | bytes |
| `storage_path` | text | path in Supabase Storage bucket |
| `ocr_result` | jsonb | parsed receipt data from OCR |
| `created_at` | timestamptz | |

Storage bucket: `expense-attachments` (private, RLS-gated).

#### `ops.expense_approvals`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `request_id` | uuid | FK to expense_requests.id |
| `decision` | text | 'approved' or 'denied' |
| `decided_by` | text | manager email |
| `decided_at` | timestamptz | |
| `signature_url` | text | Supabase Storage path to signature PNG |
| `ip_address` | text | audit trail |
| `user_agent` | text | audit trail |
| `reason_note` | text | required for denials |
| `magic_token` | uuid | unique token for magic-link auth |
| `token_expires_at` | timestamptz | expiry (e.g. 72h from creation) |
| `token_used_at` | timestamptz | null until decision is made |

#### `ops.expense_settings`

Key/value store. The `useExpenseSettings()` hook reads all rows and
parses them client-side.

| Column | Type | Notes |
|---|---|---|
| `key` | text | PK: approval_threshold, manager_emails, cogs_accounts, tags, departments |
| `value` | jsonb | parsed by type: number for threshold, array for the rest |
| `updated_at` | timestamptz | |

Known keys:

| Key | Value shape | Default |
|---|---|---|
| `approval_threshold` | number | 500 |
| `manager_emails` | string[] | [] |
| `cogs_accounts` | `{ id: string, label: string }[]` | [] |
| `tags` | string[] | [] |
| `departments` | string[] | [] |

---

## Netlify functions

> **Status: NOT YET CREATED.** The frontend calls these four endpoints.
> They are the first backend work to build.

All expense functions live at `netlify/functions/expense-request-*.mjs`
(ESM, Node 18+). They use the Supabase **service_role** key (env var)
to bypass RLS for cross-user operations.

### `process-inbound`

Receipt OCR processing. Called by `ExpenseForm.tsx` upload step.

- **Method:** POST
- **Input:** multipart form with receipt image/PDF
- **Output:** `{ vendor_name, total_amount, receipt_date, line_items[] }`
- **Integration:** TBD — options include Veryfi, Mindee, Google Document
  AI, or OpenAI Vision. The frontend is agnostic; it expects the JSON
  shape above.
- **Note:** This function name matches the existing AP-tool's inbound
  processing convention but is a separate implementation for expenses.

### `expense-request-notify`

Sends magic-link approval email to the designated manager.

- **Method:** POST
- **Input:** `{ request_id }`
- **Flow:**
  1. Read the expense request from DB (service_role)
  2. Generate a magic token (UUID), insert into `expense_approvals`
     with `token_expires_at` (72h)
  3. Build approval URL: `https://alamedapointbg.com/expense/approve/{token}`
  4. Send email via SendGrid or Resend (env-configured) to `manager_email`
  5. Return `{ success: true }`

### `expense-request-decide`

Validates magic tokens and records approval/denial decisions.

- **Method:** GET (validate token) + POST (record decision)
- **GET** `?token={uuid}`:
  1. Look up token in `expense_approvals`
  2. Check not expired (`token_expires_at > now()`)
  3. Check not already used (`token_used_at IS NULL`)
  4. Return the full expense request details for display
  5. Return 410 if expired, 409 if already decided
- **POST** `{ token, decision, reason_note?, signature_data }`:
  1. Validate token (same checks as GET)
  2. Upload signature PNG to Supabase Storage
  3. Update `expense_approvals`: decision, decided_by, decided_at,
     signature_url, ip_address, user_agent, reason_note, token_used_at
  4. Update `expense_requests.status` to 'approved' or 'denied'
  5. If approved: trigger `expense-request-link-bill` (or call inline)
  6. Return `{ success: true, decision }`

### `expense-request-link-bill`

Creates a QBO bill for an approved expense.

- **Method:** POST
- **Input:** `{ request_id }`
- **Flow:**
  1. Read the expense request (service_role)
  2. Map fields to QBO Bill object:
     - VendorRef → vendor_name (look up or create QBO vendor)
     - Line items → QBO bill lines with AccountRef from cogs_account_id
     - DepartmentRef from department
     - TxnDate from receipt_date
     - PrivateNote from memo
  3. POST to QBO API (using token from `ops.qbo_token_cache`)
  4. Update `expense_requests.qbo_bill_id` with the new Bill DocNumber
  5. Update status to 'posted'
  6. Return `{ success: true, qbo_bill_id }`

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
| Manager queue | Supabase Email/Password | Employees whose email appears as `manager_email` on pending requests |
| Magic-link approval | Token-based, no auth | Managers clicking the email link |
| Netlify functions | service_role key | Server-side only; anon key never used in functions |

---

## What's in scope vs. out

### In scope for Brixpense

- Expense receipt submission with OCR pre-fill.
- Purchase request submission (no receipt).
- Threshold-based auto-approval vs manager approval.
- Magic-link manager approval with signature capture.
- QBO bill creation for approved expenses.
- Submission history (per-user) and manager approval queue.
- Configurable settings (threshold, COGS accounts, tags, departments).

### Out of scope (lives elsewhere)

| Concern | Where it lives |
|---|---|
| Vendor bill processing (AP) | `apbg-billing/public/*.html` (legacy AP tool) |
| Sales / margin analytics | `apbg-billing/app/` (BRIX Margin Control) |
| Operations KPIs | `skypace/APBG-OPS` |
| QBO sync (read path) | `sync-qbo` Supabase edge function |
| QBO writeback (items) | `push-qbo-item` Supabase edge function |

---

## Known gaps + build backlog

1. **No Supabase migrations exist.** The frontend is fully built against
   the table shapes documented above, but zero `supabase/migrations/*expense*.sql`
   files have been created. This is the **first** backend task.

2. **No Netlify functions exist.** All four functions (`process-inbound`,
   `expense-request-notify`, `expense-request-decide`,
   `expense-request-link-bill`) are referenced by the frontend but have
   no implementation. This is the **second** backend task.

3. **OCR provider not chosen.** `process-inbound` needs an OCR backend.
   Options: Veryfi, Mindee, Google Document AI, OpenAI Vision. The
   frontend is provider-agnostic — it only cares about the output JSON
   shape.

4. **Email provider not confirmed.** `expense-request-notify` needs
   SendGrid or Resend. Both are referenced in the repo's env vars
   (from the AP tool), but the expense notification templates don't
   exist yet.

5. **No mobile sidebar.** `globals.css` hides the sidebar below 768px
   but provides no hamburger menu or alternative navigation. Mobile
   users currently see only the main content area with no nav.

6. **No admin settings UI.** The `expense_settings` key/value table is
   read by `useExpenseSettings()` but there's no admin page to manage
   threshold, COGS accounts, tags, or departments. Currently requires
   direct Supabase edits.

7. **`netlify.toml` needs updating.** The build command needs
   `npm install --prefix app-expense && npm run build --prefix app-expense`
   appended to the existing build pipeline. The gateway proxy for
   `/expense/*` may also need configuration.

8. **No sync-manifest entry.** If expense functions write to `ops.*`
   tables, `architecture/sync-manifest.json` must be updated or the
   lint gate will fail the build.

9. **Entity split not yet wired.** The `tag` field on expense requests
   maps to entity (brix/AS, freeflow/FF, shared) but the form doesn't
   enforce the entity-to-department-to-COGS-account cascade documented
   in CLAUDE.md's business rules.

10. **No edit flow for submitted requests.** The `/edit/:id` route
    exists but `ExpenseForm.tsx` doesn't load existing request data —
    it always starts fresh. Edit/resubmit flow is not implemented.

---

## File ownership rules

These files belong to Brixpense. **Do not modify files outside this
list** when working on Brixpense:

| Path pattern | What it is |
|---|---|
| `app-expense/**` | All frontend source |
| `public/expense/**` | Vite build output (committed) |
| `netlify/functions/expense-request-*.mjs` | Backend functions |
| `netlify/functions/process-inbound.mjs` | OCR receipt processing |
| `supabase/migrations/*expense*.sql` | Database migrations |
| `architecture/BRIXPENSE.md` | This document |

**Do not touch** when working on Brixpense:

- `app/` — BRIX Margin Control source
- `public/sales-next/` — Margin Control build output
- `public/sales/` — legacy SPA
- `public/*.html` — AP billing tool
- `netlify/functions/` (non-expense functions)
- Any other `architecture/` files (unless sync-manifest needs an entry)

---

## Where to look next

| Need to … | Go to … |
|---|---|
| Create the database tables | Write `supabase/migrations/YYYYMMDD_create_expense_tables.sql` with the schema above |
| Build the first Netlify function | `netlify/functions/expense-request-decide.mjs` (unblocks the approval flow) |
| Add OCR | `netlify/functions/process-inbound.mjs` — pick a provider, implement the POST handler |
| Send approval emails | `netlify/functions/expense-request-notify.mjs` — SendGrid or Resend |
| Create QBO bills | `netlify/functions/expense-request-link-bill.mjs` — mirror the AP tool's bill creation pattern |
| Add a new page | `app-expense/src/pages/NewPage.tsx`, register in `App.tsx` routes |
| Add a new component | `app-expense/src/components/` (app-level) or `components/ui/` (primitives) |
| Change theme tokens | `app-expense/tailwind.config.ts` + `src/styles/globals.css` |
| Add a settings admin UI | New page under `pages/`, new route in `App.tsx`, new sidebar item in `AppShell.tsx` |
| Update sync-manifest | `architecture/sync-manifest.json` — add expense function writers |

---

## Change log

| Date | Change |
|---|---|
| 2026-05-12 | Initial BRIXPENSE.md. Documents frontend architecture (7 pages, component tree, routing, types, hooks, theme), database schema (4 tables), Netlify function contracts (4 endpoints), expense lifecycle, magic-link approval flow, and build backlog. All backend infrastructure (migrations + functions) is pending. |
