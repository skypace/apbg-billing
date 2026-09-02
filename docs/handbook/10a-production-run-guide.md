# Running a Production Run — Click by Click

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-09-02

This is the walkthrough: one run of Hangar 25 Cola from "we need 500 cases" to
"500 cases are on the warehouse shelf and every case traces back to a lot code".
Chapter 10 is the reference for what each tab holds; this chapter is what to
click, in order, with a picture of every screen.

There is a **test script at the end**. If you are checking the system rather than
running a real batch, start there and use the rest of the chapter as the map.

> **Screens in this chapter are the real application** with real BOM data. Your
> numbers will differ; the buttons will not.

## Before you start

Sign in at **[alamedapointbg.com](https://alamedapointbg.com)** and open
**Refractor** (the Margin app). In the left sidebar choose **Production**.

At the top of the Production page is a **lane** switch — **BIB Product** and
**Cans 24pks**. Everything in this chapter is the **Cans 24pks** lane. The lane
decides which formulas, BOMs and work orders you see; picking the wrong one is
the usual reason "my BOM has disappeared".

Six tabs run left to right roughly in the order you use them:

| Tab | What it is for |
|---|---|
| **Formulas & Spec Sheets** | The recipe — % by weight, QC specs, batching instructions |
| **Materials & Pricing** | What each purchased thing costs and who we buy it from |
| **Bills of Materials** | The parts list for one case, and who gets a purchase order |
| **Work Orders** | The run itself, start to finish |
| **Purchase Orders** | The vendor POs a run raises, and receiving against them |
| **Compliance & Safety** | Certificates and audit paperwork (not part of a run) |

---

## Step 1 · Check prices and vendors

**Production → Materials & Pricing → Purchased items & vendors.**

![Materials & Pricing — the purchased-item master, grouped by vendor](/billing/production-guide/01-production-materials-pricing.jpg)

Every purchased component has **one** vendor and **one** price here, grouped by
vendor so the page reads as "here is Quantum's order, here is Calderoni's".
This is the master: a bill of materials only overrides it when a particular
product genuinely buys that part from someone else.

Prices seeded from QuickBooks carry the note *"seeded from QuickBooks purchase
cost — confirm"* until somebody saves them. **A seeded price is a guess.** The
QuickBooks cost is shown beside ours for comparison and is never written to.

> **Change a price here and every future run picks it up.** Runs already created
> keep the price they were costed at — a work order snapshots its materials, so
> editing this page cannot rewrite a batch that is already in flight.

## Step 2 · Check the bill of materials

**Production → Bills of Materials.** One row per sellable finished item.

![The BOMs list](/billing/production-guide/02-boms-list.jpg)

Click the finished item to open the editor.

![The BOM editor, with the pre-flight at the top and the recipe below](/billing/production-guide/03-bom-editor-preflight.jpg)

Read it top to bottom:

1. **Who gets a purchase order.** The pre-flight, in the grey panel. It should
   say **2 POs per run** — AC Calderoni for the syrup and the compounding fee,
   Quantum Canning for the cans, tray, fill, Velcorin and dunnage. If it names a
   third vendor, a component is pointed at the wrong supplier.
2. **Blockers, in red, stop a run.** The two that happen: a component that is
   **deactivated in QuickBooks** (QuickBooks will refuse the PO push, and you
   want to know now rather than at the push) and a component with **no vendor
   anywhere** — not on the line and not in Materials & Pricing.
3. **Warnings, in amber, do not stop a run.** The one that matters: a component
   whose QuickBooks type is **Inventory**. Everything we buy for a run should be
   *Service* or *Non-inventory*; only the finished cases we bring back into the
   warehouse are inventory items.
4. **Recipe — from the formula, per 1 case.** Sugar, flavour, acid and water,
   computed from the formula, not typed. Water is on the sheet (it is what makes
   the percentages total 100) and is deliberately never purchased.
5. **How the concentrate volume is worked out.** A case is 24 × 12 oz = 2.25 gal
   of finished soda; at 5:1 the concentrate is one part in six, so **0.375 gal per
   case**. The cross-check underneath states the syrup's solids loading and
   whether it sits in the normal band for a 5:1 syrup.
6. **Sub-items** — the things that actually get bought. Note the **Per** column:
   *per unit* scales with the run, **per run** is a flat charge for the whole
   work order however big it is. The syrup compounding fee is per run.

**Rebuild from formula** re-writes only the recipe rows from the current formula.
It never touches the sub-items you typed (cans, tray, fill, tolling) — those are
yours.

## Step 3 · Raise the work order

**Production → Work Orders → + New Work Order.**

![The work-orders list](/billing/production-guide/04-work-orders-list.jpg)

![The New Work Order form, with the batch plan and the material preview](/billing/production-guide/04b-new-work-order.jpg)

Fill in seven fields: the **BOM**, **how many finished units**, the **batch size**
(defaults from the formula), the **co-packer** and the **location materials ship
to**, **where finished goods are received**, and the **scheduled date**.

Three panels then tell you what you are about to commit to:

- **This run raises 2 purchase orders** — the same pre-flight as the BOM.
- **Batch plan — filling the tank.** 500 cases × 2.25 gal = 1,125 gal of finished
  soda, needing 188 gal of concentrate. The table shows what each tank size makes
  and how many cases to add to fill it; clicking a **+n** rounds the order up to
  a full tank. The tank is *finished product* — the co-packer dilutes and
  carbonates.
- **Materials that will be calculated onto this work order** — every purchased
  line with its quantity, vendor, unit price and extension, and an
  **Estimated materials** total. Check that total before you press the button:
  it is what the two purchase orders will add up to.

Press **Create work order**.

## Step 4 · Send the purchase orders

Open the new work order. It sits at **Draft**, and the whole run is a row of
stages across the top:

**Draft → POs issued → Materials at co-packer → In production → Yield recorded →
Shipping to us → Received to inventory → Closed**

![A work order in production, materials snapshot and batching sheet](/billing/production-guide/05-wo-detail-in-production.jpg)

Press **Generate POs per vendor →**. One purchase order per vendor is created for
the totals of every sub-item, shipping to the co-packer's location. The stage
moves to **POs issued** and the materials table grows a **PO** column showing
`✓ on PO` per line.

Go to **Production → Purchase Orders**.

![The purchase-order list](/billing/production-guide/10-po-list.jpg)

Open each one.

![The Quantum purchase order — cans, tray, fill, Velcorin, dunnage](/billing/production-guide/11-po-detail.jpg)

![The Calderoni purchase order — the syrup and the flat run fee](/billing/production-guide/11b-po-detail-calderoni.jpg)

Per PO you can:

- **View PDF** — the branded purchase order. On the Calderoni PO the PDF also
  lists the ingredient breakdown underneath the gallon line, so the compounder
  can see how much sugar and flavour to buy. That detail is on the document, not
  on this screen.
- **Email…** — sends that exact PDF to the vendor and files a copy. **The PDF we
  email is the PDF we keep**; prices move and "what did we actually send them"
  must not.
- **Push to QBO →** — creates the purchase order in QuickBooks.
- **Receive** — type the quantity that arrived in the box on the line and press
  the truck. Receiving is per line, so a part shipment is fine.
- **Close** force-closes any unreceived lines; **Void** cancels the PO.

Back on the work order, press **Materials at co-packer** when the goods have
landed, then **Start production →** when the co-packer begins. Starting
production consumes the material quantities from the co-packer's location, so
only press it when it is true.

## Step 5 · Record the yield and the lot codes

This is the step this chapter exists for.

Press **Record yield →**.

![Recording the yield with the co-packer's lot codes](/billing/production-guide/06-wo-record-yield-lots.jpg)

Enter the **actual yield** — how many cases the co-packer really made — plus the
co-pack fee, freight and any other landed cost, and the yield date. The panel
prints the yield as a percentage of plan as you type.

Then the lots. For each batch the co-packer ran, press **+ Add lot** and enter:

| Field | What goes in it |
|---|---|
| **Lot code** | The co-packer's own batch code, exactly as printed on the can |
| **Born on** | The production date coded on the can |
| **Best by** | The expiry, if they print one |
| **Cases** | How many cases came out of that lot |
| **Notes** | Anything worth remembering about that batch |

⚠ **The lot quantities must add up to the yield.** A case is in exactly one lot,
so 210 + 205 + 85 = 500 lands and anything else is refused with both numbers in
the message. The line under the table turns green and reads
*"3 lots · 500 cases — matches the yield"* when it balances.

Press **Record yield + lock costs**. The cost rollup is computed and frozen:
materials, services and fees, total, and unit cost per case, per can, per oz and
per gallon.

Lots are optional at this point — you can enter them later with **Edit lots** on
the work order, or in the Ship dialog — but they must exist before the shipment
goes out, because the BOL prints one line per lot.

![The work order after the yield, with the lots on file](/billing/production-guide/07-wo-detail-yield-recorded-lots.jpg)

## Step 6 · Ship it home

Press **Create shipping record →**.

![The shipping dialog — carrier, tracking, and the lots the BOL will carry](/billing/production-guide/08-wo-ship-dialog.jpg)

Enter the **carrier**, **tracking #**, **PRO #** and **ship date**. The note at
the bottom states exactly what the bill of lading will carry — one line per lot,
each with its born-on date. If a lot is wrong, fix it with **Edit lots** before
shipping, not after.

Press **Ship it**. A real BOL transfer is created from the co-packer's location
to the warehouse and the stage moves to **Shipping to us**.

![The work order in transit](/billing/production-guide/09-wo-detail-in-transit.jpg)

## Step 7 · The bill of lading

**Stock → Transfers.** The shipment is an ordinary transfer, so it behaves like
any other move between two locations.

![The transfers list](/billing/production-guide/12-transfers-list.jpg)

![The BOL, one line per lot](/billing/production-guide/13-transfer-detail-lots.jpg)

Three lots, three lines, each with its lot code and born-on date. **View BOL PDF**
renders the document the driver carries — with Lot and Born-on columns, and best
by as a sub-line — and **Email…** sends it and files the copy.

**Mark Received** when the pallets arrive. Or do it from the work order with
**Receive into inventory →**, which is the same thing said from the other end:
the finished cases land in the warehouse and the stage moves to **Received to
inventory**. Then **Close work order**.

## Where a lot ends up

Every inventory movement points at the transfer *line* that carried it, and the
line carries the lot — so each case that moved can be traced to the batch it came
from without a second copy of the lot code anywhere.

If somebody asks "which stores got lot Q379", that is the recall query, and it is
one read of `ops.v_lot_trace`: lot → run → BOL → ship and receive dates →
how many movements it touched.

## The documents

Three PDFs, one design, all branded the same:

| Document | Where |
|---|---|
| **Purchase order** | Purchase Orders → open a PO → **View PDF** / **Email…** |
| **Bill of lading** | Stock → Transfers → open a BOL → **View BOL PDF** / **Email…** |
| **Batching sheet** | Formulas (at any batch size) or the work order (sized to the run) → **Batching sheet** / **Email sheet…** |

Every emailed document is filed before it is sent, and the send is logged, so the
copy on file is the copy the vendor received.

---

## QC test script

Run this against a **test flavour and a small quantity** — not a batch anyone is
actually about to make — and delete the work order afterwards. Each step says
what should happen; anything else is a finding.

| # | Do this | It should |
|---|---|---|
| 1 | Production → **Materials & Pricing** | List every purchased item grouped by vendor, each with a price and a vendor. Nothing blank. |
| 2 | Change a price, save, re-open | Keep the new price; the note about being seeded from QuickBooks is gone |
| 3 | **Bills of Materials** → open one | Show **2 POs per run**, **0 blockers** |
| 4 | Read the sub-items **Per** column | The syrup compounding fee is **per run**; everything else is per unit |
| 5 | **Work Orders → + New Work Order**, pick the BOM, enter 100 units | Batch plan and material preview appear; **Estimated materials** is roughly a fifth of a 500-case run, and the run fee line stays **1 run** at its full price |
| 6 | **Create work order** | Lands at **Draft** |
| 7 | **Generate POs per vendor →** | Exactly **two** POs; the materials table shows `✓ on PO` on every line |
| 8 | Purchase Orders → open each → **View PDF** | Both PDFs render; the Calderoni one lists the ingredient breakdown under the gallon line |
| 9 | Receive one PO line short (say 10 of 100) | The line shows the partial; the PO goes to **partial**, not closed |
| 10 | Work order → **Materials at co-packer** → **Start production →** | Stage advances; the timeline records both |
| 11 | **Record yield →**, enter a yield of 100, add lots totalling **90** | **Refused**, naming both numbers |
| 12 | Fix the lots to total 100 → **Record yield + lock costs** | Accepted; cost rollup appears with a unit cost; the timeline records the lots |
| 13 | **Edit lots**, change a lot code, save | The new code shows on the work order |
| 14 | **Create shipping record →** | The note lists one line per lot before you commit |
| 15 | **Ship it** | A BOL number appears; stage is **Shipping to us** |
| 16 | Stock → Transfers → open that BOL | One line **per lot**, each with its lot code and born-on date |
| 17 | **View BOL PDF** | Lot and Born-on columns are on the document |
| 18 | **Mark Received** (or **Receive into inventory →**) | Finished cases appear in warehouse stock; stage is **Received to inventory** |
| 19 | **Close work order** | Stage is **Closed** and no action buttons remain |
| 20 | Switch the lane to **BIB Product** | The tabs collapse to **Purchase Orders** only — the cans pipeline belongs to the cans lane, and the switch really does scope the page. Switch back to **Cans 24pks**. |

**Found something?** Note the work-order number, the step number and what you saw
instead, and send it to Sky. A screenshot of the screen with the wrong number on
it is worth more than a description.

## Things that are deliberate, not faults

- **A case BOM shows a tray, cans, fill labour and dunnage but no water.** Water
  comes out of the wall at the co-packer and is never purchased.
- **The ingredient list does not become PO lines.** Sugar, flavour and acid ride
  underneath the flavour's 1-gallon line as detail. Calderoni bills us per gallon
  of compounded syrup, so the gallon is the line and the ingredients are the
  specification.
- **A flat fee does not scale.** The syrup compounding fee is $1,173.33 whether
  the run is 100 cases or 5,000.
- **The dunnage line is fractional.** Pallets are charged per pallet and a run is
  rarely a whole number of them; the purchase order rounds up.
- **Nothing posts to QuickBooks on its own.** A PO reaches QuickBooks when
  somebody presses **Push to QBO**.
