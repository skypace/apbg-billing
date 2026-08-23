# CO₂ Cylinder Audit PWA — Driver Field Guide

> Part I · User Guide · Owner: Dani · Last reviewed: 2026-07-22

This chapter is the field guide for the driver Cylinder Audit app — the phone tool drivers use to physically count the gas cylinders at a customer site, photograph them, collect signatures, and let the system true up the books automatically. It covers what the audit actually does to the books, who can use the app, how to install it, the step-by-step field procedure, what happens after submit (including the manager-approval hold on shortages), and troubleshooting.

## Quick reference

| Item | Value |
|---|---|
| App URL | https://alamedapointbg.com/audit → https://orders.brixbev.com/audit |
| Installs as | "Brix Cylinder Audit" (Add to Home Screen) |
| Who | Users with `is_driver` = true, and superadmins |
| Driver provisioning | https://orders.brixbev.com/admin → Audits → Drivers panel (grant/revoke by email) |
| Output | $0 QuickBooks invoice, doc number **CR-ADJ-\<n\>** |
| Shortage approvals | Alert to service@brixbev.com → review at `/admin/audits/:id` |
| Audit oversight | https://orders.brixbev.com/admin/audits |
| Evidence storage | Private Supabase bucket `cylinder-audits` (photos + signatures, signed URLs) |

## What the audit is and why it works this way

Cylinder balances in the portal are **derived entirely from QuickBooks invoice lines**: the latest monthly BTRF tank-rental invoice sets the baseline, then every delivery line adds and every pickup line subtracts. Nothing else counts a tank.

| Line type | Item codes | Effect |
|---|---|---|
| Delivery | `CO8011`, `CO8010`, `CO8081`, `CO8061`, `BR80*`, `NI80*` | +1 per unit on site |
| Pickup | `PU*` | −1 per unit on site |
| Baseline | monthly `BTRF-*` rental invoice | anchor balance per bucket |

So when a driver's physical count differs from the records, the one write that fixes both the live count AND next month's BTRF roll-forward is a **$0 adjustment invoice** carrying those same items for the delta. That invoice gets a document number starting **CR-ADJ-\<n\>** and, viewed in the portal, renders the full **Tank Rental Audit** document — counts, photos, signatures — right on the invoice. No side ledger, no manual journal entry: the audit IS the bookkeeping.

Buckets are gas types/sizes (e.g. "20LB CO2"), covering CO₂, beer-gas blend, and nitrogen cylinders.

## Who can use it

Access is gated on the `is_driver` flag (on `orders.customer_users`) or superadmin. Drivers need **no customer membership** — the app itself scopes what they see.

**Provisioning a driver (staff):** https://orders.brixbev.com/admin → **Audits** tab → **Drivers panel** → grant by email (this creates a profile shell if the person has no portal profile yet). Remove access from the same panel. Superadmins pass the gate automatically, which is handy for testing.

## Installing the PWA

1. On the phone, open **https://alamedapointbg.com/audit** (redirects to https://orders.brixbev.com/audit).
2. Sign in with your portal email/password (same Supabase login as everything else).
3. Use the browser's **Add to Home Screen** — it installs as **"Brix Cylinder Audit"** with its own icon. Only the audit tool is installed, not the whole portal.

## Field procedure

### 1. Pick the customer

Search for the customer/location you're standing at. The app loads the **system counts** — what the books say is on site, per bucket.

### 2. Count every tank

Each bucket shows the system count and a stepper **pre-seeded with that number** — most buckets match, so you only adjust the ones that differ. Count *everything* on site: full, empty, in the back room, chained outside.

### 3. Photos — required when anything changed

If any bucket's count differs from the system, **photos are required** (the submit button stays disabled without at least one). Use the in-app camera capture; photos are automatically downscaled on the phone so they upload fine on a weak connection. Take enough shots that someone reviewing later can verify the count — the group of tanks, plus anything unusual.

### 4. Sign

- **Driver signature** (required): sign on the pad, with your name and the date.
- **Manager sign-off** (optional): if an on-site manager is available, have them countersign on the second pad. **A name is required whenever the manager pad is signed.** Getting the countersignature is strongly encouraged whenever the count changes — especially on shortages.

### 5. Review and submit

The review sheet summarizes every delta (system → counted, with +/− highlighted). If the total counted across all buckets is **less** than the records, the sheet warns that the audit will be **held for manager approval**. Submit.

You'll see one of three success screens:

| Result | Meaning |
|---|---|
| **Balanced** | Counts matched. Audit filed as a record; **no invoice**. |
| **Adjustment booked** | Net zero-or-overage. The $0 CR-ADJ invoice booked to QuickBooks immediately; the success screen links to it. |
| **Sent for approval** | **Net shortage** (total counted < total on the books). The audit is saved with photos and signatures, but the invoice is HELD until a manager approves. |

## What happens after submit

### Audit statuses

| Status | Meaning | Who acts next |
|---|---|---|
| `balanced` | Counts matched; record filed, no invoice | Nobody |
| booked (linked invoice) | CR-ADJ invoice created in QuickBooks and mirrored instantly | Nobody |
| `pending_approval` | Net shortage; invoice held | Manager reviews at `/admin/audits/:id` |
| `declined` | Manager declined the shortage; no invoice | Ops follow-up as needed |
| `invoice_failed` | Audit saved, QuickBooks write failed | Staff hit **Retry** on /admin/audits |

### Overages and balanced audits

Book straight through (or file with no invoice). The customer's Cylinders page reflects the adjustment immediately — the CR-ADJ invoice is mirrored into `ops.qbo_invoices` at booking time, no wait for the nightly sync.

### Net shortages — manager approval

The gate is on the **net total** across all buckets: mixed deltas that net to zero or positive auto-book; only a net shortage holds. When held:

1. An alert email goes to **service@brixbev.com** (override: `AUDIT_APPROVAL_ALERT_TO` env var) with a "Review & approve audit →" link.
2. The audit sits in **Pending approval** on https://orders.brixbev.com/admin/audits.
3. A manager opens the review page (`/admin/audits/:id`) — the full Tank Rental Audit document plus an **editable Final-count table**. The approver can amend any bucket's final count before deciding; the driver's signed counts are immutable and stay on record (amended rows show the signed count struck through, with an "amended at approval" note).
4. **Approve** books the CR-ADJ invoice from the final counts (amendments that zero every delta close the audit as balanced, no invoice). **Decline** records the decision with notes and books nothing.

### Where the audit lives afterward

- The **CR-ADJ invoice** in the portal (Invoices → All/Paid; $0 invoices mirror as paid) renders the Tank Rental Audit document: system/counted/adjustment table, photo grid with lightbox, driver + manager signature blocks, and the approval record when there was one.
- The customer's **Cylinders page** shows an "Audit adjustment" history row with the signed ± quantity, linking to the invoice.
- Every audit (any status) is listed on **/admin/audits** with status, delta summary, photo count, and signer.

> **Staff note:** photos and signatures are stored in the private `cylinder-audits` Storage bucket and served via signed URLs — the audit evidence survives even if the QuickBooks write fails. The QBO realm needs "Custom transaction numbers" ON for the CR-ADJ doc number to stick; the code tolerates QBO auto-numbering and keeps CR-ADJ-\<n\> as the audit's own document number regardless.

## Troubleshooting & FAQ

**The submit succeeded but says the invoice failed (`invoice_failed`).**
The audit — counts, photos, signatures — is saved; only the QuickBooks write failed. A staff member opens /admin/audits and hits **Retry** on the row. Retry is duplicate-safe: it checks the mirror for the doc number first and re-links instead of double-booking if the original write actually landed. Retries of approved-with-amendments audits re-book the amended numbers.

**The app's counts disagree with what the customer thinks.**
The app shows the same numbers the customer's Cylinders page shows — both come from `cylinder_inventory_for_customer`. Check the customer's cylinder transaction history and any **recent CR-ADJ invoices** first (a colleague may have audited recently). Back-to-back audits agree with the books because each booked adjustment updates the mirror instantly.

**A gas type is missing from the bucket list / shows zero history.**
Buckets exist for anything with cylinder activity on the books — since 2026-07-09 a bucket no longer needs BTRF history to appear (a synthetic zero anchor counts deliveries/pickups for new gas types). If a tank on site genuinely has no invoice history at all, count it in its bucket; the adjustment creates the paper trail.

**I can't get past the photos step.**
Photos are mandatory whenever any count changed. If the camera won't open, use the file-picker fallback (it accepts gallery photos). There's a per-audit photo cap — delete a shot and retake if you hit it.

**The manager won't sign / isn't there.**
The countersignature is optional — submit with just your signature. On a shortage, the approval workflow provides the second set of eyes instead.

**I audited the wrong customer.**
Tell ops immediately. If it booked, the shortage/overage adjustment on the wrong account needs a correcting audit on both accounts — do not try to fix it by fudging the next real audit.

**Why does the customer see a $0 "paid" invoice for the audit?**
That's by design. The CR-ADJ invoice's job is to carry the adjustment quantities into the cylinder math and next month's BTRF roll-forward — not to charge anything. Because it's $0 it mirrors as `paid`, so it appears under All/Paid on the customer's Invoices page, rendering the Tank Rental Audit document. The billing effect shows up on the *next monthly rental invoice*, which reflects the corrected count.

**Can I do an audit as part of closing an account?**
Yes — the account-closure workflow accepts a Tank Rental Audit performed within the last 30 days as its tank-resolution gate. See [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle).

## Safety reminders (from the CO₂ rentals guide)

- Secure every cylinder upright; never move an unchained tank by the valve.
- Never tamper with valves or regulators; a hissing sound or sharp cold near a fitting means shut the valve and report it.
- CO₂ is heavier than air — ventilate stuffy enclosed storage areas before working in them; if you feel lightheaded, get out first.

## Related

- [Brix Order Portal — Customer Ordering, Billing & Resources](#/02-brix-order-portal) — Cylinders page, CR-ADJ invoices as the customer sees them
- [Brix Order /admin — Staff Console](#/03-brix-order-admin) — the Audits tab, Drivers panel, approvals
- [SOP-5 · CO₂ Cylinders — Rentals, Field Audits, Shortage Approvals](#/25-sop-cylinders-audits)
- [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) — closure audits
- Source docs: `brix-order/CLAUDE.md` (sessions 1.22–1.24, 1.27, 1.29), `brix-order/src/pages/audit/`, `brix-order/content/knowledge-base/tank-co2-rentals.md`
