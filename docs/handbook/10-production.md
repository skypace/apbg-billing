# Production — Formulas, BOMs, Work Orders & Purchase Orders

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-09-02

> **Looking for what to click?** [Running a Production Run — Click by Click](#/10a-production-run-guide)
> walks one run from "we need 500 cases" to received stock, with a screenshot of
> every screen and a QC test script. This chapter is the reference behind it.

The Production section of BRIX Refractor runs co-pack production end to end: the product formula drives the batch, the BOM lists the parts, the work order snapshots materials and generates purchase orders, and a staged pipeline moves the run from draft to finished goods in inventory. This chapter is the operator's guide to running a production run, written against the 2026-07-21 formula-driven redesign.

## Where it lives

Open **https://alamedapointbg.com/margin/** → **Production**, and set the lane
switch at the top to **Cans 24pks** (the other lane, **BIB Product**, shows only
Purchase Orders). Seven tabs:

| Tab | Purpose |
|---|---|
| **Formulas & Spec Sheets** | The recipes — % by weight, QC specs, batching instructions, revisions, batch scaler, printable batching sheet |
| **Materials & Pricing** | The purchased-item master — one vendor, one price and the ordering terms (MOQ, multiple, lead days) per component, the raw-ingredient list, and the raw-material stock sitting at the co-packer with its opening-balance form |
| **Bills of Materials** | Parts list per finished good, the recipe from the formula, and the pre-flight that says who gets a purchase order |
| **Work Orders** | The production runs — material snapshots, PO generation, lots, the status pipeline. Open / Pending / Closed / Voided pills, tick rows for bulk Edit / Void / Delete drafts |
| **Purchase Orders** | Vendor POs, including the one-per-vendor POs generated from work orders. Same four pills and bulk actions |
| **Licensing** | Licensing agreements — a licensor's royalty (Calderoni's syrup compounding charge) accrued per run on the cases produced, rate history, and monthly settlement into a Brixpense bill |
| **Compliance & Safety** | Certificates, audits and the document vault |
| **Run Guide** | The click-by-click walkthrough ([chapter 10a](#/10a-production-run-guide)) shown inside the page, plus the printable PDF for a tester |

The **Co-Pack (Legacy)** tab was removed on 2026-07-26; its data is retained
read-only in `ops.copack_orders`.

Data lives in `ops.product_formulas` / `_ingredients` / `_revisions`, `ops.product_bom(_lines)`, `ops.work_orders` / `work_order_materials` / `work_order_events`, and `ops.purchase_orders`; original spec spreadsheets live in the private `product-formulas` Storage bucket.

## Formulas & Spec Sheets

The formula is the driver of everything downstream. Seeded with the seven Alameda Quantum Canning batching sheets: **Hangar 25 Cola, Hangar 25 Diet Cola, Cable Car Lemon-Lime, Lost Island Ginger Beer, Old Fountain Cream Soda, Golden Gate Orange, and Oaktown Root Beer** — each carrying ingredients as % by weight, QC specs, step-by-step batching instructions, and revision history.

What you can do on a formula:

- **Interactive batch scaler.** Enter a target batch size in gallons (defaults to the formula's standard batch, e.g. 1000 gal) and every ingredient row shows its scaled **target weight** in lbs, plus total batch weight and the target unit count derived from the can size.
- **Printable batching sheet.** One click renders a print-ready sheet for the co-packer floor: numbered ingredients with %, target weights, and blank **Lot/batch #**, **Measured**, and check-off columns, followed by the batching instructions.
- **Attachments.** Upload the original spec spreadsheet; it stores in the private `product-formulas` bucket and opens from the formula card.
- **Revisions.** Formula changes are tracked in `ops.product_formula_revisions` so the recipe history is auditable.

## Bills of Materials

After the redesign, a BOM is a **pure parts list** — components and packaging per finished good, each line optionally carrying a **preferred vendor** (`preferred_qbo_vendor_id`). A BOM links to its formula (`product_bom.formula_id`); saves go through `fn_bom_save_v2`.

What a BOM deliberately does *not* do anymore: quantity and cost calculations. All of that moved to the work order, so editing a BOM never changes an in-flight run.

## Work Orders — the production pipeline

### Creating a run

Creating a work order (`fn_wo_create_pipeline`) takes the finished good's BOM and **snapshots per-vendor material requirements** into `ops.work_order_materials` at the quantity you're producing. The snapshot is frozen — later BOM edits don't touch this WO.

### Generating purchase orders

From the WO, **Generate POs** (`fn_wo_generate_pos`) creates **one purchase order per vendor** covering that vendor's share of the material snapshot. Each PO carries `work_order_id`, and the Purchase Orders tab (`v_purchase_orders`) shows the WO link, so you can always trace a PO back to its run.

### The status pipeline

Each work order shows a pipeline stepper; per-stage action buttons advance it via `fn_wo_advance`. What each advance actually does:

| Stage | Advance action | What happens |
|---|---|---|
| `draft` | (generate POs, then order) | Materials snapshotted; POs created — one per vendor |
| `ordered` | **Mark at co-packer** | Materials confirmed delivered to the co-packer |
| `at_copacker` | **Start production** | The batch run begins |
| `in_production` | **Record yield →** (dialog) | You enter the actual units produced vs planned. Posts the yield inventory movement and locks the **cost snapshot** — yield %, co-pack fee, and freight — and shows any missed-yield loss in dollars |
| `yield_recorded` | **Ship** (dialog) | Creates **and ships a real BOL transfer** from the co-packer to the warehouse |
| `in_transit` | **Receive** | Finished goods land in warehouse inventory |
| `received` | **Close** | Run complete; record locked |
| any pre-close | **Void** (reason required) | Cancels the run with an audited reason |

The grid shows each WO's stage, actual yield, and yield % (amber when under 100%). The cost panel on a closed run shows the locked snapshot including yield loss dollars.

### Audit trail

Every stage change writes to **`ops.work_order_events`**, and the `v_work_orders` view exposes stage timestamps — the WO detail stepper shows when each stage happened. If a run's history is in question, the events table is the record.

## Running a co-pack production run end to end

1. **Check the formula** (Formulas & Spec Sheets): scale it to the batch size, print the batching sheet for the co-packer, confirm the spec attachment is current.
2. **Check the BOM** (Bills of Materials): components, quantities-per-unit and preferred vendors are right *before* creating the WO — the WO freezes them.
3. **Create the work order** (Work Orders tab) for the finished good and quantity. Review the per-vendor material snapshot.
4. **Generate POs** — one per vendor — and send/confirm them from the Purchase Orders tab. Advance to `ordered`.
5. When materials arrive at the co-packer, **Mark at co-packer**.
6. When the run starts, **Start production**.
7. When the co-packer reports the finished count, **Record yield** with the actual units. Verify the cost snapshot (yield %, co-pack fee, freight) looks right — this is the moment costs lock.
8. When the truck leaves, **Ship** — this creates the BOL transfer co-packer → warehouse.
9. When the goods hit the dock, **Receive** — inventory updates.
10. **Close** the work order. Done; the audit trail and cost snapshot are permanent.

If anything went wrong before close, **Void** with a reason rather than deleting anything.

## Co-Pack (Legacy)

The pre-2026-07-21 co-pack order flow is kept as the **Co-Pack (Legacy)** tab. The old in-house consume/close work-order flow was retired (its tables were empty in production when replaced). Don't start new runs there — it exists for reference to old records.

## Engineering notes

- Migrations `20260721a`/`b` created the pipeline; it was smoke-tested end to end live (then rolled back).
- ⚠ **RPC overload trap:** `fn_create_transfer` / `fn_ship_transfer` / `fn_receive_transfer` have live legacy overloads — `fn_wo_advance` calls the longest signatures explicitly. If you touch these functions, keep the explicit-signature calls.
- All production tables are registered in `architecture/sync-manifest.json` (`brix-production:app-and-rpcs`, `push-qbo-item:vendors`); the build lints against it.

## Related

- [BRIX Refractor (Margin Control)](#/06-refractor-margin-control) — the app that hosts the Production section
- [SOP-8 · Production — Formula → BOM → Work Order → PO Pipeline](#/28-sop-production)
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — sync-manifest and migration rules
- Source: `apbg-billing/CLAUDE.md` (2026-07-21 production redesign entry); UI in `apbg-billing/app/src/pages/production/`
