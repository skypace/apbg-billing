# SOP-5 · CO₂ Cylinders — Rentals, Field Audits, Shortage Approvals

> Part II · SOP Manual · Owner: Dani · Last reviewed: 2026-07-22

This SOP defines how cylinder rentals are billed, how field audits keep the books honest, and what happens when an audit finds fewer tanks than the records say. It's for drivers, service ops, and the managers who review audits — the driver-facing step-by-step lives in the [CO₂ Cylinder Audit PWA — Driver Field Guide](#/04-driver-cylinder-audit); this chapter is the policy layer around it.

## How cylinder billing works

There is **no separate cylinder inventory database**. A customer's cylinder balance is derived entirely from QBO invoice lines in the `ops.qbo_invoices` mirror:

```
balance = latest BTRF roll-forward balance + deliveries − pickups
```

| Component | What it is |
|---|---|
| **BTRF-\* invoice** | The monthly tank-rental roll-forward invoice. Its balance line is the anchor for each gas bucket. |
| **Delivery lines** | Items `CO8011`, `CO8010`, `CO8081`, `CO8061`, `BR80*`, `NI80*` — each line adds cylinders on site. |
| **Pickup lines** | `PU*` items — each line removes cylinders. |
| **CR-ADJ-\<n\> invoice** | A $0 audit-adjustment invoice carrying the same delivery/pickup items for the delta found in a field audit. It reconciles the live count AND next month's BTRF roll-forward in one write. |

Buckets with cylinder activity but **no BTRF history yet** (new customers, first-ever delivery of a new gas type) count from a synthetic zero anchor — activity is never invisible while waiting for the first BTRF. *Why: audit adjustments on the SAMPLING account originally didn't show on the customer's Cylinders page because the math only recognized buckets that had appeared on a BTRF invoice (fixed 2026-07-09).*

Rental unit price resolves from the live `ops.qbo_items` rental rate, falling back to the BTRF price, then 0.

### Policy

- Never adjust a cylinder count by editing data directly. The **only** supported correction is a Tank Rental Audit producing a CR-ADJ invoice (or a real delivery/pickup on an order).
- CR-ADJ invoices are $0 and therefore show as **paid** in the portal — that is expected, not a billing error.
- The QBO realm's "Custom transaction numbers" setting must stay ON so CR-ADJ doc numbers stick.

## Rental terms (customer-facing rules staff must know)

Grounded in the rentals KB doc and the account application terms (`applicationTerms.ts`, version 2026-07-09):

- Cylinders are **rented**, not sold — a recurring per-cylinder rental charge appears on the regular invoice; gas refills/exchanges are billed per swap or per the customer's service plan.
- **Lost or unreturned cylinder replacement: $125** (per the posted application terms).
- **100-lb CO₂ cylinders require a CFC/IFC 5307 permit** — flag this during onboarding for any account taking 100-lb tanks (per the application terms).
- Planning rule of thumb for customer conversations: **1 lb of CO₂ per 7–10 gallons of finished product**; a 20 lb tank pours roughly 140–200 gallons (≈8–11 three-gallon BIBs — use ~10 as the safe number). A customer burning tanks faster than ~1 per 8 BIBs likely has a leak — offer a leak check.
- Recommend every account keep at least one full backup cylinder on site.
- If a customer disputes a rental charge (e.g. billed for a returned cylinder), file a service request and reconcile via audit — do not hand-edit invoices.

## Beverage-grade CO₂ only

### Policy

- Only **beverage-grade CO₂** goes into customer systems. Never welding, medical, or generic food-grade gas.
- Customers must never refill Brix cylinders elsewhere. If a driver finds evidence of third-party refills, note it on the audit and report to service ops.

This rule is published in the customer knowledge base (`co2-troubleshooting-and-safety.md`) — staff answers must match it.

## Audit cadence

> **Draft policy — proposed 2026-07-22, pending owner approval.**

- Every customer holding rented cylinders is audited **at least once per year**.
- Drivers **opportunistically audit on routine delivery visits** — the PWA takes minutes, and a fresh audit is required anyway within 30 days of any account closure (the closure workflow enforces this).
- Accounts with disputed rental charges, suspected leaks/losses, or a change of ownership get an audit on the next visit, ahead of cadence.

## Field audit procedure

Do not duplicate the steps here — drivers follow the [CO₂ Cylinder Audit PWA — Driver Field Guide](#/04-driver-cylinder-audit). The policy points that wrap it:

### Policy

- Audits happen in the driver PWA at https://orders.brixbev.com/audit (branded alamedapointbg.com/audit). Driver access is granted from Brix Order **/admin → Audits → Drivers** (the `is_driver` flag) — no SQL provisioning.
- **Photos are required whenever a count changes.** A balanced audit (counts match records) still files, with status `balanced` and no invoice.
- The driver signs the audit (name + date). An **on-site manager countersignature is optional** but encouraged — if the manager signs, their name is required.
- The driver's signed counts are **immutable** — that is what the signature attests to. Corrections happen at the manager-approval stage (below), never by editing the signed counts.

### What the system does with the result

| Audit outcome | System behavior |
|---|---|
| Counts match | Status `balanced`. No invoice. |
| Net **overage** (counted ≥ records, net across all buckets) | CR-ADJ invoice books immediately. |
| Net **shortage** (total counted < total on record) | **No invoice yet.** Audit files as `pending_approval`, alert email goes to service@brixbev.com with a review link. |
| QBO write fails | Status `invoice_failed` — the audit evidence is preserved; retry from /admin. |

The gate is on the **net total** across all buckets: mixed deltas that net to zero or positive auto-book; only a net shortage holds for approval.

## Shortage approval

### Policy

- A net-shortage audit must be reviewed and decided by a manager before any invoice books. The alert email is a notification; the decision happens signed-in at the review page.
- Managers may **amend the final counts** at approval (e.g. after calling the site or checking the truck). Amendments land in `final_counts`; the driver's signed `counts` remain untouched, and the audit document shows amended rows with the driver's count struck through and an "amended at approval by \<email\>" note. *Why: the owner asked for the ability to correct what the credit memo states at the decision point, without ever falsifying what the driver signed.*
- **Approve** books the CR-ADJ invoice from `final_counts ?? counts`. **Decline** records the decision only — no invoice, ever.
- Amendments that zero out every delta close the audit as `balanced` with no invoice. Amendments are refused if the doc number already exists in QBO (re-link only — prevents double-booking).

### Procedure

1. An alert lands in service@brixbev.com ("Review & approve audit →"). Or find it under **Pending approval** at https://orders.brixbev.com/admin/audits.
2. Open the review page (`/admin/audits/:id`). It shows the full Tank Rental Audit document: system vs counted table, photos, driver + manager signatures.
3. Verify the shortage — photos, site knowledge, recent pickups that may not have posted yet.
4. If the driver's numbers need correction, edit the **Final-count** table (per-row stepper; live delta; per-row reset). The button becomes "Approve with changes."
5. Click **Approve** (books the CR-ADJ invoice) or **Decline** (record only), with optional decision notes. Both stamp who decided and when.
6. The decision, amendments, and approval record all render permanently on the CR-ADJ invoice document in the portal.

## Failed invoice retry (`invoice_failed`)

### Policy

- An `invoice_failed` audit is never re-entered from scratch — always use **Retry** on the /admin/audits row. Retry is duplicate-safe: it checks the ops mirror for the doc number first and **re-links** instead of double-booking if the original QBO write actually landed.
- Retry rebuilds the invoice lines from `final_counts ?? counts`, so an approved-with-edits audit re-books the amended numbers.

### Procedure

1. Filter /admin/audits to `invoice_failed`.
2. Click **Retry** on the row.
3. Confirm the row flips to a booked state and the CR-ADJ invoice appears in the portal. If it fails again, treat as an incident (QBO token or API problem — see [SOP-6](#/26-sop-service-maintenance)).

## Related

- [CO₂ Cylinder Audit PWA — Driver Field Guide](#/04-driver-cylinder-audit) — the step-by-step the driver follows
- [Brix Order /admin — Staff Console](#/03-brix-order-admin) — the Audits tab, driver management
- [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) — closure requires a tank audit within 30 days or a scheduled pickup
- [SOP-3 · Orders & Fulfillment](#/23-sop-orders-fulfillment) — tank-return flow at order submit
- [SOP-6 · Service, Maintenance & Incident Response](#/26-sop-service-maintenance) — escalation for QBO/SF failures
- Source: `brix-order/content/knowledge-base/tank-co2-rentals.md` (customer-facing rental terms)
- Source: `brix-order/CLAUDE.md` sessions 1.22–1.24, 1.27, 1.29, 1.45
