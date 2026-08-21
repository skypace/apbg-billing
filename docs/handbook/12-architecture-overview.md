# Architecture & Data — How the Programs and Data Work

> Architecture & Data · Owner: Sky Pace · Last reviewed: 2026-08-21

This chapter is the visual map of how APBG's systems fit together — the apps, where the data lives, and the pipelines that move it. It summarizes and diagrams the [master architecture handbook](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md); the always-current original renders in the [Live Architecture Mirror](#/13-architecture-live) chapter. Diagrams here are Mermaid — they render inline in this viewer.

## System map

Everything public flows through the gateway at `alamedapointbg.com`; the order portal has its own front door at `orders.brixbev.com`.

```mermaid
flowchart LR
  staff([Staff]) --> gw
  cust([Customers]) --> bo
  drv([Drivers]) --> bo
  phone([Phone callers]) --> retell

  subgraph Gateway["alamedapointbg.com — apbg-gateway"]
    gw[Hub · login · waffle<br/>app registry · maintenance]
  end

  gw -->|"/billing /margin /expense /control"| ab[apbg-billing<br/>AP tool · Refractor · Brixpense<br/>Master Control · Handbook]
  gw -->|"/melt/"| melt[melt-dashboard]
  gw -->|"/operations/"| ops2[APBG-OPS]
  gw -->|"301 /fountain"| dam[fountain-dam.netlify.app]
  gw -->|"301 /audit"| bo

  subgraph Orders["orders.brixbev.com — brix-order"]
    bo[Portal · /admin · /audit PWA<br/>Mr. Bubbles · voice brain]
  end

  retell[Retell telephony] --> rail[Railway ws gateway] --> bo

  ab --> sb[(Supabase<br/>gfsdpwiqzshhexkofiif)]
  bo --> sb
  gw --> sb
  ab <--> qbo[QuickBooks Online<br/>realm 9130352144155116]
  ab <--> sf[Service Fusion]
  bo --> sf
  bo <--> stripe[Stripe]
  bo --> resend[Resend email]
  rsync[apbg-resq-sync<br/>edge functions] <--> resq[ResQ]
  rsync <--> sf
  rsync --> sb
```

## Where the data lives

One shared Supabase project (`gfsdpwiqzshhexkofiif`) holds several schemas with strict ownership:

| Schema | Owner | What's in it |
|---|---|---|
| `ops.*` | apbg-billing sync stack | QBO mirror (customers, invoices, items, invoice lines), SF/QBO token caches, Brixpense tables, production (formulas/BOMs/WOs/POs), `sync_customers` (ResQ↔SF map). **Read-only to brix-order.** New writers must register in `architecture/sync-manifest.json` — the build lint enforces it. |
| `orders.*` | brix-order | Customers/locations/memberships, orders + lines, payments + returns, cylinder audits, onboarding, service requests, KB documents + chunks (the bots' RAG), voice call sessions. |
| `public.*` | apbg-gateway | `gateway_apps` registry, `app_maintenance` banners/lockouts, auth users (shared). |
| `dam.*` | DAM-Fountain | Brand asset library metadata (assets in the `brand-assets` bucket). |

External systems of record: **QuickBooks Online** (money — one realm, multiple Intuit apps), **Service Fusion** (jobs/dispatch; pricing lives here and pushes to QBO), **ResQ** (Melt work orders), **Stripe** (the only payment rail — Bill & Pay was removed 2026-08-12), **Resend** (email, outbound AND inbound webhooks), **DocuPost** (paper mail).

## The QBO mirror — how portal data stays current

The portal never calls QuickBooks directly. Everything financial flows through the `ops.*` mirror:

```mermaid
flowchart LR
  qbo[QuickBooks Online] -->|sync-qbo edge fn<br/>daily full + 15-min CDC| mirror[(ops.qbo_customers<br/>ops.qbo_invoices + lines<br/>ops.qbo_items)]
  mirror -->|"RLS-scoped views<br/>v_invoices_all · v_invoice_lines<br/>v_cylinder_inventory"| portal[brix-order portal<br/>invoices · statements · cylinders]
  pay[stripe-pay-invoices<br/>after a charge] -.->|nudge mode=cdc| qbo
  edgewb[QBO writeback edge fns<br/>qbo-charge · qbo-return-order<br/>qbo-cylinder-audit · qbo-customer-lookup …] -->|write + instant mirror upsert| qbo
  edgewb --> mirror
```

Consequences worth knowing: a just-paid invoice flips to **Paid** when the mirror refreshes (seconds via the post-payment nudge, ≤15 min via the CDC cron); writeback edge functions upsert the mirror immediately so counts don't lag a day.

## Order & fulfillment flow

Four order channels all converge on the same `submit-order` pipeline: the **portal**, **Chloe phone orders**, **EDI email POs** (chain stores email a PO to a per-customer inbound address; review queue at `/admin/edi`), and the **Order Desk** (staff forward a customer's email to `aiorders@alamedapointbg.com`; AI proposes the order, a human clicks Accept).

```mermaid
flowchart LR
  cust([Portal · Chloe phone · EDI PO email · Order Desk forward]) -->|submit-order| sfjob[SF Job<br/>category Brix Web/Phone/EDI/Email Order]
  sfjob --> db[(orders.orders + lines)]
  db --> conf[Confirmation email]
  poller[order-lifecycle-check<br/>every 5 min] -->|reads job status/date| sfjob
  poller --> emails[Scheduled · Out for delivery<br/>Delivered emails]
  sfjob -->|"SF closes + invoices"| qbo2[QBO invoice]
  qbo2 -->|sync| mirror2[(ops mirror)] --> inv[Portal /invoices]
```

The SF job is created **before** any local rows (no orphan orders); SF's own fee engine bills fuel/hazmat — our fee lines are display-only estimates. Orders can also be **will-call pickups** (customer collects at the warehouse, pickup-worded emails), and customers with a **delivery schedule** (route days + a 4 PM day-before cutoff) get date defaulting plus a no-order reminder email.

## Payments — Stripe only

**Stripe is the only payment rail.** The legacy Bill & Pay integration was fully removed from the codebase on 2026-08-12 (accounts are deactivated manually in the B&P console); the QBO-Payments-direct rail never went live. There is no dual-rail cutover anymore — every customer pays on Stripe.

```mermaid
flowchart TD
  pay([Customer clicks Pay / autopay charge]) --> st[Stripe charge<br/>saved card or ACH]
  st -->|"Payment → Undeposited Funds<br/>(qbo-record-external-payment)"| qbo3[QBO]
  st --> recon["Stripe payout reconciler<br/>deposit = payments − fee → Chase 72"]
  recon --> qbo3
  qbo3 --> m3[(ops mirror)] --> paid[Invoice shows Paid]
  stret[Stripe return/dispute<br/>webhooks] --> inbox["/admin/payments<br/>returned-payments inbox"]
```

Charges book into QBO at charge time (gross → QBO Payment → Undeposited Funds); payouts post as QBO Deposits to Chase Business Checking with the Stripe fee split out, so the deposit one-click-matches the bank feed. Returned/disputed charges land automatically in the `/admin/payments` returned-payments inbox. Instrument entry (raw card/bank) happens **only** in Stripe's tokenized elements — never in our code (see [SOP-1](#/21-sop-security-access)). The full runbook is brix-order's `docs/PAYMENTS-SOP.md`. Per-customer payment facts (terms + how they pay per category: orders / equipment rentals / CO₂ tanks) live on the admin customer Overview "Account & payments" card; equipment-lease invoices (`EQ-LSE-*`, billed monthly by ERLS) classify into the equipment autopay scope.

## ResQ ↔ Service Fusion sync

```mermaid
flowchart LR
  resq2[ResQ work orders] -->|15-min pg_cron<br/>apbg-resq-sync| match{facility in<br/>ops.sync_customers?}
  match -->|yes| sfj[SF job created/updated<br/>status · photos · invoice]
  match -->|no| skip[Skipped — link the facility<br/>in Master Control]
  sfj -->|Completed| visit[ResQ visit + after-photos]
  sfj -->|💰 Bill| brix[QBO bill + Brixpense landing]
  sfj -->|🔒 Close → Invoiced| rinv[ResQ invoice submitted]
```

## Scheduled jobs inventory

| Job | Cadence | Lives in | What it does |
|---|---|---|---|
| `sync-qbo` full | daily ~09:35 UTC | Supabase edge fn | Full QBO → `ops.*` mirror refresh |
| `qbo-cdc-sync` | every 15 min | pg_cron → sync-qbo `mode=cdc` | Changed-invoice mirror refresh (paid toggles) |
| ResQ↔SF sync | every 15 min | pg_cron (apbg-resq-sync) | Work-order → SF job state machine |
| `order-lifecycle-check` | every 5 min | brix-order Netlify cron | SF job status → order status + lifecycle emails |
| `order-reminder-check` | every 30 min | brix-order Netlify cron | Delivery-schedule cutoff reminders ("we haven't received your order") |
| `order-unscheduled-alert` | 7a/10a/1p + 4pm EOD + 8pm escalation PT | brix-order Netlify cron | Digest of orders with no SF scheduled date → service@ |
| `invoice-notify` | hourly | brix-order Netlify cron | Post-delivery invoice emails (PDF attached) |
| Stripe payout sweep | daily 15:47 UTC | brix-order | Retry payout → QBO deposit posting |
| Token keep-alives | continuous | apbg-billing | QBO/SF OAuth freshness (Master Control tiles) |

## Keeping this chapter honest

This overview is registered in the sweep against the master `ARCHITECTURE.md` — when the architecture handbook changes, this chapter flags stale in [Master Control](#/09-master-control). The [Live Architecture Mirror](#/13-architecture-live) never drifts: it renders the current file straight from GitHub. The [Change Log](#/90-change-log) tab shows what actually shipped across every repo.

## Related

- [Live Architecture Mirror](#/13-architecture-live) — the full master handbook, rendered live
- [Change Log](#/90-change-log) — automatic feed of commits across all APBG repos
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — schema ownership, migration and secrets policy
- [Master Control](#/09-master-control) — health, sync controls, the handbook sweep
