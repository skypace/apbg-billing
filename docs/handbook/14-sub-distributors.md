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

Staff file and send an **agreement** (the partner e-signs it in their portal)
→ the partner places a **restock order** in the portal (or staff create one)
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
3. **File the agreement** (Agreements tab): version, model, fee,
   effective/expiry dates, the **Scope** (territory, accounts, products
   covered — the signer sees this), terms text, and optionally the PDF
   (private `distributor-docs` bucket). Click **Mark sent** — the partner
   gets an email with a sign link.
4. **Serviced accounts** (Accounts tab): search QBO for the Melt/Starbird
   stores this partner covers and add them, with a chain label. Depletions
   are recorded against these.
5. **Portal logins**: create the person's login from the **gateway admin
   console** (like any account), then add their **email** on the partner's
   Users tab here. That row is what grants portal access — remove or
   deactivate it to cut access. Flip the partner's status to **active**.

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
- **Agreements tab** — signed rows show the full signature record: typed
  name, signature image, email, timestamp, **IP address and browser**.

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
- **Agreements** — read the scope + terms, download the PDF, e-sign.
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
6. **Fee changes ride agreement versions.** File a new version with the new
   per-case fee and send it for signature; depletions snapshot whichever fee
   is in force when recorded.
7. Before onboarding a partner we don't fully trust: the RPC-guard hardening
   pass (see the security notes in `architecture/SUB-DISTRIBUTORS.md`) comes
   first.
