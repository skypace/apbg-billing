# BRIX Product Control — Architecture

> **Where this fits.** This is the design doc for the inventory + manufacturing
> module that lives inside the React/Vite app at `apbg-billing/app/`. It
> extends what is currently branded "BRIX Margin Control" into a fuller
> product-lifecycle tool (catalog → on-hand by location → transfers →
> bill-of-materials → work orders → margin). See
> [`MARGIN-CONTROL.md`](MARGIN-CONTROL.md) for the host app's architecture
> and [`README.md`](README.md) for the sync-manifest contract this module
> writes against.

---

## Why this exists

QuickBooks Online tracks **single-location, single-quantity** inventory.
APBG runs three physically distinct flows that QBO can't model:

1. **Multi-warehouse stock.** Cans, parts, machines move between Alameda
   yard, FreeFlow MA yard, technician vans, and co-packer sites.
   "Quantity on hand" is meaningless without "where."
2. **Inter-warehouse transfers with paperwork.** Moving stock between
   sites is an internal logistics event with a Bill of Lading. QBO has no
   document type for this.
3. **Co-pack manufacturing (Phase 2).** We ship raw materials (cans, syrup,
   labels) to a contract manufacturer who assembles them into a finished
   SKU. Today this is hacked via a "raw materials" balance-sheet account
   that POs offset with line items — there is no Bill of Materials and the
   true rolled-up cost of a finished can is invisible.

The legitimate solution in the QBO Online world is a sidecar system that
owns location-level truth, then writes back to QBO via Class tags and
journal entries for the GL roll-up. That sidecar is this module.

---

## Phasing

This is a multi-phase build. Each phase ships independently and stands
on its own. Don't try to do Phase 2 before Phase 1 is in daily use.

| Phase | Scope | Status |
|---|---|---|
| **1 — Stock** | Locations, transfers (BOL), movement ledger, on-hand view | **This PR** |
| **2 — BOM + Work Orders** | Bill of materials per finished SKU; work-order doc with co-packer consignment; cost rollup on close | Planned |
| **3 — QBO writeback** | Edge function pushes a journal entry per closed WO (raw inv → finished inv → COGS); Class tag carries product-line attribution to QBO P&L | Planned |
| **4 — Receipts + shipments** | Inbound from bills + outbound from invoices wired to the movement ledger so on-hand reflects QBO economic activity | Planned |
| **5 — Cycle counts + adjustments** | Per-location physical count cycles with variance write-off; integrates with QBO Inventory Adjustment mirror | Planned |

The rest of this document covers Phase 1 in detail and sketches Phase 2-5
at the data-model level so we don't paint ourselves into a corner.

---

## Naming

There is an existing "Inventory" page in BRIX Margin Control. It shows
the **item master with reorder velocity** (basically a catalog with
health signals). It is not about warehouses.

To avoid breaking that screen and confusing the audit trail, the new
multi-location module is mounted at a sibling route called **Stock**.
The eventual rename of the host app from "BRIX Margin Control" to
"BRIX Product Control" is **deliberately deferred** out of this PR —
it touches branding, the gateway header, the user guide, and the
sidebar sub-mark. We'll do it as a clean rename PR once Phase 2
ships and the scope has clearly outgrown the current name.

| Today | Tomorrow (post-rename) |
|---|---|
| BRIX Margin Control — `#/inventory` (item master), `#/stock` (locations + movements) | BRIX Product Control — same routes, expanded sidebar grouping |

---

## Data model (Phase 1)

Four new tables under `ops.*` and one view. All movement math is
**ledger-style**: on-hand is computed, never stored as a snapshot.

### `ops.inventory_locations`

```sql
id                uuid pk default gen_random_uuid()
code              text unique not null      -- 'ALA-YARD', 'FF-MA', 'COPACK-XYZ', 'TRANSIT'
name              text not null             -- 'Alameda Yard'
kind              text not null check (kind in
                    ('warehouse','van','co_packer','customer_consigned','in_transit','adjustment'))
entity            text not null check (entity in ('brix','freeflow','shared'))
address_line1     text
address_line2     text
city              text
state             text
postal_code       text
country           text default 'US'
contact_name      text
contact_phone     text
is_active         boolean not null default true
notes             text
created_at        timestamptz default now()
updated_at        timestamptz default now()
```

`kind` values:
- `warehouse` — a real building we own/lease
- `van` — a technician's mobile inventory
- `co_packer` — consigned stock at a contract manufacturer (Phase 2 fills this in)
- `customer_consigned` — placed at a customer site as part of a fountain install
- `in_transit` — virtual; one singleton row (`code='TRANSIT'`) used by transfer ledger math
- `adjustment` — virtual; used as the counter-party for write-offs / variance / shrinkage

The TRANSIT and ADJUSTMENT rows are seeded by the migration so they
always exist. They are non-deletable (a check in the RPC).

### `ops.inventory_transfers` — the BOL header

```sql
id                uuid pk default gen_random_uuid()
bol_number        text unique not null      -- generated 'BOL-2026-00001'
from_location_id  uuid not null references ops.inventory_locations(id)
to_location_id    uuid not null references ops.inventory_locations(id)
status            text not null default 'draft' check (status in
                    ('draft','in_transit','received','void'))
carrier           text                     -- 'Internal', 'UPS Freight', 'XPO', etc.
tracking_number   text
ship_date         date
received_date     date
shipped_by        uuid references auth.users(id)
received_by       uuid references auth.users(id)
voided_by         uuid references auth.users(id)
voided_at         timestamptz
void_reason       text
notes             text
created_by        uuid references auth.users(id)
created_at        timestamptz default now()
updated_at        timestamptz default now()
```

### `ops.inventory_transfer_lines`

```sql
id                uuid pk default gen_random_uuid()
transfer_id       uuid not null references ops.inventory_transfers(id) on delete cascade
qbo_item_id       text not null
qty               numeric not null check (qty > 0)
qty_received      numeric                  -- null until received; allows partial in future phases
unit_cost         numeric                  -- snapshot at ship time; informational
notes             text
```

For Phase 1: receiving is all-or-nothing (`qty_received = qty` on
receive). Partial receipts come in a later phase.

### `ops.inventory_movements` — the append-only ledger

This is the **source of truth** for on-hand. Never UPDATE, never DELETE
in normal operation. Every state change in inventory writes a row here.

```sql
id                  uuid pk default gen_random_uuid()
movement_type       text not null check (movement_type in
                      ('transfer_ship','transfer_receive','receipt','shipment',
                       'adjustment','production_consume','production_yield'))
qbo_item_id         text not null
qty                 numeric not null check (qty > 0)
from_location_id    uuid references ops.inventory_locations(id)
to_location_id      uuid references ops.inventory_locations(id)
unit_cost           numeric
source_doc_type     text                   -- 'transfer' | 'bill' | 'invoice' | 'work_order' | 'manual'
source_doc_id       uuid
source_doc_line_id  uuid
occurred_at         timestamptz not null default now()
created_by          uuid references auth.users(id)
created_at          timestamptz not null default now()
notes               text
```

Rules:
- `from_location_id` null = external source (vendor receipt or production yield)
- `to_location_id` null = external sink (customer shipment or production consume)
- Both null is invalid (CHECK constraint)
- Both equal is invalid (CHECK constraint)

Phase 1 only writes `transfer_ship` and `transfer_receive` rows.

### `ops.v_inventory_on_hand` — derived view

```sql
create view ops.v_inventory_on_hand as
select
  qbo_item_id,
  location_id,
  sum(qty) as on_hand
from (
  select qbo_item_id, to_location_id   as location_id,  qty
    from ops.inventory_movements where to_location_id is not null
  union all
  select qbo_item_id, from_location_id as location_id, -qty
    from ops.inventory_movements where from_location_id is not null
) m
group by qbo_item_id, location_id;
```

This is intentionally a regular view, not materialized. Movements volume
is low (single-digit hundreds per month even at scale) and the join is
trivial. When volume justifies it (10k+ rows), promote to a materialized
view with the same `REFRESH CONCURRENTLY` pattern as `mv_sales_lines`.

---

## Transfer status flow

```
            create
draft ──────────────► void  (terminal, only from draft)
  │
  │ fn_ship_transfer
  ▼
in_transit            (movements: source → TRANSIT)
  │
  │ fn_receive_transfer
  ▼
received              (movements: TRANSIT → destination)
```

- `fn_create_transfer({from_location_id, to_location_id, lines, carrier?, notes?})`
  → inserts header + lines, status='draft', no movements yet.
- `fn_ship_transfer(transfer_id, ship_date?)` → status='draft'→'in_transit',
  writes one `transfer_ship` movement per line (from=source, to=TRANSIT).
- `fn_receive_transfer(transfer_id, received_date?)` → status='in_transit'
  →'received', writes one `transfer_receive` movement per line
  (from=TRANSIT, to=destination). Sets `qty_received = qty` on each line.
- `fn_void_transfer(transfer_id, reason)` → only from 'draft'; status='void';
  writes nothing to the ledger.

All four are SECURITY DEFINER, anon-callable (matches the rest of the
`ops.*` RPC surface). Authorization is taken from `auth.uid()` for the
audit columns.

---

## QBO integration

**Phase 1: none.** Stock movements live entirely in Supabase. The QBO
Items module still owns "quantity on hand" as a single rolled-up number
fed by QBO bills and invoices. Multi-location truth and the QBO total
will diverge — that's the expected, permanent reality of layering a
sidecar on QBO Online.

**Phase 4** will reconcile: when QBO bills create item lines tagged with
a destination warehouse, the receipt becomes a movement row. Similarly
for shipment on invoice. At that point, the sum of movement on-hand
across all locations should equal the QBO `QtyOnHand` figure for the
same item — and any drift is the reconciliation report.

**Phase 3** is the manufacturing GL writeback (described below).

---

## Phase 2 sketch (BOM + work orders)

For when we pick this up — not implemented in this PR.

```sql
ops.product_bom
  id, finished_item_id (qbo_item_id), version, effective_date,
  yield_qty, is_active, notes

ops.product_bom_lines
  bom_id, line_type ('component' | 'service'),
  component_item_id (qbo_item_id, nullable for 'service'),
  service_label (e.g. 'Co-pack fee per case'),
  qty_per, scrap_pct, default_cost

ops.work_orders
  id, batch_code, bom_id, qty_to_produce, co_packer_location_id,
  status ('draft','released','materials_shipped','in_production','received','closed','void'),
  scheduled_ship_date, actual_ship_date, received_date,
  qbo_class_id, qbo_journal_entry_id

ops.work_order_movements
  generated, references inventory_movements with movement_type =
  'production_consume' | 'production_yield'

ops.work_order_costs
  wo_id, component_costs jsonb, copack_fee, freight,
  total_cost, unit_cost, computed_at
```

The co-packer is just another `inventory_location` with `kind='co_packer'`.
Raw materials shipped to it use the same transfer mechanism as Phase 1 —
no new "consignment" concept needed.

## Phase 3 sketch (QBO writeback)

New edge function `push-qbo-work-order` (sibling of `push-qbo-item`,
deployed to the same Supabase project). On WO close:

1. Compute `unit_cost` from rolled-up component costs + co-pack fee.
2. POST a QBO Journal Entry: debit Finished Goods Inventory at
   `qty * unit_cost`, credit Raw Materials Inventory + co-pack AP.
3. Tag every line with QBO Class = `<product_family>:<batch_code>`.
4. Store the resulting `Id` on `work_orders.qbo_journal_entry_id` so we
   can reverse it if the WO is voided.

This will need a new `writers[]` entry in `sync-manifest.json` with
`writes: ['ops.qbo_token_cache', 'ops.qbo_writeback_log']`, both
already multi-writer.

---

## RLS

Phase 1 keeps it permissive, matching the rest of the operator-facing
`ops.*` data:

```sql
-- read: any authenticated user (operator UI is for staff)
GRANT SELECT ON ops.inventory_locations TO authenticated;
GRANT SELECT ON ops.inventory_transfers TO authenticated;
GRANT SELECT ON ops.inventory_transfer_lines TO authenticated;
GRANT SELECT ON ops.inventory_movements TO authenticated;
GRANT SELECT ON ops.v_inventory_on_hand TO authenticated;

-- writes: via SECURITY DEFINER RPCs only (movements + transitions)
-- locations: writable directly by authenticated for now (low volume,
-- low risk; promote to RPC if abuse appears)
GRANT INSERT, UPDATE ON ops.inventory_locations TO authenticated;
```

RLS policies are documented in the migration; the short version is
"authenticated users can do everything; no anon access; no
service-role-only paths in Phase 1." We add tighter policies (e.g.
warehouse staff role) when we have the role taxonomy in place.

---

## sync-manifest entry

A new writer claim covers all four new tables:

```json
{
  "name": "brix-stock:app-and-rpcs",
  "kind": "manual-ui",
  "source_repo": "skypace/apbg-billing",
  "schedule": "on-demand (operator creates/ships/receives transfers)",
  "writes": [
    "ops.inventory_locations",
    "ops.inventory_transfers",
    "ops.inventory_transfer_lines",
    "ops.inventory_movements"
  ],
  "notes": "BRIX Stock surface (app/src/pages/stock/) + ops.fn_create_transfer / fn_ship_transfer / fn_receive_transfer / fn_void_transfer. Movements are append-only via SECURITY DEFINER RPCs. inventory_locations is directly writable from the UI for low-volume CRUD. Phase 1 only emits transfer_ship and transfer_receive movement types; Phase 4 will add receipts (from bills) and shipments (from invoices)."
}
```

---

## UI surface (Phase 1)

New top-level route `#/stock` → `pages/stock/StockPage.tsx` with four tabs:

| Tab | What it shows |
|---|---|
| **On-Hand** | DataGridPro of `v_inventory_on_hand` × item, grouped by location. Filterable, exportable. |
| **Locations** | DataGridPro of `inventory_locations`. Inline edit. Add/deactivate. |
| **Transfers** | DataGridPro of `inventory_transfers`. Create new (modal: pick from/to + lines). Open one to see lines, ship, receive, void. Print BOL (Phase 1.1). |
| **Movements** | DataGridPro of `inventory_movements`. Read-only audit log. Filter by item / location / date / type. |

Sidebar gets a new `Stock` entry between `Inventory` and `Settings`,
icon `Warehouse` from lucide-react.

---

## Per-item Stock toggles

Multi-location tracking is **opt-in per SKU**, controlled by two flags on
`ops.inventory_settings` (the existing per-item settings table that also
holds `is_managed`, `is_planner`, etc.):

| Flag | What it does | Default |
|---|---|---|
| `track_locations` | If true, this item participates in the Stock multi-location ledger. Appears in `v_inventory_on_hand`, the Transfer line picker, and the "Tracked items only" filter on the On-Hand grid. Items with this off still show in the Movements audit log (so legacy data isn't hidden) but are otherwise invisible to Stock. | `false` |
| `has_bom` | Flags this item as a manufactured/assembled SKU. Drives the Phase 2 BOM editor + work-order cost rollup. Exposed in the Items grid now (one-shot setup) even though Phase 2 isn't built. | `false` |

Both flags surface as columns in **Settings → Items (master)**: `Stock`
and `BOM`. Toggling either calls `ops.fn_set_inventory_settings` (the
canonical 11-arg setter). Stock UI reads them from `fn_items_master`,
which now returns both columns.

Why opt-in: services, one-off jobs, P&L hierarchy items, and the
hundreds of legacy SKUs that nobody moves between warehouses should not
clutter the Stock On-Hand grid or the transfer line picker. The operator
explicitly turns on the SKUs that move (cans, parts, machines).

### Related fix shipped in the same migration

`fn_items_master` and `fn_item_pl_audit` now filter out
`qbo_items.type = 'Category'` rows. QBO models its item-category
hierarchy as Item records with `Type='Category'` — those are folders
holding sellable children, not products. Before the filter they
appeared in the items grid and were flagged `alignment_status =
no_account` by the P&L audit because they have no `income_account_name`
on themselves. The category row IS the QBO entity; the audit was asking
it the wrong question.

---

## Open conflicts checked (2026-05-13)

- **Existing `ops.inventory_settings`** — Margin Minder dashboard config (target days supply, planner flag). No overlap.
- **Existing `ops.inventory_velocity_excludes`** — items to ignore in velocity math. No overlap.
- **Existing `ops.qbo_inventory_adjustments` / `*_lines`** — QBO mirror of InventoryAdjustment objects, written by `sync-qbo-inventory-adjustments`. Phase 5 will read these to detect adjustments not driven by our movement ledger. No overlap with Phase 1.
- **Existing `pages/InventoryPage.tsx`** — Item master with reorder/velocity tabs. Kept as-is at `#/inventory`. The new Stock surface is `#/stock`.
- **Existing `lib/inventory.ts`** — helpers for the item-master page. Untouched. New module is `lib/inventoryControl.ts`.

No name, route, or sync-manifest conflicts exist.

---

## Change log

| Date | Phase | Change |
|---|---|---|
| 2026-05-13 | 1 | Initial design doc. Phase 1 scope = locations, transfers (BOL), movement ledger, on-hand view + Stock surface in app/. Phase 2-5 sketched at data-model granularity. |
| 2026-05-13 | 1 | Per-item toggles `track_locations` + `has_bom` added to `ops.inventory_settings`. Surfaced in Settings → Items master + filter chip on Stock On-Hand grid. Stock UI is now opt-in per SKU. Same migration filters QBO `Type='Category'` rows out of `fn_items_master` and `fn_item_pl_audit` (those rows were false-positive misalignments). |
