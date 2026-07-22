# Brix Order /admin — Staff Console (Customers, Onboarding, Payments, Audits)

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

This chapter is the staff manual for the Brix Order admin console at **https://orders.brixbev.com/admin** — the back office behind the customer portal. It covers every tab: taking phone orders, enabling and managing customers, reviewing new-account applications, running the payment-processor cutover console, approving tank audits, and maintaining the AI knowledge base. It is written for owners, ops, and accounting staff who hold superadmin access.

## Who can access

- Access is gated on `orders.customer_users.is_superadmin = true` in the shared Supabase project. Non-superadmins who hit `/admin` are redirected to `/home`.
- Every admin endpoint requires a Bearer JWT plus the superadmin check (`_lib/admin-auth.ts`); database reads are additionally protected by superadmin RLS policies. Actions are written to `orders.admin_audit_log`.
- Staff who sign in land directly on **/admin/quick-order** (customers land on `/home`).
- Drivers are a separate flag (`is_driver`) managed from the Audits tab — a driver is not a superadmin.

## Tab map

| Tab | URL | What it's for |
|---|---|---|
| Quick order | https://orders.brixbev.com/admin/quick-order | Phone-order launchpad; act-as-customer entry point |
| Customers | https://orders.brixbev.com/admin/customers | Customer lifecycle (Active / Inactive / Closed), per-customer detail |
| Onboarding | https://orders.brixbev.com/admin/onboarding | New-account application queue (from `/apply`) |
| Billing | https://orders.brixbev.com/admin/billing | Billing Run — send invoices/statements in batch |
| Payments | https://orders.brixbev.com/admin/payments | Processor cutover console, returned payments, Stripe payouts |
| Audits | https://orders.brixbev.com/admin/audits | Tank Rental Audits + driver management |
| Knowledge | https://orders.brixbev.com/admin/knowledge | KB docs the AI assistants use + voice teachings |
| Company | https://orders.brixbev.com/admin/company | Company email identity, Bill & Pay migration export |

## Quick order — phone orders

The first tab and the staff landing page. A searchable list of enabled customers, each row with **Start order** and a **Manage** link. Favorites (★) sort first; a **credit-hold badge** warns you before you key in an order that submit will block.

### Taking a phone order

1. Open https://orders.brixbev.com/admin/quick-order (you land here on login).
2. Search for the customer. If they're not in the list, they haven't been enabled — see [Enabling a customer](#customers) below.
3. Click **Start order**. This calls `set_active_customer` and drops you into the Shop (`/order`) under that customer's pricing and locations.
4. Build the cart and submit exactly as a customer would. The sidebar always shows a static "Ordering for &lt;customer&gt;" chip so you never lose track of whose account you're in; use its "Change customer →" link to return to Quick order. There is deliberately **no customer dropdown** for staff.
5. Admin-entered orders go through the same `submit-order` pipeline as customer orders (SF job category "Brix Web Order") and send the confirmation email to the submitter **plus the customer's Primary email**.

### Act-as model

- "Acting as" is persisted server-side (`customer_users.active_customer_id`) — it survives tabs and devices until you change it.
- From a customer's detail page you can also **Act as customer** (lands on their `/home`) or **Start order** (lands on Shop), and toggle the **★ Favorite** that feeds your Quick-order sort.

## Customers

### Lifecycle tabs

The index at `/admin/customers` has three pill tabs:

| Tab | Meaning | Row actions |
|---|---|---|
| Active | Set up on the web (enabled in `orders.customers`) | Manage → detail page |
| Inactive | Open QBO account, never set up in the portal | **Enable** |
| Closed | Deactivated / closed accounts | Reactivate, Manage |

### Enabling a customer

1. Find the customer on the **Inactive** tab (this list is the `ops.qbo_customers` QBO mirror, minus anyone ever enabled).
2. Click **Enable**. This upserts `orders.customers` from the QBO mirror and imports the QBO sub-customers as `customer_locations` (stripping the `Parent:Sub` name prefix). Sub-accounts ARE the customer's locations — there is no separate locations feature.
3. New enables default to **all email notifications ON** (invoices, statements, reminders) and **paper OFF**, with `enabled_at = now()` as a cutoff so the customer never gets a blast of their QBO history — only documents created after enable.
4. Invite users from the detail page's Users tab (below).

Enable is idempotent and audit-logged. Defaults only apply on the first insert — re-enabling never clobbers notification settings someone turned off later.

### Per-customer detail page

Each enabled customer gets `/admin/customers/:id` with a header (name, QBO id, active/credit-hold status, 1:1-vs-master location mode, Act as customer / Start order / ★) and these tabs:

- **Overview** — account facts, status lifecycle, and addresses/locations. Actions: **Lock/Unlock ordering** (temporary hold — the customer can still sign in but submit blocks), **Deactivate / close account…** (routes to the guided Closure page — there is no instant deactivate any more), **Reactivate**, and **Refresh from invoices** (re-seeds the customer's My Collection / `customer_pricing` from their last 12 months of QBO invoice lines).
- **Users** — invite a new user (crypto-random temp password meeting the 8+/four-character-class Supabase policy; branded welcome email with a `/set-password` link), attach an existing user by email, set the membership role (Member / Admin / Accounts payable), resend welcome (optionally with a password reset), and detach. One user can belong to many customers via `customer_memberships`.
- **Pricing** — the per-customer price mirror (`orders.customer_pricing`). ⚠ Pricing's system of record is **Service Fusion** (SF → QBO); this mirror is derived from invoice history. Read `brix-order/docs/PRICING.md` before changing anything about prices.
- **Billing & comms** — the four email slots (Primary / Secondary / Optional / Accounting), each with per-email Invoices / Statements / Reminders checkboxes, plus feature toggles. Primary maps to `billing_email` and is the default recipient of everything.
- **Paper / mail** — DocuPost paper statements/invoices (mailed documents; the same PDF renderer as portal Download/Print).
- **Change requests** — inbox for account/address change requests submitted from the customer side (applied to SF best-effort).
- **Closure** — the guided account-closure workflow (next section).

### Closing an account (guided closure)

Closing is gated behind four live server-checked gates on `/admin/customers/:id/closure`. Start the closure from Overview → "Deactivate / close account…".

1. **Equipment** — no assets on site per the ERLS mirror (`ops.equipment_assets`). Can be overridden with a required note.
2. **Tanks** — cylinders either scheduled for pickup or reconciled by a **closure Tank Rental Audit** performed within the last 30 days.
3. **Balances** — open QBO balances across the parent + all sub-locations cleared, or a write-off attestation note (the actual write-off is done in QBO).
4. **Refunds** — answer "none" or build a **return order**: catalog picker → lines → the credit books in QBO as a **Credit Memo** (`qbo-return-order` edge function; SF hard-rejects negative amounts) and the physical pickup dispatches as a **$0 SF job** listing the returned items.

When all four gates are green, the red **Close account** button (confirm-gated) does the final sequence:

1. Flips `orders.customers.active = false`.
2. **QuickBooks:** deactivates the QBO customer (`qbo-customer-lookup` v2 `action: 'deactivate'`; QBO requires a $0 balance, which the balances gate guarantees).
3. **Service Fusion:** SF has no API archived flag, so a close-out ticket is created ("ACCOUNT CLOSED — INACTIVATE THIS CUSTOMER IN SERVICE FUSION…", category Internal Administrative Work Order) for a human to archive the customer in SF.
4. Any deactivation failure surfaces amber on the closed panel for manual follow-up — it never un-closes the account.

Cancelled and closed closure rows are kept as the audit record. See [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) for the policy side.

## Onboarding

The queue behind the public application at https://orders.brixbev.com/apply — a credit-app-grade form: business info + DUNS, Tax ID and resale certificate (text + document upload to the private `onboarding-docs` bucket), accounting/billing/orders/management contacts, delivery windows + special instructions, multiple delivery locations with ZIP-triggered address verification, optional credit application (Net 15/Net 30, 3 trade references), terms acceptance, and a required applicant signature.

### Reviewing and approving an application

1. Open https://orders.brixbev.com/admin/onboarding. Expand a row to see the full application: DUNS, tax id, delivery windows, contact cards, credit block (violet "Credit · Net 30" chip on the collapsed row), the terms-acceptance line with the signature image, and **doc links** (1-hour signed URLs to the tax-id / resale-cert uploads).
2. Click **Approve**. This creates the **Service Fusion customer** with the full application loaded: all contacts (typed by role, phones normalized to `XXX-XXX-XXXX`), custom fields "Tax ID" and "Resale Certificate" (⚠ these must be defined for customers in SF Settings — on rejection the create retries without them and surfaces `sf_warnings`), ~10-year signed doc links + delivery notes in private notes, Billing + every delivery location as SF service locations, and `is_taxable: true` when no resale cert was provided.
3. Approve also creates the **setup ticket** — an SF job (status "New Account Setup", category "Setup New Account", falling back to Unscheduled if SF rejects the pair): "NEW CUSTOMER — PLEASE MAKE SURE ALL CONTACTS ARE SET UP PROPERLY AND CLOSE THIS OUT AND INVOICE IT." Ops must close this ticket with a **$0 setup invoice** (zero out any auto-added fuel/hazmat fees) — posting it is what syncs the new customer into QuickBooks.
4. **Finish onboarding** lights up once the customer appears in the QBO mirror. The queue no longer waits on the nightly sync — an approved row that misses the mirror triggers a live QBO lookup (`qbo-customer-lookup`) so `qbo_ready` usually lights within minutes of the $0 invoice posting.
5. Click **Finish**. This enables the customer (same defaults as Enable), imports the application's delivery locations into `customer_locations`, creates the portal login, and sends the branded welcome email with a `/set-password` link.

## Billing

The **Billing Run** batch-sends invoices and/or statements to enabled customers (channels: email, or email + paper). Rows that aren't statement-enabled are skipped on the email channel and flagged in the run UI. Invoice emails attach the canonical pdf-lib invoice PDF — the exact same document as DocuPost paper mail and the portal's Download/Print. Per-customer one-off sends (Send invoice, Send statement, paper mail) live on the customer detail page's Billing & comms and Paper tabs.

## Payments

The dual-rail payment console. Every customer is on exactly one processor: **`billandpay`** (the bridge — Bill & Pay charges saved methods behind our UI and posts payments into QBO pre-applied) or **`qbo`** (the Intuit/QBO Payments rail). Details and policy: [SOP-4 · Billing & Payments](#/24-sop-billing-payments).

### Cutover console

Each row shows the processor badge, cutover status, and the customer's **live** Bill & Pay state (enrolled / username / autopay, matched by QBO id; a B&P outage degrades gracefully). Actions (all confirm-gated and audit-logged):

| Action | Effect |
|---|---|
| Start bridge | Verifies the B&P match, snapshots their autopay, opts them out of B&P's own invoice/reminder/statement emails (keeps payment confirmations + autopay pre-debit reminders) |
| Flip to QuickBooks | Manual switch to the `qbo` processor. Also happens **automatically** when a customer saves a payment method on the Intuit rail |
| Deactivate B&P | Final step after a flip; refused while the customer is still on the bridge |

### Returned payments inbox

Bounced ACH/checks are detected **automatically**: an hourly poller (`billandpay-returns-check`) pulls B&P's return log, persists new returns with NACHA reason codes, matches the customer + the original payment, flips that payment to `returned`, and emails an alert to service@brixbev.com (override: `BP_RETURNS_ALERT_TO`) linking to `/admin/payments?returns=1`. Returns older than 14 days are treated as historical backfill — persisted but auto-acknowledged with no alert (added after the first sync blasted 54 alert emails for 2022–2026 history).

Working the queue:

1. **Book return →** deep-links to the matched customer's Billing tab, where **Record returned payment** does the QBO bookkeeping (expense-swap against A/R + the $35 Returned Payment Fee invoice, via the `qbo-returned-payment` edge function).
2. **Mark handled** keeps the row visible as an acknowledged record.
3. **✕ Clear** (per row) or **Clear handled** (bulk) soft-dismisses rows out of the queue — they stay on record so dedup prevents any re-alert. Never hard-delete a recent return; it would just re-import on the next hourly sync.
4. **Sync now** forces a live pull outside the hourly schedule.

### Stripe payouts

The Stripe payout panel posts card-payment payouts as QBO Deposits (payment gross − Stripe fee = the bank credit, one-click matchable in the bank feed). This is normally automatic (payout webhook + a daily sweep that retries `needs_review`/`failed` rows); the panel's manual post button is the override when a payout is stuck.

## Audits

Oversight for the driver Tank Rental Audits (CR-ADJ adjustment invoices). Field procedure: [CO₂ Cylinder Audit PWA — Driver Field Guide](#/04-driver-cylinder-audit); policy: [SOP-5 · CO₂ Cylinders](#/25-sop-cylinders-audits).

### Audits list

Every audit, newest first, with status filter chips (including **Pending approval** and **Declined**), the CR-ADJ doc number, customer, delta summary, photo count, signer, a link to the CR-ADJ invoice, and a **Retry** button on `invoice_failed` rows (duplicate-safe: it re-links instead of double-booking if the original QBO write actually landed).

### Approving a held (net-shortage) audit

An audit whose total counted comes in **less** than the records skips the QBO write and lands in `pending_approval`; an alert email goes to service@brixbev.com (override: `AUDIT_APPROVAL_ALERT_TO`) linking to the review page.

1. Open the audit from the alert email or the Pending approval filter (`/admin/audits/:id`).
2. Review the full Tank Rental Audit document: system vs counted table, photo grid, driver + optional manager signatures.
3. Optionally **amend the final counts** in the editable table (records / driver count / stepper / live delta). The driver's signed counts are immutable; amendments land in `final_counts` and the invoice is built from them, with amended rows annotated on the document.
4. **Approve** (or "Approve with changes") books the CR-ADJ invoice; **Decline** records the decision with no invoice. Both stamp who/when/notes. Amendments that zero every delta close the audit as `balanced`.

### Drivers panel

Grant or revoke the `is_driver` flag by email (creates a customer-less profile shell when needed) — this is what admits someone to the driver PWA at https://orders.brixbev.com/audit (branded https://alamedapointbg.com/audit). Superadmins pass the driver gate automatically for testing.

## Knowledge

Manages `orders.kb_documents` — the grounding corpus for Mr. Bubbles and the Chloe/Ziggy phone line, and the content of the customer `/resources` library. The editor includes a **"Show in the customer Resources library"** checkbox (`customer_visible`): unchecked docs still answer in chat but never appear on `/resources`. Edits saved here are live immediately — no deploy. Below the docs list, the **Voice teachings** panel reviews the style/rule teachings Ziggy's training mode has persisted. Full coverage: [AI Assistants — Chloe & Ziggy Phone Line, Mr. Bubbles, Knowledge Base](#/05-voice-ai-assistants).

## Company

- **Company email identity** — "Primary Email" (the company AR inbox: Reply-To + remit-to on statements) and "Accounting Email" (BCC copy of every billing email). These are sender-identity config, not customer recipients.
- **Bill & Pay migration** — "Download cutover list (CSV)": pages through B&P customers + 12 months of transactions, aggregates portal-vs-other and ACH-vs-card activity, joins the QBO mirror and `orders.customers`, and sorts most-engaged first. Read-only by policy (the B&P client has no charge/write methods here); payment instruments are never exported — customers re-enter payment info (cards can't move for PCI reasons, ACH re-auth was rejected on NACHA grounds). Runbook: `brix-order/docs/BILLANDPAY-MIGRATION.md`.

## Related

- [Brix Order Portal — Customer Ordering, Billing & Resources](#/02-brix-order-portal) — the customer-facing side of the same app
- [CO₂ Cylinder Audit PWA — Driver Field Guide](#/04-driver-cylinder-audit) — the field half of the Audits tab
- [AI Assistants — Chloe & Ziggy Phone Line, Mr. Bubbles, Knowledge Base](#/05-voice-ai-assistants) — the Knowledge tab in depth
- [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) · [SOP-3 · Orders & Fulfillment](#/23-sop-orders-fulfillment) · [SOP-4 · Billing & Payments](#/24-sop-billing-payments) · [SOP-5 · CO₂ Cylinders](#/25-sop-cylinders-audits)
- Source docs: `activespacescience/brix-order` `CLAUDE.md` (session log), `ARCHITECTURE.md`, `docs/BILLANDPAY-MIGRATION.md`, `docs/PRICING.md`
