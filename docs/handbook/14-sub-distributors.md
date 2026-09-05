# Sub-Distributors — Partner Program, Portal, Agreements & Fee Settlement

> **What this is.** Brix/Alameda product reaches The Melt and Starbird stores
> outside our own delivery footprint through sub-distribution partners —
> **Origins Soda Co.**, **Desert Beverage**, and whoever comes next. This
> chapter covers both sides of the program: the staff side in **Refractor →
> Sub-Distributors**, and the partner side at
> **alamedapointbg.com/distributor** (their own login).
>
> **The model today is consignment**: Brix owns the inventory sitting in the
> partner's warehouse until they deliver it, and the partner charges Brix a
> **per-case delivery fee** for every case delivered. Sell-in (they buy the
> product at contract pricing) is supported per agreement version for later.

---

## The one-paragraph flow

Staff **build an agreement** from the deal terms and send it as a link (the
counterparty signs it on screen — no login) → the partner places a **restock
order** in the portal (or staff create one)
→ staff **fulfill** it, which creates an ordinary Stock **BOL transfer** to
the partner's warehouse location → staff ship it from Inventory → Transfers →
the partner **receives it in the portal with per-line counts** (shortages are
flagged automatically) → the partner records **depletions** (cases delivered
to each Melt/Starbird store they service) → monthly, staff **Generate
Settlement**, which turns the period's delivery fees into a Brixpense bill on
the partner's QBO vendor — posted to QuickBooks with the usual human click.
Emails flow automatically at every step (15-minute cycle).

---

## Staff side — Refractor → Sub-Distributors

### Onboarding a new partner

1. **Create the registry row** (New Sub-Distributor): code, name, model
   (consignment/sell-in), the **per-case delivery fee**, territory, contacts.
   Every partner gets its own **inventory location** (kind `distributor`) —
   link an existing one or create it here, and fill in the warehouse address
   (it prints on their BOLs).
2. **Link their QBO records** on the Overview tab:
   - **QBO vendor** — required before the first settlement; this is who the
     delivery-fee bill lands on. The **Accounting (QBO mirror)** panel below
     it shows what they've billed us recently.
   - QBO customer + SF customer ids if they'll be invoiced for product
     (sell-in) or serviced.
3. **Build and send the agreement** (Agreements tab → **Build an
   agreement**). See *The agreement* below — this is the main event, and it
   is our own paper rather than a PDF somebody produced elsewhere.
4. **Serviced accounts** (Accounts tab): search QBO for the Melt/Starbird
   stores this partner covers and add them, with a chain label. Depletions
   are recorded against these.
5. **Portal logins**: create the person's login from the **gateway admin
   console** (like any account), then add their **email** on the partner's
   Users tab here. That row is what grants portal access — remove or
   deactivate it to cut access. Flip the partner's status to **active**.

### The agreement

**We send our own paper.** The wording lives in a template
(`subdist_agreement_templates`, seeded from the shipped v1 text) and the
numbers live in a **Schedule** you fill in on a form. That split is the whole
design: a rate change is a form field, never a clause rewrite, so two
partners on different fees read the identical body text.

**Refractor → Sub-Distributors → [partner] → Agreements**:

1. **Build an agreement** — fill in the Schedule: territory, per-case
   delivery fee and any other fee lines, service levels, insurance limits,
   term, and the notice addresses. It mints `SDA-YYYY-NNNNN`.
2. **Preview** it on screen, or **Download the PDF**, and read it before it
   goes anywhere.
3. **Send for signature** — this executes OUR side (your stored portal
   signature), mints a 30-day link and emails it to the counterparty.
4. They open the link, fill in their **own legal name, entity type and
   address**, read the agreement, type their name and sign.
5. The executed PDF is filed in the `distributor-docs` bucket and emailed to
   both sides. The row shows the whole signature record.

**What the 34 clauses commit them to** — the four that carry the weight:

| § | What it says | Why it is worded that way |
|---|---|---|
| 2 | Title stays with us until the case is sold | That is what makes the consignment inventory ours to count and theirs to owe on |
| 5 | Receiving the transfer in the portal **is** the reconciliation | A signed BOL proves a truck arrived; the portal receipt is what makes the ledger true |
| 16 | They may sell their own craft soda, but soliciting an Alameda Soda customer is a breach | Sharper than a blanket non-compete: the risk is them standing in our account with our product on their truck |
| 31 | ESIGN/UETA consent is in the text from the start | It is what makes a signature collected on screen hold up |

Also covered: Service Fusion for every delivery, monthly settlement out of
our system, portal login and bill submission, confidentiality, brand and
trademark use, insurance, indemnity, audit, and termination in writing.

⚠ **Service levels are Level 1 = 24 hours, Level 2 = 48, Level 3 = 72.**
Level 1 is the emergency. If you see them the other way round somewhere,
that is the error.

⚠ **A partner who does no service work gets NO response times.** Use the
"They do no service work" button, which empties the list. Leaving the
section blank is not the same thing — a missing Schedule key falls back to
the standard three levels, and that would commit them to hours nobody
agreed to.

⚠ **This is our paper, not legal advice.** Counsel should read it before the
first one goes out.

### Day-to-day

- **Orders tab** — restock orders the partner submitted. **Fulfill → create
  BOL** picks the ship-from warehouse and creates a draft transfer; ship it
  from Inventory → Transfers like any BOL.
- **Inventory tab** — on-hand at their location + recent transfers.
- **Depletions tab** — what they delivered, per store, with the fee each row
  carries. **Generate settlement** (defaults to last month) sweeps un-settled
  fees into one settlement (`SD-<CODE>-<YYYYMM>`), stamps the rows so they
  can't be billed twice, and creates the Brixpense bill — finish it in
  **Brixpense → Post to QuickBooks**. **Void** un-does a settlement that
  hasn't been posted yet.
- **Agreements tab** — build, preview, send, re-send and switch off
  agreements. Signed rows carry the full signature record: typed name,
  signature image, email, timestamp, **IP address and browser**, plus the
  executed PDF.

### Emails you'll get (service@brixbev.com, or `DISTRIBUTOR_ALERT_TO`)

- A partner **submitted a restock order** (with the lines).
- A partner **received short** — the BOL, who signed, and exactly which lines
  came up short. The shortfall stays in TRANSIT until you resolve it
  (re-ship, adjust, or claim against the carrier).
- An **agreement was signed**.

## Partner side — alamedapointbg.com/distributor

Partners sign in with their own email/password (no gateway role — their
access is scoped by the Users tab). They see **only their own slice**:

- **Dashboard** — cases on hand (with the "owned by Brix, held on
  consignment" notice), shipments in transit, open orders.
- **Shipments** — every BOL to/from their warehouse, a printable BOL, and the
  **receive flow**: count each line, note discrepancies, type a signature.
- **Orders** — place restock orders from the item catalog (names only — no
  costs are visible to partners anywhere).
- **Deliveries (Depletions)** — record cases delivered per store; this is
  what their delivery-fee settlement is computed from.
- **Agreements** — read the scope and terms and download the PDF. ⚠ An
  agreement **built** here is NOT signed in the portal: it is signed on a
  link, by a person who may have no login at all (see below). Only a
  legacy **uploaded** agreement is e-signed from this tab.
- **Settlements** — read-only: what they'll bill Brix, by period.
- **Billing** — their own QBO invoices (sell-in / anything we invoice them).

They get emails when an order is accepted, when a shipment goes out, and when
an agreement is ready to sign or fully signed.

---

## Hard rules (SOP)

1. **Link the QBO vendor before the first settlement.** The settlement
   button refuses without it, on purpose.
2. **Nothing auto-posts to QuickBooks.** A settlement creates the Brixpense
   bill; a human posts it. Same rule as every other expense (2026-08-14).
3. **Never hand-edit depletion or settlement rows in SQL** — fees are
   snapshots; the settlement stamps are the double-billing guard.
4. **Short receipts are not errors to hide.** The shortfall stays in TRANSIT
   and the alert email is the work queue — resolve every one.
5. **Partner logins are provisioned via the gateway admin console and granted
   via the Users tab** — never share a staff login with a partner.
6. **Fee changes ride agreement versions.** Build a new agreement with the
   new Schedule and send it for signature; depletions snapshot whichever fee
   is in force when recorded.
7. **Read the agreement before you send it.** Preview or download the PDF.
   Once the counterparty signs, the text is frozen at the database and the
   only way to change a term is a new agreement.
8. **Editing a template never changes a signed agreement.** The wording is
   snapshotted onto the agreement when it is built, so publishing v1.1 is
   safe. Do not try to "fix" an executed agreement by editing the template —
   it will not work, and it should not.
9. **A signed agreement cannot be revoked from the app.** §25 terminates in
   writing. Switch off applies to a draft or an unsigned link only.
10. **A lost link is re-issued, never recovered.** Only the hash of the token
    is stored, so nobody — us included — can read a link back out of the
    database. Press **Send again**; the old link dies on the spot.
11. **The signing page is public on purpose.** The counterparty has no login
    and never will. The token in the URL is the entire gate, so treat the
    link like a credential: send it to the named signer, not to a group
    inbox.
12. Before onboarding a partner we don't fully trust: the RPC-guard hardening
    pass (see the security notes in `architecture/SUB-DISTRIBUTORS.md`) comes
    first.

---

## Where the detail lives

- **`architecture/SUBDIST-AGREEMENTS.md`** — the agreement's design: the two
  entry paths, the clause table, one-parse-three-renderers, the token model,
  what is snapshotted and why, and the known gaps.
- **`architecture/SUB-DISTRIBUTORS.md`** — the program: schema, RPCs, the
  RLS scoping that makes an external login safe on the shared project.
