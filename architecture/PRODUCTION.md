# Production — formula → BOM → work order → POs → production order

> Written 2026-09-02 after Sky walked the intended process end to end. Read this
> before changing anything under Refractor → Production, and before touching
> `ops.product_formulas`, `ops.raw_ingredients`, `ops.product_bom*`,
> `ops.work_order*` or the production purchase orders.

## The shape of it

```
FORMULA  (the batching sheet — percent by weight)
   │  a case is cans × oz ÷ 128 gallons; × density = lbs of liquid;
   │  × each percent = lbs of that material in ONE case
   ▼
RAW MATERIALS  (ops.raw_ingredients — one row per physical material)
   │  how it is BOUGHT: vendor, pack, cost, QuickBooks item
   ▼
BILL OF MATERIALS  (one per sellable case SKU)
   │  ingredients (from the formula) + 24 cans
   │  + fill charge + tolling charge          ← per case
   ▼
WORK ORDER  ("make 500 cases")
   │  batch plan: gallons needed, and how many MORE cases fill the tank
   │  materials: recipe quantity → whole vendor packs
   ▼
PURCHASE ORDERS  — ONE PER VENDOR, generated from the work order
   │  AC Calderoni  → N gallons of CONCENTRATE, with the ingredient
   │                  breakdown printed underneath (see The roll-up)
   │  Quantum Canning → cans, tolling, Velcorin, dunnage
   ▼
PRODUCTION  at the co-packer: materials land → consume → record yield
   │  the yield rate is per flavour and lives on the formula
   ▼
PRODUCTION PURCHASE ORDER
   │  ONE PO to ALAMEDA SODA COMPANY PRODUCTION for the finished cases,
   │  priced at the merged per-case cost of everything above
   ▼
SHIP (BOL) back to Brix → RECEIVE into inventory → CLOSE
```

## The concentrate — 5:1, and the check that proves it

Every Alameda Soda flavour is a **5:1 fountain syrup**: one part concentrate to
five parts water, so the concentrate is **one sixth of the finished volume**.
Calderoni's own product codes say so on the bills — `Cola Syrup - 5XB0`,
`Root Beer 5XW0`.

Nothing here is typed. It is derived:

```
finished per case = cans × oz ÷ 128            = 24 × 12 ÷ 128 = 2.25 gal
concentrate       = finished ÷ (1 + throw)     = 2.25 ÷ 6      = 0.375 gal
```

`fn_bom_sync_from_formula` writes that onto the flavour's gallon BOM line on
every rebuild, so it cannot drift and cannot be quietly wrong. **The BOM used to
say 1 gal per case** — a placeholder that was neither of the two defensible
readings and that multiplied the whole ingredient bill by 2.7.

### The ingredients are the independent check

Every material on the sheet except water ends up inside that concentrate. So
their weight over its volume is the syrup's **solids loading**, which anyone who
knows fountain syrup reads instantly. `fn_formula_batch_basis` computes it:

| flavour | solids / case | ÷ 0.375 gal | verdict |
|---|---|---|---|
| Hangar 25 Cola | 2.290 lb | **6.11 lb/gal** | consistent with 5:1 |
| Golden Gate Orange | 2.371 lb | 6.32 lb/gal | consistent with 5:1 |
| Lost Island Ginger Beer | 2.441 lb | 6.51 lb/gal | consistent with 5:1 |
| Cable Car Lemon-Lime | 2.139 lb | 5.70 lb/gal | consistent with 5:1 |
| Olde Fountain Crème | 2.121 lb | 5.66 lb/gal | consistent with 5:1 |
| Oaktown Root Beer | 2.112 lb | 5.63 lb/gal | consistent with 5:1 |
| Hangar 25 **Diet** Cola | 0.092 lb | 0.25 lb/gal | *diet — check does not apply* |

Six flavours land between 5.6 and 6.5 lb/gal — textbook for 5:1 — and they agree
with each other, which is what makes the ratio believable rather than asserted.
Set the throw wrong and the number goes somewhere obviously silly.

⚠ **Diet Cola's 0.25 lb/gal is correct, not a fault.** It is monk-fruit
sweetened and carries no bulk sugar, so its syrup genuinely is almost all water.
The check detects that (no material above 2% of the finished weight) and says
the band does not apply, rather than printing a warning on one of seven products
that could never be cleared.

The throw ratio lives on the **formula** (`dilution_ratio`) and is written down
to `product_bom.dilution_ratio`, which the older `fn_bom_scale_runs` reads. One
source, one derived copy, maintained by the rebuild.

## The roll-up — ingredients in, one gallon line out

**AC Calderoni bills per gallon of a flavour, never per ingredient.** Every bill
on file says so: `3G6121 HANGAR 25 COLA, 210 @ 28.75 — "Cola Syrup 5XB0"`. They
compound the batch; the ingredient list is the *specification* of what goes into
it, not a set of things we buy separately.

So a BOM component line is one of two things:

| | carries | is | reaches QuickBooks |
|---|---|---|---|
| **stocked** | `component_qbo_item_id` | the gallon, cans, tolling, Velcorin, dunnage | yes — as its own PO line |
| **recipe** | `ingredient_id`, usually no item | sugar, citric acid, flavor | **no** |

A recipe line points at the flavour's 1-gallon item through
`rollup_qbo_item_id`. When purchase orders are generated:

- the **gallon** gets an ordinary PO line — for 500 cases, *187.5 gal of
  `1GNS6121` @ $5.38* — and that is the only thing the QuickBooks push sends. **`postPurchaseOrder`
  needed no change at all**, which is the point of modelling it this way rather
  than teaching the push to collapse lines.
- the **ingredients** are filed underneath it in
  `ops.purchase_order_line_details` — *Cane Sugar 1 102.8 lbs, Cola Flavor 41.4
  lbs, Sodium Gluconate 0.945 lbs* — which is what Refractor shows and what the
  printed PO tells the supplier to buy.

### Two costs, and which one is true

`allocated_cost` splits the gallon line's price across the materials **by
weight**, so the breakdown always adds back to what we are actually billed
($971.45 + $36.47 + $0.83 = $1 008.75 on the run above). ⚠ It is an
*allocation*, not a quote: flavour is a rounding error by weight and a large
share of the real cost, so weight-allocation flatters sugar and starves flavour.
It answers "what does this gallon break down to arithmetically", nothing more.

`quoted_cost` is filled only where a material has a real price on file. When
enough of them do, the sum can be compared against the gallon price and the
difference is a real number — the supplier's margin and handling — rather than
a guess.

**The gallon holds the price. Everything else is derived from it.**

### Buying a material directly

`raw_ingredients.purchase_mode` is `rollup` (the default, and every ingredient
today) or `direct`. Only a `direct` material gets its own PO line, and only a
`direct` material needs a QuickBooks item. The mode is explicit precisely so
that creating an item for a material does not by itself change how it is
bought — otherwise one click on *create the missing items* would turn a
Calderoni gallon order into seventeen ingredient lines.

## Where each number comes from

| Question | Answered by |
|---|---|
| How much sugar is in a case? | `ops.fn_formula_case_requirements(bom_id)` |
| How many cases fill a 2 000 gal tank? | `ops.fn_batch_plan(bom_id, cases)` |
| How much do we buy for 500 cases? | `ops.fn_wo_create_pipeline` → `ops.work_order_materials` |
| Which vendor gets which PO? | the vendor on each material row; `ops.fn_wo_generate_pos` groups by it |
| What did a case actually cost? | `ops.work_order_costs.per_case`, set when the yield is recorded |
| What do we owe ourselves for the finished cases? | `ops.fn_wo_create_production_po` |

There is exactly ONE implementation of the per-case arithmetic. The BOM rebuild,
the recipe preview in the BOM editor and the work order all call
`fn_formula_case_requirements`. A second copy would drift, and the direction it
drifts in is a purchase order for the wrong quantity.

## Rules that are load-bearing

**Water is not purchased.** Filtered water is 87–99% of every formula by weight
and comes out of the wall at the co-packer. It stays on the batching sheet — it
is what makes the percentages total 100 — and is excluded from the BOM and every
PO by `raw_ingredients.is_purchased = false`. Putting it on a Calderoni PO would
order two tons of water per run.

**Recipe units are not purchase units.** The formula says lbs; the vendor sells
50-lb bags. `work_order_materials.recipe_qty` is the theoretical need and
`required_qty` is what goes on the purchase order — converted to packs and
rounded UP to a whole order multiple, because you cannot buy 0.4 of a bag.
Collapsing the two is how a PO ends up ordering 11.7 bags of sugar.

**A BOM line has an owner.** `product_bom_lines.source` is `'formula'` (written
by `fn_bom_sync_from_formula`, replaced wholesale on every rebuild) or
`'manual'` (cans, tolling, Velcorin, dunnage — written by `fn_bom_save_v2`,
never touched by a rebuild). The BOM editor loads only manual lines into its
form and shows the recipe read-only beside them. Break that split and a rebuild
either wipes the operator's packaging lines or adds a second copy of the recipe.

**Nothing invents a cost.** A material with no price on file shows a gap, and
the per-case cost comes out short and says so. A plausible-looking number here
becomes a QuickBooks bill.

**A rolled-up ingredient is never costed twice.** Its price is allocated OUT of
the gallon line it rolls into, and it is never a purchase order line, never an
inventory movement and never part of the component cost — which is enforced
structurally, by keeping recipe lines in `ops.work_order_recipe_lines` where
`fn_wo_advance` cannot see them, rather than by remembering to filter them in
the consume and the yield.

**The production PO is refused before a yield is recorded.** Until then there is
no measured per-case cost, only an estimate nobody weighed.

**A materials PO and the production PO are opposite ends of one run.**
`purchase_orders.po_kind` keeps them apart (`materials` vs `production`). Summing
them as spend double-counts the whole batch.

## Prices and vendors — one master, one precedence

`ops.production_items` is where a stocked component's **vendor and price** live —
the flavour gallons, the printed cans, tolling, Velcorin, dunnage. It is
edited on **Production → Materials & Pricing → Purchased items & vendors**, and
it exists because neither number could be managed anywhere sensible before:
the price came from the QuickBooks item mirror (nightly, and stale — $0.26 a can
against $0.31–0.37 billed) and the vendor lived on each BOM line separately, so
moving the cans to another supplier meant editing seven BOMs.

Everywhere a cost or vendor is read, the precedence is:

```
BOM line override  >  production_items  >  raw_ingredients  >  QBO mirror
```

`fn_wo_create_pipeline` (what the work order prices its POs at) and
`fn_bom_preflight` (which vendor gets which PO) both read it. **The BOM line's
own vendor slot is now an OVERRIDE, not the default** — the migration cleared
every line vendor that merely repeated the master, so the master actually
governs instead of being shadowed by seven identical copies. Use the line slot
for the genuine exception (this one flavour buys its cans elsewhere).

⚠ The QuickBooks purchase cost is shown alongside for comparison and is **never
written to** from here. A price seeded from QuickBooks carries the note "seeded
from QuickBooks purchase cost" until somebody confirms it against the vendor's
sheet and saves — an unconfirmed price should look unconfirmed.

## What the vendors actually bill — the BOM reconciled to their invoices

Asked on 2026-09-02 whether the BOM carried every charge from both vendors, the
honest answer was no — and the way to find out was to read the vendors' own
paper, not our item list. Quantum invoices 1462 (05/2025 final), 1741 (04/2026
deposit), 1583 and 1766, bill 171778 (cans), and every AC Calderoni line booked
to Can Raw Materials since 2025:

| Charge | Who bills it | What the paper says | On the BOM now as |
|---|---|---|---|
| Tolling (fill + pack-off) | Quantum | ONE line, `Basic Fill: Tolling`, **$0.62/can** on 1462 and 1741 | `12OZ CAN FILL LABOR` (531) × 24 @ $0.62 — the PACK OFF line (532) is gone; Quantum never billed it |
| Velcorin (DMDC) | Quantum | $0.02/can × 233,088 on 1462 | `VELCORIN 12OZ CAN` (1390, new) × 24 @ $0.02 |
| Dunnage | Quantum | "CHEP Pallet, 4-way polystrap, shrinkwrap" **$50 × 114 pallets** for 233,088 cans ≈ 85 cases/pallet | `DUNNAGE FEE PER PALLET` (565) × 1/85 @ $50 |
| Printed cans | Quantum | $0.328 on bill 171778 (07/2026); 2025 deposits $0.31–0.37 | six can items @ $0.328 (was $0.26) |
| 24-pk tray | **nobody, on any Quantum invoice** | — | **removed from every BOM (`20260902u`)** — taken to be inside the $0.62 tolling line, the same way pack-off was |
| Syrup | Calderoni | lump-sum "can ingredients" per run ($5,073 May, $9,236 + $3,544 June) | the 1GNS gallon line, 0.375 gal/case |
| Canning fee | Calderoni | **flat $1,173.33 per run**, every run since 2026-03 | ~~`CANNING RUN FEE (SYRUP COMPOUNDING)` (1391) — 1 per run~~ **Off the BOM since 2026-09-03** — it is a licensing royalty on the cases produced, accrued at yield (see "Licensing agreements" below) |
| Freight | Calderoni | a separate line most runs ($98–$3,200) | not on the BOM — entered as landed freight at Record yield |

A flat per-run charge cannot be a per-case quantity, so a BOM line now has a
**basis**: `per_yield` (the default — scales with the run) or `per_run` (one per
work order, whatever the size). `fn_wo_create_pipeline` and
`fn_bom_material_requirements` honour it; the BOM editor shows it as
"per unit / per run".

**Per-case variable cost is now $25.85 for Hangar 25 Cola** (was $17.52 before
the tolling and the missing lines were fixed), plus $1,173.33 a run. The
finished-case QuickBooks items carry $21.36 — a number nobody can trace, and
now demonstrably too low. ⚠ The gallon price is the piece still worth
checking: Calderoni bills syrup as a lump sum, and May's $5,073 for a run
Quantum deposited as 4,400 gal finished works out to about **$6.92 per gallon
of concentrate**, which is in the range the 1GNS items carry ($4.25–$7.44) — so
the gallon is plausible, not proven.

⚠ Two QuickBooks items were created for this (1390 Velcorin, NonInventory;
1391 canning fee, Service — both expensed to Can Raw Materials 294). Nothing
Inventory; see "Item types" below. 1391 was then **retired on 2026-09-03**:
the charge it stood for is not a purchased material but a royalty on the cases
produced, and it now lives on the Licensing tab (next section). The QuickBooks
item stays, deactivated in the purchased-item master only — it carries history.

## Licensing agreements — the royalty is not a PO line

Calderoni's "canning fee" first landed on the BOM as a flat $1,173.33 per-run
line (item 1391). Sky's correction, 2026-09-03: *"the syrup compound isn't a
receivable item, it's a calculation that goes on its own tab called licensing
agreements… like a rebate would be"*, and the basis is **"total final cases of
soda made in each production run — this is why it's separate from the PO."** A
purchase order lists what a vendor ships or performs; a royalty is owed on what
came off the line, which is only known at yield. So it moved (migration
`20260903a`):

| Piece | Table / RPC | What it holds |
|---|---|---|
| Program | `ops.licensing_programs` | the licensor (QBO vendor), entity, settlement period (month / quarter), status |
| Rule | `ops.licensing_rules` | basis (`cases_produced` — the one Sky named — or concentrate / finished gallons), the current **rate** + unit label, optional formula scope, active flag |
| Rate history | `ops.licensing_rule_rates` | append-only, written by trigger on every rate change; the accrual reads the rate in force on the yield date |
| Accrual | `ops.licensing_accruals` | one row per (rule, work order), written **at `record_yield`** by `fn_licensing_accrue_wo`; `settlement_id` NULL = unsettled |
| Settlement | `ops.licensing_settlements` | one per program per finished period, reference `LIC-<CODE>-YYYYMM`, snapshot of the calc, link to the Brixpense request |

**Rules that are load-bearing:**

- **Accrue at yield, not at settlement.** `fn_wo_advance__i record_yield` calls
  `fn_licensing_accrue_wo(wo_id, yield_qty, yield_date)` and adds the amount to
  `work_order_costs` as a `kind:'royalty'` detail row — so the per-case cost
  does not silently drop by $1,173.33 ÷ cases when the BOM line leaves, and a
  rate change is **forward-only by construction** (a run yielded under the old
  rate keeps it; **Re-price unsettled** on the tab is the deliberate override
  and touches only accruals not yet settled).
- **A period settles once it has ended.** `fn_licensing_settlement_create`
  refuses the current month; the tab disables the button for the same reason.
  Settlement sums the unsettled accruals in the window and inserts an
  `ops.expense_requests` row (approved, as_bill, tag `Licensing`, bill number
  `LIC-…`, one line per rule) — **posting to QuickBooks stays a human click in
  Brixpense**, the 2026-08-14 gate. Void releases the accruals and archives the
  request; refused once posted.
- **Nothing is received and nothing ships.** There is no PO, no movement, no
  QuickBooks item for it — which is exactly the point of taking it off the BOM.

Seeded: program **CALDERONI** (vendor 1099, monthly), one rule at **$0.50 per
case produced** — Sky: "I think right now it's $.50 per raw gallon" — ⚠ the rate
and its basis are seeded from that remark and carry the note *confirm against
the agreement*; the Licensing tab is where they get corrected, with history.
Verified live in a rolled-back run: 100 cases of Hangar 25 Cola accrued
`100 × 0.50 = $50.00`, landed in the cost snapshot as a royalty line, and all
seven BOMs still pre-flight at 2 POs / 0 blockers with the 1391 line gone.

## The documents — PO, BOL, batching sheet, as PDFs

`netlify/functions/production-doc.mjs` renders the three documents the
pipeline produces, in the same design as The Melt system's PO and BOL
(melt-dashboard `generate-po.mjs` / `generate-bol.mjs`): both brand marks, the
red accent rule, company block left / document number right, grey meta blocks,
accent table header, grand total, signatures, footer. One renderer
(`lib/production-docs.mjs`, pure — payload in, bytes out) serves all three, so
the batching sheet a co-packer receives looks like the PO that came with it.

| Document | Source | Where |
|---|---|---|
| Purchase order | `purchase_orders` + lines + the ingredient detail under the gallon line | Production → Purchase Orders → open one → **View PDF / Email…** |
| Bill of lading | `inventory_transfers` + lines, shipper/consignee from `inventory_locations` | Stock → Transfers → open one → **View BOL PDF / Email…** — Quantum ↔ Brix moves are ordinary transfers |
| Batching sheet | formula + ingredients, scaled to a batch size or to a work order's run | Formulas → **Batching sheet PDF**; Work Orders → **Batching sheet** (sized to the run) |

**Emailing is server-side and the PDF we email is the PDF we keep.** The bytes
go to the private `production-docs` bucket first, then out as an attachment,
and `ops.production_doc_sends` records recipients, subject, note, storage path
and Resend id — a failed send still records what was built. The email modal
shows what has already gone out for the same document before offering to send
again, because the usual reason to open it twice is "did that go out?".

The company identity on every document (name, address, email, web, accent
colour, From: address) is on `ops.production_settings` and edits without a
deploy. ⚠ `doc_from` must be a Resend-verified sender; `sendEmail()` quietly
falls back to `alerts@alamedapointbg.com` if it is not, so a misconfiguration
degrades rather than bounces.

⚠ **Auth on the function is hub superadmin/admin**, and a `window.open` cannot
carry a bearer — the client fetches the PDF with the token and hands the browser
a blob URL (`lib/productionDocs.ts openDocPdf`). Same trap melt-dashboard
documents for its admin GETs.

⚠ Every string the renderer draws goes through `winAnsi()` first. pdf-lib's
standard fonts throw on a character outside WinAnsi, and the wrap step measures
before it draws — so a raw em dash in a vendor name would crash the render one
line earlier than the drawing call anyone would look at (the 2026-08-31 lesson).

## Buckets and bulk actions — one vocabulary on every list

Sky, 2026-09-03: "open, pending, closed and voided on different tabs" and
"delete, edit, and receive multiple items in any table… a void on each that I
can select all." Every production list — Work Orders, Purchase Orders, Stock →
Transfers — now opens on the same four pills, with counts:

| Bucket | Means | Work order | Purchase order | Transfer |
|---|---|---|---|---|
| **Open** | a step is still to be taken | ordered → received | open, partial, **received** | in transit |
| **Pending** | a draft; edit or delete freely | draft | draft | draft |
| **Closed** | nothing more happens | closed, consumed | closed | **received** |
| **Voided** | cancelled, reason on the row | void | void | void |

**The rule lives once, in SQL** — `ops.fn_status_bucket(kind, status)`,
exposed as `bucket` on `v_work_orders` and `v_purchase_orders`; the client's
`lib/lifecycleBuckets.ts` mirrors it for lists that read a bare table
(transfers) and says so at the top of the file. Two placements are deliberate
and worth stating: a **received purchase order or work order is still Open**,
because a click (Close) remains and a document you still have to act on must
not hide under Closed; a **received transfer is Closed**, because nothing
remains — the stock has landed.

**Bulk actions** (migration `20260903b`): tick rows → the bar offers **Edit…**,
**Void…** and, on the Pending bucket, **Delete drafts…**. Rules:

- **Nothing half-applies silently.** Each id runs in its own sub-transaction
  and the RPC returns `{done[], skipped[{id, number, reason}]}`; the dialog
  shows *before* you press the button which rows will be voided and which will
  be left alone and why (a work order past `at_copacker`, a PO with receipts, a
  shipped transfer), and the toast afterwards names anything the server still
  refused. `window.prompt()` is gone from every void — the `ReasonDialog` is
  the one place a reason is typed, for one row or fifty.
- **The eligibility rules did not move.** The bulk functions call the existing
  single-row inner functions (`fn_wo_advance__i 'void'`, `fn_void_purchase_order__i`,
  `fn_void_transfer__i`), so what may be voided is decided in one place.
- **Delete is draft-only and the only hard delete in the module.** A draft
  with no QuickBooks id, no receipts and no dependent document (a PO raised
  from a work order, a transfer that is a work order's return shipment or
  fulfils a sub-distributor order) can be deleted; anything else is voided,
  and the void reason is the record.
- **Edits are whitelisted per document** — PO `expected_date`/`notes`, work
  order `scheduled_date`/`notes`, transfer `carrier`/`tracking_number`/
  `special_instructions`/`notes` — and a field left blank in the dialog is not
  sent, so an empty box cannot blank ten rows; tick *clear* to blank one on
  purpose.
- **Every action is audited.** Work orders already had `work_order_events`;
  purchase orders and transfers gain `ops.production_doc_events`
  (void / delete / edit, with the reason or the patch), written only inside
  the SECURITY DEFINER functions.
- ⚠ **Voiding a PO also releases its work-order materials** (`po_id` /
  `po_line_id` cleared) so **Generate POs** can raise a replacement — a gap
  the single-row void had: a voided PO left the materials marked "on PO" and
  the work order could never re-order them.

Verified live in a rolled-back block: a draft PO voided while an unknown id
was skipped with `PO not found`; the void PO then refused deletion (*is void;
only a draft can be deleted*) and edit (*is void; reopen it first*); a patch
carrying `subtotal` was refused by name; a draft transfer took `carrier=XPO`
and dropped an empty `notes` without blanking it, then voided; four audit
rows were written.

## Receive, reopen, correct — a closed document is not a locked one

Sky, 2026-09-03: "When I receive something I should be able to edit it if I
closed it and reopen. That should be on all items." Migration `20260903c`:

| Action | Where | What actually happens |
|---|---|---|
| **Receive…** several POs at once | Purchase Orders → tick rows (Open) → Receive… | every outstanding line of the selected POs, grouped by PO with its destination, quantity defaulting to what is still short; one call, `fn_receive_po_lines`, each line in its own sub-transaction |
| **Close…** | tick rows (Open) → Close… | the existing single-row close, in bulk; refused for a PO with nothing received |
| **Reopen** | PO / work order / transfer detail, or tick rows (Closed) → Reopen… | closed → open again, with a reason stamped `reopened_at/by/reason` |
| **Correct a receipt** | PO detail → pencil beside Received | the line's received quantity set to a new figure, up or down, dated, with a reason |

**The ledger is append-only, so a correction is a movement, not an edit.** A
receipt corrected UP posts another `receipt`; corrected DOWN posts a
**`receipt_reversal`** (a new movement type — the table's `qty > 0` CHECK
holds and the direction carries the sign). The original receipt stays: "why
did 3 cases leave the warehouse on the 4th" must remain answerable from the
movements, and an edited row cannot answer it.

**A correction is refused once the goods have moved on.** Reversing 3 units
needs 3 on hand at the PO's destination; if they have already shipped to a
store, the stock is somewhere else and the fix belongs where it is, not on a
document that was right when it was written. The same rule reopens a
received transfer: every line is reversed from the destination back to
TRANSIT, refused if the destination no longer holds them — and refused
outright when the transfer is a work order's return shipment that the run has
already received, because the run's receipt is the record.

**A reopened PO's status is recomputed from its lines, never guessed**
(`fn_po_recompute_status`: all lines full → received; some received →
partial; none → open). Correcting a receipt on a closed PO so that a line is
short again reopens it by itself, with the reason on the row. **The
QuickBooks purchase order is never touched by any of this**; the dialogs say
so.

Verified live in a rolled-back block: two lines received in one call with a
third refused by name (*receiving 9 would exceed qty_ordered (4)*); the PO
closed, then a line corrected 10 → 7 posted one `receipt_reversal`, reopened
the PO to *partial* with *Receipt corrected: counted 7 not 10* on it; a
partial PO refused Reopen (*only a closed PO can be reopened*); a shipped and
received transfer reopened to in transit with the destination back at 0 and
TRANSIT at 2; eight audit rows written in order.

## What is received, and when a purchase order closes

Sky, walking the run: *"tolling items and services should just be a part of
the order process. nothing needs to ship to Quantum… no need to receive the
services PO"*; the Quantum PO closes *"as a part of the production run when
you build the yield and what's getting shipped back"*; the Calderoni PO closes
when Quantum receives the raw materials. Migration `20260903d`.

**Two facts, two columns, one place each.** `purchase_orders.close_rule` says
how a PO ends: `on_receipt` (the default — it closes by itself the moment
every receivable line is fully in) or `on_run_yield` (the co-packer's own PO,
which closes when the run ships and against which nothing is ever received).
`purchase_order_lines.receivable` says whether a line is a thing that arrives:
false on every line of an `on_run_yield` PO and on every **Service** item
anywhere. `fn_wo_generate_pos` stamps both — vendor equals the work order's
co-packer → `on_run_yield`, anyone else → `on_receipt` — and the PO's own note
says *closes when the run ships (nothing is received against it)* so the rule
is on the document, not only in a column.

**Receiving refuses a non-receivable line by name** — *this line is not
received — the co-packer's PO closes when the run ships* or *… it is a
service, not stock* — and completion counts receivable lines only, so a
tolling line can never hold a Calderoni PO open. When a run's `on_receipt` PO
completes it CLOSES (`closed_reason = 'received'`), and when the run's last
`on_receipt` PO closes the work order moves **ordered → at_copacker** by
itself: the Calderoni PO closing *is* "the materials are at Quantum", and
pressing a second button to say so was the step people forgot.

**What Quantum supplies to itself lands at Quantum, once, at start of
production.** The cans and the Velcorin on the Quantum PO are real stock the
co-packer owns until the batch consumes them — so `start_production` posts a
`receipt` for every non-Service line of an `on_run_yield` PO into the PO's
destination (idempotent on the line id), then consumes. ⚠ **Service items are
never consumed as stock.** Before this, `start_production` posted a
`production_consume` for FILL LABOR and DUNNAGE and the co-packer's on-hand
for a tolling charge went to −4,618 — a number that means nothing and drifts
forever. The consume now skips `qbo_items.type = 'Service'`. ⚠ The
record-yield **cost** roll-up deliberately does NOT skip them: tolling is a
cost of the batch even though it is never a thing on a shelf. Those are two
different questions and the migration anchors them separately — the same
`FROM … work_order_materials` appears twice in `fn_wo_advance__i`, and only the
consume copy was changed (anchored on its `WO consume ·` note line).

**Ship closes the co-packer's PO.** When the work order ships, every
`on_run_yield` PO on it has its lines marked received-in-full (no movement — a
service does not arrive), a `production_doc_events` close row, and
`status = 'closed'`, `closed_reason = 'run_shipped'`. Nobody receives the
Quantum PO; the run does.

**Void releases.** `fn_void_purchase_order` now clears
`work_order_materials.po_id/po_line_id` and the recipe lines' `po_line_id`, so
Generate POs can raise a replacement — 20260903b had closed that gap on the
bulk path only.

On screen: the PO header carries a chip — **Closes when the run ships** /
**Closes on receipt** (hover for the sentence) — and a closed PO prints its
`closed_reason`. A PO with no receivable line has no Receive column at all;
on a mixed PO a service line reads *service — not received* where the truck
would be, and the pencil (receipt correction) only appears on receivable
lines. The bulk **Receive…** dialog skips `on_run_yield` POs and names them
(*PO-2026-00025 (closes when the run ships)*) rather than offering lines that
would be refused.

Verified live in a rolled-back block on a 500-case Hangar 25 Cola run:
two POs — Calderoni `on_receipt` (gallon, receivable) and Quantum
`on_run_yield` (fill labour, cans, Velcorin, dunnage, all non-receivable);
receiving a Quantum line refused with the sentence above; receiving the gallon
closed the Calderoni PO `received` and moved the WO to `at_copacker` with a
`materials_at_copacker` event; `start_production` landed 12,000 cans + 12,000
Velcorin at Quantum once and consumed three items with **zero** Service
consumption; `record_yield` + `ship` left the WO `in_transit`, the Quantum PO
`closed/run_shipped` with all four lines received, two doc events in order,
and the $250 royalty on the cost row.

⚠ **Pre-existing negatives at QUANTUM-CANNING are NOT corrected by this** —
the ledger is append-only. WO-2026-00009 (closed) consumed 4,618 of FILL
LABOR, DUNNAGE 0.353 and 4,618 Velcorin and 4,618 Oaktown cans with nothing
landed first, so those four items read negative at Quantum today. They are the
last runs before the fix, not live stock; an `adjustment` to zero the two
Service items is an operator's call (Stock → Adjustments), and the can/Velcorin
balances are what P5's opening-stock form is for.

## MOQ, demand and the surplus at the co-packer

Ask (Sky): a place to record each item's MOQ; when the MOQ exceeds the run's
need "we need to fill that void" — order the minimum, land the rest at Quantum
and **see it as raw-material stock for the next run**; and "we will need
starting amounts for the ingredients". Migration `20260903e`.

**Two quantities on every work-order material, and they mean different
things.** `demand_qty` is what the BATCH needs, in purchase units, unrounded —
12,000 cans for 500 cases. `required_qty` is what is ORDERED once the vendor's
terms are applied — 20,000 cans under a 20,000 MOQ. The purchase order carries
`required_qty`; `start_production` lands `required_qty` at the co-packer and
consumes `demand_qty`; `record_yield` costs the batch on `demand_qty` (the
detail row now carries both, as `qty` and `ordered_qty`). **The 8,000 that
were never used stay valued at Quantum, not buried in this batch's cases**,
which is the rule that closes gap #4 below: the first run does not eat the MOQ,
and the second run sees 8,000 cans already sitting there.

**The terms live where the price lives.** `production_items` gains
`min_order_qty`, `order_multiple`, `lead_days` — edited on Materials & Pricing
→ Purchased items, beside the vendor and the price, because they are the same
kind of fact (this is how Quantum sells cans). `raw_ingredients` gains
`min_order_qty` next to the `pack_size` / `order_multiple` it already had.

**ONE rounding rule, in two places that must agree.** `ops.fn_order_qty(demand,
moq, multiple)`: nothing said → order the demand; otherwise
`ceil(max(demand, MOQ) / multiple) × multiple`. `lib/componentSourcing.ts`
`orderQty` / `componentOrderQty` is the client copy, so the New Work Order
preview prints the same **Ordered** figure and the same `+8,000 MOQ` chip the
work order will carry. ⚠ **Blank and 1 are different answers.** A blank
multiple is "any quantity" (5.8825 pallets of dunnage, as today); a typed
multiple of 1 is "whole units" (6 pallets). The first version treated 1 as
blank, which would have made typing 1 to get whole pallets do nothing — the
exact case an operator will try first. `raw_ingredients.order_multiple`
defaults to 1 *by schema*, so there a 1 with no pack size is treated as blank
(the schema said it, not a person). A `per_run` line is a flat charge and is
never rounded.

**Opening stock is a one-shot, and refuses to be a second shot.**
`fn_copacker_opening_balance(location, lines, as_of, note)` posts one
`adjustment` movement per item, ADJUSTMENT → co-packer, `source_doc_type =
'opening_balance'`. It refuses a warehouse by name (that is Stock →
Adjustments' job), refuses an unknown item and a zero, and **refuses an item
that already has an opening at that location** — a wrong opening is corrected
by an ordinary adjustment with its own reason on it, because two "openings" a
month apart is how nobody can later say what the count was. On screen:
Materials & Pricing → **Raw materials at the co-packer** — on hand, open
demand (materials on work orders not yet in production), what is left after
those runs, MOQ, last cost, last moved — and the **Record opening stock…** form
under it. `ops.v_copacker_stock` is the view; its `reserved` column is 0 today
and is redefined by the runs phase without changing shape.

**Stock → Adjustments can now see raw materials at a co-packer.** They are
`excluded` from every inventory lane, so the lane picker could never offer
them; at a co-packer location the purchased-item master is offered as well.
That is also how the four negative Quantum balances left by WO-2026-00009 get
zeroed.

Verified live in a rolled-back block: cans set to MOQ 20,000 × 1,000 and
dunnage to a multiple of 2; a 500-case run stamps cans **need 12,000 / ordered
20,000**, dunnage **5.8825 / 6**, gallon 187.5 / 187.5; the Quantum PO carries
20,000; `start_production` lands 20,000, consumes 12,000, and
`v_copacker_stock` reads **8,000 on hand**; the cost detail carries
`qty 12,000 · ordered_qty 20,000 · $3,936`; the opening form refused
BRIX-WAREHOUSE, recorded 4,618 Oaktown cans at $0.328 (which took that item's
balance from −4,618 to exactly 0), skipped an unknown item and a zero by
reason, and refused a second opening for the same item.

## Lots and born-on dates — QC on the way home

Quantum's invoice already speaks in lots — 1462 lists each flavour's tolling
with its batch codes in parentheses (`Q375, Q379, 390, 393, 397`). Until
2026-09-02 nothing here could hold them: a work order had ONE batch code (ours)
and the shipment back was ONE transfer line for the whole yield.

```
record_yield ── lots: [{lot_code, born_on_date, best_by_date, qty}, …]   (optional here)
       │             └─ quantities MUST total the yield — a case is in exactly one lot
       ▼
 yield_recorded ── "Edit lots" on the work order, or enter them in the Ship dialog
       │
       ▼
   ship ── the co-packer → warehouse transfer is written ONE LINE PER LOT
       │   (inventory_transfer_lines.lot_code / born_on_date / best_by_date)
       │   and the BOL prints Lot · Born on beside every line, Best by underneath
       ▼
 receive ── fn_ship_transfer / fn_receive_transfer stamp every movement with
            source_doc_line_id, so each movement traces to its lot with NEITHER
            function changing
```

- `ops.work_order_lots` — the lots on a run. Written only through
  `fn_wo_set_lots` (allowed while `in_production` or `yield_recorded`) and
  `fn_wo_advance` (`record_yield` and `ship` both accept a `lots` array).
- **The quantities must add up to the recorded yield.** A total that disagrees
  is refused with the two numbers in the message — it is a typo to fix, not a
  rounding difference to accept. Verified live: 410 against a 500 yield is
  refused; 210 + 205 + 85 lands as three BOL lines and three received lines.
- `ops.v_lot_trace` — one row per lot: the run, the BOL it left on, ship and
  receive dates, and how many movements reference it. This is the recall query.
- Ordinary warehouse transfers carry the same optional Lot / Born-on fields on
  the Stock → Transfers form; nothing demands them there.

⚠ Deliberately not done: a lot column on `inventory_movements`. The movement
already points at the transfer line that carries the lot, and a second copy is
the kind that drifts.

## The pre-flight — which vendor gets which PO

`ops.fn_bom_preflight(bom_id)` answers two questions off the BOM, before anyone
commits a run: **how many purchase orders this flavour raises and to whom**, and
**anything that would stop one reaching QuickBooks**. It renders on the BOM
editor and again on the work-order form.

Today every case BOM is exactly **two** materials POs:

| Vendor | Lines |
|---|---|
| **AC Calderoni** (1099) | the flavour's 1-gallon concentrate — with the ingredients filed underneath as detail |
| **Quantum Canning** (1744) | 24 printed cans · 24 × tolling · 24 × Velcorin · pallet dunnage |

⚠ **The ingredients are deliberately not counted as POs.** They ride under the
gallon line and never become a PO line of their own — that is the whole point of
the roll-up, so a pre-flight that counted them would contradict it.

⚠ **A deactivated QuickBooks item is a blocker, not a warning.** Refractor will
write the PO happily; the push is what fails, which is the worst moment to find
out. So it is asked here instead. A line with no vendor is the same shape —
`fn_wo_generate_pos` already raises on it.

**Why cans and trays are Quantum's and not Craft's.** Both vendors were on the
BOM until 2026-09-02, which produced three POs instead of two. The billing
history settles it: every Craft Beverage Packaging line ever booked is a monthly
period charge — "May 2025 hours log", "Oct 20th-31st", "Dec-25", "Jan-26" — i.e.
labour, never a can or a tray. Quantum's lines are where the can units appear:
"Deposit - 202,000 units @ $0.31", "Cream soda cans". Craft is not a packaging
supplier to this run. (The tray came off the BOM entirely on 2026-09-02 —
`20260902u` — because it is on no Quantum invoice either; the cans stayed.)

## Item types — Service or Non-inventory, never Inventory

**The rule:** everything the production system consumes is a **Service** or a
**Non-inventory** item in QuickBooks. The only **Inventory** items are the
finished cases that come back into the warehouse, and those already exist.

| Role | QBO type | Why |
|---|---|---|
| Fill labour, pack off | **Service** | a charge, nothing arrives |
| Flavour gallon, cans, raw materials | **NonInventory** | consumed at the co-packer; we never count them |
| `24P####  … CASE` (the seven finished goods) | **Inventory** | these physically arrive at Brix and are counted |

An Inventory-type raw material does not fail loudly — the purchase order posts
perfectly well — it quietly starts tracking a quantity and a valuation for
something nobody counts, and it surfaces later as an inventory-adjustment
problem. So the pre-flight reports it as a **warning, not a blocker**: a blocker
stops the push and this does not, and calling it one would teach people to click
past the category that means stop.

Two places hold the line:

* `ops.fn_bom_preflight` warns on any component whose QBO type is `Inventory`.
* `qbo-raw-materials` creates every raw-material item as `NonInventory` with
  `TrackQtyOnHand: false`, and its `restore_components` action **refuses** an
  Inventory item outright — reviving one revives a quantity and a valuation,
  which is an accounting decision rather than housekeeping.

## The accounting

Everything settles through **Can Raw Materials** (QuickBooks account `294`),
named in `ops.production_settings.clearing_account_ref_id`:

- The AC Calderoni bill hits it.
- The Quantum Canning and Craft Beverage bills hit it.
- The bill from **ALAMEDA SODA COMPANY PRODUCTION** for the finished cases hits
  it as the offset, and puts the real cost on the finished case item.

So the account nets to zero per run, and any balance left in it is a genuine
variance you can look at rather than a rounding rumour buried in COGS.

## Tanks and yield

`product_formulas.tank_sizes_gal` (default `{1500,2000,2500}`) and
`product_formulas.yield_pct` are **per flavour** — a flavour that cannot run in
the small tank simply does not list it, and a flavour with a known loss carries
its own. `yield_pct` does two jobs: it sets how much liquid must go into the
tank for N cases, and it becomes the scrap percentage on the formula-derived BOM
lines (`scrap = (1 − yield) / yield`, so `qty × (1 + scrap)` is exactly
`qty ÷ yield`).

`yield_pct` ships at **1.0 on all seven formulas** — the honest default until a
real run measures one. Set it from the first run's actuals.

## Creating the QuickBooks items

**Most materials do not need one.** A rolled-up ingredient is billed inside the
gallon, so it never appears in QuickBooks at all. Only a material switched to
*bought directly* needs an item — and today none are.

For those, Refractor → Production → **Raw Materials** → *Create the N missing
QuickBooks items*. It previews first and writes nothing until the second click,
because a QuickBooks item cannot be deleted once created, only made inactive.

Items are created as **non-inventory purchase items** named `RM <material>`
(SKU `RM-<SLUG>`), expensed to the clearing account. An item of the same name
that already exists is LINKED, never duplicated — a duplicate item splits an
item's purchase history in two and that is not fixable by editing.

Backed by the `qbo-raw-materials` edge function (`verify_jwt=false`, gated by the
service-role key and the shared QBO OAuth lease, same posture as every other
`qbo-*` function on this project).

## The stock ledger, and what it is actually for

**QuickBooks owns HOW MANY of a thing we hold. This ledger owns WHERE it is.**
That one sentence decides everything else here, and it is the reason the ledger
is not — and must not become — a second copy of QuickBooks' quantities.

QuickBooks has no notion of place. It cannot tell you that 500 cases are on a
truck between Frederick and Alameda, or that 12,000 cans are sitting at
Quantum waiting to be filled. `ops.inventory_movements` can, and that is its
whole job: a co-packer move, a BOL, a lot's traceability, a sub-distributor's
consignment. Where the two overlap — the total on the warehouse floor — they
must agree, and `ops.v_inventory_drift` is what says whether they do.

### What went wrong, and what it cost

The ledger was seeded once on **2026-05-14** — 49 movements, every one an
`adjustment`, 5,631 units into BRIX-WAREHOUSE — and then nothing moved it for
**111 days**. Nothing fed it: no sale decremented it, no ordinary purchase
incremented it, and the production pipeline that would have was not yet run.
QuickBooks meanwhile carried on, so by 2026-09-02 **31 of the 34
location-tracked items had drifted, 3,345 units in absolute terms**. Oaktown
Root Beer cases read **1,198 here against 249 in QuickBooks**.

⚠ **The drift was not the defect. The silence was.** The On-Hand grid printed
those numbers with no date beside them and no comparison to anything, so a
number 111 days stale looked exactly like one counted that morning. A quantity
with no date cannot be judged, and nobody could have known to distrust it.

⚠ **The machinery to detect and fix this already existed and had never been
used.** `ops.v_inventory_drift` and `ops.fn_reconcile_inventory_to_qbo` were
live on the database with **no migration file and no caller anywhere in the
repo**. Migration `20260902v` wrote them down as they stood, added
`ops.v_inventory_ledger_status` and a bulk entry point, and put all of it on
the screen.

### Reconciling

A reconcile **corrects, it never rewrites**: one new movement per drifting
item, dated today, carrying its reason and both numbers. The May seed stays in
history. A ledger you can edit is not a ledger, and the movement that explains
a 949-case correction is worth more later than a tidy balance is now.

| | |
|---|---|
| `ops.v_inventory_drift` | Per item: what QuickBooks says, what our warehouses say, the difference |
| `ops.v_inventory_ledger_status` | The one-line answer: when it last moved, how many items disagree, by how much |
| `ops.fn_reconcile_inventory_to_qbo(item)` | Fix one item |
| `ops.fn_reconcile_inventory_bulk(reason, commit)` | Fix all of them; **preview by default**, `commit` writes |

⚠ **The bulk reconcile REFUSES while any stock is at a co-packer or in
transit, and this is the part a later edit will want to soften.** The drift
view measures QuickBooks against **warehouse-kind locations only** — goods at
Quantum or on a truck are counted separately, deliberately. So mid-run every
one of those cases reads as warehouse drift, and reconciling would post
adjustments inventing stock we have not received, which the receipt would then
post a second time. It is a hard stop rather than a warning on purpose: an
amber notice on a screen that is about to double-count a batch is one somebody
clicks past.

### Ownership is not a kind of building

⚠ `inventory_locations.kind` was answering two unrelated questions at once:
*what sort of place is this* (a building, a truck, a virtual counter) and
*does the stock in it still count as ours*. That is why Desert Beverage and
Origins — each a **warehouse we ship to** and a **distributor we have terms
with** — ended up entered twice, once under each kind, and why neither entry
was right on its own.

They are one place. `ops.v_inventory_locations` separates the two questions:

| | |
|---|---|
| `is_physical` | Somewhere stock can actually sit. False for TRANSIT and the adjustment counter. |
| `counts_as_our_stock` | Ours: our own warehouses always; a partner's site **only while the agreement is consignment** |

**Ownership comes from `ops.sub_distributors.model`, never from the kind.** On
consignment the stock is still ours until the partner sells it — which is
exactly why QuickBooks keeps counting it in `qty_on_hand`, so it belongs in the
comparison. On sell-in they own it the moment it ships, QuickBooks drops it,
and it stops counting **by itself**. A boolean copied onto the location would
be a second home for one fact, and would disagree with it the first time
somebody changed one.

⚠ **It fails closed.** A distributor location with no partner record, or one on
any model but consignment, does **not** count as ours. Get this backwards and
the failure is silent: over-counting our side *cancels* real drift and shows
green, while under-counting shows as drift and someone goes and looks.

The duplicates (`DESERT-BEVERAGE`, `ORIGINS-CRAFT-SODA`) are deactivated, not
deleted — a location id is the kind of thing an old document points at. There
was nothing to merge: both had zero movements, zero transfers, were no
partner's site, no item's default receiving location, and on no work order or
PO. **`CRAFT-COFFEE-SVCS` is deliberately left alone** — unlike those two it
has no partner record to fall back on, so whether it is a sub-distributor or a
dead name is an operator's question.

### Two screens say "inventory" and only one was ever stale

*Inventory Planning* (reorder, velocity) reads `fn_items_master` → QuickBooks'
own `qty_on_hand`, refreshed daily by `sync-qbo`; it was always current.
*Stock → On-Hand* reads this ledger. Do not conflate them.

### What still has no feed

The re-seed makes the ledger true as of 2026-09-02. It does not make it
self-maintaining: a sale still does not decrement it and an ordinary purchase
still does not increment it. **The production pipeline is its first real
feed** — a run consumes materials, records a yield, ships a BOL and receives
finished cases, all as movements — and the first live run is what proves it.

### The sales feed — what finally maintains it

⚠ **How fast it goes stale was measured, not guessed.** The 2026-09-02
re-seed left the ledger at zero drift at 09:02 UTC. By 16:30 the QuickBooks
mirror had pulled in the day's real invoices and the ledger was **176 units
behind across 24 items** — seven hours, because stock shipped and nothing told
the ledger. The strip caught it the same afternoon, which is the feature
working; but it also means **reconciling by hand is a stopgap, not the
answer.** The sales feed (`ops.qbo_invoice_lines` → shipment movements) is the
next build, and until it exists the honest workflow is to read the strip before
trusting a number and reconcile when it says to.

**`ops.fn_apply_sales_to_ledger` closes it.** Every invoice line for a
location-tracked item becomes a movement: Invoice and SalesReceipt take stock
out, CreditMemo and RefundReceipt put it back.

**An invoice cannot say WHICH building the case left, so the customer decides
it.** `ops.fn_sales_ledger_location` reads `ops.sub_distributor_accounts` —
attach a customer to a partner under **Sub-Distributors → Accounts** and their
invoices deduct from that partner's warehouse; everyone else falls through to
Brix Warehouse. That works because **a sub-distributor is always on
consignment and our system bills their customers**: the stock is ours until
the end customer is invoiced, so the invoice is the depletion signal for their
warehouse exactly as it is for ours.

⚠ **Not by state.** 315 of the 324 customers who buy stock are in California,
and the state field itself holds `CA`, `California` and `San Francisco`. State
sorts 97% of customers into one bucket. Per-customer is also cheaper than it
sounds — only the exceptions are entered.

**Three cases, and only the first is obvious.** A NEW line deducts. An EDITED
line — QuickBooks upserts a line in place — posts the DIFFERENCE against
`ops.sales_ledger_applied`, never a second full deduction. A VOIDED line, gone
from the mirror, is reversed and its applied row stamped rather than deleted,
because "why did 12 cases come back on the 4th" needs an answer.

⚠ **Shadow by default, and that is the cutover plan rather than a
placeholder.** The feed and the reconcile must never both be authoritative:
reconcile sets the ledger EQUAL to QuickBooks, so if it runs while the mirror's
quantities are a few hours behind the invoices the feed already deducted, it
puts them straight back. In shadow the feed computes and writes nothing — even
when called with `commit` — so its numbers can be checked against the drift the
strip reports for a day or two first. Once it is live, **reconcile becomes the
audit, not the mechanism**, and should only be run deliberately.

⚠ **`fn_distributor_record_depletion` no longer moves stock** (`20260902x`). It
posted its own shipment out of the partner's location, which with the feed live
is the same case deducted twice. It stays as the DELIVERY and per-case fee
record — the thing a delivery PO and the "their invoice matches ours" check
will be built on — and simply stopped being a second stock writer.

## The run guide, inside the app

The click-by-click walkthrough is handbook chapter **`10a-production-run-guide`**
(`docs/handbook/`), rendered by the viewer at `public/docs/handbook/index.html`.
**Production → Run Guide** frames that viewer rather than holding a second copy
of the text — one guide, one source, or the two disagree the first time somebody
edits one.

Three things are worth knowing before touching it:

- **The viewer has an embed mode.** Framed (or given `?embed=1`) it hides its own
  sidebar and its *Back to the Hub* link — chrome inside chrome, and a hub link
  inside a frame strands a whole hub in somebody's tab. The chapter renders
  unchanged; only the viewer's furniture goes.
- **Two different path bases, and they are not interchangeable.** The handbook is
  at `/margin/docs/handbook/` behind the gateway and `/docs/handbook/` on the bare
  Netlify site. The PDF is at **`/billing/production-guide/`** behind the gateway
  and `/production-guide/` bare — `/margin/*` proxies to the Vite bundle, not to
  the site root, so `/margin/production-guide/` is a 404. `RunGuideTab.tsx` derives
  both from `location.pathname`; do not "tidy" them into one helper.
- **The PDF is a committed artifact** (`public/production-guide/Brix-Production-Run-Guide.pdf`),
  beside the screenshots the chapter already uses. It is what you hand a QC tester;
  the online copy is the one that stays current, and the tab says so. Re-export it
  whenever the chapter changes materially — nothing regenerates it automatically.

## Known gaps, 2026-09-02

1. **No per-ingredient costs and no pack sizes.** All 17 materials have both
   blank. This no longer blocks costing a run — the gallon price does that — but
   until some are filled in, `quoted_cost` is empty and the allocated split
   cannot be checked against anything real. (Stocked-component prices — cans,
   labour, gallons, cans — now have a home of their own: Materials & Pricing →
   Purchased items. The gallon and can prices there are still the seeded
   QuickBooks figures until confirmed.)
1b. **The gallon prices in QuickBooks look stale, and everything now hinges on
   them.** The 1GNS items carry $4.25–$7.44. The only 1GNS lines ever billed
   were $32–$38/gal in May 2025 (a pilot), while the current 3-gallon BIB price
   works out to roughly **$9.58/gal** (`3G6121, 50 @ $28.75`). Since the gallon
   is now the master price and the ingredient breakdown is allocated out of it,
   refreshing these from the current Calderoni sheet is the single highest-value
   data fix left.
2. ~~Six of the seven can items are deactivated in QuickBooks.~~ **Closed
   2026-09-02.** All six were **restored, not recreated** — they were already
   `NonInventory` on the right expense account at the right cost and they carry
   the purchase history, so a fresh near-identical item would have split that
   history and left two confusable names in the list. Names normalised to the
   live one's convention (`CAN <FLAVOUR> 12OZ SLEEK EMPTY`); `685` and `690`
   needed `EMPTY` adding as well as the `(deleted)` strip. Every BOM now
   pre-flights at 2 POs, 0 blockers.
3. ~~The can price looks stale too.~~ **Closed 2026-09-02** — the whole Quantum
   side was reconciled to Quantum's invoices (see "What the vendors actually
   bill"): cans $0.328, tolling one $0.62 line, Velcorin and pallet dunnage
   added, Calderoni's flat canning fee added as a per-run line (and moved
   again on 2026-09-03 to the Licensing tab — see "Licensing agreements"). Per-case
   variable cost is now **$25.84** against the **$21.36** the finished-case
   QuickBooks items carry — the QuickBooks number is the one that is wrong.
   (It was $25.85 before the tray came off; the tray was 1.6 cents.)
3b. **The 24-pk tray is off the BOM** (`20260902u`, 2026-09-02). It appeared on
   no Quantum invoice — 1462, 1741 and can bill 171778 all checked — while
   every other Quantum line appears on at least one, so it was flagged rather
   than guessed at, and Sky's answer was to take it out. The reading that makes
   that a correction rather than an omission: the tray is inside the $0.62/can
   tolling line, exactly as pack-off turned out to be, and carrying it
   separately charged the case for it twice.
   ⚠ It cost $0.0158 in the QBO mirror — about a fiftieth of what a corrugated
   24-pk tray really costs — which is its own evidence that the number was a
   placeholder for something nobody buys. Item 563 is retired in the master and
   deliberately **not** deactivated in QuickBooks (it carries purchase history).
   **If trays turn out to be bought separately, put the line back with the
   vendor who actually bills for one — not Quantum, who never has.**
4. ~~`record_yield` values components from what was BOUGHT.~~ **Closed
   2026-09-03** (`20260903e`): consume and cost read `demand_qty`; the MOQ /
   pack surplus stays on hand at the co-packer for the next run — see "MOQ,
   demand and the surplus at the co-packer". The arguable half ("the last bag's
   remainder belongs in the batch") was decided the other way on Sky's
   instruction: the leftover is stock, not scrap.
