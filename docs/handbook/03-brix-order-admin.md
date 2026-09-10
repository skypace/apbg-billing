# Brix Order /admin — Staff Console (Customers, Onboarding, Payments, Audits)

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-08-26

This chapter is the staff manual for the Brix Order admin console at **https://orders.brixbev.com/admin** — the back office behind the customer portal. It covers every tab: taking phone orders, enabling and managing customers, reviewing new-account applications, reviewing emailed EDI purchase orders, accepting Order Desk email forwards, watching payments and returned payments, approving tank audits, and maintaining the AI knowledge base. It is written for owners, ops, and accounting staff who hold superadmin access.

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
| Payments | https://orders.brixbev.com/admin/payments | Quick sync invoices, returned payments, Stripe payouts |
| EDI orders | https://orders.brixbev.com/admin/edi | Review queue for emailed POs (chain customers like THE MELT) |
| Order desk | https://orders.brixbev.com/admin/order-desk | Staff-forwarded customer emails proposed as orders — review & accept |
| Links | https://orders.brixbev.com/admin/links | New-store onboarding links per chain / franchise company |
| Audits | https://orders.brixbev.com/admin/audits | Tank Rental Audits + driver management |
| Activity | https://orders.brixbev.com/admin/activity | Master log — orders, payments, changes, every outbound email; sortable, archivable |
| Knowledge | https://orders.brixbev.com/admin/knowledge | KB docs the AI assistants use + voice teachings |
| Company | https://orders.brixbev.com/admin/company | Company email identity, order fees, Order Desk config |

## Quick order — phone orders

The first tab and the staff landing page. A searchable list of enabled customers, each row with **Start order** and a **Manage** link. Favorites (★) sort first; a **credit-hold badge** warns you before you key in an order that submit will block.

### Taking a phone order

1. Open https://orders.brixbev.com/admin/quick-order (you land here on login).
2. Search for the customer. If they're not in the list, they haven't been enabled — see [Enabling a customer](#customers) below.
3. Click **Start order**. This calls `set_active_customer` and drops you into the Shop (`/order`) under that customer's pricing and locations.
4. Build the cart and submit exactly as a customer would. The sidebar always shows a static "Ordering for &lt;customer&gt;" chip so you never lose track of whose account you're in; use its "Change customer →" link to return to Quick order. There is deliberately **no customer dropdown** for staff.
5. Admin-entered orders go through the same `submit-order` pipeline as customer orders (SF job category "Brix Web Order"). The confirmation email routes via the customer's **Order updates** email selection (the fourth checkbox column on Billing & comms) — a STAFF submitter is deliberately dropped from the recipients, so keying in a phone order doesn't email you; the customer's selected addresses still get it.

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

- **Overview** — account facts, status lifecycle, and addresses/locations. Actions: **Lock/Unlock ordering** (temporary hold — the customer can still sign in but submit blocks), **Deactivate / close account…** (routes to the guided Closure page — there is no instant deactivate any more), **Reactivate**, and **Refresh from invoices** (re-seeds the customer's My Collection / `customer_pricing` from their last 12 months of QBO invoice lines). Also home to the **Delivery schedule card**: set the customer's delivery days ("Tuesdays & Fridays", or every two weeks anchored on a date) plus per-location overrides for chains whose stores run different routes. A schedule defaults every order (portal cart + EDI PO) to the next scheduled delivery day, and — when a location has no order in by the cutoff (default 4:00 PM PT the day before delivery) — sends a friendly reminder email that morning ("order by 4 PM today or it moves to your next delivery day"). Reminder recipients: the schedule's own list → the EDI order-notify list → the Primary email.
- **Users** — invite a new user (crypto-random temp password meeting the 8+/four-character-class Supabase policy; branded welcome email with a `/set-password` link), attach an existing user by email, set the membership role (Member / Admin / Accounts payable), resend welcome (optionally with a password reset), and detach. One user can belong to many customers via `customer_memberships`.
- **Pricing** — the per-customer price mirror (`orders.customer_pricing`). ⚠ Pricing's system of record is **Service Fusion** (SF → QBO); this mirror is derived from invoice history. Read `brix-order/docs/PRICING.md` before changing anything about prices.
- **Billing & comms** — the four email slots (Primary / Secondary / Optional / Accounting), each with per-email Invoices / Statements / Reminders / **Order updates** checkboxes (Order updates governs the order confirmed/scheduled/delivered emails; unchecking it everywhere silences them for that customer — the person who placed an order still gets its updates unless they're staff), plus feature toggles, the **EDI Orders & Invoicing** settings card (see the EDI orders section below), the account-documents vault, and the customer's communications history.
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

### Inviting a prospect (before they apply)

The **"Invited — waiting to hear back"** panel at the top of `/admin/onboarding` lets a superadmin get ahead of a prospect who hasn't filled out `/apply` yet. Click **Invite a new customer**, pick **Chain** or **Franchisee** (a tracking tag only — it doesn't change pricing, contracts, or what the application asks for), enter their email (+ optional contact name / internal notes), and send. They get a warm branded email with a "why Brix" bullet list and a link to `/apply?invite=<token>` — the same full application everyone else fills out, just pre-tagged so it matches back to this invite on submission.

The panel tracks status (**Invited** → **Applied** / **Cancelled**) with per-row **Resend** and **Cancel**, so the queue always shows who you're still waiting to hear back from. A matched request row shows a small teal category chip. This is a different mechanism from the shared per-chain `/apply/:token` link (see [SOP-2](#/22-sop-customer-lifecycle) and the **Links** tab) — that one is a static URL handed to a chain's corporate office and skips terms/credit/tax docs because the chain's master account already covers those; an invite here is a single tracked email to one prospect who still fills out the full credit application.

### Reviewing and approving an application

1. Open https://orders.brixbev.com/admin/onboarding. Expand a row to see the full application: DUNS, tax id, delivery windows, contact cards, credit block (violet "Credit · Net 30" chip on the collapsed row), the terms-acceptance line with the signature image, and **doc links** (1-hour signed URLs to the tax-id / resale-cert uploads).
2. Click **Approve**. This creates the **Service Fusion customer** with the full application loaded: all contacts (typed by role, phones normalized to `XXX-XXX-XXXX`), custom fields "Tax ID" and "Resale Certificate" (⚠ these must be defined for customers in SF Settings — on rejection the create retries without them and surfaces `sf_warnings`), ~10-year signed doc links + delivery notes in private notes, Billing + every delivery location as SF service locations, and `is_taxable: true` when no resale cert was provided.
3. Approve also creates the **setup ticket** — an SF job (status "New Account Setup", category "Setup New Account", falling back to Unscheduled if SF rejects the pair): "NEW CUSTOMER — PLEASE MAKE SURE ALL CONTACTS ARE SET UP PROPERLY AND CLOSE THIS OUT AND INVOICE IT." Ops must close this ticket with a **$0 setup invoice** (zero out any auto-added fuel/hazmat fees) — posting it is what syncs the new customer into QuickBooks.
4. **Finish onboarding** lights up once the customer appears in the QBO mirror. The queue no longer waits on the nightly sync — an approved row that misses the mirror triggers a live QBO lookup (`qbo-customer-lookup`) so `qbo_ready` usually lights within minutes of the $0 invoice posting.
5. Click **Finish**. This enables the customer (same defaults as Enable), imports the application's delivery locations into `customer_locations`, creates the portal login, and sends the branded welcome email with a `/set-password` link.

## Billing

The **Billing Run** batch-sends invoices and/or statements to enabled customers (channels: email, or email + paper). Rows that aren't statement-enabled are skipped on the email channel and flagged in the run UI. Invoice emails attach the canonical pdf-lib invoice PDF — the exact same document as DocuPost paper mail and the portal's Download/Print. Per-customer one-off sends (Send invoice, Send statement, paper mail) live on the customer detail page's Billing & comms and Paper tabs.

## Payments

**Stripe is the only payment rail** (the Bill & Pay integration was removed 2026-08-12; the "Switched over to the new system" checkbox on each customer's Overview is a manual tracker of who has been turned off in the B&P console). Details and policy: [SOP-4 · Billing & Payments](#/24-sop-billing-payments).

- **Quick sync invoices** runs the QBO CDC sync on demand, so a payment made anywhere (check keyed into QBO, legacy links) flips the portal invoice to Paid immediately instead of on the 15-minute cron.
- **Returned payments inbox** — Stripe-detected bounces land here with reason codes. **Book return →** deep-links to the customer's Billing tab where **Record returned payment** does the QBO bookkeeping (expense-swap against A/R + the $35 Returned Payment Fee invoice); **Mark handled** keeps a visible record; **✕ Clear** / **Clear handled** soft-dismiss rows out of the queue (never hard-delete — dedup prevents re-alerts).
- **Stripe payouts** posts each Stripe payout as one QBO Deposit into Chase Business Checking (payment gross − Stripe processing fees − any Stripe account fee = the bank credit, one-click matchable in the bank feed). Normally automatic (payout webhook + a daily sweep at 15:47 UTC retrying `needs_review`/`failed` rows); **Reconcile** on a row re-runs it now, **Sweep** re-scans the window. Reading the row: **Posted** names the QBO deposit id — match the bank line to it. **Needs review** shows a reason: "no booked QBO Payment yet" (a charge, usually ACH, has not settled and booked — the hourly settlement sweep normally clears it) or "refund/dispute/adjustment" (there genuinely is one in the payout; book it via Returned payments, then Reconcile). Stripe's own monthly account fees (Financial Connections verification, Radar) are **not** a hold — since 2026-09-04 they post as their own labeled line on Merchant Processing Fees. The row's **fee** figure is everything Stripe deducted from that payout, processing and account fees together. Procedure and the deposit's line-by-line shape: [SOP-4 · Stripe payouts](#/24-sop-billing-payments).

## EDI orders — emailed POs (chain customers)

Chain customers like **THE MELT** don't use the portal — each store emails its PO to a dedicated address (e.g. `themelt@alamedapointbg.com`). The system reads the PO attachment, matches its line items to our catalog (their "Vendor Item #" is our SKU), resolves the store to a location, and creates the Service Fusion job through the same pipeline as every other order. The PO sender gets the order receipt and delivery updates; invoices route separately through the Billing comms email slots (Accounting Email + the Invoices checkbox).

- **Review queue** (`/admin/edi`): every PO holds here until reviewed unless the customer's **auto-submit** switch is ON (leave it OFF until a chain's POs prove reliable). Held reasons include unmatched lines, unresolved store, duplicate PO number, PO comments ("Test order — DO NOT SEND" really happened), and a printed price differing from our resolved price (**their PO never dictates pricing — we always bill our own resolved price**; a mismatch is a contract-pricing flag to check in Refractor → Pricing).
- **Review page** (`/admin/edi/:id`): the original PO beside the parsed data, a per-line match editor, location picker, PO#/date/notes, then **Submit order** or **Reject**. Every reviewed submit **teaches** the matcher (line + store aliases) so the next PO from that chain matches by itself.
- **Per-customer settings** live on the customer's Billing & comms tab (EDI Orders & Invoicing card): inbound address, sender allowlist, order-notification list, auto-submit, store aliases, extraction hints.

## Order desk — staff-forwarded email orders

The Order Desk turns a customer's emailed order into a submitted order without anyone re-typing it. **Staff forward the customer's email to `aiorders@alamedapointbg.com`** (only staff addresses are accepted — a customer emailing it directly is ignored); the system reads the forward, works out which customer it is (with the provenance stated — "matched forwarded sender joel@…"), matches the lines against that customer's own order history first, picks the next delivery-schedule date, and emails the forwarder a **proposal with Accept / Edit / Discard buttons**. Nothing ever auto-submits — a human always clicks.

- **Accept** (from the email, or the review page at `/admin/order-desk/:id`) submits through the same `submit-order` pipeline (SF category "Brix Email Order"); the customer gets the normal branded confirmation.
- **The queue** (`/admin/order-desk`) holds every forward — including ones where the customer or a line couldn't be resolved; the review page has an account picker and per-line item pickers with history quick-picks. The delivery date is read-only: it comes from the customer's delivery schedule, not the email.
- Accepting **teaches** the system: the forwarded sender is filed as a customer contact (next forward resolves instantly) and line corrections feed the matcher.
- **Configuration** is company-wide, on /admin → Company → Order desk: enable, inbound address, staff allowlist, proposal recipients, plus a "Check the intake" diagnostic.

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
- **Order fees** — the delivery-surcharge estimate toggles (fuel / hazmat / force-majeure / CRV / SSB), including the admin-managed beverage-tax cities + ZIP ranges. These govern the on-screen estimate; Service Fusion's own fee engine is what actually bills fuel/hazmat.
- **Order desk** — the Order Desk configuration card (see the Order desk section above): enable, inbound address, staff allowlist, proposal recipients, intake check.
- (The Bill & Pay migration export was removed with the B&P integration on 2026-08-12 — Stripe is the only rail; the per-customer "Switched over to the new system" checkbox remains as the manual tracker.)

## Related

- [Brix Order Portal — Customer Ordering, Billing & Resources](#/02-brix-order-portal) — the customer-facing side of the same app
- [CO₂ Cylinder Audit PWA — Driver Field Guide](#/04-driver-cylinder-audit) — the field half of the Audits tab
- [AI Assistants — Chloe & Ziggy Phone Line, Mr. Bubbles, Knowledge Base](#/05-voice-ai-assistants) — the Knowledge tab in depth
- [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) · [SOP-3 · Orders & Fulfillment](#/23-sop-orders-fulfillment) · [SOP-4 · Billing & Payments](#/24-sop-billing-payments) · [SOP-5 · CO₂ Cylinders](#/25-sop-cylinders-audits)
- Source docs: `activespacescience/brix-order` `CLAUDE.md` (session log), `ARCHITECTURE.md`, `docs/BILLANDPAY-MIGRATION.md`, `docs/PRICING.md`
