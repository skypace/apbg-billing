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
| Bill-to address | Customer page → **Locations & addresses** card (read-only echo on the Billing card) | dual-run | It is a LOCATION row (`is_billing`), not a customer column; pick or edit it in the Locations card, which pushes it to QuickBooks as `BillAddr` (+ its phone as `PrimaryPhone`). ⚠ 2026-09-10 supersedes the 2026-09-09 row that said editing stays in brix-order — the whole record is editable here now, and there is still exactly one copy of the address |
| **Locations** — add, edit (address, suite, phone, delivery notes), hide/show, set bill-to | **Locations & addresses** card | dual-run | Sky has edited a real location here and seen the QuickBooks Customer's ShipAddr / BillAddr follow. The `PRIMARY` row is QuickBooks' ship-to; the bill-to row is its billing address; every other location is portal-only. ⚠ Service Fusion has NO customer-update API (`PUT` → 405, brix-order §1.129) — an address change comes back as a RETYPE note, not a sync |
| **Contacts** — who runs the account (name · role · title · email · phone), add / edit / deactivate; "Make QuickBooks primary" | **Contacts** card | dual-run | as above. ⚠ Contacts are NOT logins (`orders.customer_users` is a different table and stays in brix-order). QuickBooks holds ONE contact per Customer (`GivenName`/`FamilyName`); "Make QuickBooks primary" writes that person's name onto `customers.billing_contact_name`, which is what pushes |
| **Documents** — the vault: tax id, resale certificate, the signed application, the ACH form; file / edit / archive, with a file pushed onto the QuickBooks Customer as an **Attachable** | **Documents & attachments** card | dual-run | Sky has filed a document here and seen it under the customer's Attachments in QuickBooks. `qbo_attachable_id` on the row is the proof; a row with a file and no id was filed before 2026-09-10 or was refused (the note says which). Archive is soft |
| QuickBooks contact name + Notes box | Billing card → **QuickBooks contact & notes** | dual-run | as above. `billing_contact_name` → `GivenName`/`FamilyName` (split on the last space); `notes` → `Notes` (2,000-char cap, QuickBooks') |
| **Enable a customer in the portal** ("Set up this customer in the portal") | Billing card, shown when the customer has no portal record | dual-run | ⚠ Same `_lib/enable-customer` as brix-order's Enable: imports the QuickBooks subs as locations, seeds pricing from invoice history, switches every email notification ON (paper off), sends the account-live invite, and REFUSES an EQUIPMENT / RESQ bucket. The confirm on the card says all of that before the click |
| Company billing identity — company name, from name, reply-to, remit-to, accounting BCC, statement send day, the two global dunning switches | Settings → **Company Billing** | dual-run | as above. 9 of the 14 `company_settings` columns |

### Explicitly staying in brix-order

| What | Why |
|---|---|
| The customer-facing billing portal — their invoices, statements, pay page, saved cards, autopay, ACH agreement | It is the customer's own surface. This is the half Sky called "customer facing billing portal with equipment in Brix order" |
| The customer's own edit of their four billing email addresses | A self-service preference with a real portal home |
| `company_settings.order_fees` and `.order_desk` | Order-portal settings that happen to share a row with billing identity |
| Portal LOGINS (`orders.customer_users`, memberships, welcome emails, password resets) | A login is portal access, and the portal is brix-order's. Contacts (a name and a phone) moved; logins did not |
| Ordering — portal, phone (Chloe), EDI, the order desk | The store |
| Incoming service requests | The store's front door; they become work orders in BrixSD |
| The four billing crons — `invoice-notify` (hourly), `reminder-notify` (daily), `statement-notify` (monthly), `stripe-autopay-charge` (daily) | ⚠ **The riskiest thing in this whole exercise.** One of them charges cards. Moving a sender is not moving a screen: it needs its own change, its own verification and its own window. Do not fold it into a UI move |
| Stripe — the rail, the webhooks, the payout reconciler, the returns queue | Money movement. Not part of a UI relocation |

### Not started

| What | Notes |
|---|---|
| Estimates / pre-estimate lead management (CRM) | Sky's next want. ⚠ **The main risk is a THIRD quote series.** Live today: ERLS `Q-EQ-#####`, melt-dashboard `QT-####`, plus order series `SO-####` / `MV-####` (melt) and `SO-YYYY-N` / `WO-YYYY-N` (BrixSD) and `SDO-` (Refractor). Decide FIRST whether a CRM estimate and an ERLS `Q-EQ` are the same document; if they are, the CRM reads ERLS's quotes rather than minting its own |
| BrixSD is a static publish with no server tier and no secret | Estimates need PDFs, e-signature and outbound email. That architecture has to change before CRM lands there. `dispatch.fn_invoice_knock` (pg_net + the vault) is the precedent for how |
| **Reverse the arrow: move the customer-master write functions into apbg-billing BEFORE brix-order's staff screens are switched off** | The dump step for every dual-run row above, and ⚠ **it must come FIRST, not last** — decided by Sky 2026-09-10 ("i just dont know why it would still write through brix-order when those functions are removed… reverse it so its doing it from refractor, that way when we shut it down the question isnt, why are these buttons writing through brix order"). Today Refractor's cards POST to `orders.brixbev.com`; if the tabs are hidden first, that call reads as a mystery. See **"Before the shutdown: reverse the arrow"** below for the sequence. As of 2026-09-10 the set is **nine** functions to move: `admin-payment-profile`, `admin-set-billing-comms`, `admin-set-credit-hold`, `admin-set-customer-name`, `admin-company-settings`, `admin-customer-locations`, `admin-customer-contacts`, `admin-customer-documents`, plus `_lib/push-customer-master` and `_lib/sf-customer-manual`. `admin-enable-customer` + `_lib/enable-customer` **stay in brix-order** — portal provisioning is the store's |

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

- **Migration `20260910a_refractor_reads_contacts_and_documents.sql`** — the
  same additive `FOR SELECT … using (ops.fn_is_staff())` on
  `orders.customer_contacts` and `orders.customer_documents`, which carried the
  identical pre-20260909a shape (one policy on the portal superadmin flag).
  Proven as three roles in a rolled-back probe: gateway staff with no portal
  row → 49 contacts / 4 documents and an INSERT refused; a bare login → 0 / 0.
  ⚠ Document FILES stay in the service-role `customer-docs` bucket; Refractor
  reads 1-hour signed URLs from brix-order's `admin-customer-documents` GET,
  never the bucket.
- **The outward push grew on 2026-09-10** (brix-order `_lib/push-customer-master`
  → apbg-billing edge function `qbo-customer-lookup` v6, deployed as version 11,
  `verify_jwt:false`): the `PRIMARY` location → `ShipAddr`; the bill-to row →
  `BillAddr` + its phone as `PrimaryPhone`; `billing_contact_name` →
  `GivenName`/`FamilyName`; `notes` → `Notes`; and a new `attach_file` action
  that uploads a vault document as a QBO Attachable on the Customer
  (`customer_documents.qbo_attachable_id` records it — the push is NOT
  idempotent, so the id is what stops a re-push). Every one of those is
  best-effort and reported in `push_notes`; a refusal never un-saves the
  portal row.
- **Four cards, one customer read.** `app/src/lib/customerMaster.ts`
  memoises the `orders.customers` handle per QuickBooks id and broadcasts an
  invalidation (`forgetOrdersCustomer`) when one card changes the record — the
  screenshot caught the Locations card still reading "not set up in the
  portal" after the Billing card had enabled the customer, because it held the
  memoised null.

## Before the shutdown: reverse the arrow

**Decided 2026-09-10 (Sky).** The dual run is correct as built — both apps write
the same row through the same brix-order functions, so nothing can drift — but
the ORDER of the shutdown was wrong in the first draft of this ledger. It said
"switch off brix-order's staff screens, then move the functions." Do it the
other way round, or the day the tabs disappear somebody asks why Refractor is
still writing through a system that was supposedly turned off.

⚠ **Trigger for the reminder:** the moment Sky says the Refractor billing side
is tested and brix-order's customer tabs can go, THIS is the first change, and
hiding the tabs is the last. Do not hide a tab while a Refractor card still
POSTs to `orders.brixbev.com`.

The sequence, one change, one window:

1. **Move the nine writer endpoints and the push mapper into apbg-billing**
   (`netlify/functions/`). The actual QuickBooks write already lives here in
   the `qbo-customer-lookup` edge function; what moves is the thin mapper
   (`push-customer-master`), the handlers, their field allow-lists, the audit
   log call and the Service Fusion retype note (`sf-customer-manual`). Bring
   `tests/customer-master-push.test.ts` and the CORS verb test with them.
2. **Point Refractor's cards at the local functions** (`lib/customerBilling.ts`
   + `lib/customerMaster.ts` carry the base URL) — same origin, so the
   allow-list here only needs the gateway and this site.
3. **Point brix-order at apbg-billing over a shared secret** for the writes
   it must keep making forever: the CUSTOMER's own edits
   (`customer-update-settings` email slots, `apply-account-change`,
   `submit-address-change`). ⚠ These are the store's by the ownership map and
   never move; they just stop pushing to QuickBooks locally and call here
   instead. Same server-to-server shape brix-order already uses toward
   melt-dashboard's `provision-tenant` (`X-Provision-Secret`). The dependency
   arrow flips direction; it does not disappear.
4. **Brix-order's staff screens call apbg-billing too** while they still
   exist, so both doors keep writing one row via one implementation.
5. **Delete brix-order's copies** of the nine handlers and the mapper. The
   `_lib/cors.ts` allow-list there shrinks to the gateway's Staff console.
6. **Hide brix-order's staff customer tabs** (Customers detail: Overview
   payment card, Billing & comms, Locations, Users stays). Now the shutdown is
   just deleting screens.
7. **Update this ledger and both CLAUDE.md files** in the same change.

⚠ **Both halves of step 3 ship in the same window.** The customer self-service
push cannot be dark between "brix-order stopped pushing locally" and
"apbg-billing accepts the call" — a customer's address change would land in
the portal and never reach QuickBooks, silently.

⚠ **Enable stays put.** "Set up this customer in the portal" imports
locations, seeds pricing from invoice history, sets notification defaults and
emails the invite — that is store provisioning and the store owns it.
Refractor's button keeps calling brix-order's `admin-enable-customer`, and that
one cross-origin call is the documented exception, not a leftover.

Cost estimate: one session. Risk: the customer self-service push (step 3),
which is why it is called out twice.

## The two rules to keep

1. **Both systems edit the same row.** Do not add a copy, a cache, a mirror or
   a second writer. If a value needs to be two places, it is one place and one
   read.
2. **Every move gets a row here, in the same change.** Including the dump.
