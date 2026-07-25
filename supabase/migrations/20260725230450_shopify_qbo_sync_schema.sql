-- shopify-qbo-sync: replaces the Intuit QBO Commerce "Shopify channel" app.
-- Order-level idempotent booking of Shopify orders into QBO with real SKU mapping.
-- (Applied live 2026-07-25 as 20260725230450; this file is the repo copy.)

create table if not exists ops.shopify_item_map (
  shopify_sku text primary key,
  qbo_item_id text not null,
  qbo_item_name text,
  notes text,
  updated_at timestamptz not null default now()
);
comment on table ops.shopify_item_map is 'Shopify variant SKU -> QBO item. Writer: shopify-qbo-sync edge function reads; humans maintain. Unmapped SKUs fall back to the generic Shopify Sales Item (697) and are flagged.';

create table if not exists ops.shopify_sync_orders (
  shopify_order_id text primary key,
  order_name text,
  created_at_shopify timestamptz,
  updated_at_shopify timestamptz,
  total numeric,
  financial_status text,
  status text not null default 'pending',      -- booked | skipped_unpaid | skipped_test | skipped_precutover | error
  qbo_salesreceipt_id text,
  qbo_doc_number text,
  had_unmapped_sku boolean not null default false,
  error text,
  booked_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table ops.shopify_sync_orders is 'Idempotency ledger: one row per Shopify order seen by shopify-qbo-sync. booked rows carry the QBO SalesReceipt id + doc number (SH-<order#>).';

create table if not exists ops.shopify_sync_refunds (
  shopify_refund_id text primary key,
  shopify_order_id text not null,
  order_name text,
  created_at_shopify timestamptz,
  amount numeric,
  status text not null default 'pending',
  qbo_refundreceipt_id text,
  qbo_doc_number text,
  error text,
  booked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists ops.shopify_sync_payouts (
  shopify_payout_id text primary key,
  issued_at timestamptz,
  net numeric,
  fee numeric,
  status text not null default 'pending',
  qbo_deposit_id text,
  error text,
  booked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists ops.shopify_sync_config (
  id int primary key check (id = 1),
  enabled boolean not null default false,
  backfill_start_at timestamptz,            -- orders created before this are never booked (old channel app owns them)
  orders_watermark timestamptz,             -- updated_at high-water mark
  shop_domain text not null default 'alameda-soda-co.myshopify.com',
  qbo_customer_id text not null default '1643',        -- "Shopify - alameda-soda-co Customer"
  qbo_clearing_account_id text not null default '316',
  qbo_fee_account_id text not null default '318',      -- Channel Selling Fees:Shopify Selling Fees
  qbo_item_fallback text not null default '697',       -- Shopify Sales Item (generic)
  qbo_item_shipping text not null default '699',
  qbo_item_tax text not null default '698',
  qbo_item_discount text not null default '695',
  qbo_item_crv text not null default '694',            -- CRV-24PK
  last_run_at timestamptz,
  last_result jsonb,
  updated_at timestamptz not null default now()
);

insert into ops.shopify_sync_config (id, enabled, backfill_start_at, orders_watermark)
values (1, false, '2026-07-16T19:15:00Z', '2026-07-16T19:15:00Z')
on conflict (id) do nothing;

alter table ops.shopify_item_map enable row level security;
alter table ops.shopify_sync_orders enable row level security;
alter table ops.shopify_sync_refunds enable row level security;
alter table ops.shopify_sync_payouts enable row level security;
alter table ops.shopify_sync_config enable row level security;

-- Seed the SKU map (verified against ops.qbo_items 2026-07-25; all targets active).
insert into ops.shopify_item_map (shopify_sku, qbo_item_id, qbo_item_name, notes) values
 ('24P126121','572','24P126121 HANGAR 25 COLA CASE',null),
 ('24P121091','570','24P121091 HANGAR 25 DIET COLA CASE',null),
 ('24P126151','574','24P126151 OAKTOWN ROOTBEER CASE',null),
 ('24P126481','575','24P126481 GOLDEN GATE ORANGE CASE',null),
 ('24P126141','573','24P126141 CABLE CAR LEMON LIME CASE',null),
 ('24P126471','576','24P126471 LOST ISLAND GINGER BEER CASE',null),
 ('24P126491','560','24P126491 OLDE FOUNTAIN CREME CASE',null),
 ('8PK6491','890','8PK6491 Olde Fountain Creme Soda 8-Pack (8 × 12 fl oz)',null),
 ('8PK6471','888','8PK6471 Lost Island Ginger Beer 8-Pack (8× 12 fl oz)',null),
 ('8PK6141','886','8PK6141 Cable Car Lemon Lime 8-Pack (8 × 12 fl oz)',null),
 ('8PK6481','889','8PK6481 Golden Gate Orange Soda 8-Pack (8 × 12 fl oz)','shopify sku has trailing space; sync trims'),
 ('8PK6151','887','8PK6151 Oaktown Root Beer 8-Pack (8 × 12 fl oz)',null),
 ('8PK1091','1061','8PK1091 Hangar 25 Diet Cola 8-Pack (8 × 12 Fl oz)',null),
 ('8PK6121','885','8PK1621 Hangar 25 Cola 8-Pack (8 × 12 fl oz)','Shopify sku 8PK6121 vs QBO code 8PK1621 (transposed) — verified same product'),
 ('8PKVAR1','891','8PKVAR1 Alameda Soda Variety  8-Pack (8 × 12 fl oz)',null),
 ('3G6121','222','3G6121 HANGAR 25 COLA',null),
 ('3G1091','205','3G1091 HANGAR 25 DIET COLA',null),
 ('3G6151','225','3G6151 OAKTOWN ROOT BEER',null),
 ('3G3041','218','3G3041 APT TEA',null),
 ('3G6511','230','3G6511 GRAND LAKE GRAPEFRUIT',null),
 ('3G6471','226','3G6471 LOST ISLAND GINGER BEER',null),
 ('3G6141','224','3G6141 CABLE CAR LEMON LIME',null),
 ('3G6481','227','3G6481 GOLDEN GATE ORANGE',null),
 ('3G6491','228','3G6491 OLDE FOUNTAIN CREME',null),
 ('3G6131','223','3G6131 APT GINGER ALE',null),
 ('3G1911','207','3G1911 DOCTEUR POIVRE',null),
 ('3G6501','229','3G6501 DIABLO BLACK CHERRY',null),
 ('3G2051','209','3G2051 APT CRANBERRY',null),
 ('3G2121','214','3G2121 APT ORANGE JUICE',null),
 ('3G2491','217','3G2491 APT MEYER LEMONADE',null),
 ('3G2011','208','3G2011 APT APPLE',null),
 ('3G2161','216','3G2161 APT SWEET & SOUR',null),
 ('3G1141','206','3G1141 APT TONIC',null),
 ('3G2151','215','3G2151 APT PINEAPPLE',null),
 ('3G5011','221','3G5011 APT ENERGY',null),
 ('QCD001','550','QCD Connector',null),
 ('fountain-flavor-stickers-1','549','Fountain Flavor Stickers',null),
 ('fountain-flavor-stickers-2','549','Fountain Flavor Stickers',null),
 ('fountain-flavor-stickers-3','549','Fountain Flavor Stickers',null)
on conflict (shopify_sku) do nothing;
-- deliberately unmapped (fall back to generic + flag): peach-tea-bib, dragon-fruit-bib

-- Health check registration (required for any new credential/pipeline per repo policy).
create or replace function ops.fn_sync_health_extra()
 returns table(check_name text, status text, last_event_at timestamp with time zone, age_seconds integer, detail text)
 language plpgsql
 security definer
 set search_path to 'ops', 'orders', 'public'
as $function$
declare
  v_resq ops.resq_sf_token_cache%rowtype;
  v_cookie_at timestamptz;
  v_fb_at timestamptz;
  v_fb_err text;
  v_shop ops.shopify_sync_config%rowtype;
  v_err_ct int;
  v_unmapped_ct int;
begin
  select * into v_resq from ops.resq_sf_token_cache t order by t.updated_at desc nulls last limit 1;
  check_name := 'resq_sf_token';
  if v_resq.id is null or coalesce(v_resq.refresh_token,'') = '' then
    last_event_at := null; age_seconds := null; status := 'red';
    detail := 'no ResQ SF token cached — re-auth via sf-connect (?start=1&secret=…)';
  else
    last_event_at := v_resq.updated_at;
    age_seconds := coalesce(extract(epoch from (now() - v_resq.updated_at))::int, null);
    status := case
      when v_resq.refresh_token_expires_at is not null and v_resq.refresh_token_expires_at < now() then 'red'
      when v_resq.last_error is not null and v_resq.updated_at > now() - interval '2 hours' then 'red'
      when v_resq.updated_at < now() - interval '72 hours' then 'yellow'
      else 'green' end;
    detail := 'ResQ SF token refresh #' || coalesce(v_resq.refresh_count::text,'?') ||
      case when v_resq.last_error is not null then ' [last_error: ' || left(v_resq.last_error,140) || ']' else '' end;
  end if;
  return next;

  select s.updated_at into v_cookie_at from orders.sf_portal_session s where s.id = 1;
  check_name := 'sf_portal_cookie';
  last_event_at := v_cookie_at;
  age_seconds := coalesce(extract(epoch from (now() - v_cookie_at))::int, null);
  status := case
    when v_cookie_at is null then 'red'
    when v_cookie_at < now() - interval '30 days' then 'red'
    when v_cookie_at < now() - interval '14 days' then 'yellow'
    else 'green' end;
  detail := case when v_cookie_at is null then 'no SF admin-portal session cookie — receipt images cannot attach'
    else 'SF admin-portal cookie last refreshed ' || greatest(0, extract(epoch from (now()-v_cookie_at))::int/86400) || 'd ago (Make hook refreshes on demand)' end;
  return next;

  -- qbo_netlify_chain — billing site's own QBO token (Netlify Blobs).
  select s.completed_at, s.error_message into v_fb_at, v_fb_err
    from ops.sync_log s
    where s.source = 'qbo' and s.sync_type = 'netlify_token_fallback'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'qbo_netlify_chain';
  last_event_at := v_fb_at;
  age_seconds := coalesce(extract(epoch from (now() - v_fb_at))::int, null);
  status := case
    when v_fb_at is not null and v_fb_at > now() - interval '24 hours' then 'red'
    else 'green' end;
  detail := case
    when v_fb_at is not null and v_fb_at > now() - interval '24 hours'
      then 'Billing QBO chain BROKEN — riding shared edge token. Re-auth via Master Control → Connections. [' || coalesce(left(v_fb_err,140),'') || ']'
    when v_fb_at is not null
      then 'own chain healthy (last fallback signal ' || greatest(0, extract(epoch from (now()-v_fb_at))::int/86400) || 'd ago)'
    else 'own chain healthy (no fallback signals on record)' end;
  return next;

  -- shopify_qbo_sync — DTC order booking (replaces Intuit's Shopify channel app).
  select * into v_shop from ops.shopify_sync_config c where c.id = 1;
  select count(*) into v_err_ct from ops.shopify_sync_orders o
    where o.status = 'error' and o.updated_at > now() - interval '24 hours';
  select count(*) into v_unmapped_ct from ops.shopify_sync_orders o
    where o.had_unmapped_sku and o.updated_at > now() - interval '7 days';
  check_name := 'shopify_qbo_sync';
  last_event_at := v_shop.last_run_at;
  age_seconds := coalesce(extract(epoch from (now() - v_shop.last_run_at))::int, null);
  if v_shop.id is null or not v_shop.enabled then
    status := 'green';
    detail := 'shopify-qbo-sync not yet enabled (awaiting Shopify custom-app token + channel-app disconnect)';
  else
    status := case
      when v_err_ct > 0 then 'red'
      when v_shop.last_run_at is null or v_shop.last_run_at < now() - interval '2 hours' then 'red'
      when v_unmapped_ct > 0 then 'yellow'
      else 'green' end;
    detail := 'orders sync: ' || coalesce((v_shop.last_result->>'summary'), 'no result yet')
      || case when v_err_ct > 0 then ' [' || v_err_ct || ' order(s) in error — see ops.shopify_sync_orders]' else '' end
      || case when v_unmapped_ct > 0 then ' [' || v_unmapped_ct || ' order(s) with unmapped SKUs — add to ops.shopify_item_map]' else '' end;
  end if;
  return next;
end;
$function$;
