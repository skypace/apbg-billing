# shopify-qbo-sync

Replaces Intuit's QBO Commerce **Shopify channel** app, which (a) created duplicate
documents with no idempotency key (root cause of the $14.7K clearing-account blowup
cleaned up 2026-07-25), and (b) booked every sale to generic Service items, so DTC
sales **never relieved inventory** (~$97K of retail sales since May 2024 with zero
quantity decrement — the canned-product shortage mechanism).

## What it does (every 30 min once enabled)

| Shopify | QBO |
|---|---|
| Paid order | Sales Receipt `SH-<order#>`, customer 1643 (*Shopify - alameda-soda-co Customer*), deposit-to clearing account 316, **real SKU-mapped Inventory item lines** (`ops.shopify_item_map`) + shipping (item 699) / tax (698) / order-level discount (695) lines. Inventory + COGS relieved automatically. |
| Refund | Refund Receipt `SHR-<order#>-<n>`; restocked lines use the mapped item (restores qty), remainder to the generic item. |
| Shopify Payments payout | Deposit into Chase (72): +gross from clearing 316, −fee to *Shopify Selling Fees* (318). Deposit equals the bank credit → one-click bank-feed match. Negative payouts (clawbacks) are left for manual review. |

Idempotency is double-layered: `ops.shopify_sync_orders/_refunds/_payouts` PKs **and**
a QBO DocNumber lookup before every create. Unmapped SKUs fall back to the generic
Shopify Sales Item and flag the order (`had_unmapped_sku`) — surfaced by the
`shopify_qbo_sync` check in `ops.fn_sync_health_extra()`.

Watermark: `ops.shopify_sync_config.orders_watermark` (Shopify `updated_at`, 10-min
overlap re-scan). Orders created before `backfill_start_at` (2026-07-16 19:15 UTC =
just after the Intuit channel app's last import) are never booked — the old app owns
history before the cutover.

## Go-live runbook (in order)

1. **Create a custom Shopify app** (Shopify admin → Settings → Apps and sales channels
   → Develop apps → Create): Admin API scopes `read_orders`, `read_all_orders`,
   `read_shopify_payments_payouts`. Install → copy the Admin API access token (`shpat_…`).
2. **Set the secret:** `supabase secrets set SHOPIFY_ADMIN_TOKEN=shpat_…` on project
   `gfsdpwiqzshhexkofiif` (or Dashboard → Edge Functions → Secrets).
3. **Disconnect the Intuit Shopify channel** (QBO → Sales channels / Commerce →
   Shopify → disconnect). Do this BEFORE step 4 or both will book the same orders.
   Note the timestamp of its final import; if it imported anything after
   2026-07-16 19:15 UTC, bump `backfill_start_at` accordingly.
4. **Enable:** `update ops.shopify_sync_config set enabled = true where id = 1;`
5. **Schedule the cron** (Supabase SQL editor; replace `<INTERNAL_PAY_SECRET>` with the
   value from Edge Function secrets — same one the qbo-reconcile cron uses):

   ```sql
   select cron.schedule('shopify-qbo-sync', '*/30 * * * *', $$
     select net.http_post(
       url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/shopify-qbo-sync',
       headers := jsonb_build_object('Content-Type','application/json',
                                     'x-internal-secret','<INTERNAL_PAY_SECRET>'),
       body := '{}'::jsonb, timeout_milliseconds := 240000);
   $$);
   ```

6. **Watch the first run:** `select * from ops.shopify_sync_config;` and
   `select * from ops.shopify_sync_orders order by updated_at desc limit 20;`
   The health check `shopify_qbo_sync` goes red on errors or a stalled run.
7. **One-time inventory true-up:** physical count of canned product, then a QBO
   inventory adjustment dated at cutover — the historical never-decremented gap
   (~$97K retail of DTC sales since May 2024) has to be squared once by hand.

## Config / maintenance

- `ops.shopify_item_map` — SKU → QBO item. Add a row when a new Shopify product
  launches (unmapped SKUs alert via health check; they book to the generic item so
  revenue is never lost, only inventory detail).
  Known intentionally unmapped: `peach-tea-bib`, `dragon-fruit-bib` (no confident QBO item).
- `ops.shopify_sync_config` — enable flag, watermark, all QBO account/item ids.
- Env overrides: `QBO_SHOPIFY_BANK_ACCOUNT_ID` (default 72), `QBO_REALM`.
- Uses the shared `ops.qbo_token_cache` access token (refreshed hourly by sync-qbo's
  cron); if expired mid-window, the run fails soft and the next run recovers.
