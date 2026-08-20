# Sub-Distributors — architecture

Companion to [`MARGIN-CONTROL.md`](MARGIN-CONTROL.md) and
[`BRIXPENSE.md`](BRIXPENSE.md). Shipped 2026-08-18 (v0.1.0, PR #379) +
2026-08-20 (v0.2.0, PR #387). Cross-repo picture:
`Skilliosis_Mytosis_Architecture/ARCHITECTURE.md` +
`projects/sub-distributor-portal/`.

## What it is

Distribution partners (Origins Soda Co., Desert Beverage) hold Brix/Alameda
product in **their** warehouse and deliver it to chain accounts (The Melt,
Starbird) in territories our trucks don't cover. Two commercial models,
selectable per distributor AND per agreement version (`model`):

- **consignment** (live today) — Brix owns the inventory until depletion; the
  partner bills Brix a `per_case_delivery_fee`, snapshotted on every
  depletion row and settled monthly into a Brixpense bill.
- **sell_in** (ready, unused) — the partner buys at contract pricing
  (`ops.resolve_price` snapshot on order lines); inventory tracking is
  visibility only.

## Surfaces

| Surface | Where | Who |
|---|---|---|
| Refractor → Sub-Distributors | `app/src/pages/distributors/` + `app/src/lib/subDistributors.ts` | staff (`ops.fn_is_staff()`) |
| Partner portal | `app-distributor/` → `public/distributor/` → gateway `/distributor` | external partner logins |
| Notifications | `netlify/functions/distributor-notify.mjs` (scheduled `*/15`) | system |

The portal is the third SPA on the Brixpense recipe (vite base
`/distributor/`, `BrowserRouter basename`, shared `apbg_session` token-chain
`supabase.ts` copied verbatim, netlify.toml build step + SPA fallback,
gateway proxy rows + `gateway_apps` tile in apbg-gateway).

## Data model (`ops.*`, migrations `20260818f` + `20260820a`)

- `sub_distributors` — registry: code, name, status, model,
  `per_case_delivery_fee`, `qbo_customer_id`, `qbo_vendor_id`,
  `sf_customer_id`, `inventory_location_id` (→ `inventory_locations`, new
  kind `'distributor'`), territory, contacts.
- `sub_distributor_users` — **the RLS membership key**: email (matched
  case-insensitively against the JWT) and/or `user_id`, role, `is_active`.
- `sub_distributor_agreements` — versioned; model + fee per version;
  `scope`; terms; PDF in private bucket `distributor-docs`
  (`<sub_id>/agreements/…`); status draft→sent→signed; signature record =
  typed name + PNG data-URL + email + timestamp + `signer_ip` +
  `signer_user_agent` (read from PostgREST `request.headers` inside the sign
  RPC — not client-supplied).
- `sub_distributor_accounts` — serviced chain stores (`qbo_customer_id` of
  the Melt/Starbird store, chain label).
- `sub_distributor_orders` / `_order_lines` — `SDO-YYYY-####` restock orders
  (submitted → fulfilled/cancelled; `transfer_id` links the BOL).
- `sub_distributor_depletions` — one row per item per delivery batch:
  account, cases, delivered_date, `movement_id` (the posted `shipment`
  movement out of the partner's location), `fee_per_case`/`fee_amount`
  snapshots, `settlement_id` (null until settled).
- `sub_distributor_settlements` — one per distributor per period:
  totals, `reference SD-<code>-<YYYYMM>`, status open/void,
  `expense_request_id` → the Brixpense bill.
- `sub_distributor_notifications` — service-role-only dedup ledger,
  `UNIQUE(event_type, ref_id)`.

**Inventory and BOLs are NOT duplicated** — a shipment to a partner is an
ordinary `ops.inventory_transfers` BOL; on-hand derives from
`ops.inventory_movements`; depletions post `shipment` movements. The
`sub-distributors:app-and-rpcs` manifest writer is multi-writer on that
ledger with `brix-stock` (both RPC-only).

## RPCs (SECURITY DEFINER)

- `fn_distributor_create_order` / `fn_distributor_cancel_order` — member or
  staff; sell-in lines snapshot `resolve_price`.
- `fn_fulfill_distributor_order` — **staff**; order → draft BOL transfer to
  the partner's location (explicit 12-arg `fn_create_transfer` — the legacy
  overloads are still live).
- `fn_distributor_receive_transfer` — member of the destination distributor
  (or staff); **per-line counted quantities**; shortfall stays in TRANSIT and
  sets `inventory_transfers.has_discrepancy` + `receiver_notes` (the internal
  `fn_receive_transfer` remains all-or-nothing and is untouched).
- `fn_distributor_sign_agreement` — member; sent→signed + audit fields.
- `fn_distributor_record_depletion` — member or staff; posts movements + fee
  snapshots (latest signed consignment agreement's fee, else the registry
  default).
- `fn_distributor_settlement_create` — **staff**; sweeps un-settled
  fee-carrying depletions for a period (row-locked), stamps them, and inserts
  an `ops.expense_requests` row (status `approved`, `as_bill`,
  tag `Sub-Distributor`, `bill_number` = the settlement reference → QBO
  DocNumber, per-account line items, vendor = the linked
  `qbo_vendors.display_name`, submitted under the clicking staff member's
  identity so it appears in *their* Brixpense list with the **Post to
  QuickBooks** button). **QBO posting stays human-gated** (2026-08-14 rule).
- `fn_distributor_settlement_void` — staff; releases depletions + archives
  the unposted request; refuses once `qbo_bill_id`/`posted`.
- Membership helpers: `fn_is_distributor()`, `fn_my_distributor_ids()`,
  `fn_my_distributor_location_ids()`, `fn_my_distributor_qbo_customer_ids()`,
  `fn_is_distributor_member(uuid)`.

## The RLS model (the load-bearing part)

Auth is the shared Supabase project — "authenticated" is not a trust
boundary. External partner logins are contained by **`AS RESTRICTIVE`
policies** (ANDed with the permissive ones, so they can only narrow):

```
USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor() OR <scope>)
```

- Zero change for staff/internal/brix-order logins **by construction**.
- Distributor logins: transfers/lines/movements scoped to their location;
  locations scoped to their own + our warehouses (BOL ship-from address);
  `qbo_invoices`/`_lines`/`qbo_customers` scoped to their own customer +
  serviced stores; ~90 other open-read ops tables (formulas, WOs, POs,
  expenses, fleet, HR, pricing, `qbo_items`, …) **denied** outright.
- `qbo_items` is replaced for partners by `ops.v_distributor_catalog`
  (owner-executed view, names only, **no cost columns**); the portal never
  queries `qbo_items` and never renders `unit_cost`.
- `v_inventory_on_hand` / `v_sales_lines` / `v_work_orders` /
  `v_purchase_orders` are `security_invoker` so they inherit the scoping.
- Verified live at ship time with a temporary membership: 1 registry row,
  1 location, catalog names, zero invoices/formulas/costs.

### Known limits (pre-existing, flagged 2026-08-18 — do these before
### onboarding a partner you don't trust)

1. **SECURITY DEFINER RPCs granted to `authenticated`** (e.g.
   `fn_items_master`, returns purchase costs) are callable by ANY login on
   the project — also true for brix-order customers today. Needs an
   RPC-guard pass (`IF ops.fn_is_distributor() AND NOT ops.fn_is_staff()
   THEN RAISE` in the leaky ones).
2. **`ops.qbo_invoices`/`_lines` carry ANON read policies** — the invoice
   mirror is readable with the public anon key alone. Separate decision.

## Notifications (`distributor-notify.mjs`)

15-minute Netlify schedule (+ staff kick via `requireScheduledOrAuth`).
Events → recipients: `order_submitted` → staff (`DISTRIBUTOR_ALERT_TO`,
default service@brixbev.com); `order_fulfilled`, `transfer_shipped` → partner
(contact_email ∪ active portal users); `transfer_discrepancy` → staff with
the per-line short counts; `agreement_sent` → partner with the sign link;
`agreement_signed` → both. Exactly-once via the ledger; failed sends recorded
and retried next tick; scans capped to 30 days so a deploy can't blast
history. Uses the shared `email-helpers.mjs` (Resend/SendGrid).

## Env

| Var | Where | Purpose |
|---|---|---|
| `DISTRIBUTOR_ALERT_TO` | apbg-billing Netlify (optional) | staff notification recipient override |

Everything else rides existing env (`SUPABASE_SERVICE_ROLE_KEY`,
`RESEND_API_KEY`/`SENDGRID_API_KEY`).

## Graduation path

If the portal outgrows the monorepo (own deploy cadence, custom domain), it
extracts to its own repo/site the way Fountain DAM did — the ops data layer
and RPCs stay here regardless.
