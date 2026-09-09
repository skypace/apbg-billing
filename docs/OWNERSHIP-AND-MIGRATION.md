# Who owns what, and the ledger of what is moving

**Set by Sky, 2026-09-09.** This file is the record. The rule he gave with it:

> *Anything we move from brix-order to another place needs to be notated.*

So: **nothing moves out of brix-order without a row in the ledger below, added
in the same change that moves it.** A move with no row is how a dual run
becomes two systems nobody dares switch off.

---

## The three apps

| | Owns | Repo |
|---|---|---|
| **Brix Order** | The **store**. Ordering (portal, phone, EDI, order desk), incoming service requests, the **customer-FACING** billing portal (their invoices, statements, pay page, saved cards, autopay, their own billing email preferences), customer-facing equipment. | `activespacescience/brix-order` |
| **BrixSD — Service Direct** | **CRM, dispatch, invoicing.** Everything Service Fusion did: raising work, putting it on a person and an hour, the technician's phone, the work-order record, the job clock, and turning a finished job into an invoice. Estimates and lead management ahead of that. | `skypace/apbg-dispatch` |
| **Refractor** | **Purchase orders, inventory, billing, the customer master.** The finance function: AR configuration, terms, collections, statements, AP/Brixpense, the sales ledger, pricing, the health board. | `skypace/apbg-billing` |

Two boundaries are easy to get backwards and are worth stating:

- **Invoicing vs billing.** *Invoicing* is BrixSD's: a finished work order
  becomes an invoice, the way Service Fusion did it. *Billing* is Refractor's:
  the terms it goes out on, who it is sent to, when it is chased, and the
  books it lands in. Same word, two jobs.
- **Customer-facing vs staff-facing billing.** A customer editing their own
  remit-to address is the portal. Staff setting that customer's terms and
  credit hold is Refractor. They are the same columns and two different
  audiences, and both surfaces are legitimate.

## Nothing was migrated, and nothing needs to be

The customer master is **one table** — `orders.customers`, 204 rows — in the
one shared Supabase project (`gfsdpwiqzshhexkofiif`) that all five APBG apps
already reach. Sky's own framing, and it is correct:

> *I mean all of this is in the same table it's about ui really. Where it lives
> is already pretty clean.*

So this is a **UI relocation**, not a data migration. Both UIs edit the same
rows for as long as the dual run lasts. Verified before starting: there is no
blob cache, no materialized copy and no mirror between the two apps, so a
change made on either surface is visible on the other on its next load.

An earlier suggestion to move the table into the `ops` schema was **withdrawn**
as over-engineering. Do not revive it.

## One writer, and why the reads and writes go different ways

| | How |
|---|---|
| **Reads** | Straight from PostgREST under the staff member's own gateway JWT, `Accept-Profile: orders` (`app/src/lib/rpc.ts` → `sbqOrders`). |
| **Writes** | Through **brix-order's** existing admin endpoints (`app/src/lib/customerBilling.ts`). |

That asymmetry is deliberate, on two grounds:

1. **There is no browser write path and there must not be one.**
   `authenticated` holds `SELECT` and nothing else on `orders.customers`,
   `customer_locations` and `company_settings`. Granting `UPDATE` would let
   any of the **204 customer logins** on this shared project PATCH their own
   payment terms and clear their own credit hold. Every write is service-role,
   inside a function, behind an auth gate.
2. **A customer-master change has to be pushed onward to QuickBooks** (terms →
   `SalesTermRef`, name → `DisplayName`) and read back to confirm it landed.
   That rule exists once, in brix-order's `_lib/push-customer-master`. A
   second writer here would be a second field allow-list and a second push
   rule, and the one edited second is the one that silently stops pushing.

⚠ **Consequence, stated so nobody is surprised by it:** when brix-order's
staff billing screens are switched off, those functions are **not deleted** —
they move to `apbg-billing/netlify/functions/` with their bodies intact. Until
then brix-order hosts a backend for a UI in another repo. That is a known,
deliberate debt and it is cheaper than two implementations of the push.

---

## The ledger

Status vocabulary:

- **dual-run** — built in the new home, still live in brix-order. Both work.
- **new-home-only** — brix-order's copy is gone.
- **stays** — belongs in brix-order; not moving.

### Moved to Refractor

| What | Where it is now | Status | What has to be true before brix-order's copy is dumped |
|---|---|---|---|
| Customer billing record — payment terms, taxable flag, the three per-section payment methods | Customer page → **Billing & customer master** card | dual-run | Sky has tested a save on a real account and seen it in QuickBooks |
| The four billing email slots + per-slot routing (invoices / statements / reminders / order updates) | same card | dual-run | as above. ⚠ The CUSTOMER's own edit surface for these four addresses **stays** in the portal — it is a customer preference, not just a staff setting |
| Credit hold | same card | dual-run | as above |
| Account rename (→ QuickBooks `DisplayName`) | same card | dual-run | as above |
| Bill-to address (read-only display) | same card | dual-run | ⚠ Editing it **stays** in brix-order's Locations tab. It is a LOCATION row (`is_billing`), not a customer column, and a second editable copy is the drift this exercise removes |
| Company billing identity — company name, from name, reply-to, remit-to, accounting BCC, statement send day, the two global dunning switches | Settings → **Company Billing** | dual-run | as above. 9 of the 14 `company_settings` columns |

### Explicitly staying in brix-order

| What | Why |
|---|---|
| The customer-facing billing portal — their invoices, statements, pay page, saved cards, autopay, ACH agreement | It is the customer's own surface. This is the half Sky called "customer facing billing portal with equipment in Brix order" |
| The customer's own edit of their four billing email addresses | A self-service preference with a real portal home |
| `company_settings.order_fees` and `.order_desk` | Order-portal settings that happen to share a row with billing identity |
| Locations, including the bill-to flag | One home for an address |
| Ordering — portal, phone (Chloe), EDI, the order desk | The store |
| Incoming service requests | The store's front door; they become work orders in BrixSD |
| The four billing crons — `invoice-notify` (hourly), `reminder-notify` (daily), `statement-notify` (monthly), `stripe-autopay-charge` (daily) | ⚠ **The riskiest thing in this whole exercise.** One of them charges cards. Moving a sender is not moving a screen: it needs its own change, its own verification and its own window. Do not fold it into a UI move |
| Stripe — the rail, the webhooks, the payout reconciler, the returns queue | Money movement. Not part of a UI relocation |

### Not started

| What | Notes |
|---|---|
| Estimates / pre-estimate lead management (CRM) | Sky's next want. ⚠ **The main risk is a THIRD quote series.** Live today: ERLS `Q-EQ-#####`, melt-dashboard `QT-####`, plus order series `SO-####` / `MV-####` (melt) and `SO-YYYY-N` / `WO-YYYY-N` (BrixSD) and `SDO-` (Refractor). Decide FIRST whether a CRM estimate and an ERLS `Q-EQ` are the same document; if they are, the CRM reads ERLS's quotes rather than minting its own |
| BrixSD is a static publish with no server tier and no secret | Estimates need PDFs, e-signature and outbound email. That architecture has to change before CRM lands there. `dispatch.fn_invoice_knock` (pg_net + the vault) is the precedent for how |
| Moving the customer-master write functions into apbg-billing | The dump step for every dual-run row above |

---

## How the plumbing works, for whoever dumps this later

- **Migration `20260909a_refractor_reads_the_customer_master.sql`** — additive
  `FOR SELECT` policies on the three tables, gated on **`ops.fn_is_staff()`**
  (the gateway role), which is how every other Refractor screen authorizes.
  ⚠ Before it, the only staff read policy keyed on
  `orders.customer_users.is_superadmin` — a brix-order **portal** flag. All 7
  gateway staff happen to hold it, so Refractor would have read the table *by
  luck*; measured as the role that makes the call with no portal row, it saw
  **0 rows**. The first staff member added without one would have got an empty
  billing page and no explanation.
  Proven after applying, as three roles: gateway staff with no portal row
  → 204 / 1 / 259 and **writes refused**; a real customer login → still their
  own single row, writes refused; a bare login → nothing.
- **`netlify/functions/_lib/cors.ts`** (brix-order) — the one origin
  allow-list, now shared by the gateway's Staff console and Refractor.
  ⚠ CORS is **not** the gate; each endpoint's own auth gate is. `tests/cors.test.ts`
  pins the prefix and suffix attacks and asserts every wrapped endpoint allows
  the verbs it actually serves — which caught `admin-company-settings` being
  wrapped as `POST` when it serves **`PUT`**, a mistake that would have failed
  every save at the preflight and surfaced only as "Failed to fetch".

## The two rules to keep

1. **Both systems edit the same row.** Do not add a copy, a cache, a mirror or
   a second writer. If a value needs to be two places, it is one place and one
   read.
2. **Every move gets a row here, in the same change.** Including the dump.
