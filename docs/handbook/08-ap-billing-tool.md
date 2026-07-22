# 3rd-Party Billing (AP Tool) — Vendor Bills, OAuth Setup & Freshpet Billing

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

The AP tool at https://alamedapointbg.com/billing/ is the original vendor-bill processor: drop a vendor bill PDF, AI extracts it, a human reviews and approves, and a real QuickBooks bill (and optionally a marked-up customer invoice) is created. This chapter covers the daily AP workflow, the OAuth setup page that keeps QuickBooks and Service Fusion connected, and the Freshpet billing functions that share this backend.

> **⚠ Daily-driver warning.** This tool processes real accounts-payable every day. It is at the top of the repo's "do not break" list — `public/*.html` + `netlify/functions/` in `apbg-billing`. Test changes on a deploy preview, never straight on production.

## Where it lives

| Surface | URL | Source |
|---|---|---|
| Billing loader (PDF drop) | https://alamedapointbg.com/billing/ | `public/index.html` |
| Bill review & approve | https://alamedapointbg.com/billing/approve.html | `public/approve.html` |
| OAuth setup (QBO + SF) | https://alamedapointbg.com/billing/setup.html | `public/setup.html` |
| Legacy PACER Ops Dashboard | `/billing/dashboard.html` | `public/dashboard.html` |
| Backend | Netlify Functions (`netlify/functions/*.mjs`) | same repo |

Everything is vanilla HTML + JS served by Netlify, proxied through the gateway. Function endpoints require an authenticated APBG session (`requireAuth` in `lib/auth.mjs`); setup.html is superadmin-only.

## The vendor-bill flow: drop → extract → approve → QBO

### 1. Drop the bill

Open `/billing/`. The loader is a single card: **"Drop vendor bill PDF here"** (or click to browse; images work too). The file goes to the `process-inbound` function, which sends it to the Claude API with a strict JSON-extraction prompt and returns vendor name, bill number, dates, line items, subtotal, tax, and total. On success you're redirected to the review form with a signed token (`approve.html?token=…`). There's also an **"Enter a bill manually →"** link that opens the same form blank.

### 2. Review & approve

`approve.html` shows the scanned summary (vendor, bill meta) above an editable form:

- **Vendor** — searchable dropdown against QBO vendors (`get-vendors`). If the vendor doesn't exist, the dropdown offers a **create** option that calls `create-vendor` and makes the vendor in QuickBooks on the spot (display name, optional company/email/phone).
- **Location / Customer** — required; picks the QBO customer the cost is tied to.
- **Account** — the QBO expense account the bill posts against.
- **Job number** — required; goes into the bill for traceability.
- **Line items** — description / qty / unit cost rows with a computed total bar.
- Bill number, due date, memo.

Pressing **Approve** calls `approve-bill`, which creates the **QBO Bill**: one `AccountBasedExpenseLineDetail` line per row, `AccountRef` = your chosen account, `CustomerRef` = the location, `BillableStatus: NotBillable`, then sends a confirmation email to the AP approval address.

### 3. Optional: bill the customer back

`create-invoice` builds the pass-through **customer invoice with a markup %**: each vendor-bill line is re-priced at `unit cost × (1 + markup %)`. Defaults: the "Sales" item (388) posting to Equipment Sales income (32); service work uses "Service Provided" (365) → Service Income (35). Customer, line items, and a markup percentage are required.

### Service Fusion expenses → QBO bills

`expense-to-bill` is the sibling path for Service Fusion job receipts (the 💰 Bill action in the ResQ/SF workflow): GET lists an SF job's expenses; POST scans the receipt with Claude, matches the QBO vendor, and creates the bill. Its category → account map: `equipment` → Equipment Sales COGS (42), `service` → Service COGS (101, the default). If the job's facility matches a linked customer in `ops.sync_customers`, the bill gets a `CustomerRef`. After creating the bill it also lands a posted expense row in Brixpense tagged `Service Fusion` — see [Brixpense](#/07-brixpense).

## setup.html — QBO + Service Fusion OAuth (fix expired tokens HERE)

https://alamedapointbg.com/billing/setup.html (superadmin-gated) has two buttons:

| Button | What it authorizes | Callback |
|---|---|---|
| **Connect to QuickBooks** | The apbg-billing Intuit app against realm `9130352144155116` (customers, vendors, bills, invoices) | `https://apbg-billing.netlify.app/.netlify/functions/oauth-callback` |
| **Connect to Service Fusion** | The shared SF OAuth connection (customer creation, jobs, expenses) | `https://apbg-billing.netlify.app/.netlify/functions/sf-oauth-callback` |

Operational facts you need when things break:

- **Tokens expire.** OAuth refresh tokens eventually go stale (or get revoked). When QBO or SF calls start failing with auth errors, a superadmin re-runs the relevant Connect button on this page. That's the whole fix.
- **The SF token is SHARED.** The Service Fusion token in `ops.sf_token_cache` is used by apbg-billing **and** the ResQ ↔ Service Fusion sync (`skypace/apbg-resq-sync`). When the SF refresh token expired on 2026-06-29 (`Invalid refresh_token`), the ResQ sync was down until someone re-authenticated via setup.html. If Master Control shows the ResQ sync stalled, check SF auth here first.
- **Never edit token caches directly.** `ops.qbo_token_cache` and `ops.sf_token_cache` are managed via lease RPCs / the Netlify Blobs token store (`qbo-helpers.mjs` caches QBO tokens with a refresh lock). Manual edits cause concurrent-refresh storms.
- **One realm, many Intuit apps.** Several apps (apbg-billing, pacerfinance MCP, melt-dashboard, apbg-finance) each have their own Intuit client ID and redirect URI pointed at the same QBO company. Re-authing here fixes only the apbg-billing connection — an unfamiliar redirect URI belongs to a sibling app, not an orphan.

## Freshpet billing (summary)

Five functions serve the Freshpet admin console (the back-office at `/freshpet/admin.html`, repo `activespacescience/Fresh-Pet`). They authenticate the caller against the **Freshpet Supabase project** (`mmkncrsaijexezmhfmiw`, admin role required) but use this repo's QBO connection to write to QuickBooks:

| Function | What it does |
|---|---|
| `freshpet-invoice` | PM billing → one QBO invoice to the FRESH PET customer (QBO id 759) summarizing selected completed PMs. `preview` mode computes totals with no writes; `create` posts the invoice, marks PMs billed, renders the invoice PDF + a CSV visit report, and optionally emails them. |
| `freshpet-quarterly-invoice` | The Reactive contract: quarterly retainer priced per **out-of-warranty** cooler from an imported asset batch. One QBO invoice (FP-QRB-#### numbering), PDF page 1 = branded invoice, page 2+ = the full asset/warranty report, stored to the `fp-invoices` bucket. |
| `freshpet-payout-bill` | The payout side — a QBO **A/P bill** paying a technician (vendor = the tech) for completed PMs at count × rate, against the payout expense account (default Service COGS 101). Stamps PMs `paid_out`. Independent of the `billed` flag. |
| `freshpet-send-invoice` | Send / re-send the branded "your invoice is ready" email for an existing invoice, with the PDF attached (PM emails also link to the customer portal). No QBO or DB writes. |
| `freshpet-invoice-email` | The shared email template renderer (navy Brix branding) — not called directly. |

All money-writing Freshpet functions re-read the selected records server-side so line counts and amounts can't be tampered with client-side, and support preview-before-create.

## The legacy dashboard

`/billing/dashboard.html` is the original PACER Ops Dashboard (Executive / Delivery / Service / Reman / Fleet / HR / Roster tabs reading Supabase directly). Its agenda largely moved to BRIX Refractor and `skypace/APBG-OPS` (`/operations/`); it still loads but is not the primary surface for anything.

## Related

- [Brixpense — Expenses & Purchase Requests](#/07-brixpense) — where SF job expenses land
- [Master Control — Health, ResQ Sync, Linked Customers, Maintenance & Sweeps](#/09-master-control) — ResQ sync status + linked customers (`ops.sync_customers`)
- [BRIX Refractor (Margin Control)](#/06-refractor-margin-control) — the analytics side of the same repo
- [SOP-1 · Security & Access](#/21-sop-security-access) — credential and token-handling rules
- Repo orientation: `apbg-billing/CLAUDE.md`
