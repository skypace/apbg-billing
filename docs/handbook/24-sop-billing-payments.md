# SOP-4 · Billing & Payments — Invoices, Statements, Payment Rails, Returned Payments

> Part II · SOP Manual · Owner: Sky Pace · Last reviewed: 2026-07-22

This SOP covers how invoices and statements reach customers, the dual payment rails (the Bill & Pay bridge behind our UI vs the QBO/Stripe rails), how payments are taken and reflected, the returned-payments pipeline, Stripe payout reconciliation, and the posted fee terms. Audience: accounting, billing admins, and anyone working the `/admin/payments` console at `https://orders.brixbev.com/admin`.

## Invoice & statement delivery

### Policy

- Each customer has **four email slots** with **per-email routing** — every address can independently receive Invoices, Statements, and/or Reminders (checkboxes per row on the customer's Billing & comms tab, mirrored in the customer's own Settings):

| UI label | Stored column | Routing role |
|---|---|---|
| Primary Email | `billing_email` | billing |
| Secondary Email | `remittance_email` | remittance |
| Optional Email | `optional_email` | optional |
| Accounting Email | `accounting_email` | accounting |

- New customers default to all email notifications ON, routed to the Primary email; paper OFF (see [SOP-2 enable defaults](#/22-sop-customer-lifecycle)).
- **One canonical document:** invoice/statement PDFs are rendered by one server pipeline (`assembleInvoicePdf` / the statement equivalent). The DocuPost mailed paper, the portal Download/Print, and the email attachment all emit the **same PDF** — they cannot drift.
- Invoice emails (the hourly post-delivery send and the admin "Send invoice" action) **attach the invoice PDF** (`brix-invoice-<doc#>.pdf`). The attachment is best-effort: a broken render never blocks the notification email.
- **Paper (DocuPost) is opt-in** per customer, managed on the Paper/mail tab. It is never on by default.
- Company-side "Primary Email" and "Accounting Email" (on /admin → Company) are sender-identity config — the AR reply-to/remit-to and the BCC copy of every billing email — not customer recipients.

## Payment rails — the dual-rail model

### Policy

- Every customer is on exactly **one** payment rail at a time, flagged on the customer record: `billandpay` (the bridge) or `qbo` (the new Intuit/Stripe rails, default).
- **Bill & Pay bridge:** B&P remains the payment *processor* behind **our** portal UI. `/pay` lists the customer's saved B&P methods (masked to last4 server-side) and charges the selected one **by reference**. B&P posts the payment into QBO pre-applied — identical to how B&P payments always reconciled. B&P's own invoice/reminder/statement emails are opted out at bridge start (our portal sends those); B&P payment confirmations and autopay pre-debit notices stay on until deactivation.
- **Customers touch Bill & Pay's window exactly once — to save a card/bank.** Instrument entry opens B&P's hosted page embedded in our portal ("Save a card or bank", the wallet screen). Saving there does not charge anything and does not flip the customer. Raw card/bank data never touches our systems — see [SOP-1 · PCI posture](#/21-sop-security-access).
- **The flip (bridge → qbo) is one-way** and happens two ways, both stamped on the cutover record:
  1. **Automatically** — the customer saves a payment method on the new (Intuit-tokenized) rails; their B&P autopay is turned off.
  2. **Manually** — /admin → Payments → "Flip to QuickBooks" (phone cutovers).
- **Deactivate in B&P** only after the flip and after the last bridge payment settles (the console refuses deactivation while still on bridge). Deactivation silences B&P for that customer permanently.
- Bridge customers with live B&P **autopay** keep it running untouched during the bridge; the portal /autopay page shows their real B&P autopay state and hides the new-rails enrollment so double-enrollment is impossible. Flip autopay customers **last**, on the phone, once QBO Payments is live — the console snapshots their schedule/method as the call list.

### Procedure — put a customer on the bridge

1. /admin → Payments → find the customer row (live B&P columns show enrolled/username/autopay, matched by QBO id).
2. **Start bridge** (confirm-gated). Verify the processor badge flips to "Bill & Pay bridge" and the cutover badge reads "On bridge".
3. The customer can now pay in our portal against their existing saved B&P methods immediately — no QBO Payments dependency.

## Taking a payment

### Policy

- **Every payment goes through our tracked Pay button** on `/pay`. Never complete a payment inside Bill & Pay's hosted pages — a payment made there is invisible to our records: no `orders.payments` row, no receipt, the invoice still shows open, and a double-charge becomes possible.
- On success (both rails) the system automatically sends a **payment receipt email** (to the customer's Primary email + the submitter, deduped, BCC service@brixbev.com) and **nudges the QBO CDC sync** so the invoice flips to Paid within seconds instead of the 15-minute cron.
- **Processing → Paid semantics:** a just-paid invoice shows **Processing** until the QBO mirror reflects the zero balance, then **Paid**. Processing can never mask Paid — the badge only renders while the mirror still shows the invoice open. Honest limit: the paid status comes from the QBO mirror, which we cannot write; if B&P batches the charge, QBO doesn't have it yet and the flip waits for B&P's posting (the receipt email is the immediate acknowledgment).

**Why:** in July 2026 the "add payment method" button briefly opened B&P's make-a-payment page; a payment completed there left no record, no notification, and an invoice that still showed open — the wallet-only screen + tracked-Pay rule is the fix (brix-order 1.64).

### Procedure — take/verify a payment (staff)

1. Customer (or staff acting for them) selects invoices on `/pay` and a saved method, then presses **Pay $X**.
2. Confirm the success screen and that the receipt email went out.
3. Expect the invoice to read Processing, then Paid within moments (or after B&P's batch posts). If it stays Processing past a day, check the payment row and the QBO side before re-charging anything.

## Returned payments (ACH/check bounces)

### Policy

- Detection is **automatic**: an hourly job pulls Bill & Pay's return feed (NACHA reason code + text, amount, original transaction), persists each new return (deduped on the B&P return id), matches it to the payment row it bounced from and flips that payment to `returned`, and emails an alert to service@brixbev.com (override: `BP_RETURNS_ALERT_TO`) linking to **/admin/payments?returns=1**.
- Returns older than **14 days** at first sight are treated as historical backfill: persisted for the console but auto-acknowledged, **no alert email**. **Why:** the first sync after credentials went live blasted 54 alert emails for bounces dating back to 2022 (2026-07-11).
- Two halves, not duplicates: the **/admin/payments Returned-payments panel is the inbox** (what bounced, needs attention/handled); the **customer's Billing tab "Record returned payment" is the bookkeeping** — the QBO expense-swap plus the **$35 Returned Payment Fee invoice** (Expense/Check against A/R on the deposit bank account so the bank-feed clawback matches, original Payment re-linked so the deposit stays reconciled and the invoice reopens).
- **Mark handled** = acknowledged, stays visible as a record. **Clear** = dismissed from the queue (soft-clear — the row survives so the dedup can never re-alert). Never hard-delete a recent return; it would just re-pull on the next sync.

### Procedure — work a returned payment

1. Open the alert email's link (or /admin/payments → Returned payments). New returns carry a red badge.
2. Review the NACHA reason code and the matched customer/payment.
3. Click **Book return →** — it deep-links to that customer's Billing tab.
4. Run **Record returned payment** there: books the QBO expense-swap and creates the $35 fee invoice.
5. Back in the inbox, **Mark handled** (keep the record) and later **Clear handled** to tidy the queue.
6. If a return didn't match a customer/payment automatically, resolve it manually against B&P + QBO before booking.

## Stripe payouts (QBO/Stripe rail)

### Policy

- Card charges on the Stripe rail book at charge time as a QBO Payment into Undeposited Funds. Stripe deducts its fee at payout and deposits the **net** to the bank.
- A **payout reconciler** books the QBO Deposit for each Stripe payout: gross payments − Stripe fees = the bank credit, one-click matchable against the bank feed.
- Payouts containing genuine refunds/adjustments land in **needs_review** instead of auto-posting; a daily sweep (15:47 UTC) retries needs_review and failed rows, and /admin/payments has a **manual post** button for immediate retry.

### Procedure — verify a Stripe payout

1. When a Stripe deposit hits the bank feed, find the matching payout row on /admin/payments.
2. If auto-posted: confirm the QBO Deposit (payment − fee = net) and one-click match the bank line.
3. If needs_review: inspect the payout's refunds/adjustments, then use the manual post button (or let the daily sweep retry) once resolved.

**Why the review path exists:** the first reconciler version mis-counted the payout's own balance transaction, so nothing ever auto-posted, and the first manual post then hit a QBO Deposit API requirement — both fixed 2026-07-21; the sweep/manual-post retry loop is the designed recovery path for anything similar.

## Fees per the posted application terms

### Policy

Per the Terms & Conditions every applicant accepts on /apply (versioned in `src/lib/applicationTerms.ts`, `TERMS_VERSION = '2026-07-09'`):

- **Returned payment fee: $35** — booked via the Record-returned-payment flow above.
- **Late charge: 1.5% per month** on past-due balances.
- Disputes must be raised within the **6-month dispute window**.

Do not quote or apply fee amounts other than these; changes go through a terms-version bump, not ad-hoc invoicing.

## Reconciliation guidance

### Policy

- **One rail per customer, always** — a customer is never on both. Internal payment records carry the processor flag 1:1 for audit.
- B&P bridge charges are posted into QBO **by Bill & Pay itself, pre-applied to the invoices** — nothing changes for accounting on that side. QBO/Stripe-rail charges record their own applied Payment plus the payout-deposit flow above.
- The temporary cost of the cutover is **two merchant settlement streams** hitting the bank until the last customer flips. Use the /admin/payments console to see exactly who remains on the bridge and flip fast.
- Verify B&P's QBO bookkeeping on the first live ACH return of any new pattern before trusting it blind.

## Write-off authorization

> **Draft policy — proposed 2026-07-22, pending owner approval.**

Today, balance write-offs are attested with a required note in the account-closure flow ([SOP-2, gate 3](#/22-sop-customer-lifecycle)) and the actual write-off is booked in QBO by accounting. Proposed additions:

- Write-offs up to **$250** may be authorized by the ops approver working the closure (note required, as today).
- Write-offs above **$250** require explicit approval from the owner (Sky) or the accounting lead before the closure note is entered; record who approved in the note.
- Accounting books the QBO write-off within 5 business days of the closure and references the closure record in the QBO memo.
- Threshold amounts are proposals — set the real numbers at approval.

## Related

- [SOP-1 · Security & Access](#/21-sop-security-access) — PCI posture, credential handling
- [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) — enable defaults, closure balance gate
- [SOP-3 · Orders & Fulfillment](#/23-sop-orders-fulfillment) — the orders that generate these invoices
- [Brix Order /admin — Staff Console](#/03-brix-order-admin)
- [Brix Order Portal — Customer Ordering, Billing & Resources](#/02-brix-order-portal)
- Source docs: `activespacescience/brix-order/CLAUDE.md` (sessions 1.19–1.20, 1.49–1.68, 1.80–1.81), `activespacescience/brix-order/docs/BILLANDPAY-MIGRATION.md`, `activespacescience/brix-order/docs/BILLANDPAY-API-CAPABILITIES.md`
