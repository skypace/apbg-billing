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
   │  Quantum Canning → fill labour, pack off
   │  Craft Beverage Packaging → cans, trays
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
   cannot be checked against anything real.
1b. **The gallon prices in QuickBooks look stale, and everything now hinges on
   them.** The 1GNS items carry $4.25–$7.44. The only 1GNS lines ever billed
   were $32–$38/gal in May 2025 (a pilot), while the current 3-gallon BIB price
   works out to roughly **$9.58/gal** (`3G6121, 50 @ $28.75`). Since the gallon
   is now the master price and the ingredient breakdown is allocated out of it,
   refreshing these from the current Calderoni sheet is the single highest-value
   data fix left.
2. **Six of seven BOMs have no empty-can line.** Items `685`, `686`, `688`,
   `689`, `690`, `691` are INACTIVE in QuickBooks (someone deactivated them —
   QBO appends "(deleted)" to the name); only Old Fountain's `687` is live.
   Reactivating them is a deliberate decision about whether those can designs
   are current, so it has been left to a human.
3. **Cans and trays are vendored to Craft Beverage Packaging Solutions, not
   Quantum Canning.** That is what the live BOM data says and it contradicts the
   process as described. It is not a bug in the code — PO generation groups by
   whatever vendor is on the line, so today a run produces three POs, not two.
   Change the vendor on the BOM lines if the description is the correct one.
   (The gallon line's vendor WAS wrong and has been corrected: it pointed at
   ALAMEDA SODA COMPANY PRODUCTION, and every gallon ever billed came from AC
   CALDERONI. Alameda Soda Production remains the vendor for the finished cases
   at the other end of the run.)
4. **`fn_wo_advance`'s `record_yield` still values components from
   `work_order_materials`.** With pack rounding in play that is the cost of what
   was BOUGHT rather than what was CONSUMED. For a first run they are the same
   number; once pack sizes exist they will differ by the remainder of the last
   bag, which is a real cost and arguably belongs in the batch anyway.
