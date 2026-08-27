# SOP-2 · Customer Lifecycle — Application, Approval, Setup Ticket, Enable, Closure

> Part II · SOP Manual · Owner: Dani · Last reviewed: 2026-08-26

This SOP is the end-to-end procedure for bringing a customer onto APBG systems and taking them off again: the /apply application, admin review, Service Fusion creation, the NEW ACCOUNT SETUP ticket, portal enablement, ongoing holds, and the gated account-closure workflow. It is written for ops and admin staff working in the Brix Order admin console at `https://orders.brixbev.com/admin`.

## Lifecycle at a glance

| Stage | Where | Result |
|---|---|---|
| 0. Invite (optional) | `/admin/onboarding` → Invite a new customer | Tracked invite email, `orders.onboarding_invites` row |
| 1. Application | Customer fills `https://orders.brixbev.com/apply` (or `?invite=<token>`) | `orders.onboarding_requests` row + docs |
| 2. Review | `/admin/onboarding` | Verified application |
| 3. Approve | `/admin/onboarding` → Approve | SF customer + NEW ACCOUNT SETUP ticket |
| 4. Setup ticket close | Service Fusion | $0 setup invoice → customer syncs into QBO |
| 5. Finish onboarding | `/admin/onboarding` → Finish | Portal login + welcome email + locations |
| 6. Ongoing | `/admin/customers/:id` | Lock ordering / credit hold / comms config |
| 7. Closure | `/admin/customers/:id/closure` | Four gates → close → QBO + SF inactivation |

Customer admin tabs: **Active** (set up on the web) / **Inactive** (open account, not set up) / **Closed** (deactivated).

## Which system does a new customer start in?

**Always brix-order.** It is the front door for every customer, because product and delivery is the universal arm and the proven pipeline lives there: `/apply` → credit application → Service Fusion customer → setup ticket → QBO sync → portal login.

The **BRIX Foodservice Portal** (`/melt/`) is not a second onboarding. Foodservice equipment management is a different arm of the business that only *named individuals at some customers* ever use, so it is an **entitlement granted during onboarding here**, which provisions the portal tenant automatically.

| Customer buys… | Onboard in | Foodservice portal? |
|---|---|---|
| Product + delivery only | brix-order | no |
| Product + foodservice equipment management | brix-order | yes — tick the entitlement, then invite the specific people |
| A franchisee of an existing brand | brix-order, under its own QuickBooks parent | yes if they manage equipment — it lands as its own tenant under the brand |

**The grey area, resolved by contract rather than by system:** Alameda Soda fountain and ice equipment sold or leased under an *Alameda Soda* contract is beverage-arm revenue that is nonetheless *managed* in the foodservice portal (install, PM, warranty). Any other foodservice equipment is purely the equipment arm. Same portal, different contract — and the contract says which P&L it belongs to. Do not invent a new customer type for this.

### Policy

- A franchisee is **its own customer**, not a location of its franchisor. We sell to the operating company (e.g. Whiplash Holdings), it has its own QuickBooks parent, and it gets its own tenant. The brand link is for roll-up reporting only and merges no data.
- **Granting the entitlement creates no login.** Portal access is invited per person afterwards. If someone says "we onboarded them but they can't get in", that is the expected state — invite them.
- Provisioning is **idempotent on the QuickBooks customer id**, so re-ticking or a retried call returns the existing tenant instead of creating a duplicate. Never work around a perceived failure by creating the tenant a second time by hand.
- Imported locations arrive as **Planning / not trading, with no street address** — on a chain sub-customer QuickBooks holds the corporate address. Fill each one in as the store actually opens.

## Inviting a prospect (optional, before they apply)

### Policy

A superadmin who already knows a prospect wants an account doesn't have to wait for them to find `/apply` on their own. From `/admin/onboarding` → **Invite a new customer**, pick **Chain** or **Franchisee** (a tracking tag for the reviewer only — it does not shorten the application, alter pricing, or authorize a contract) and enter the prospect's email. This is distinct from the shared per-chain `/apply/:token` link (the **Links** tab) — that link is handed to a chain's corporate office and skips terms/credit/tax docs because the master account already covers them; an invite here goes to one named person who still completes the full credit application below.

### Procedure

1. Open `/admin/onboarding`. Expand the **Invited — waiting to hear back** panel and click **Invite a new customer**.
2. Choose Chain or Franchisee, enter the email (+ optional contact name / internal notes), and send.
3. The prospect receives a branded invite email with a link to `/apply?invite=<token>` — the same application everyone fills out.
4. Track status in the panel: **Invited** (no response yet — Resend or Cancel available), **Applied** (matched to a submitted application — review it normally, it carries a category chip), **Cancelled**.
5. A submission through the invite link matches back to the invite automatically; nothing further is required.

## New-customer application (/apply)

### Policy

Every new account comes in through the public application at `https://orders.brixbev.com/apply` — do not seed customer data by SQL. The application collects, and the submit function requires:

- Business information + DUNS number.
- Tax ID (text) and optional Tax ID document upload; resale certificate upload. **No resale certificate means the customer WILL be charged sales tax** (the form warns them; approval sets `is_taxable: true` in SF).
- Contacts: accounting contact + email, plus Billing / Orders / Management role contacts.
- Structured addresses (street / unit / city / state / ZIP) with automatic verification against the Census geocoder when the ZIP completes — "Did you mean…" suggestion or keep-as-entered; verification is optional and never blocks submission. Multiple delivery locations supported ("+ Add another delivery location").
- Delivery day/time windows and special instructions (gate codes, keys).
- Payment & credit: card-on-file default, or an optional credit application (Net 15/Net 30, entity type, years in business, bank, **3 complete trade references** required).
- Posted Terms & Conditions acceptance (versioned — `TERMS_VERSION` stamped on the request) + authorized-by name/title + a **required signature** (signature pad; the submission is rejected without it).

Uploaded docs land in the private `onboarding-docs` Storage bucket; admins read them via signed URLs only.

## Reviewing an application

### Procedure

1. Open `https://orders.brixbev.com/admin/onboarding`. New applications show in the queue; credit applications carry a violet "Credit · Net 30" chip.
2. Expand the detail and verify: business info, DUNS, contacts, delivery locations (✓ verified markers), delivery windows, special instructions.
3. Open the **Tax ID** and **resale certificate** doc links (1-hour signed URLs) and confirm they are legible and match the business.
4. If there is **no resale certificate**: the account is taxable — approval will set `is_taxable: true` on the SF customer. If a certificate is present, SF's default is left alone so a human verifies before flipping the customer tax-exempt.
5. For credit applications: check terms (Net 15/Net 30), entity type, bank, and the three trade references.
6. Confirm the terms-acceptance line and the applicant signature image render.

## Approve

### Policy

Approve creates the Service Fusion customer and the setup ticket. Service Fusion is the **single writer** — we never dual-create the customer directly in QBO. The customer reaches QuickBooks only via the $0 setup invoice (SF → QBO sync). **Why:** dual-writing risks duplicate QBO customers if SF's name-match ever misses (decision recorded 2026-07-09).

### What Approve does (automatic)

1. **SF customer create** with the full application loaded:
   - All contacts (primary + Accounting + Billing/Orders/Management, labeled via `contact_type`; phones normalized to SF's strict `XXX-XXX-XXXX` or dropped — one bad phone never sinks an approval).
   - Custom fields **Tax ID** and **Resale Certificate** (these must be defined in SF Settings first; if SF rejects them the approve retries without custom fields and surfaces `sf_warnings`).
   - Long-lived signed links to the tax-id/resale-cert docs written into SF private notes (SF has no document-upload API), plus delivery windows and special instructions.
   - Billing + every delivery location as SF service locations (deduped).
2. **NEW ACCOUNT SETUP ticket** — an SF job on the new customer, status **"New Account Setup"**, category **"Setup New Account"** (both must exist in SF Settings; if SF rejects them the ticket is retried as plain Unscheduled). Description: "NEW CUSTOMER — PLEASE MAKE SURE ALL CONTACTS ARE SET UP PROPERLY AND CLOSE THIS OUT AND INVOICE IT." Ticket creation is best-effort — a failure never sinks the approval; the queue tells you to create it by hand.

If SF rejects the approval outright, do not work around it with SQL — the SF customers API payload shape has changed under us before (July 2026: nested phones/emails, `street_1` locations), and the fix belongs in code.

## Ops: close the setup ticket at $0

### Policy

The $0 setup invoice is **the mechanism that syncs the new customer into QuickBooks** — and "Finish onboarding" is gated on the customer appearing in the QBO mirror. Closing this ticket is not optional paperwork; it unlocks the portal login.

### Procedure

1. In Service Fusion, open the setup ticket (the admin queue shows its job number).
2. Verify all contacts came across and are set up properly (that is the ticket's instruction).
3. **Zero any auto-added fees** (SF's fee engine may add fuel/hazmat to jobs on some customers) so the invoice posts at exactly $0.
4. Close the ticket and post the $0 invoice.
5. The SF→QBO sync mirrors the customer; the onboarding queue's "Finish onboarding" button lights up. A live QBO lookup backstops the daily mirror refresh, so this is typically minutes, not a day.

## Finish onboarding

### Procedure

1. On `/admin/onboarding`, the approved row's **Finish** button enables once the customer is in the QBO mirror (`qbo_ready`).
2. Click Finish. This: enables the customer in the portal (see enable defaults below), creates the portal login, sends the branded **welcome email** with a one-time set-password link, and imports the application's delivery addresses into the portal's customer locations (idempotent; best-effort — never blocks the login).
3. Confirm with the customer that the welcome email arrived; resend from the customer's Users tab if needed.

## Enable defaults

### Policy

On the **initial** enable of any customer (admin Enable button or onboarding Finish — same shared core):

- All email notifications **ON**: invoice emails, statements, reminders (each stamped `enabled_at = now()`).
- Paper invoices and paper statements **OFF** (DocuPost mail is opt-in later).
- Recipients default to the Primary email slot, so notifications route out of the box.
- The `enabled_at` timestamp is the **no-backlog cutoff**: a freshly enabled customer with QBO history only receives documents generated **after** enable — never a blast of their historical invoices.
- Defaults apply on insert only — re-enabling later never clobbers toggles an admin has since changed.

**Why:** a delivered-order invoice silently failed to email in July 2026 because the invoice-email toggle defaulted OFF per customer; the defaults were flipped ON-at-enable so every future customer notifies without manual setup (brix-order 1.67).

## Ongoing lifecycle controls

| Control | Where | Meaning |
|---|---|---|
| **Lock ordering** | Customer Overview tab | Temporary hold — ordering blocked, account otherwise live. The tool for short-term problems; not a closure. |
| **Credit hold** | Customer Overview tab | Flags the account; quick-order shows a warning badge and submit will block. |
| **Reactivate** | Customers list (Closed tab) | Re-opens a closed account. |
| Billing & comms | Billing tab | Four email slots + per-email routing — see [SOP-4](#/24-sop-billing-payments). |

## Account closure

### Policy

Closing an account is a **gated workflow**, not a button. From the customer Overview tab, "Deactivate / close account…" routes to the closure status page (`/admin/customers/:id/closure`). The final **Close account** button enables only when all four gates are green, and it is superadmin-only. Gate checks are computed live server-side and re-validated at close.

### The four gates

1. **Equipment** — all equipment removed from the ERLS and no longer showing on the account, **or** explicitly overridden with a required note.
2. **Tanks** — cylinders either scheduled for pickup, **or** an account-closure Tank Rental Audit performed **within the last 30 days** (see [SOP-5 · CO₂ Cylinders](#/25-sop-cylinders-audits)).
3. **Balances** — open balances cleared, or written off with a required attestation note. The actual write-off is booked in QBO by accounting — the closure note is the authorization record. QBO requires a $0 balance to deactivate a customer, so this gate is what makes the final step possible.
4. **Refunds** — answer the refund question: none, **or** build a **return order**. SF hard-rejects negative amounts, so the return order books as a **QBO Credit Memo** (from catalog lines) plus a best-effort **$0 SF pickup job** listing the returned items. The credit memo is the gate; the pickup job is reported if it fails.

### Procedure — close an account

1. Open the customer → Overview → "Deactivate / close account…" → **Start** the closure.
2. Work the four step cards. Each shows live data (on-site asset list, tank buckets, open-invoice total) and its inline action (override with note / resolve tanks / write off with note / resolve refunds or build the return order).
3. When all gates are green, click **Close account** (confirm-gated). If any gate regressed, the close is refused with the list of unmet gates.
4. Closing automatically:
   - Flips the portal customer inactive.
   - **Deactivates the customer in QuickBooks** (real `Active=false` sparse update).
   - **Tickets the Service Fusion inactivation** — SF has no API archived flag, so a close-out ticket (category "Internal Administrative Work Order") instructs ops: "ACCOUNT CLOSED — INACTIVATE THIS CUSTOMER IN SERVICE FUSION… close this ticket (no invoice)." A best-effort API archive attempt is also made.
5. **Check the closed panel for amber.** A failed QBO or SF deactivation never un-closes the account — it surfaces amber on the closure record for manual follow-up. Ops must clear any amber item by hand (deactivate in QBO/SF directly) and note it.
6. Cancelled and closed closure rows are kept as the audit record; every action is audit-logged.

## Related

- [SOP-1 · Security & Access](#/21-sop-security-access) — user provisioning and password policy
- [SOP-3 · Orders & Fulfillment](#/23-sop-orders-fulfillment) — what an enabled customer can do
- [SOP-4 · Billing & Payments](#/24-sop-billing-payments) — comms slots, payment rails, write-off booking
- [SOP-5 · CO₂ Cylinders](#/25-sop-cylinders-audits) — closure tank audits
- [Brix Order /admin — Staff Console](#/03-brix-order-admin)
- Source doc: `activespacescience/brix-order/CLAUDE.md` (sessions 1.25–1.36, 1.55, 1.67, 1.116)
