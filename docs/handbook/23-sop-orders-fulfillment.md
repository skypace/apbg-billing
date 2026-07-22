# SOP-3 · Orders & Fulfillment — Web, Phone & Admin Orders, Tank Returns, Service Calls

> Part II · SOP Manual · Owner: Dani · Last reviewed: 2026-07-22

This SOP covers how orders enter the system (customer web, AI phone line, staff quick-order), what happens after submit (Service Fusion job, lifecycle emails, cancellations), the tank-return prompt, service-call intake, and the operational rules for working with the Service Fusion API. Audience: ops, dispatch, and anyone taking a phone order.

## Order intake channels

### Policy

All orders flow through **one submit pipeline** (`submit-order`): the SF job is created **first**, local records after, so a failed SF submit never leaves an orphan order. The three entry points differ only in who drives the UI and the SF job category:

| Channel | Who | SF job category |
|---|---|---|
| Customer web order | Customer at `https://orders.brixbev.com` | **Brix Web Order** |
| Phone order via Chloe | AI phone line (510) 800-6281 | **Brix Phone Order** |
| Staff quick-order | Staff at `/admin/quick-order` (acts through the portal) | **Brix Web Order** |

- Both categories **must exist in SF Settings → Job Categories**. SF only attaches existing categories — an unknown name rejects the whole job, so the pipeline retries once without the category (the order goes through; a warning is logged). If you rename a category in SF, update the env override (`SF_ORDER_JOB_CATEGORY` / `SF_PHONE_ORDER_JOB_CATEGORY`) in the same change.
- Every order carries an idempotency key; SF product line names must be the QBO/SF master item header (the friendly name rides in the description).

## Fees

### Policy

- **Service Fusion's fee engine bills fees** (fuel, hazmat, force-majeure, CRV, SSB). Our app computes fee lines for **display only** — the on-screen estimate, the order record, and the confirmation email.
- **Never add fee lines as products on the SF job.** The fee items are QBO items applied by SF's job-level fee engine — they are not SF products.
- The /admin fee toggles govern the on-screen estimate only, not what SF bills.

**Why:** the auto-fee feature briefly sent fee lines as SF products in June 2026 — SF rejected every job ("Product can not be found") and **every order failed for two weeks** (last success 2026-06-23, root-caused 2026-07-08). Even if the products had existed, SF's own fee engine would have double-charged.

## Tank returns at submit

### Procedure (built into the Cart — know it to explain it)

1. When a cart contains gas, "Review & submit" first asks: **"Empty tanks to return?"**
2. **No** → any stray pickup lines are cleared and the normal submit modal opens.
3. **Yes** → per-tank-type steppers (the seven PU* pickup items) let the customer set counts, then a confirm summary: "You have selected N tanks for return & pickup."
4. Confirming writes $0 pickup lines into the cart; they ride the order into SF like any line.
5. Pickup items never appear in the Shop grid — they enter an order only through this flow.
6. Gas items are **never blocked by inventory** — QBO qty-on-hand does not gate ordering for any item; zero-stock non-gas items show a "Backordered" note instead.

## Order lifecycle & emails

### Policy

- A poller (`order-lifecycle-check`) runs **every 5 minutes**, reading open orders' SF jobs and sending lifecycle emails exactly-once (confirmation backfill / scheduled / out-for-delivery / delivered).
- Emails go to the **submitter + the customer's Primary email**, deduped, BCC service@brixbev.com — so an admin-entered order still notifies the customer.
- The **"scheduled" email fires off the scheduled DATE**, not the status name: it sends whenever the SF job has a scheduled date and isn't delivered/cancelled. Do not add status-name matching for lifecycle logic — this SF account uses custom status names ("Scheduled- Product", "Shipping Product") that break name matches.
- **Cancellations reflect within one poller tick (≤5 min):** a cancelled SF status (or a deleted SF job) stamps the order cancelled, stops polling it, and suppresses lifecycle emails. To cancel an order, cancel the SF job — the portal follows.

**Why:** the date-based rule exists because a job at custom status "Shipping Product" carried a scheduled date but never matched `/^Scheduled/`, so the customer got no scheduled email (2026-07-10); the cancellation mapping exists because cancelled SF jobs showed "Submitted" in the portal indefinitely (2026-07-09).

## Phone-order procedure for staff

### Procedure

1. Sign in at `https://orders.brixbev.com` — staff land on **`/admin/quick-order`** (the phone-order launchpad) automatically.
2. Search the enabled-customer list. Favorites (★) sort first.
3. **Check the credit-hold badge before dialing in the order** — submit will block on a credit-hold account; resolve or escalate first.
4. Click **Start order** — this switches your context to that customer and lands you on the Shop with their pricing and locations.
5. The sidebar always shows an **"Ordering for <customer>"** chip while you work — confirm it names the right account before adding anything to the cart. Use "Change customer →" to go back to quick-order.
6. Build the cart, run the tank-return prompt with the caller, and submit. Lifecycle emails go to the customer's Primary email as well as you.

### Chloe phone orders (context for staff)

Chloe (the AI line at (510) 800-6281) takes customer orders through the same pipeline on an internal-token path: identical validation, SF category "Brix Phone Order", cart persisted per call. Chloe **always asks about tank pickups** and requires a **read-back with an explicit yes** before submitting.

## Service calls

### Policy

- Service requests from any source — portal UI, Mr. Bubbles chat, Chloe phone, or the bot endpoint — land in one shared pipeline: ticket insert → **automatic SF job creation** → notification email to service@brixbev.com.
- SF job categories are fixed to ones that exist: equipment issue → **Service Call**; refill → **Product Delivery**; scheduling/other → **Service Call**. (The old mapping used category names that don't exist in SF, which 422'd every push — never invent SF category names.)
- The push is idempotent and retries once without the category on rejection.
- The AI assistants confirm before filing, read the ticket number back, and never file twice.

### Procedure — when the auto-push failed

1. The service@brixbev.com notification email shows either "✓ Already in Service Fusion as Job #N" or a signed **push-to-SF retry button** — the button only renders when the auto-push failed.
2. Click the retry button; it re-runs the same push (idempotent — safe if the original actually landed).
3. If it still fails, create the SF job by hand with the correct category and note the ticket.

## Service Fusion API operational rules

### Policy (for anyone scripting or debugging against SF)

- **Always pass an explicit `sort` on `GET /jobs`** (e.g. `sort=-id`). Queries relying on SF's default sort hang past 24 seconds on our jobs table; with an explicit sort they return in ~1s.
- **No DELETE /customers endpoint exists** — never create test customers in SF; they cannot be removed via the API.
- **Custom statuses break name-matching** — prefer date-based or pattern-tolerant logic (see lifecycle policy above). SF only *attaches* existing statuses/categories; unknown names 422 the whole job.
- There is **no API way to list SF products** (`/items` was removed); the catalog stays QBO-driven and QBO item names are the SF item names.
- SF has no webhooks — polling is the integration model.
- The SF customers API payload shape has changed without notice before (nested phones/emails, `street_1`); when SF returns a 422 on a previously working payload, check the current spec at docs.servicefusion.com/api.json before assuming our bug.

## Order-entry accuracy

> **Draft policy — proposed 2026-07-22, pending owner approval.**

Read-back + explicit yes is already standing practice for Chloe's phone orders (built into the agent). Proposed extension to human-taken phone orders:

- Before submitting any staff-entered phone order, read back to the caller: the account name (from the "Ordering for" chip), every line item + quantity, any tank returns, and the delivery location.
- Obtain an explicit yes before pressing submit.
- If the caller can't confirm (e.g., a voicemail request), use the dry-run/preview and hold the order until confirmed.

## Related

- [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) — enabling customers so they can order
- [SOP-4 · Billing & Payments](#/24-sop-billing-payments) — what happens after delivery (invoicing, payment)
- [SOP-5 · CO₂ Cylinders](#/25-sop-cylinders-audits) — cylinder balances the tank-return flow feeds
- [Brix Order Portal — Customer Ordering](#/02-brix-order-portal)
- [Brix Order /admin — Staff Console](#/03-brix-order-admin)
- [AI Assistants — Chloe & Ziggy Phone Line](#/05-voice-ai-assistants)
- Source doc: `activespacescience/brix-order/CLAUDE.md` (sessions 1.10, 1.18, 1.41–1.48, 1.56, 1.70–1.79)
