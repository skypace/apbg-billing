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
| Canning fee | Calderoni | **flat $1,173.33 per run**, every run since 2026-03 | `CANNING RUN FEE (SYRUP COMPOUNDING)` (1391, new) — **1 per run** |
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
Inventory; see "Item types" below.

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
still does not increment it. (Both have feeds now — the sales feed below since
2026-09-02/03 and the purchase feed since 2026-09-04.) **The production pipeline
was its first real feed** — a run consumes materials, records a yield, ships a BOL and receives
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

### The runner — nothing ran the feed until 2026-09-03

⚠ **`20260902x` shipped the feed and the switch, and nothing ever CALLED it with
commit.** Not a pg_cron job, not the deployed `sync-qbo` (v47 refreshes the
sales view and stops), not another database function, not the panel — which
only read the preview and set the mode. So "live" would have changed a label
and deducted nothing, and the ledger would have gone on losing a day of stock a
day with the switch showing green. Found by enumerating every caller class,
not by reading the switch.

**`ops.fn_sales_ledger_run()`** (`20260903a`) is the one entry point: it calls
`fn_apply_sales_to_ledger(true)`, counts new / edited / voided lines, and writes
`ops.sync_log` (`source='inventory'`, `sync_type='sales_feed'`) on EVERY run,
shadow included — a run that leaves no row is indistinguishable from a cron
that never fired. It never raises: a failure is recorded in the row and
returned, so the cron cannot die silently. **pg_cron `sales-ledger-apply`**
runs it at :05/:20/:35/:50, five minutes behind `qbo-cdc-sync`, so each run
works the invoice lines the sync just landed. **`ops.fn_sales_feed_health()`**
(`sales_feed` on the health board) is red on an errored run or a live feed whose
runner has been quiet for an hour; in shadow it is green and says what it
would deduct. The panel's **Run now** button is the same call, for testing a
cutover without waiting for the clock.

⚠ **The first live run failed, and the health check is what caught it.**
`fn_apply_sales_to_ledger` RETURNS TABLE with a column named `invoice_line_id`,
and its INSERT … ON CONFLICT (invoice_line_id) into `sales_ledger_applied`
names the same column — plpgsql reads that as ambiguous. Shadow mode never
executed the write, so the bug sat invisible for a day and surfaced on the
first commit. Fixed in `20260903b` with `#variable_conflict use_column`; a
function that returns a column named like a table column it writes needs that
pragma, or its OUT parameter shadows the column the first time the write runs.

**The cutover, as it was actually done (2026-09-03).** The mirror's quantities
are a snapshot taken at 09:45 UTC. Zero of the day's invoice lines predated
that snapshot, so: reconcile the ledger EQUAL to the mirror (28 items, dated
today, reason on every movement), set `apply_from` to today, flip to live, run.
The feed then deducts today's lines; tomorrow's 09:45 sync brings the mirror
level with it, and drift reads zero. ⚠ **`apply_from` must be the mirror's
snapshot day, not earlier** — an earlier date deducts sales the reconcile
already absorbed, twice.

⚠ **`fn_distributor_record_depletion` no longer moves stock** (`20260902x`). It
posted its own shipment out of the partner's location, which with the feed live
is the same case deducted twice. It stays as the DELIVERY and per-case fee
record — the thing a delivery PO and the "their invoice matches ours" check
will be built on — and simply stopped being a second stock writer.

### Repacks — cases into 8-packs, one signed sheet (2026-09-04)

The warehouse breaks 24-pack cases down into 8-packs. Before this there was no
place to record it: two repacks had been keyed straight into QuickBooks as
InventoryAdjustments — ref 500 on 8/24 to account 1150040010 *Ecommerce
Repackaging* and ref 503 on 8/26 to 353 *Inventory Shrinkage* (memo "need 8pk
conversion numbers from Kyle") — and the stock ledger knew about neither, so the
24P items read high and the 8PK items were not tracked at all.

**`alamedapointbg.com/repack`** (`public/repack.html`, a hub tile, and framed at
**Refractor → Stock → Repacks**) is the sheet: cases used per flavour, 8-packs
made (defaults to 3 a case, editable), the variety 8-pack as a produce-only row,
who did it, a signature, and the date stamped automatically. Saving it runs
**`ops.fn_repack_create`** (`20260904a`) — one `adjustment` movement per line
through the Adjustment Counter, cases out of Brix Warehouse and packs in, the
same shape the reconcile writes so every on-hand and drift view already
understands it — and THEN `netlify/functions/repack.mjs` posts one QuickBooks
**InventoryAdjustment** on the account in `ops.repack_settings` (353 per Sky;
one edit to change) with `DocNumber` = the `RP-YYYY-NNNNN` number, so the two
records name each other. After the push it re-reads the touched items'
`QtyOnHand` into `ops.qbo_items`, so On-Hand agrees with QuickBooks at once
rather than after the 09:45 UTC items sync.

Three rules carry the weight. **Ledger first, QuickBooks best-effort:** a QBO
refusal (closed period, dead token) lands as `qbo_error` with a Retry button —
the sheet the warehouse signed is never lost to an accounting hiccup, and
`ops.fn_repack_health()` goes red on the board after an hour unpushed.
**`ops.repack_pairs` is an allow-list:** the tool can only move the seven
case→pack pairs and the variety pack; a stray SKU cannot be adjusted through a
repack sheet. **Never an uneven 8-pack** (`20260904b`, Sky: "only exact 8 packs that match
the 24 pack count"): a case is 24 cans = exactly 3 packs, and the sheet derives
the pack count from the cases — nobody types it. **Variety is a recipe, built
from a bin** (`20260904c`, Sky: "Variety packs consist of 2 colas, and one of
every flavor… a variety pack warehouse… where we move cases to build variety
packs out of"): `ops.repack_variety_recipe` says a variety 8-pack is 2 × Cola +
1 × each of the six other flavours; whole cases are first moved into the
**VARIETY-BIN** location (a ledger move — still 24P cases, still ours,
QuickBooks unchanged), and each variety pack made pulls its recipe out of the
bin. No 24-pack variety item is needed. ⚠ **The bin counts cans; the ledger and
QuickBooks count whole cases.** `ops.repack_bin` holds each flavour's cans
(24 × cases in − cans drawn); a case is posted OUT of the bin and off QuickBooks
the moment its 24th can is drawn, so an opened case still reads as a case in the
bin until it is empty — what a person counting the bin would say too. Between
the first and last can of an open case QuickBooks overstates that flavour by the
cans already inside variety packs (at most 23); whole numbers everywhere are
worth that, because fractional cases would drift on every sum. The function
refuses a variety count the bin cannot cover and says how many more cases of
which flavour to move in; `v_repack_bin` shows cans, cases, open-case and "packs
possible" per flavour. A sheet that only moved cases into the bin has nothing
to tell QuickBooks and is marked `qbo_required=false`, which the health check
respects. ⚠ The first cut allowed an unbalanced sheet with a note, because the
8/24 hand-keyed sheet had not balanced (1,008 in, 656 out); that was the wrong
lesson — it did not balance because nothing forced it to.
Void deletes the QBO adjustment first, then reverses every
movement with new rows — history is never edited. Enabling `track_locations` on
the eight 8PK items also means the sales feed deducts 8-pack sales from today on
(zero 8PK invoice lines since `apply_from`, checked before applying).

**The account, and the bin deducts (`20260904j`, later the same day).** Sky,
after the first two sheets posted: *"when an 8 pack variety is being made and we
move cases to variety bin i still want that to be deducted from inventory on the
Inventory Shrinkage line — under Ecommerce Repack. also move the rest of the
repacks to that line as well rather than just shrink."* Two changes. **(1)**
`ops.repack_settings` now names **1150040010 Ecommerce Repackaging** — the
account the hand-keyed 8/24 repack used — instead of 353; `repack.mjs` reads it
at push time, and the account each sheet was actually posted with is stamped on
the row (`repack_orders.qbo_account_id`). When that differs from the setting
the sheet page shows *"N posted sheets sit on a different QuickBooks account"*
with a **Move them to Ecommerce Repackaging** button → action `repoint`, a
full-entity update of the adjustment with its current SyncToken (QuickBooks has
no sparse update for InventoryAdjustment); the adjustment number stays, only
its P&L line moves. RP-2026-00001/00002 (adjustments 174302/174303) are the two
it exists for. ⚠ QuickBooks carries two accounts named "Inventory Shrinkage"
(353 and 44) and a 328 "Repack - leaking 24pks"; the hand repack's account was
the tie-breaker — one UPDATE on `repack_settings` changes it. **(2) A case
moved into the variety bin leaves BOTH books the moment it goes in:** the
ledger movement goes to the Adjustment Counter (still `source_doc_type
'repack_bin'`) and the QuickBooks adjustment carries `QtyDiff −N` for it, on
the same account. The variety draw then moves nothing on either book — the
bin's own count (`ops.repack_bin`, cans) is the only record of what is inside,
and `v_repack_bin` still says how many variety packs it can make; the variety
packs made post `+M` as before. The **VARIETY-BIN** ledger location is retired
(inactive; it held zero stock — the one bin sheet had been voided). Consequences:
a bin-only sheet now needs a QuickBooks adjustment (`qbo_required=true`),
Inventory Planning's *Used in runs/repacks* counts a case the day it is binned,
and the drift strip stays flat because the two books move together.

### Purchasing — QuickBooks and Refractor share one PO table (2026-09-04)

**Ask (Sky):** keep doing main purchasing in QuickBooks, see those POs here,
edit them here and push back ("a two way street"), and when the warehouse
receives here "receive creates the bill. the bill can get matched to the
invoice in brixpense. make sure there is sync if i dont want to wait for the
15 min cron i just click it."

**What was there.** Two tables that never met: `ops.purchase_orders` for POs
created here (pushed to QuickBooks once, never read back — the SyncToken was
never stored, `qbo_push_error` was written by nothing) and a hand-imported
SHADOW of QuickBooks POs (`ops.qbo_purchase_orders`, one row, from a picker).
Receiving wrote the ledger and stopped; the vendor bill was keyed separately;
and the purchase side of the ledger had no feed at all, so every QuickBooks
receipt since the 09-03 seed read as drift.

**The model now (migration `20260904d`).** One table. A PO keyed into
QuickBooks lands in `ops.purchase_orders` as `origin='qbo'` on the 15-minute
pull; a PO created here is `origin='brix'` and is pushed there. Either can be
edited here (`fn_po_update`) and pushed back. Both directions carry the
QuickBooks **SyncToken**: the pull skips a row marked `qbo_dirty` (a local edit
waiting to push), and a push whose token QuickBooks has moved past is a **409**
the operator resolves — force (overwrite QuickBooks) or reload (drop the local
edit). The last writer never wins silently, in either direction.

**Receiving is one gesture, in this order because the order is the point:**

1. `fn_po_receipt_record` (caller's JWT) — the ledger moves through the same
   `fn_receive_purchase_order_line__i` it always has, and `ops.po_receipts`
   gets its row. This is the record.
2. The PO is pushed to QuickBooks first if it is not there yet.
3. `POST /bill` with every line **LinkedTxn'd to the PO line** — QuickBooks
   marks the PO received/closed itself, so a PO received here and one received
   inside QuickBooks end in the same state.
4. `fn_po_receipt_bill_landed` files the Brixpense row **Posted** (`as_bill`,
   tag Purchasing or Production, `bill_number` = the vendor invoice if in hand).
   It is in the books; the vendor's invoice is what is still to come, and
   Brixpense's duplicate gate (same vendor, same amount within 10 days) is what
   flags that invoice against this bill when it arrives. ⚠ That match is by
   amount, not by document — a vendor invoice that differs from the PO price
   posts as a second bill and is caught by the aging, not the gate.
5. Best-effort: mirror the bill's lines, re-read the items' QtyOnHand, re-read
   the PO.

A QuickBooks refusal at step 3 stamps `qbo_error` on the receipt: the PO shows
**Retry bill**, and `fn_purchase_feed_health` goes red after an hour unbilled.
The stock already moved; the sheet is never lost.

**The purchase feed** (`fn_apply_purchases_to_ledger`, the mirror of the sales
feed): every Bill / VendorCredit item line on a location-tracked item since
`apply_from` that no receipt of OURS created (`po_receipts.qbo_bill_id`) posts
a `receipt` movement (`source_doc_type='qbo_purchase'`); an edited bill posts
the difference, a deleted bill reverses. A bill received against a PO we hold
bumps `qty_received` on that PO line, capped at what was ordered. LIVE from the
start with `apply_from = 2026-09-03`: the ledger was set equal to QuickBooks on
09-03 and no inventory bill had posted since (checked), so a first live run had
nothing to double-count. Receiving location = the item's default receiving
location, else Brix Warehouse — QuickBooks cannot say where a case landed.

**The pull** (`netlify/functions/lib/qbo-purchasing-sync.mjs`, one
implementation behind pg_cron `qbo-purchasing-sync` at :10/:25/:40/:55 and the
**Sync now** button): CDC since the last successful run (first run = a full
pull of open POs + bills since `apply_from`), PurchaseOrders →
`fn_qbo_po_mirror_upsert`, Bills/VendorCredits → `qbo_expense_lines` in
sync-qbo-expenses' exact row shape plus `linked_po_qbo_id`/`linked_po_line_id`
off LinkedTxn, missing vendors/items pulled into the mirrors on the way, then
**every Inventory item's QtyOnHand re-read into `ops.qbo_items`** — the drift
strip's QuickBooks number is now 15 minutes old instead of a day — then the
purchase feed. It lives on Netlify, not as an edge function, because the
deployed `sync-qbo` / `push-qbo-item` edge functions have drifted from their
repo copies more than once; pg_cron only knocks.

⚠ **A comparison is only as fresh as its older side.** The day this shipped
the drift strip showed 28 items / 145 units adrift and offered Reconcile —
every unit of it the day's sales, already deducted here by the live sales feed
and already in QuickBooks, but not yet in `ops.qbo_items` (last written by the
09:45 UTC items sync 15 hours earlier). Applying that reconcile would have put
145 sold cases BACK. The strip now says when its QuickBooks number was read
and refuses to offer Reconcile while that number is older than the ledger's
last movement; Sync now is the fix, not Reconcile.

⚠ **Safeupdate.** The PostgREST role runs with `session_preload_libraries=
safeupdate`, so any `UPDATE`/`DELETE` without a `WHERE` reached through an RPC
fails with SQLSTATE 21000 — which is how `fn_sales_ledger_set_mode` (a one-row
config table, updated bare) could never be flipped from the screen although it
worked every time it was tested as postgres (`20260904e`). A single-row table
is still updated WITH its key.

**Unexercised until the first real use:** the QuickBooks writes themselves
(PurchaseOrder create/update, Bill create) need a hub session and a live
token; the payload shapes are Intuit's documented ones, the SQL half was
driven end to end in a rolled-back dry run (create → refresh → edit marks
dirty → pull skipped → push clears → receipt → bill landed → a foreign bill on
the same PO line applied by the feed, our own excluded), and the pure mappers
are pinned by `tests/qbo-purchasing-sync.test.mjs`.

### Inventory Planning — what the velocity counts (2026-09-04)

**Asked whether the planner really works, with root beer as the test case
("I think we have about 19 days left"). It did not, and the fault was in the
data under it rather than the arithmetic on top.**

`fn_items_master` read demand from three places: invoice lines, ledger
consumption, and `ops.qbo_inventory_adjustment_lines` counted as shrinkage.
That third table held **125,694 rows for 1,138 real lines**. QuickBooks puts
no `LineNum` on an InventoryAdjustment line, so the nightly
`sync-qbo-inventory-adjustments` wrote `line_num = NULL`, its upsert key
`(qbo_txn_id, line_num)` never matched (NULLs are distinct in a unique index),
and every run since 2026-05-03 inserted every line again. Over 90 days the
planner counted **24,770 units of shrinkage against a true 743**. Root beer
cases (574) read 39.5 a day and five days of supply on the 90-day lookback,
and 12.8 a day and 16.7 days on the 30-day lookback, which is the "19 days"
on the screen. The true rate is about 7.4 a day and 214 sellable cases,
so roughly **29 days**.

What changed (migration `20260904f`, edge function v15, the repo now carries
the function source):

- **The duplicates are gone and cannot stack again.** v15 numbers each line
  (`LineNum`, else `Id`, else position) and rewrites an adjustment's lines on
  every run, so the table is exactly QuickBooks' lines.
- **Demand is sales plus consumption, never a count correction.** Invoice
  lines, production runs eating materials (`production_consume`), and repacks
  turning cases into packs. A QuickBooks adjustment is a correction of the
  count, not something to reorder for. It stays visible as `adjustment_qty`
  and `shrinkage_qty` and no longer moves the velocity.
- **Velocity is recency-weighted.** 60% of the trailing 28-day rate plus 40%
  of the lookback rate when the lookback is longer than 28 days. A flavour that
  is slowing or picking up is read within a month instead of a quarter.
  `velocity_28d` and `velocity_trend_pct` are on the screen so the blend can
  be checked.
- **Sellable versus inbound.** `planning_on_hand` is what can ship today
  (warehouses plus consignment partners). Stock at a co-packer, in transit, or
  on an open PO line is `qty_inbound`. `days_of_supply` is on the sellable
  figure and `days_of_cover` adds the inbound. Status and the suggested order
  use cover, so a PO already raised stops the alarm.
- **The shadow PO table is out of the maths.** QuickBooks POs are real rows in
  `purchase_orders` since `20260904d`. The one shadow row left, AC04282026 from
  April, was still counting 140 BIBs as on order.
- **Overstock is a real status** (more than 3 × (target + lead) days).

⚠ **Lead time still defaults to 7 days** (`inventory_settings.lead_time_days`).
A co-packed case has a production cycle measured in weeks, so "reorder" fires
late on those until the lead time is set per item. That is a settings entry,
flagged rather than guessed.

Verified after the rebuild: 574 at 7.42 a day, 28.8 days of cover, 61 cases
suggested; 3G6151 BIB at 6.84 a day, 47.2 days; on order 0 for both.

### Inventory Planning v2 — the planner forecasts, it no longer just extrapolates (2026-09-04)

Sky, same day as the shrinkage fix: three weeks from ordering raw materials to
canned product back in the warehouse; fountain product ordered about every two
weeks; only BIB, 24-pack and 8-pack items need planning; use last year's
totals and the growth per product across the weeks; account for holidays and
weekends that move; leave Brix Beverage sampling out. Migration `20260904g`.

**Scope — `is_planner` is a rule, not a checkbox.** A planner item is an
active QuickBooks `Inventory` item on one of the three lanes (`bib_product`,
`cans_24pk`, the new `cans_8pk`) whose name starts `3G`, `5G`, `24P` or
`8PK`. That is 39 items today: 24 BIBs, 7 cases, 8 eight-packs. The other
~1,070 items in `inventory_settings` keep their rows and stay off the planner
screens (the page filters `is_planner` client-side; the RPC still returns
everything for the Items master). ⚠ `cans_8pk` is a planner lane and NOT a
production lane — `PRODUCTION_LANES` in `inventoryLane.ts` restricts the
Production page to BIB + 24-pack, and the lane picker there only offers those
two. An 8-pack is made by the repack sheet, never by a work order.

**Lead time and target by lane** (only rows still carrying the seeded 7/30
were touched — a hand-set value stays):

| Lane | Lead time | Target cover | Why |
|---|---|---|---|
| `cans_24pk`, `cans_8pk` | 21 days | 30 days | ingredients → cans → fill → ship back is about three weeks |
| `bib_product` | 7 days (unchanged) | 14 days | ordered roughly every two weeks |

⚠ The BIB lead time was left at 7 because nobody has confirmed how long a
Calderoni BIB order takes; it is a per-item settings entry.

**Sampling is out.** QuickBooks customer 95 (`BRIX BEVERAGE - SAMPLING`) is in
`inventory_velocity_excludes`, so demos and special events count in neither the
recent rate nor last year's baseline.

**What "demand" is.** `v_planning_daily_sales` (security_invoker, service_role
only — `fn_items_master__i` reads it) is one row per planner item per day:
Invoice + SalesReceipt add, CreditMemo + RefundReceipt subtract, excluded
customers dropped, nothing dated after today. Same signs the sales feed uses,
so a return that comes back is not demand twice.

**Last year, aligned by weekday and holiday.** `fn_planning_daymap(from, to)`
maps each coming day to its comparison day last year: `d − 364` keeps the
weekday (a Saturday compares to a Saturday), and when the day falls in a week
that holds a holiday, the whole week shifts so this year's holiday lands on
last year's — Labor Day 2026-09-07 compares to Labor Day 2025-09-01, not to
2025-09-08. Holidays live in `ops.planning_holidays` (72 rows, 2024–2027;
fixed-date ones like July 4th and floating ones like Thanksgiving, Super Bowl
Sunday, Easter; floating wins a tie). Staff can add or remove rows; nothing
else writes the table.

**Growth.** `fn_planning_yoy()` compares the trailing 13 complete Mon–Sun weeks
with the same aligned weeks last year, per item, clamped to −50%…+100% and
null when last year had fewer than 10 units (a 900% growth on a product that
sold 3 cases is noise, not a trend). The 8-packs are new in 2026, so they have
no baseline and run on the recent rate alone.

**The plan rate.** `forecast_daily` = last year's units over the coming
lead + target window, aligned, × (1 + growth), ÷ the window's days. The
planning rate is `0.5 × recent velocity + 0.5 × forecast_daily` when a
forecast exists, else the recent velocity (0.6 × 28-day + 0.4 × lookback, as
before). Half and half on purpose: recent alone misses September picking up
after August, last year alone misses a customer who left in March.

**Safety stock.** `1.65 × (weekly σ ÷ √7) × √lead` — about 95% service on
demand noise over one lead time — **capped at one lead time of demand**. The
cap exists because a low-volume 8-pack (0.19 a day, σ 11.65) produced a safety
stock of 33 and a reorder point of 37 on an item that sells six a month.

**Reorder point and dates.** `reorder_point_calc` = `inventory_settings.
reorder_point` if a human set one, else safety + lead × rate. Status:
`critical` (out), `reorder` (sellable + inbound ≤ ROP — the order is already
late), `reorder_soon` (within 7 days of the ROP), `overstock`, `ok`.
`stockout_date` = today + floor(cover units ÷ rate); `order_by_date` =
stockout − lead − floor(safety ÷ rate). **Suggested qty** =
ceil((target + lead) × rate + safety − sellable − inbound), never below
`min_order_qty`, never negative. ⚠ `min_order_qty` is 0 on every item, so the
suggestion is not rounded to a canning run or a pallet — a per-item setting.

**On screen.** Inventory Planning defaults to planner items; the Reorder tab
sorts by **Order by** and shows Recent/day · 28d trend · LY forecast/day ·
YoY · Plan rate/day · Cover · Inbound · Safety · Reorder Pt · Order by ·
Stockout · Suggested; a new **Forecast** tab lists every planner item and, on
click, the 13-weeks-back / 8-weeks-ahead weekly view from
`fn_planning_weekly` (this year, last year aligned, forecast, the holiday in
that week).

Verified live after apply: root beer cases (574) plan at 8.27 a day (recent
7.15, last-year window 9.40, YoY +0.3%), safety 28, ROP 202, 214 on hand →
`reorder_soon`, order by 2026-09-05, stockout 2026-09-29, suggested 237. Olde
Fountain Creme cases (560): 116 on hand, order by today, suggested 146.
⚠ 574's last-year weekly series has two October weeks at 131 and 135 cases
against a normal 40–60 — a bulk buyer, most likely — and the forecast will
carry that bump into October 2026. If it was a one-off, the customer belongs in
`inventory_velocity_excludes` or the holiday table is the wrong tool.

### Inventory Planning v3 — anomalies out, pars in, and a fill plan for the gas (2026-09-04)

Sky, after seeing v2: drop customers who bought a lot last year and have gone
quiet; flag large quantities as an abnormality and let a human keep or exclude
them; the smallest order; a weekly fill plan for 20 lb CO₂ and 20 lb mixed
gas; call the buffer what it is, a **par**, and say what the pars should be;
and wire the prediction into an actual order. Migration `20260904h`.

**Anomalies (`ops.planning_exceptions`).** The detector,
`fn_planning_exceptions_refresh()`, runs daily at 10:05 UTC and from the new
Anomalies tab. Two rules:

| Kind | Rule | What is excluded |
|---|---|---|
| Lapsed customer | ≥10% (and ≥20 units) of a planner item in the window 364–728 days ago, and nothing bought in the last 120 days | the whole customer, every item, every date |
| Volume spike | one customer's week ≥3× their own median week and ≥½ the item's normal week, or a buyer with ≤3 weeks of history at ≥2× the item's normal week; 24+ units | that customer, that item, that week |

Found live: **J&J Vending** (424 root-beer cases last year, 31% of the item,
silent since 2025-08), **Canteen Fremont Facebook** (728 cases each of cola
and orange in two weeks of May–June 2025, 66% and 37% of those items, silent
since) and Best Western El Rancho (apple, orange juice) are lapsed; the
October 2025 root-beer bump is **Office Libations**, two weeks of 91 cases,
flagged as a spike. Every row lands `excluded`; the tab shows the evidence
(their normal week, the item's normal week, the quantity) with **Keep** and
**Exclude** buttons, and a decision is never overridden by the detector. A
spike that no longer qualifies is dropped; a lapsed customer who orders again
is `resolved`. ⚠ The first cut flagged any week ≥2× the item's median
regardless of the customer's own history — which caught every Origins order of
a flavour Origins is most of the market for. A distributor who always orders 50
is not a spike; that is the demand.

`v_planning_daily_sales` applies the exclusions, so the items master, the
weekly view and the growth calculation all read one cleaned baseline. Recent
sales are never touched by a lapsed exclusion (a lapsed customer has none), and
a spike inside the last 13 weeks leaves the recent rate too — one bulk order is
not a rate, and it would otherwise inflate the buffer and the par.

⚠ **Growth is clamped to ±50% now, not −50%…+100%.** Removing a lapsed bulk
buyer from last year's base made every case item read +100% growth — a thin
base, not a doubling market. Root beer: v2 forecast 9.4/day, then 11.6/day
with J&J out and the old clamp, **8.7/day** with the new one; plan rate 7.9.

**Pars.** `par_min` = the reorder point — order when sellable + inbound reaches
it (buffer + lead × plan rate, or the hand-set reorder point). `par_max` = the
level an order brings you back to ((target + lead) × plan rate + buffer).
"Safety stock" is labelled **Buffer** on screen; the arithmetic is unchanged.
Suggested qty = par_max − sellable − inbound, floored at the minimum order.

**The smallest order.** `smallest_order_qty` = the smallest quantity we have
actually bought of the item in 24 months (QuickBooks bill lines).
`inventory_settings.min_order_qty` was seeded from it for every BIB still at 0
(BIB lines run 5, 10, 20, 30, 40 — Calderoni's multiples); cans stay at 0
because their bill lines are Quantum tolling invoices, not run sizes. ⚠ Seeding
the MOQ surfaced a bug: `suggested_order_qty` floored at the MOQ even when the
item needed nothing, so every "ok" BIB suddenly suggested 5 or 30. The floor
applies only when an order is needed; an item with cover to spare suggests 0.

**Fill plan (`ops.planning_fill_items`, `fn_planning_fill_plan`).** The gas
cylinders are filled, not stocked, so there is no on-hand and no reorder point
— the question is how many tanks to have filled before Monday. Per item per
week: what we filled this year, last year's aligned week (same holiday
alignment as the planner), the forecast (half the last 8 weeks' average, half
last year's aligned week grown by the trend, clamped ±50%) and a **weekly par**
= forecast + 1.65 × the weekly swing. Live for the week of 2026-09-07 (Labor
Day week): 20 lb CO₂ forecast 82, par **111**; 20 lb mixed gas forecast 8, par
**12**. Small nitrogen is in the table, inactive.

**The prediction becomes an order through the door the lane actually uses.**
One button on the Reorder tab, three destinations: BIB → a purchase order
(Production → Purchase Orders, lines prefilled — the existing path); 24-pack →
**Production → Work Orders**, where the suggested runs sit in a queue and each
**Start run** opens the create form with the BOM and quantity filled in (one
work order is one flavour); 8-pack → **Stock → Repacks**, the repack sheet with
the cases to repack prefilled (suggested packs ÷ 3, rounded up — the sheet does
the conversion, because that rule lives in `repack_settings`). Nothing is
created until the operator saves the PO, the work order or the signed sheet.

### Inventory Planning v4 — the four predictive tools, built into the prediction (2026-09-04)

Sky, after v3: *"Ok build the other stuff into the predictions."* The four tools proposed at the end of v3, each one now a column, a tab, or a number the forecast itself reads. Migration `20260904i` (applied live in three steps: the functions and the log table via `apply_migration`; then `fn_items_master__i` + its wrapper as an anchor-checked read-modify-write of the LIVE definition — ten anchors, each asserted to match exactly once; then a second anchor edit for the suggested-order floor).

**1. Who is due to order this week — and it drives the reorder.** `ops.v_planning_daily_sales_cust` is the per-customer sibling of the planner baseline (same excludes, same exceptions). `fn_planning_customer_cadence()` reads each customer's ordering rhythm from it: the **median gap** between their order days over the last year, their next order expected one gap after the last, and what they **usually take** (the median of their last six orders, per item). Statuses: `due` (next order within 7 days), `overdue` (past the gap), `lapsing` (past 1.5× the gap — dropped from demand, and the Anomalies detector's territory once it passes 120 days), `not_due`, `irregular` (fewer than 3 orders). Live: 413 customers — 75 due, 44 overdue, 41 lapsing, 68 irregular. `fn_planning_due_demand(7)` adds those customers up per item, and the items master carries it as **`due_demand_7d` / `due_customers_7d`**. Two rules read it: **an item whose due demand exceeds sellable + inbound reads `reorder` whatever the daily rate says** (Hangar 25 Cola 8-packs: 2 on hand, one distributor due for its usual 39), and **the suggested order is at least due demand − cover** — the first cut let an item read REORDER with a suggestion of 0, which is a contradiction on a screen someone orders from. New **Customers Due** tab: due / overdue / lapsing buckets, the usual items per customer, the units due this week across everyone.

**2. Growth on RETURNING customers, and the new customers as their own line.** `fn_planning_yoy()` used to compare this year's 13 weeks to last year's for the whole item. ⚠ That reads a customer who arrived this year as growth of last year's base — and last year's base does not contain them, so the forecast (LY × growth) never did either. Measured live before building: **55–66% of the last eight weeks' case sales are to customers who did not buy that item a year ago.** Now growth is `ty_returning_qty / ly_qty − 1` (customers who bought the item 364–728 days ago, clamped ±50%), and the customers new to the item ride separately as **`new_customer_daily`** (their 56-day run rate) — added on top of the LY-based forecast in `fn_items_master` and as `× 7` per week in `fn_planning_weekly`. Root beer cases 574: returning growth +20%, 33 new customers at 3.3/day, forecast 8.7 → 10.3/day, plan rate 7.9 → 8.7/day. The Reorder and Forecast tabs show **YoY (returning)** and **New cust/day**.

**3. Lead time measured from history.** `fn_planning_lead_times()` collects every receipt it can find — a Refractor PO's `ordered_at` → its `po_receipts` row, a QuickBooks PO's `qbo_txn_date` → the bill linked to it (`qbo_expense_lines.linked_po_qbo_id`), a work order's `ordered_at` → `received_at` — and takes the median per item over 24 months. With **three or more samples** it overrides `inventory_settings.lead_time_days` everywhere the items master reads a lead (the planner window, the safety stock, the reorder point, the pars, the order-by date); `lead_time_source` says `measured` or `setting` and the Forecast tab's Lead column carries the badge. ⚠ **There is no history yet** — zero received POs, zero mirrored QBO POs with a linked bill, zero received work orders — so every item reads `setting` today. The first three receives of a BIB flavour will settle whether the unconfirmed 7-day BIB lead is right without anyone editing a setting.

**4. Forecast accuracy — written down, then scored.** `ops.planning_forecast_log` (PK week_start × item, kind stock|fill) + `fn_planning_forecast_snapshot()` on pg_cron **Mondays 10:20 UTC**: the forecast for the current and next week per planner item and per fill item, **first write wins** — a prediction is never rewritten after the fact, because a forecast you can edit later cannot be wrong. First snapshot taken 2026-09-04 (78 stock + 4 fill rows). `fn_planning_forecast_accuracy(item, weeks)` scores each past week: the logged forecast where one exists, otherwise a **backtest** (half the prior 4 weeks' average, half last year × the growth of the prior 13 weeks — the v2/v3 shape, as it would have read at the time), labelled `logged` / `backtest`, with the miss and the percentage miss. The Forecast drill shows it under the weeks table with an average miss and a **bias** line. ⚠ Root beer's backtest over the last 13 weeks: average miss 20%, **bias −7.6 cases a week — the old forecast ran LOW in 10 of 13 weeks**, which is exactly the new-customer blind spot item 2 closes.

**Performance trap, worth keeping.** The first cut of `fn_planning_due_demand` and `fn_planning_customer_cadence` ran past 55 seconds and took the items master with them; `v_planning_daily_sales_cust` alone runs in 0.4 s. The planner estimates that view at **one row**, inlines the CTEs, and re-runs the whole view once per row of the join between "who is due" and "what they usually take" (2,708 × 119). **Every CTE in those three functions is `AS MATERIALIZED`** — ~1 s. `fn_planning_yoy` got the same treatment pre-emptively.

Manifest: new writer `planner:forecast-snapshot`; `planning_forecast_log` in the snapshot. `fetchCustomerCadence()` / `fetchForecastAccuracy()` in `lib/inventory.ts`.

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
   added, Calderoni's flat canning fee added as a per-run line. Per-case
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
4. **`fn_wo_advance`'s `record_yield` still values components from
   `work_order_materials`.** With pack rounding in play that is the cost of what
   was BOUGHT rather than what was CONSUMED. For a first run they are the same
   number; once pack sizes exist they will differ by the remainder of the last
   bag, which is a real cost and arguably belongs in the batch anyway.

---

## Dates a person sets, and print as a report (2026-09-04)

Two asks from the same message, both about paperwork rather than stock.

### The transfer and the repack sheet carry their own date

> *"the tranfers also dont have a date, they use the system date. I need a date
> that can be changed. I also need that on the repack screens. need to enter
> dates or change names on repack screen not just whos logged in."* — Sky

A transfer had three dates and **none of them was the operator's to set**. The
document date was `created_at`, i.e. when the row happened to be typed, and the
ship/received dates were stamped `CURRENT_DATE` by the RPCs because the UI
called them with no date at all. Paperwork written up on Monday for a Friday
load therefore read Monday — on the BOL, in the list, and in the ledger's own
history. The repack sheet was the same shape: `repack_orders.repack_date`
already existed and already drove the QuickBooks adjustment's `TxnDate`, and
`fn_repack_create` simply never set it, so it fell to the column default.

- **`ops.inventory_transfers.transfer_date`** — the DOCUMENT date, defaulting to
  today, backfilled from `created_at` for every existing row, printed as
  *Issued* on the BOL and now the list's Issued column and default sort.
- **`ops.fn_set_transfer_dates(id, transfer, ship, received)`** — set any of the
  three, before or after the fact, from the transfer's detail panel.
- **`fn_repack_create` gains `p_repack_date`** — the sheet's date box, which is
  what QuickBooks receives. The signer's NAME was always editable (prefilled
  from the login, never locked to it); the date was the gap.
- Ship and Receive now **ask** for the date instead of assuming today, because a
  load that went out on Friday is routinely marked shipped on Monday.

⚠ **Changing a date corrects PAPERWORK, never the ledger.** A movement is
stamped when it is POSTED and history is not edited — that is the same rule the
reconcile follows. `fn_set_transfer_dates` says so, and it **refuses a ship or
received date on a transfer that has not reached that state**, so a date can
never assert an event that did not happen. `fn_repack_create` refuses a date in
the FUTURE for the mirror-image reason: a sheet records work that has been done,
and a future date would post a QuickBooks adjustment into a period that has not
happened.

⚠ **`fn_create_transfer` did NOT gain a date argument, deliberately.** It has
two live overloads (6-arg and 12-arg), so adding a defaulted parameter to either
makes a call naming the shorter set match both, and Postgres refuses it as
ambiguous (42725) — which is exactly what happened to this session's own first
attempt at raising a transfer. The create posts, then `fn_set_transfer_dates`
sets the date; one function writes a date, and it is the same one the
edit-after-the-fact button uses.

⚠ **`fn_repack_create` is migrated by an anchor-checked read-modify-write of the
LIVE definition**, not a pasted body — the `fn_items_master` /
`fn_sync_health_extra` pattern. It is 150 lines of ledger and variety-bin
arithmetic that four migrations have each edited; re-typing it to add one
parameter is how one of those edits silently reverts. Six anchors, each
asserted to match exactly once, or the migration raises and changes nothing.
The 4-argument signature is DROPPED in the same migration for the ambiguity
reason above; PostgREST calls it by named arguments, so `repack.mjs` keeps
resolving.

Migration `20260904k`. Verified by applying the whole thing inside a transaction
and rolling it back: a backdated sheet stored `2026-09-01`, a sheet with no date
given stored today, a future date was refused by name, and
`fn_set_transfer_dates` returned the new date — after which the live function
was still the 4-argument one and no row had changed.

### Print is a chooser, not a dump

> *"well make the report selectable what you arre going to print so it doesn
> print everything, maybe we should make a report builder later."* — Sky

Every table already had a Print button. It printed the whole table, which is the
wrong default for making a report out of a screen with thirty columns.

- **Plain tables** (`PrintableTable`) — Print opens a small chooser: a tick per
  column, an optional word to narrow the rows to, and a title for the report.
  The column choice is REMEMBERED per table, because a report somebody prints
  weekly is the same report every week and re-ticking eight boxes is how a
  feature stops being used. A remembered pick is only honoured while it still
  fits the table's shape, so a view toggle that changes the columns falls back
  to all of them rather than cutting the wrong ones.
- **Data grids** (`GridToolbarWithPrint`) — the grid already HAS the two
  controls, so the button uses them rather than adding a third: it prints the
  ticked rows if any are ticked and otherwise everything the current filter
  leaves (never the raw table behind a filter), with the columns switched on in
  the Columns menu. The button reads `PRINT 12` when twelve rows are selected,
  so it says what it is about to do before you press it.

A report BUILDER — saved reports, chosen columns across several tables — is the
next step and is deliberately not this.

---

## The transfer process — a pull ticket, a ticket somebody works, and a link that receives (2026-09-05)

Ask (Sky, 2026-09-04): *"can you make a system when we do transfers where i can
print pull tickets for the load being tranferred and create a real inventory
transfer process where the order gets put in, an email gets sent to
service@brixbev.com to make the order for the transfer, with all the details and
the pick ticket, and it makes a ticket in service fusion thats just a
UNSCHEDULED - Brix Beverage Sampling customer ticket that says Product Transfer
Ticket type. The ticket numbre (Service fusion) gets entered on the email. The
receiving branch gets a notification via email as well letting them know all
this. Then the tech works the ticket and completes the ticket. The ticket tells
them how many cases of what to build on the notes or tasks section 20 cases of
XXXXX Then once the ticket is completed, an email comes back to schedule the
transfer for delivery. Then it asks for the shippng and BOL information. once
thats entrerd it kicks off another email with all details, pallets, etc with a
link to receive the product when it gets to the transfer location, that link
will be one time link."*

**Before this, a transfer was a row that changed state.** Somebody typed it,
somebody else pressed Mark Shipped, and the only thing connecting those two
moments was a person remembering. Nothing told the warehouse to build it,
nothing told the receiving branch it was coming, and the pick list existed only
in whoever's head had opened the screen.

### The four steps

| Step | What happens | Who is told |
|---|---|---|
| **Request** | The Service Fusion ticket is created, then the row is stamped | The office gets the **pull ticket PDF attached** and the SF ticket number; the receiving branch gets a heads-up |
| **Built** | The tech completes the SF ticket (or a human presses the button) | The office: schedule the delivery |
| **Schedule & ship** | Shipping + BOL details are collected, then the load **ships** | The receiving branch gets the BOL PDF **and a one-time link** |
| **Receive** | The branch opens the link on a phone and presses one button | The office is told it landed |

`inventory_transfers.workflow_status` runs `none → requested → built →
scheduled`, beside — never instead of — `status`, which still says where the
stock is.

### ⚠ The order of operations, and why it is that way

The Service Fusion ticket is created **first**, because its number belongs on
the email. An email saying "SF ticket: not created" is honest; one sent before
the ticket exists could never carry the number at all. The database is stamped
**second**, so the transfer always knows which ticket is its own even when an
email later fails. Emails are **last** and are best-effort — a Resend hiccup
must not leave a transfer that Service Fusion has a ticket for and our database
does not. A send that fails is recorded and reported ("2 of 3 emails sent"),
never thrown.

### ⚠ Only ONE step moves stock

`schedule` ships, and it ships by calling the ordinary `ops.fn_ship_transfer`
under the caller's own JWT, so `shipped_by` is the real person. Receiving calls
`ops.fn_receive_transfer` the same way. **Neither function writes an inventory
movement of its own** — that is what keeps the append-only ledger single-pathed
alongside `brix-stock` and `sub-distributors`. Everything else in the process is
paperwork.

The consequence on screen: the plain **Mark Shipped** button disappears once a
transfer is being run as a process. Two buttons that both move stock is the one
thing an operator must never be offered.

### The receive link is a credential, and it is treated as one

- 32 random bytes; **only the sha256 is stored**. A database read — or a leaked
  backup — yields nothing that opens the page, and re-sending the original is
  impossible by construction. "Send a new link" mints one and kills the old in
  the same write, which is the honest behaviour anyway: a link that needs
  re-sending has usually gone astray.
- Single use is enforced by a **conditional patch** (`receive_token_used_at is
  null AND status = in_transit`) that runs BEFORE the RPC, so a double-tap on a
  phone cannot receive the load twice.
- It expires (`transfer_workflow_settings.receive_link_days`, default 21).
- Unknown, used and expired all answer **identically**. A probe must not learn
  which tokens exist.
- `netlify/functions/transfer-receive.mjs` is **structurally separate** — it
  contains no code to list, create, edit or void anything. That is not a role
  check that could be got wrong; there is nothing there to reach.

### Service Fusion has no webhooks, so the ticket is polled

`transfer-sf-poll.mjs` runs every 30 minutes, reads `GET /jobs/{id}` for each
transfer waiting on a ticket (capped at 15 a run — SF rate-limits hard, and the
2026-06/07 429 outage is the reason every SF-hitting cron in this repo is
throttled), and advances a completed one to `built`, emailing the office. The
button is still there for the day SF is slow or the tech forgot.

⚠ **The job CATEGORY `Product Transfer Ticket` must exist in SF Settings → Job
Categories.** Service Fusion only ATTACHES an existing category and rejects an
unknown one with a 422 that kills the whole job — so `createTransferSfJob`
retries once without the field SF's own error names, keeps the ticket, and
reports a warning. The ticket matters more than the label; nobody hears about a
missing setting if the failure is silent.

### The pull ticket

`renderPullTicketPdf` in `lib/production-docs.mjs`, same Melt design as the PO
and the BOL: where to pull from, where it is going, the SF ticket number, and one
line per item with a **tick box** and a bold quantity — because that is what a
person carries into the warehouse. It is attached to the office's email
automatically and there is a **Pull ticket** button on the transfer for a
reprint.

The Service Fusion ticket's description repeats the same list **in words**
(`20 cases of 3G6141 CABLE CAR LEMON LIME`) rather than leaving it in an
attachment: the tech works from the SF app, where our PDF is not.

### Where the pieces live

| | |
|---|---|
| Migration | `supabase/migrations/20260905a_transfer_workflow.sql` |
| Settings | `ops.transfer_workflow_settings` — one row: enabled, SF customer/category/status, ops email, cc list, link days |
| Staff endpoint | `netlify/functions/transfer-workflow.mjs` (superadmin \| admin) |
| Public receive | `netlify/functions/transfer-receive.mjs` + `public/transfer-receive.html` |
| Poll | `netlify/functions/transfer-sf-poll.mjs` (`*/30`) |
| Shared | `lib/transfer-workflow.mjs` (tokens, SF ticket, emails), `lib/transfer-docs.mjs` (the document payload) |
| Screen | Refractor → Stock → Transfers → open a transfer |
| Watcher | `ops.fn_transfer_workflow_health()` inside `fn_sync_health_extra` |

Every notification lands in `ops.production_doc_sends`, so "what did we send and
did it arrive" has one answer per transfer.

### Still unexercised

The Service Fusion ticket create, the emails and the receive page each need a
live hub session, which is not reachable from a build session — the token rules,
the 422 ladder and the ticket's wording are covered by
`tests/transfer-workflow.test.mjs`, and every other step is proven separately.
The first real Request is the end-to-end proof.
