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
   │  ingredients (from the formula) + 24 cans + 1 tray
   │  + fill charge + tolling charge          ← per case
   ▼
WORK ORDER  ("make 500 cases")
   │  batch plan: gallons needed, and how many MORE cases fill the tank
   │  materials: recipe quantity → whole vendor packs
   ▼
PURCHASE ORDERS  — ONE PER VENDOR, generated from the work order
   │  AC Calderoni  → N gallons of CONCENTRATE, with the ingredient
   │                  breakdown printed underneath (see The roll-up)
   │  Quantum Canning → cans, tray, fill labour, pack off
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
| **stocked** | `component_qbo_item_id` | the gallon, cans, tray, fill labour, pack off | yes — as its own PO line |
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
`'manual'` (cans, tray, fill labour, tolling — written by `fn_bom_save_v2`,
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
the flavour gallons, the printed cans, the tray, fill labour, pack-off. It is
edited on **Production → Materials & Pricing → Purchased items & vendors**, and
it exists because neither number could be managed anywhere sensible before:
the price came from the QuickBooks item mirror (nightly, and stale — $0.26 a can
against $0.31–0.37 billed) and the vendor lived on each BOM line separately, so
moving trays to another supplier meant editing seven BOMs.

Everywhere a cost or vendor is read, the precedence is:

```
BOM line override  >  production_items  >  raw_ingredients  >  QBO mirror
```

`fn_wo_create_pipeline` (what the work order prices its POs at) and
`fn_bom_preflight` (which vendor gets which PO) both read it. **The BOM line's
own vendor slot is now an OVERRIDE, not the default** — the migration cleared
every line vendor that merely repeated the master, so the master actually
governs instead of being shadowed by seven identical copies. Use the line slot
for the genuine exception (this one flavour buys its tray elsewhere).

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
| 24-pk tray | **nobody, on any Quantum invoice** | — | still on the BOM at the QBO mirror value with a note saying so — who supplies it is a question for a human |
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
| **Quantum Canning** (1744) | 24 printed cans · 1 sleek tray · 24 × fill labour · 24 × pack off |

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
supplier to this run.

## Item types — Service or Non-inventory, never Inventory

**The rule:** everything the production system consumes is a **Service** or a
**Non-inventory** item in QuickBooks. The only **Inventory** items are the
finished cases that come back into the warehouse, and those already exist.

| Role | QBO type | Why |
|---|---|---|
| Fill labour, pack off | **Service** | a charge, nothing arrives |
| Flavour gallon, cans, tray, raw materials | **NonInventory** | consumed at the co-packer; we never count them |
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

## Known gaps, 2026-09-02

1. **No per-ingredient costs and no pack sizes.** All 17 materials have both
   blank. This no longer blocks costing a run — the gallon price does that — but
   until some are filled in, `quoted_cost` is empty and the allocated split
   cannot be checked against anything real. (Stocked-component prices — cans,
   tray, labour, gallons — now have a home of their own: Materials & Pricing →
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
   variable cost is now **$25.85** against the **$21.36** the finished-case
   QuickBooks items carry — the QuickBooks number is the one that is wrong.
3b. **The 24-pk tray is on no Quantum invoice.** It is vendored to Quantum on
   instruction at the QBO mirror value ($0.01583) with a note saying so.
   Whether Quantum supplies it inside the tolling, someone else supplies it, or
   it was never billed is a question for Sky, not a guess.
4. **`fn_wo_advance`'s `record_yield` still values components from
   `work_order_materials`.** With pack rounding in play that is the cost of what
   was BOUGHT rather than what was CONSUMED. For a first run they are the same
   number; once pack sizes exist they will differ by the remainder of the last
   bag, which is a real cost and arguably belongs in the batch anyway.
