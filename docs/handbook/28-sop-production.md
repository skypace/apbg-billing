# SOP-8 · Production — Formula → BOM → Work Order → PO Pipeline

> Part II · SOP Manual · Owner: Sky Pace · Last reviewed: 2026-07-22

This SOP governs how a beverage gets made: the formula is the single source of truth, the BOM is a parts list, and every quantity, cost, and purchase order is computed on the work order. It's for production ops and anyone touching the Production tabs in Refractor. The screen-by-screen user guide is the [Production chapter](#/10-production) — this is the policy and the run procedure.

## Formula control

### Policy

- **The product formula / spec sheet is the single source of truth** for a product's composition: ingredients as % by weight, QC specs, and batching instructions. It lives in `ops.product_formulas` + `ops.product_formula_ingredients`, with full revision history in `ops.product_formula_revisions`.
- **Changes to a formula create a revision** — never overwrite the record in place. The revision history is the audit trail for what was actually batched when.
- The **original batching spreadsheets** are archived in the **private** Storage bucket `product-formulas` (attachment upload on the Formulas & Spec Sheets tab). They are reference documents; the structured formula rows are what the pipeline runs on.
- The seven Alameda Quantum Canning batching sheets are seeded as the founding formula set: Hangar 25 Cola, Hangar 25 Diet Cola, Cable Car Lemon-Lime, Lost Island Ginger Beer, Old Fountain Cream Soda, Golden Gate Orange, Oaktown Root Beer.
- Use the tab's **interactive batch scaler** and **printable batching sheet** for co-packer runs — don't hand-scale in a spreadsheet and risk drift from the formula of record.

## BOM

### Policy

- A BOM is a **pure parts list**: which materials go into the product and each line's preferred vendor (`product_bom_lines.preferred_qbo_vendor_id`), linked to its formula (`product_bom.formula_id`). Saved via `fn_bom_save_v2`.
- **No quantities or costs live on the BOM.** All quantity/cost math happens at the work order, where batch size is known. Do not re-add per-BOM quantities; that design was deliberately retired in the 2026-07-21 rebuild.
- Keep preferred vendors current on BOM lines — PO generation groups by vendor, so a stale vendor produces a wrong PO.

## The production run

### Policy

- Every production run is a **work order** created from a formula, advanced through a fixed status pipeline. The pipeline (driven by `fn_wo_advance`) is:
  `draft → ordered → at_copacker → in_production → yield_recorded → in_transit → received → closed`
- Materials are **snapshotted onto the WO at creation** (`ops.work_order_materials`, per-vendor) — later BOM edits don't silently change an in-flight run.
- Purchasing is WO-driven: **one PO per vendor**, generated from the WO (`fn_wo_generate_pos`; `purchase_orders.work_order_id` links them). Don't hand-create production POs outside the WO.
- The co-packer → warehouse move is a **real BOL transfer** created and shipped at `in_transit`; finished goods land in inventory at `received`.
- The legacy in-house consume/close flow is retired (its tables were empty live). The Co-Pack Orders tab remains only as "Co-Pack (Legacy)" — do not start new work there.

### Procedure

1. **Create the work order** from the formula (Work Orders tab). `fn_wo_create_pipeline` snapshots per-vendor material requirements into `work_order_materials`.
2. **Generate POs** — one per vendor — from the WO. Send them; advance to `ordered`.
3. Advance to `at_copacker` when materials arrive at the co-packer, then `in_production` when the run starts (per-stage actions on the pipeline stepper).
4. **Record yield** (`yield_recorded`) — see the yield policy below. This posts the yield movement and the cost snapshot.
5. Advance to `in_transit` — this creates and ships the BOL transfer from co-packer to warehouse.
6. **Receive** — finished goods land in inventory.
7. **Close** the WO.

## Yield recording

### Policy

- **Actual yield is recorded at the `yield_recorded` stage, before the goods ship** — the cost snapshot depends on it. The snapshot captures yield %, co-pack fee, and freight; entering yield late or estimating it corrupts the unit cost that flows to inventory and margin.
- Record what the co-packer actually produced, not the theoretical batch size. The yield % is the honest loss record.

## Audit trail

### Policy

- Every WO stage change is logged in `ops.work_order_events` — that is the audit trail for who advanced what and when. Operational views: `v_work_orders` (pipeline state) and `v_purchase_orders` (exposes the WO link).
- Corrections to a mis-advanced WO should be visible in the event trail, not made by editing rows silently.

## Engineering caution: RPC overloads on `fn_wo_advance`

### Policy

- Anyone modifying `fn_wo_advance` or the transfer RPCs must know: **`fn_create_transfer` / `fn_ship_transfer` / `fn_receive_transfer` have live legacy overloads.** `fn_wo_advance` calls the **longest signatures explicitly** to disambiguate. *Why: the RPC-overload trap struck twice during the 2026-07-21 rebuild — an ambiguous call silently binds to the wrong overload.*
- If you add parameters to any of these functions, either drop the legacy overloads (after confirming nothing calls them) or keep the explicit longest-signature calls in sync in the same change.
- Schema changes here follow the normal migration + sync-manifest rules ([SOP-9](#/29-sop-data-engineering)); all production tables are registered in the manifest under `brix-production:app-and-rpcs` (vendors via `push-qbo-item:vendors`).

## Related

- [Production — Formulas, BOMs, Work Orders & Purchase Orders](#/10-production) — the user guide for the tabs and the stepper
- [BRIX Refractor (Margin Control)](#/06-refractor-margin-control) — the app hosting the Production surface
- [SOP-7 · Expenses & Purchasing](#/27-sop-expenses-purchasing) — non-production purchasing
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — migrations, manifest registration, RPC discipline
- Source: `apbg-billing/CLAUDE.md` change log, 2026-07-21 production redesign entry
