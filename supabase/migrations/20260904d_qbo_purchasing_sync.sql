-- Purchasing: QuickBooks and Refractor share ONE purchase-order table, both
-- directions, and receiving here creates the QuickBooks bill.
--
-- ASK (Sky, 2026-09-04): keep doing main purchasing in QuickBooks, see those
-- POs here, edit them here and push back ("a two way street"), and when the
-- warehouse receives a PO here the bill is created in QuickBooks so Brixpense
-- can match it to the vendor's invoice. Plus a Sync now button beside the cron.
--
-- WHAT WAS THERE: two tables. ops.purchase_orders held Refractor-native POs
-- (pushed to QuickBooks once, never read back — qbo_push_error was written by
-- nothing, the SyncToken never stored). ops.qbo_purchase_orders held a hand-
-- imported SHADOW of QuickBooks POs (one row, imported 2026-05-16, read by the
-- On Order maths and nothing else). Receiving wrote the ledger and stopped;
-- the vendor bill was keyed separately, and the purchase side of the stock
-- ledger had no feed at all — every QuickBooks receipt since the 09-03 seed
-- would have shown as drift until somebody pressed Reconcile.
--
-- THIS MIGRATION:
--   1. purchase_orders gains the QuickBooks half: origin (brix|qbo),
--      qbo_sync_token, qbo_synced_at, qbo_status, qbo_doc_number, qbo_dirty
--      (edited here, not yet pushed) and the raw MetaData time. Lines gain
--      qbo_line_id, which is what a bill's LinkedTxn points at.
--   2. ops.fn_qbo_po_mirror_upsert(jsonb) — a QuickBooks PurchaseOrder JSON
--      in, one purchase_orders row out. Native rows are matched by their QBO
--      id and REFRESHED (status, token, lines); QuickBooks-created POs land as
--      origin='qbo' with po_number = the QuickBooks DocNumber. A row that is
--      qbo_dirty (a local edit waiting to push) is left alone and reported as
--      a conflict — the push carries a SyncToken, so QuickBooks decides.
--   3. ops.po_receipts — one row per receiving event: the lines, who, when,
--      the vendor invoice number if known, and the QuickBooks Bill it became
--      (or the error). fn_po_receipt_record posts the ledger FIRST (through
--      the existing fn_receive_purchase_order_line__i, so nothing about how
--      stock lands changes) and returns what the bill must carry;
--      fn_po_receipt_bill_landed then files the Brixpense row as POSTED with
--      the bill id, so it shows on Brixpense's Posted tab awaiting the vendor's
--      invoice. A receipt whose bill failed is visible and retryable, never
--      lost — the ledger already moved.
--   4. The PURCHASE FEED, mirror of the sales feed: qbo_expense_lines gains
--      linked_po_qbo_id / linked_po_line_id; ops.v_purchase_ledger_pending
--      lists Bill / VendorCredit item lines on location-tracked items since
--      apply_from that no receipt of OURS created; fn_apply_purchases_to_ledger
--      posts receipts (new), differences (edited), reversals (deleted), and
--      bumps qty_received on the PO line a bill links to, so a PO received in
--      QuickBooks reads received here. fn_purchase_ledger_run logs every run.
--      ⚠ LIVE from the start, apply_from 2026-09-03: the ledger was set equal
--      to QuickBooks on 09-03 and no inventory bill has posted since (checked),
--      so there is nothing a first live run could double-count.
--   5. ops.fn_po_update — edit header + lines locally (native or mirrored);
--      marks qbo_dirty when the PO exists in QuickBooks so the push runs.
--   6. Health: fn_purchasing_sync_health (the 15-min pull went quiet or
--      errored) and fn_purchase_feed_health, both wired by read-modify-write
--      on the LIVE fn_sync_health_extra. v_inventory_ledger_status gains
--      qbo_as_of so the drift strip can say how old its QuickBooks number is.
--   7. pg_cron 'qbo-purchasing-sync' :10/:25/:40/:55 → the Netlify function
--      (same cron-secret pattern as sf-expense-ocr). Sync now is the same
--      function under a staff bearer.
--
-- ⚠ Guard rule (20260820b): every new RPC is SECURITY DEFINER with the staff-
-- or-service guard INLINE; EXECUTE revoked from public/anon. The receive RPCs
-- run under the caller's JWT so created_by / submitted_by are the real person.
-- fn_receive_purchase_order_line__i is called by its INNER name from inside a
-- guarded function — the wrapper is never CREATE OR REPLACEd here.

-- 1 ── purchase_orders: the QuickBooks half ------------------------------------
alter table ops.purchase_orders
  add column if not exists origin           text not null default 'brix',
  add column if not exists qbo_sync_token   text,
  add column if not exists qbo_synced_at    timestamptz,
  add column if not exists qbo_status       text,
  add column if not exists qbo_doc_number   text,
  add column if not exists qbo_txn_date     date,
  add column if not exists qbo_updated_at   timestamptz,
  add column if not exists qbo_dirty        boolean not null default false,
  add column if not exists qbo_skipped_lines jsonb;

alter table ops.purchase_orders drop constraint if exists purchase_orders_origin_check;
alter table ops.purchase_orders add constraint purchase_orders_origin_check check (origin in ('brix', 'qbo'));

create unique index if not exists purchase_orders_qbo_id_unique
  on ops.purchase_orders (qbo_purchase_order_id) where qbo_purchase_order_id is not null;

alter table ops.purchase_order_lines
  add column if not exists qbo_line_id text;
create index if not exists purchase_order_lines_qbo_line_idx on ops.purchase_order_lines (qbo_line_id) where qbo_line_id is not null;

comment on column ops.purchase_orders.origin is 'brix = created in Refractor; qbo = created in QuickBooks and mirrored here. Both push and pull the same way once linked.';
comment on column ops.purchase_orders.qbo_dirty is 'Edited here since the last push. The 15-min pull skips a dirty row (a local edit must not be overwritten by a stale pull); the push clears it or reports a SyncToken conflict.';

-- 2 ── the bill-line link the purchase feed reads --------------------------------
alter table ops.qbo_expense_lines
  add column if not exists linked_po_qbo_id text,
  add column if not exists linked_po_line_id text;
create index if not exists idx_qel_linked_po on ops.qbo_expense_lines (linked_po_qbo_id) where linked_po_qbo_id is not null;

-- 3 ── receipts ------------------------------------------------------------------
create table if not exists ops.po_receipts (
  id                    uuid primary key default gen_random_uuid(),
  po_id                 uuid not null references ops.purchase_orders(id) on delete restrict,
  received_at           timestamptz not null default now(),
  received_by           uuid references auth.users(id),
  received_by_email     text,
  vendor_invoice_number text,
  invoice_date          date,
  notes                 text,
  lines                 jsonb not null,            -- [{po_line_id, qbo_line_id, qbo_item_id, item_name, qty, unit_cost, amount}]
  total_amount          numeric(12,2) not null default 0,
  completes_po          boolean not null default false,
  qbo_bill_id           text,
  qbo_bill_doc_number   text,
  qbo_pushed_at         timestamptz,
  qbo_error             text,
  qbo_attempts          int not null default 0,
  expense_request_id    uuid references ops.expense_requests(id) on delete set null,
  created_at            timestamptz not null default now()
);
create index if not exists po_receipts_po_idx on ops.po_receipts (po_id);
create unique index if not exists po_receipts_bill_unique on ops.po_receipts (qbo_bill_id) where qbo_bill_id is not null;

alter table ops.po_receipts enable row level security;
drop policy if exists po_receipts_staff on ops.po_receipts;
create policy po_receipts_staff on ops.po_receipts for select to authenticated using (ops.fn_is_staff());
grant select on ops.po_receipts to authenticated;
grant all on ops.po_receipts to service_role;

-- 4 ── purchase feed tables -----------------------------------------------------
create table if not exists ops.purchase_ledger_config (
  only_row   boolean primary key default true check (only_row),
  mode       text not null default 'live' check (mode in ('off', 'shadow', 'live')),
  apply_from date not null default '2026-09-03',
  updated_at timestamptz not null default now()
);
insert into ops.purchase_ledger_config (only_row, mode, apply_from) values (true, 'live', '2026-09-03')
on conflict (only_row) do nothing;

create table if not exists ops.purchase_ledger_applied (
  expense_line_id bigint primary key,   -- ops.qbo_expense_lines.id; deliberately NO FK: a deleted bill's mirror rows
                                       -- vanish and the void loop needs this row to survive them
  qbo_txn_type    text not null,
  qbo_txn_id      text not null,
  qbo_item_id     text not null,
  location_id     uuid not null references ops.inventory_locations(id),
  qty_applied     numeric not null,
  movement_id     uuid references ops.inventory_movements(id),
  po_line_id      uuid references ops.purchase_order_lines(id) on delete set null,
  reversed_at     timestamptz,
  applied_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists purchase_ledger_applied_txn_idx on ops.purchase_ledger_applied (qbo_txn_type, qbo_txn_id);

alter table ops.purchase_ledger_config enable row level security;
alter table ops.purchase_ledger_applied enable row level security;
drop policy if exists purchase_ledger_config_staff on ops.purchase_ledger_config;
create policy purchase_ledger_config_staff on ops.purchase_ledger_config for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());
drop policy if exists purchase_ledger_applied_staff on ops.purchase_ledger_applied;
create policy purchase_ledger_applied_staff on ops.purchase_ledger_applied for select to authenticated using (ops.fn_is_staff());
grant select, update on ops.purchase_ledger_config to authenticated;
grant select on ops.purchase_ledger_applied to authenticated;
grant all on ops.purchase_ledger_config, ops.purchase_ledger_applied to service_role;

-- A bill line's receiving location: the item's default receiving location,
-- else the Brix warehouse. QuickBooks does not know where a case landed.
create or replace function ops.fn_purchase_ledger_location(p_qbo_item_id text)
returns uuid
language sql stable security definer
set search_path to 'ops', 'pg_temp'
as $$
  select coalesce(
    (select s.default_receiving_location_id from ops.inventory_settings s
       join ops.inventory_locations l on l.id = s.default_receiving_location_id
      where s.qbo_item_id = p_qbo_item_id and l.is_active and l.kind = 'warehouse'),
    (select l.id from ops.inventory_locations l
      where l.kind = 'warehouse' and l.is_active
      order by (l.code = 'BRIX-WAREHOUSE') desc, l.name limit 1));
$$;
revoke all on function ops.fn_purchase_ledger_location(text) from public, anon;
grant execute on function ops.fn_purchase_ledger_location(text) to authenticated, service_role;

-- What the feed owes the ledger: every Bill / VendorCredit item line on a
-- location-tracked item since apply_from that no receipt of OURS created
-- (po_receipts.qbo_bill_id), less what has already been applied.
create or replace view ops.v_purchase_ledger_pending
with (security_invoker = true) as
select
  e.id                                   as expense_line_id,
  e.qbo_txn_type,
  e.qbo_txn_id,
  e.txn_date,
  e.vendor_name,
  e.item_ref_id                          as qbo_item_id,
  coalesce(i.name, e.item_name)          as item_name,
  ops.fn_purchase_ledger_location(e.item_ref_id) as location_id,
  case when e.qbo_txn_type = 'VendorCredit' then -1 else 1 end * coalesce(e.quantity, 0) as qty_in,
  ap.qty_applied,
  (case when e.qbo_txn_type = 'VendorCredit' then -1 else 1 end * coalesce(e.quantity, 0)) - coalesce(ap.qty_applied, 0) as qty_delta,
  e.linked_po_qbo_id,
  e.linked_po_line_id,
  pl.id                                  as po_line_id
from ops.qbo_expense_lines e
join ops.inventory_settings s on s.qbo_item_id = e.item_ref_id and s.track_locations
left join ops.qbo_items i on i.qbo_item_id = e.item_ref_id
left join ops.purchase_ledger_applied ap on ap.expense_line_id = e.id
left join ops.purchase_order_lines pl on pl.qbo_line_id = e.linked_po_line_id
  and pl.po_id = (select p.id from ops.purchase_orders p where p.qbo_purchase_order_id = e.linked_po_qbo_id)
cross join ops.purchase_ledger_config c
where e.detail_type = 'ItemBasedExpenseLineDetail'
  and e.item_ref_id is not null
  and e.qbo_txn_type in ('Bill', 'VendorCredit')
  and e.txn_date >= c.apply_from
  and not exists (select 1 from ops.po_receipts r where r.qbo_bill_id = e.qbo_txn_id and e.qbo_txn_type = 'Bill');
grant select on ops.v_purchase_ledger_pending to authenticated, service_role;

create or replace function ops.fn_apply_purchases_to_ledger(p_commit boolean default false)
returns table(action text, expense_line_id bigint, txn_id text, item_name text, qty numeric, location_code text)
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
#variable_conflict use_column
declare
  v_mode text;
  v_live boolean;
  r record;
  v_mv uuid;
  v_remaining numeric;
begin
  select mode into v_mode from ops.purchase_ledger_config;
  v_live := p_commit and v_mode = 'live';
  if v_mode = 'off' then return; end if;

  for r in
    select p.*, il.code as loc_code
      from ops.v_purchase_ledger_pending p
      join ops.inventory_locations il on il.id = p.location_id
     where p.qty_delta <> 0
     order by p.txn_date, p.expense_line_id
  loop
    if v_live then
      -- a positive delta is stock arriving; a negative one (credit, or an
      -- edit that lowered the quantity) is stock leaving
      insert into ops.inventory_movements (
        movement_type, qbo_item_id, qty, from_location_id, to_location_id,
        source_doc_type, occurred_at, notes)
      values (
        case when r.qty_delta > 0 then 'receipt' else 'shipment' end,
        r.qbo_item_id, abs(r.qty_delta),
        case when r.qty_delta > 0 then null else r.location_id end,
        case when r.qty_delta > 0 then r.location_id else null end,
        'qbo_purchase', r.txn_date,
        r.qbo_txn_type || ' ' || r.qbo_txn_id || ' - ' || coalesce(r.vendor_name, 'vendor')
          || case when r.qty_applied is not null then ' - adjusted from ' || r.qty_applied else '' end)
      returning id into v_mv;

      insert into ops.purchase_ledger_applied (expense_line_id, qbo_txn_type, qbo_txn_id, qbo_item_id, location_id, qty_applied, movement_id, po_line_id)
      values (r.expense_line_id, r.qbo_txn_type, r.qbo_txn_id, r.qbo_item_id, r.location_id, r.qty_in, v_mv, r.po_line_id)
      on conflict (expense_line_id) do update
        set qty_applied = excluded.qty_applied, movement_id = excluded.movement_id,
            location_id = excluded.location_id, reversed_at = null, updated_at = now();

      -- A bill received in QuickBooks against a PO we hold: mark the PO line
      -- received here too, capped at what was ordered.
      if r.po_line_id is not null and r.qty_delta > 0 then
        select greatest(qty_ordered - qty_received, 0) into v_remaining from ops.purchase_order_lines where id = r.po_line_id;
        if coalesce(v_remaining, 0) > 0 then
          update ops.purchase_order_lines set qty_received = qty_received + least(v_remaining, r.qty_delta) where id = r.po_line_id;
          perform ops.fn_po_recompute_status((select po_id from ops.purchase_order_lines where id = r.po_line_id));
        end if;
      end if;
    end if;

    action := case when r.qty_applied is null then 'new' else 'edited' end;
    expense_line_id := r.expense_line_id; txn_id := r.qbo_txn_type || ' ' || r.qbo_txn_id;
    item_name := r.item_name; qty := r.qty_delta; location_code := r.loc_code;
    return next;
  end loop;

  -- A bill line that vanished from the mirror (the bill was deleted in
  -- QuickBooks) is reversed, and its applied row stamped rather than deleted.
  for r in
    select ap.*, il.code as loc_code
      from ops.purchase_ledger_applied ap
      join ops.inventory_locations il on il.id = ap.location_id
     where ap.reversed_at is null
       and not exists (select 1 from ops.qbo_expense_lines e where e.id = ap.expense_line_id)
  loop
    if v_live then
      insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, source_doc_type, occurred_at, notes)
      values (case when r.qty_applied > 0 then 'shipment' else 'receipt' end, r.qbo_item_id, abs(r.qty_applied),
              case when r.qty_applied > 0 then r.location_id else null end,
              case when r.qty_applied > 0 then null else r.location_id end,
              'qbo_purchase_void', now(), 'Purchase reversed - the bill line is no longer in QuickBooks');
      update ops.purchase_ledger_applied set reversed_at = now(), updated_at = now() where expense_line_id = r.expense_line_id;
    end if;
    action := 'voided'; expense_line_id := r.expense_line_id; txn_id := r.qbo_txn_type || ' ' || r.qbo_txn_id;
    item_name := r.qbo_item_id; qty := -r.qty_applied; location_code := r.loc_code;
    return next;
  end loop;
end;
$$;
revoke all on function ops.fn_apply_purchases_to_ledger(boolean) from public, anon, authenticated;
grant execute on function ops.fn_apply_purchases_to_ledger(boolean) to service_role;

create or replace function ops.fn_purchase_ledger_run()
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_mode text; v_started timestamptz := clock_timestamp();
  v_new int := 0; v_edited int := 0; v_voided int := 0; v_units numeric := 0; v_pending int := 0;
  v_result jsonb; v_err text;
begin
  perform ops.fn_assert_staff_or_service();
  select mode into v_mode from ops.purchase_ledger_config;
  if v_mode = 'off' then
    v_result := jsonb_build_object('mode', v_mode, 'written', false, 'new', 0, 'edited', 0, 'voided', 0, 'units', 0, 'note', 'feed is off');
  else
    begin
      select count(*) filter (where action = 'new'), count(*) filter (where action = 'edited'),
             count(*) filter (where action = 'voided'), coalesce(sum(qty), 0)
        into v_new, v_edited, v_voided, v_units
        from ops.fn_apply_purchases_to_ledger(true);
      select count(*) into v_pending from ops.v_purchase_ledger_pending where qty_delta <> 0;
      v_result := jsonb_build_object('mode', v_mode, 'written', v_mode = 'live', 'new', v_new, 'edited', v_edited,
                                     'voided', v_voided, 'units', v_units, 'pending_after', v_pending);
    exception when others then
      v_err := left(sqlerrm, 500);
      v_result := jsonb_build_object('mode', v_mode, 'written', false, 'error', v_err);
    end;
  end if;
  insert into ops.sync_log (source, sync_type, status, started_at, completed_at, records_synced, error_message, metadata)
  values ('inventory', 'purchase_feed', case when v_err is null then 'success' else 'error' end, v_started, clock_timestamp(),
          case when v_mode = 'live' then v_new + v_edited + v_voided else 0 end, v_err, v_result);
  return v_result;
end;
$$;
revoke all on function ops.fn_purchase_ledger_run() from public, anon;
grant execute on function ops.fn_purchase_ledger_run() to authenticated, service_role;

-- 5 ── the mirror upsert: a QuickBooks PurchaseOrder in, one of OUR rows out ------
create or replace function ops.fn_qbo_po_mirror_upsert(p_po jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_qbo_id text := p_po ->> 'Id';
  v_deleted boolean := coalesce((p_po ->> 'status') = 'Deleted', (p_po ->> 'Deleted')::boolean, false);
  v_row ops.purchase_orders%rowtype;
  v_vendor text := p_po -> 'VendorRef' ->> 'value';
  v_doc text := nullif(btrim(p_po ->> 'DocNumber'), '');
  v_status text := coalesce(p_po ->> 'POStatus', 'Open');
  v_loc uuid;
  v_line jsonb; v_item text; v_qty numeric; v_cost numeric; v_line_id text; v_sort int := 100;
  v_seen text[] := '{}';
  v_skipped jsonb := '[]';
  v_subtotal numeric := 0;
  v_existing uuid;
  v_recv numeric;
  v_action text;
  v_new_status text;
  v_po_number text;
  v_item_type text;
begin
  perform ops.fn_assert_staff_or_service();
  if v_qbo_id is null then raise exception 'PurchaseOrder has no Id'; end if;

  select * into v_row from ops.purchase_orders where qbo_purchase_order_id = v_qbo_id for update;

  -- deleted in QuickBooks: void here unless stock was already received against it
  if v_deleted then
    if v_row.id is null then return jsonb_build_object('qbo_id', v_qbo_id, 'action', 'ignored_deleted'); end if;
    if exists (select 1 from ops.purchase_order_lines l where l.po_id = v_row.id and l.qty_received > 0) then
      update ops.purchase_orders set qbo_status = 'Deleted', qbo_synced_at = now(),
             notes = coalesce(notes, '') || case when coalesce(notes, '') like '%deleted in QuickBooks%' then '' else E'\n⚠ deleted in QuickBooks after stock was received here' end
       where id = v_row.id;
      return jsonb_build_object('qbo_id', v_qbo_id, 'po_id', v_row.id, 'action', 'deleted_after_receipt');
    end if;
    update ops.purchase_orders set status = 'void', voided_at = coalesce(voided_at, now()), void_reason = coalesce(void_reason, 'deleted in QuickBooks'),
           qbo_status = 'Deleted', qbo_synced_at = now(), qbo_dirty = false where id = v_row.id;
    return jsonb_build_object('qbo_id', v_qbo_id, 'po_id', v_row.id, 'action', 'voided');
  end if;

  -- a local edit is waiting to push: QuickBooks decides at push time, not here
  if v_row.id is not null and v_row.qbo_dirty then
    update ops.purchase_orders set qbo_synced_at = now() where id = v_row.id;
    return jsonb_build_object('qbo_id', v_qbo_id, 'po_id', v_row.id, 'action', 'skipped_dirty',
                              'remote_sync_token', p_po ->> 'SyncToken', 'local_sync_token', v_row.qbo_sync_token);
  end if;

  if v_vendor is null or not exists (select 1 from ops.qbo_vendors where qbo_vendor_id = v_vendor) then
    raise exception 'vendor % is not in the QuickBooks vendor mirror (run Sync vendors)', coalesce(v_vendor, '?');
  end if;

  if v_row.id is null then
    select id into v_loc from ops.inventory_locations where kind = 'warehouse' and is_active order by (code = 'BRIX-WAREHOUSE') desc, name limit 1;
    -- the QuickBooks number is the PO number when it is free; otherwise QBO-<id>
    v_po_number := coalesce(v_doc, 'QBO-' || v_qbo_id);
    if exists (select 1 from ops.purchase_orders where po_number = v_po_number) then v_po_number := 'QBO-' || v_qbo_id; end if;
    insert into ops.purchase_orders (po_number, qbo_vendor_id, destination_location_id, status, expected_date, notes,
                                     ordered_at, origin, qbo_purchase_order_id, po_kind)
    values (v_po_number, v_vendor, v_loc, 'open', nullif(p_po ->> 'DueDate', '')::date,
            nullif(p_po ->> 'PrivateNote', ''), coalesce(nullif(p_po ->> 'TxnDate', '')::timestamptz, now()),
            'qbo', v_qbo_id, 'other')
    returning * into v_row;
    v_action := 'created';
  else
    v_action := 'refreshed';
    -- vendor and dates follow QuickBooks; notes only when we have none
    update ops.purchase_orders
       set qbo_vendor_id = v_vendor,
           expected_date = coalesce(nullif(p_po ->> 'DueDate', '')::date, expected_date),
           notes = coalesce(notes, nullif(p_po ->> 'PrivateNote', ''))
     where id = v_row.id;
  end if;

  -- lines: match by QuickBooks line Id, then by item for lines we pushed
  -- before qbo_line_id existed
  for v_line in select * from jsonb_array_elements(coalesce(p_po -> 'Line', '[]'::jsonb)) loop
    if (v_line ->> 'DetailType') <> 'ItemBasedExpenseLineDetail' then
      v_skipped := v_skipped || jsonb_build_object('line', v_line ->> 'Id', 'detail_type', v_line ->> 'DetailType',
                                                    'description', v_line ->> 'Description', 'amount', v_line ->> 'Amount');
      continue;
    end if;
    v_item := v_line -> 'ItemBasedExpenseLineDetail' -> 'ItemRef' ->> 'value';
    v_qty := coalesce((v_line -> 'ItemBasedExpenseLineDetail' ->> 'Qty')::numeric, 0);
    v_cost := coalesce((v_line -> 'ItemBasedExpenseLineDetail' ->> 'UnitPrice')::numeric,
                       case when v_qty > 0 then (v_line ->> 'Amount')::numeric / v_qty else 0 end, 0);
    v_line_id := v_line ->> 'Id';
    if v_item is null or v_qty <= 0 then
      v_skipped := v_skipped || jsonb_build_object('line', v_line_id, 'reason', 'no item or zero quantity');
      continue;
    end if;
    select type into v_item_type from ops.qbo_items where qbo_item_id = v_item;
    if v_item_type is null then
      raise exception 'item % on PO % is not in the QuickBooks item mirror yet', v_item, coalesce(v_doc, v_qbo_id);
    end if;

    select id into v_existing from ops.purchase_order_lines where po_id = v_row.id and qbo_line_id = v_line_id;
    if v_existing is null then
      select id into v_existing from ops.purchase_order_lines
       where po_id = v_row.id and qbo_line_id is null and qbo_item_id = v_item order by sort_order limit 1;
    end if;

    if v_existing is null then
      insert into ops.purchase_order_lines (po_id, qbo_item_id, description, qty_ordered, unit_cost, sort_order, receivable, qbo_line_id)
      values (v_row.id, v_item, nullif(v_line ->> 'Description', ''), v_qty, greatest(v_cost, 0), v_sort,
              v_item_type <> 'Service', v_line_id)
      returning id into v_existing;
    else
      select qty_received into v_recv from ops.purchase_order_lines where id = v_existing;
      update ops.purchase_order_lines
         set qbo_item_id = v_item, description = coalesce(nullif(v_line ->> 'Description', ''), description),
             qty_ordered = greatest(v_qty, coalesce(v_recv, 0)),   -- never below what already arrived
             unit_cost = greatest(v_cost, 0), qbo_line_id = v_line_id, sort_order = v_sort
       where id = v_existing;
    end if;
    v_seen := v_seen || v_existing::text;
    v_subtotal := v_subtotal + v_qty * v_cost;
    v_sort := v_sort + 10;
  end loop;

  -- lines QuickBooks no longer has: drop them unless stock arrived on them
  delete from ops.purchase_order_lines l
   where l.po_id = v_row.id and l.qty_received = 0 and not (l.id::text = any (v_seen));

  -- status: QuickBooks says Open or Closed; receipts here refine Open into partial/received
  v_new_status := case
    when v_status = 'Closed' then 'closed'
    when v_row.status in ('void') then 'void'
    else 'open' end;
  if v_new_status = 'open' and exists (select 1 from ops.purchase_order_lines where po_id = v_row.id and qty_received > 0) then
    v_new_status := case when exists (select 1 from ops.purchase_order_lines where po_id = v_row.id and receivable and qty_received < qty_ordered)
                         then 'partial' else 'received' end;
  end if;

  update ops.purchase_orders
     set status = v_new_status,
         closed_at = case when v_new_status = 'closed' then coalesce(closed_at, now()) else closed_at end,
         closed_reason = case when v_new_status = 'closed' then coalesce(closed_reason, 'closed in QuickBooks') else closed_reason end,
         subtotal = round(v_subtotal, 2),
         qbo_sync_token = p_po ->> 'SyncToken',
         qbo_status = v_status,
         qbo_doc_number = v_doc,
         qbo_txn_date = nullif(p_po ->> 'TxnDate', '')::date,
         qbo_updated_at = nullif(p_po -> 'MetaData' ->> 'LastUpdatedTime', '')::timestamptz,
         qbo_synced_at = now(),
         qbo_pushed_at = coalesce(qbo_pushed_at, now()),
         qbo_push_error = null,
         qbo_skipped_lines = case when jsonb_array_length(v_skipped) > 0 then v_skipped else null end,
         updated_at = now()
   where id = v_row.id;

  return jsonb_build_object('qbo_id', v_qbo_id, 'po_id', v_row.id, 'po_number', v_row.po_number, 'action', v_action,
                            'status', v_new_status, 'lines', coalesce(array_length(v_seen, 1), 0), 'skipped_lines', jsonb_array_length(v_skipped));
end;
$$;
revoke all on function ops.fn_qbo_po_mirror_upsert(jsonb) from public, anon, authenticated;
grant execute on function ops.fn_qbo_po_mirror_upsert(jsonb) to service_role;

-- Stamp the QuickBooks identity onto a native PO after a push (called with the
-- created/updated PurchaseOrder JSON so line Ids land too).
create or replace function ops.fn_po_mark_pushed(p_po_id uuid, p_po jsonb)
returns void
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare v_line jsonb; v_item text; v_id text; v_qty numeric;
begin
  perform ops.fn_assert_staff_or_service();
  update ops.purchase_orders
     set qbo_purchase_order_id = p_po ->> 'Id', qbo_sync_token = p_po ->> 'SyncToken', qbo_status = p_po ->> 'POStatus',
         qbo_doc_number = nullif(p_po ->> 'DocNumber', ''), qbo_txn_date = nullif(p_po ->> 'TxnDate', '')::date,
         qbo_updated_at = nullif(p_po -> 'MetaData' ->> 'LastUpdatedTime', '')::timestamptz,
         qbo_pushed_at = now(), qbo_synced_at = now(), qbo_push_error = null, qbo_dirty = false, updated_at = now()
   where id = p_po_id;
  -- line ids: match by item + qty among lines without one, in order
  for v_line in select * from jsonb_array_elements(coalesce(p_po -> 'Line', '[]'::jsonb)) loop
    if (v_line ->> 'DetailType') <> 'ItemBasedExpenseLineDetail' then continue; end if;
    v_item := v_line -> 'ItemBasedExpenseLineDetail' -> 'ItemRef' ->> 'value';
    v_qty := (v_line -> 'ItemBasedExpenseLineDetail' ->> 'Qty')::numeric;
    v_id := v_line ->> 'Id';
    update ops.purchase_order_lines set qbo_line_id = v_id
     where id = (select id from ops.purchase_order_lines
                  where po_id = p_po_id and qbo_item_id = v_item and (qbo_line_id is null or qbo_line_id = v_id)
                  order by (qty_ordered = v_qty) desc, sort_order limit 1);
  end loop;
end;
$$;
revoke all on function ops.fn_po_mark_pushed(uuid, jsonb) from public, anon;
grant execute on function ops.fn_po_mark_pushed(uuid, jsonb) to authenticated, service_role;

create or replace function ops.fn_po_mark_push_error(p_po_id uuid, p_error text)
returns void
language sql security definer
set search_path to 'ops', 'pg_temp'
as $$
  select ops.fn_assert_staff_or_service();
  update ops.purchase_orders set qbo_push_error = left(p_error, 500), updated_at = now() where id = p_po_id;
$$;
revoke all on function ops.fn_po_mark_push_error(uuid, text) from public, anon;
grant execute on function ops.fn_po_mark_push_error(uuid, text) to authenticated, service_role;

-- 6 ── editing a PO here ----------------------------------------------------------
-- p_patch: {expected_date?, notes?}   p_lines: [{id?, qbo_item_id, description?, qty_ordered, unit_cost}]
-- A line omitted from p_lines is removed when nothing was received on it; a
-- line's qty_ordered can never fall below its qty_received.
create or replace function ops.fn_po_update(p_po_id uuid, p_patch jsonb default '{}'::jsonb, p_lines jsonb default null)
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_po ops.purchase_orders%rowtype; v_line jsonb; v_id uuid; v_recv numeric; v_qty numeric; v_cost numeric;
  v_seen uuid[] := '{}'; v_sort int := 100; v_subtotal numeric := 0; v_item_type text;
begin
  perform ops.fn_assert_staff_or_service();
  select * into v_po from ops.purchase_orders where id = p_po_id for update;
  if v_po.id is null then raise exception 'purchase order not found'; end if;
  if v_po.status not in ('draft', 'open', 'partial') then
    raise exception '% is %; only an open purchase order can be edited', v_po.po_number, v_po.status;
  end if;

  if p_patch ? 'expected_date' then
    update ops.purchase_orders set expected_date = nullif(p_patch ->> 'expected_date', '')::date where id = p_po_id;
  end if;
  if p_patch ? 'notes' then
    update ops.purchase_orders set notes = nullif(p_patch ->> 'notes', '') where id = p_po_id;
  end if;

  if p_lines is not null then
    if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
      raise exception 'a purchase order needs at least one line';
    end if;
    for v_line in select * from jsonb_array_elements(p_lines) loop
      v_qty := (v_line ->> 'qty_ordered')::numeric;
      v_cost := coalesce(nullif(v_line ->> 'unit_cost', '')::numeric, 0);
      if v_qty is null or v_qty <= 0 then raise exception 'qty_ordered must be > 0'; end if;
      if v_cost < 0 then raise exception 'unit_cost cannot be negative'; end if;
      v_id := nullif(v_line ->> 'id', '')::uuid;
      if v_id is not null then
        select qty_received into v_recv from ops.purchase_order_lines where id = v_id and po_id = p_po_id;
        if v_recv is null then raise exception 'line % does not belong to %', v_id, v_po.po_number; end if;
        if v_qty < v_recv then
          raise exception 'a line cannot be cut below what already arrived (% received)', v_recv;
        end if;
        update ops.purchase_order_lines
           set qty_ordered = v_qty, unit_cost = v_cost, description = nullif(v_line ->> 'description', ''),
               qbo_item_id = coalesce(nullif(v_line ->> 'qbo_item_id', ''), qbo_item_id), sort_order = v_sort
         where id = v_id;
      else
        if nullif(v_line ->> 'qbo_item_id', '') is null then raise exception 'every line requires qbo_item_id'; end if;
        select type into v_item_type from ops.qbo_items where qbo_item_id = v_line ->> 'qbo_item_id';
        if v_item_type is null then raise exception 'item % is not in the QuickBooks item mirror', v_line ->> 'qbo_item_id'; end if;
        insert into ops.purchase_order_lines (po_id, qbo_item_id, description, qty_ordered, unit_cost, sort_order, receivable)
        values (p_po_id, v_line ->> 'qbo_item_id', nullif(v_line ->> 'description', ''), v_qty, v_cost, v_sort, v_item_type <> 'Service')
        returning id into v_id;
      end if;
      v_seen := v_seen || v_id;
      v_subtotal := v_subtotal + v_qty * v_cost;
      v_sort := v_sort + 10;
    end loop;
    if exists (select 1 from ops.purchase_order_lines where po_id = p_po_id and qty_received > 0 and not (id = any (v_seen))) then
      raise exception 'a line with stock already received cannot be removed';
    end if;
    delete from ops.purchase_order_lines where po_id = p_po_id and not (id = any (v_seen));
    update ops.purchase_orders set subtotal = round(v_subtotal, 2) where id = p_po_id;
  end if;

  update ops.purchase_orders
     set qbo_dirty = (qbo_purchase_order_id is not null), updated_at = now()
   where id = p_po_id;
  perform ops.fn_po_recompute_status(p_po_id);

  insert into ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  values ('purchase_order', p_po_id, 'edit', 'Edited in Refractor', auth.uid());

  return jsonb_build_object('po_id', p_po_id, 'qbo_dirty', v_po.qbo_purchase_order_id is not null, 'lines', coalesce(array_length(v_seen, 1), 0));
end;
$$;
revoke all on function ops.fn_po_update(uuid, jsonb, jsonb) from public, anon;
grant execute on function ops.fn_po_update(uuid, jsonb, jsonb) to authenticated, service_role;

-- 7 ── receiving: the ledger first, then what the bill must say -------------------
-- p_lines: [{po_line_id, qty}]. Returns the receipt row plus the lines with
-- everything the QuickBooks Bill needs (item, qty, cost, PO line id).
create or replace function ops.fn_po_receipt_record(p_po_id uuid, p_lines jsonb, p_vendor_invoice_number text default null,
                                                    p_invoice_date date default null, p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_po ops.purchase_orders%rowtype; v jsonb; v_line_id uuid; v_qty numeric; v_l record;
  v_out jsonb := '[]'; v_total numeric := 0; v_receipt uuid; v_completes boolean;
  v_actor uuid := auth.uid(); v_email text := auth.jwt() ->> 'email';
begin
  perform ops.fn_assert_staff_or_service();
  if v_actor is null then raise exception 'a receipt is recorded by a signed-in user — no session on this call'; end if;
  select * into v_po from ops.purchase_orders where id = p_po_id for update;
  if v_po.id is null then raise exception 'purchase order not found'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'nothing to receive'; end if;

  for v in select * from jsonb_array_elements(p_lines) loop
    v_line_id := (v ->> 'po_line_id')::uuid;
    v_qty := (v ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select l.*, coalesce(qi.name, l.description, l.qbo_item_id) as item_name into v_l
      from ops.purchase_order_lines l left join ops.qbo_items qi on qi.qbo_item_id = l.qbo_item_id
     where l.id = v_line_id and l.po_id = p_po_id;
    if v_l.id is null then raise exception 'line % is not on %', v_line_id, v_po.po_number; end if;
    -- the ledger: the one place a receipt has always been written
    perform ops.fn_receive_purchase_order_line__i(v_line_id, v_qty, null, null);
    v_out := v_out || jsonb_build_object('po_line_id', v_line_id, 'qbo_line_id', v_l.qbo_line_id, 'qbo_item_id', v_l.qbo_item_id,
                                         'item_name', v_l.item_name, 'description', v_l.description, 'qty', v_qty,
                                         'unit_cost', v_l.unit_cost, 'amount', round(v_qty * v_l.unit_cost, 2));
    v_total := v_total + round(v_qty * v_l.unit_cost, 2);
  end loop;
  if jsonb_array_length(v_out) = 0 then raise exception 'nothing to receive — every quantity was zero'; end if;

  select not exists (select 1 from ops.purchase_order_lines where po_id = p_po_id and receivable and qty_received < qty_ordered)
    into v_completes;

  insert into ops.po_receipts (po_id, received_by, received_by_email, vendor_invoice_number, invoice_date, notes, lines, total_amount, completes_po)
  values (p_po_id, v_actor, v_email, nullif(btrim(p_vendor_invoice_number), ''), p_invoice_date, nullif(btrim(p_notes), ''), v_out, round(v_total, 2), v_completes)
  returning id into v_receipt;

  insert into ops.production_doc_events (doc_type, doc_id, event_type, payload, created_by)
  values ('purchase_order', p_po_id, 'receive', jsonb_build_object('receipt_id', v_receipt, 'lines', v_out), v_actor);

  return jsonb_build_object('receipt_id', v_receipt, 'po_id', p_po_id, 'po_number', v_po.po_number,
                            'qbo_purchase_order_id', v_po.qbo_purchase_order_id, 'qbo_vendor_id', v_po.qbo_vendor_id,
                            'production_run_id', v_po.production_run_id, 'work_order_id', v_po.work_order_id,
                            'lines', v_out, 'total', round(v_total, 2), 'completes_po', v_completes,
                            'status', (select status from ops.purchase_orders where id = p_po_id));
end;
$$;
revoke all on function ops.fn_po_receipt_record(uuid, jsonb, text, date, text) from public, anon;
grant execute on function ops.fn_po_receipt_record(uuid, jsonb, text, date, text) to authenticated, service_role;

-- The bill landed in QuickBooks: file it in Brixpense as POSTED (it is in the
-- books; the vendor's invoice is what is still to come) and stamp the receipt.
create or replace function ops.fn_po_receipt_bill_landed(p_receipt_id uuid, p_qbo_bill_id text, p_doc_number text default null)
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  r ops.po_receipts%rowtype; v_po ops.purchase_orders%rowtype; v_vendor text; v_er uuid; v_run text;
  v_lines jsonb; v_acct text; v_acct_name text; v_actor uuid := auth.uid(); v_email text := auth.jwt() ->> 'email';
begin
  perform ops.fn_assert_staff_or_service();
  select * into r from ops.po_receipts where id = p_receipt_id for update;
  if r.id is null then raise exception 'receipt not found'; end if;
  select * into v_po from ops.purchase_orders where id = r.po_id;
  select display_name into v_vendor from ops.qbo_vendors where qbo_vendor_id = v_po.qbo_vendor_id;
  select run_number into v_run from ops.production_runs where id = v_po.production_run_id;
  select clearing_account_ref_id, clearing_account_name into v_acct, v_acct_name from ops.production_settings where id;

  if r.expense_request_id is null then
    select jsonb_agg(jsonb_build_object('description', coalesce(l ->> 'description', l ->> 'item_name'), 'qty', (l ->> 'qty')::numeric,
                                        'unit_price', (l ->> 'unit_cost')::numeric, 'amount', (l ->> 'amount')::numeric, 'qbo_item_id', l ->> 'qbo_item_id'))
      into v_lines from jsonb_array_elements(r.lines) l;
    insert into ops.expense_requests (
      request_type, status, vendor_name, vendor_id, total_amount, receipt_date, tag, as_bill, auto_approved,
      memo, description, line_items, bill_number, entity, cogs_account_id, cogs_account_label,
      submitted_by, submitter_email, submitter_name, approved_at, approved_by, posted_at, qbo_bill_id)
    values (
      'expense', 'posted', coalesce(v_vendor, 'vendor ' || v_po.qbo_vendor_id), v_po.qbo_vendor_id, r.total_amount,
      coalesce(r.invoice_date, r.received_at::date),
      case when v_po.production_run_id is not null or v_po.work_order_id is not null then 'Production' else 'Purchasing' end,
      true, true,
      'Received against ' || v_po.po_number || coalesce(' · run ' || v_run, '') || ' in Refractor',
      case when r.vendor_invoice_number is null
           then v_po.po_number || ' received — awaiting the vendor invoice'
           else v_po.po_number || ' received · vendor invoice ' || r.vendor_invoice_number end,
      v_lines, left(r.vendor_invoice_number, 21), 'brix',
      case when v_po.production_run_id is not null then v_acct end, case when v_po.production_run_id is not null then v_acct_name end,
      coalesce(v_actor, r.received_by), coalesce(v_email, r.received_by_email), coalesce(v_email, r.received_by_email, 'Refractor'),
      now(), 'system (received in Refractor)', now(), p_qbo_bill_id)
    returning id into v_er;

    if v_po.production_run_id is not null then
      insert into ops.production_run_bills (run_id, po_id, kind, expense_request_id, qbo_vendor_id, vendor_invoice_number, invoice_date, amount_gross, amount_net, created_by)
      values (v_po.production_run_id, r.po_id, 'po', v_er, v_po.qbo_vendor_id, r.vendor_invoice_number, coalesce(r.invoice_date, r.received_at::date), r.total_amount, r.total_amount, coalesce(v_actor, r.received_by));
    end if;
  else
    v_er := r.expense_request_id;
    update ops.expense_requests set qbo_bill_id = p_qbo_bill_id, status = 'posted', posted_at = coalesce(posted_at, now()) where id = v_er;
  end if;

  update ops.po_receipts
     set qbo_bill_id = p_qbo_bill_id, qbo_bill_doc_number = p_doc_number, qbo_pushed_at = now(), qbo_error = null,
         qbo_attempts = qbo_attempts + 1, expense_request_id = v_er
   where id = p_receipt_id;

  insert into ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  values ('purchase_order', r.po_id, 'bill', 'QuickBooks bill ' || p_qbo_bill_id || ' created from receipt · ' || r.total_amount, v_actor);

  return jsonb_build_object('receipt_id', p_receipt_id, 'expense_request_id', v_er, 'qbo_bill_id', p_qbo_bill_id);
end;
$$;
revoke all on function ops.fn_po_receipt_bill_landed(uuid, text, text) from public, anon;
grant execute on function ops.fn_po_receipt_bill_landed(uuid, text, text) to authenticated, service_role;

create or replace function ops.fn_po_receipt_bill_failed(p_receipt_id uuid, p_error text)
returns void
language sql security definer
set search_path to 'ops', 'pg_temp'
as $$
  select ops.fn_assert_staff_or_service();
  update ops.po_receipts set qbo_error = left(p_error, 500), qbo_attempts = qbo_attempts + 1 where id = p_receipt_id;
$$;
revoke all on function ops.fn_po_receipt_bill_failed(uuid, text) from public, anon;
grant execute on function ops.fn_po_receipt_bill_failed(uuid, text) to authenticated, service_role;

-- fn_po_create_bill (the Production "bill once closed" path) must not double a
-- PO that receiving already billed.
create or replace function ops.fn_po_create_bill(p_po_id uuid, p_vendor_invoice_number text, p_invoice_date date default current_date, p_total_override numeric default null)
returns jsonb
language plpgsql security definer
set search_path to 'ops', 'pg_temp'
as $$
DECLARE po ops.purchase_orders%ROWTYPE; v_lines jsonb; v_total numeric; v_er uuid; v_bill uuid; v_run text; v_actor uuid := auth.uid();
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO po FROM ops.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF po.id IS NULL THEN RAISE EXCEPTION 'purchase order not found'; END IF;
  IF po.status <> 'closed' THEN RAISE EXCEPTION '% is %; a bill is created once the purchase order is closed', po.po_number, po.status; END IF;
  IF EXISTS (SELECT 1 FROM ops.po_receipts r WHERE r.po_id = p_po_id AND r.qbo_bill_id IS NOT NULL) THEN
    RAISE EXCEPTION '% was billed when it was received — the bill is already in QuickBooks and Brixpense', po.po_number;
  END IF;
  IF EXISTS (SELECT 1 FROM ops.production_run_bills b JOIN ops.expense_requests er ON er.id = b.expense_request_id WHERE b.po_id = p_po_id AND er.archived_at IS NULL) THEN
    RAISE EXCEPTION '% already has a bill — archive it in Brixpense before creating another', po.po_number;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'description', COALESCE(l.description, qi.name, l.qbo_item_id), 'qty', l.qty_ordered, 'unit_price', l.unit_cost,
           'amount', round(l.qty_ordered * l.unit_cost, 2), 'qbo_item_id', l.qbo_item_id) ORDER BY l.sort_order), '[]'::jsonb),
         COALESCE(sum(round(l.qty_ordered * l.unit_cost, 2)), 0)
    INTO v_lines, v_total
    FROM ops.purchase_order_lines l LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.qbo_item_id WHERE l.po_id = p_po_id;
  IF p_total_override IS NOT NULL AND round(p_total_override, 2) <> round(v_total, 2) THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('description', 'Invoice variance vs PO ' || po.po_number, 'qty', 1, 'unit_price', round(p_total_override - v_total, 2), 'amount', round(p_total_override - v_total, 2)));
    v_total := p_total_override;
  END IF;
  SELECT run_number INTO v_run FROM ops.production_runs WHERE id = po.production_run_id;
  v_er := ops.fn_production_bill_request__i(po.qbo_vendor_id, v_total, p_vendor_invoice_number, p_invoice_date,
    'Vendor bill for ' || po.po_number || COALESCE(' · run ' || v_run, ''),
    'Purchase order ' || po.po_number || COALESCE(' · ' || v_run, '') || CASE WHEN p_vendor_invoice_number IS NOT NULL THEN ' · vendor invoice ' || p_vendor_invoice_number ELSE '' END,
    v_lines);
  INSERT INTO ops.production_run_bills (run_id, po_id, kind, expense_request_id, qbo_vendor_id, vendor_invoice_number, invoice_date, amount_gross, amount_net, created_by)
  VALUES (po.production_run_id, p_po_id, 'po', v_er, po.qbo_vendor_id, p_vendor_invoice_number, p_invoice_date, round(v_total, 2), round(v_total, 2), v_actor)
  RETURNING id INTO v_bill;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('purchase_order', p_po_id, 'bill', 'Bill created in Brixpense · ' || round(v_total, 2) || COALESCE(' · invoice ' || p_vendor_invoice_number, ''), v_actor);
  RETURN jsonb_build_object('bill_id', v_bill, 'expense_request_id', v_er, 'total', round(v_total, 2), 'lines', jsonb_array_length(v_lines));
END $$;

-- 8 ── views ----------------------------------------------------------------------
-- Columns are APPENDED (create or replace view cannot insert mid-list, 42P16).
create or replace view ops.v_purchase_orders as
 SELECT o.id, o.po_number, o.qbo_vendor_id, v.display_name AS vendor_name, o.destination_location_id,
    (loc.code || ' · '::text) || loc.name AS location_label, o.status, o.expected_date, o.subtotal, o.notes,
    o.qbo_purchase_order_id, o.qbo_pushed_at, o.qbo_push_error, o.ordered_at, o.received_at, o.closed_at, o.voided_at, o.void_reason,
    o.work_order_id, wo.batch_code AS work_order_batch_code,
    COALESCE(l.line_count, 0) AS line_count, COALESCE(l.qty_ordered_total, 0::numeric) AS qty_ordered_total,
    COALESCE(l.qty_received_total, 0::numeric) AS qty_received_total, o.created_at, o.updated_at,
    ops.fn_status_bucket('purchase_order'::text, o.status) AS bucket, o.po_kind, o.reopened_at, o.reopen_reason, o.close_rule, o.closed_reason,
    COALESCE(l.receivable_line_count, 0) AS receivable_line_count, o.production_run_id, r.run_number,
    COALESCE(wob.batch_codes, wo.batch_code) AS work_order_batch_codes, COALESCE(l.qty_surplus_total, 0::numeric) AS qty_surplus_total,
    o.origin, o.qbo_status, o.qbo_doc_number, o.qbo_sync_token, o.qbo_synced_at, o.qbo_dirty, o.qbo_skipped_lines,
    COALESCE(rc.receipt_count, 0) AS receipt_count, rc.last_receipt_at, rc.bills_pending
   FROM ops.purchase_orders o
     LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = o.qbo_vendor_id
     LEFT JOIN ops.inventory_locations loc ON loc.id = o.destination_location_id
     LEFT JOIN ops.work_orders wo ON wo.id = o.work_order_id
     LEFT JOIN ops.production_runs r ON r.id = o.production_run_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS line_count, count(*) FILTER (WHERE pl.receivable)::integer AS receivable_line_count,
            sum(pl.qty_ordered) AS qty_ordered_total, sum(pl.qty_received) AS qty_received_total,
            sum(GREATEST(pl.qty_ordered - pl.demand_total, 0::numeric)) FILTER (WHERE pl.demand_total IS NOT NULL) AS qty_surplus_total
           FROM ops.purchase_order_lines pl WHERE pl.po_id = o.id) l ON true
     LEFT JOIN LATERAL ( SELECT string_agg(DISTINCT w.batch_code, ', '::text ORDER BY w.batch_code) AS batch_codes
           FROM ops.purchase_order_line_demand d JOIN ops.work_orders w ON w.id = d.wo_id WHERE d.po_id = o.id) wob ON true
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS receipt_count, max(pr.received_at) AS last_receipt_at,
            count(*) FILTER (WHERE pr.qbo_bill_id IS NULL)::integer AS bills_pending
           FROM ops.po_receipts pr WHERE pr.po_id = o.id) rc ON true;

create or replace view ops.v_inventory_ledger_status as
 SELECT ( SELECT count(*) FROM ops.inventory_movements) AS movement_count,
    ( SELECT max(occurred_at) FROM ops.inventory_movements) AS last_movement_at,
    ( SELECT count(*) FROM ops.v_inventory_drift WHERE track_locations AND drift <> 0::numeric) AS items_drifting,
    ( SELECT COALESCE(sum(abs(drift)), 0::numeric) FROM ops.v_inventory_drift WHERE track_locations) AS abs_drift,
    ( SELECT COALESCE(sum(v.on_hand), 0::numeric) FROM ops.v_inventory_on_hand v JOIN ops.inventory_locations l ON l.id = v.location_id
       WHERE l.kind = ANY (ARRAY['co_packer'::text, 'in_transit'::text])) AS qty_away_from_warehouse,
    ( SELECT COALESCE(sum(v.on_hand), 0::numeric) FROM ops.v_inventory_on_hand v JOIN ops.v_inventory_locations l ON l.id = v.location_id
       WHERE l.counts_as_our_stock AND l.kind <> 'warehouse'::text) AS qty_on_consignment,
    ( SELECT max(i.synced_at) FROM ops.qbo_items i JOIN ops.inventory_settings s ON s.qbo_item_id = i.qbo_item_id WHERE s.track_locations) AS qbo_as_of,
    ( SELECT max(s.completed_at) FROM ops.sync_log s WHERE s.source = 'qbo' AND s.sync_type = 'purchasing' AND s.status = 'success') AS purchasing_synced_at;

-- 9 ── health -----------------------------------------------------------------------
create or replace function ops.fn_purchasing_sync_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql security definer
set search_path to 'ops', 'public'
as $$
declare v_at timestamptz; v_status text; v_err text; v_meta jsonb;
begin
  select s.completed_at, s.status, s.error_message, s.metadata into v_at, v_status, v_err, v_meta
    from ops.sync_log s where s.source = 'qbo' and s.sync_type = 'purchasing'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'qbo_purchasing_sync'; last_event_at := v_at;
  age_seconds := coalesce(extract(epoch from (now() - v_at))::int, null);
  if v_at is null then
    status := 'green'; detail := 'QuickBooks purchasing sync has not logged yet (pg_cron qbo-purchasing-sync, every 15 min)';
  else
    status := case when v_status = 'error' then 'red' when v_at < now() - interval '60 minutes' then 'red' else 'green' end;
    detail := 'last pull ' || greatest(0, extract(epoch from (now()-v_at))::int/60) || 'm ago'
      || ' · ' || coalesce(v_meta->>'pos','0') || ' PO(s) / ' || coalesce(v_meta->>'bills','0') || ' bill(s) / ' || coalesce(v_meta->>'items','0') || ' item(s) changed'
      || case when coalesce((v_meta->>'conflicts')::int, 0) > 0 then ' · ' || (v_meta->>'conflicts') || ' PO(s) edited here and not yet pushed' else '' end
      || case when v_status = 'error' then ' [ERROR: ' || coalesce(left(v_err,140),'') || ']' else '' end;
  end if;
  return next;
end;
$$;
revoke all on function ops.fn_purchasing_sync_health() from public, anon, authenticated;

create or replace function ops.fn_purchase_feed_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql security definer
set search_path to 'ops', 'public'
as $$
declare v_mode text; v_at timestamptz; v_status text; v_err text; v_meta jsonb; v_pending int; v_units numeric; v_unbilled int;
begin
  select mode into v_mode from ops.purchase_ledger_config;
  select s.completed_at, s.status, s.error_message, s.metadata into v_at, v_status, v_err, v_meta
    from ops.sync_log s where s.source = 'inventory' and s.sync_type = 'purchase_feed'
    order by s.completed_at desc nulls last limit 1;
  select count(*), coalesce(sum(qty_delta), 0) into v_pending, v_units from ops.v_purchase_ledger_pending where qty_delta <> 0;
  select count(*) into v_unbilled from ops.po_receipts where qbo_bill_id is null and received_at < now() - interval '1 hour';
  check_name := 'purchase_feed'; last_event_at := v_at;
  age_seconds := coalesce(extract(epoch from (now() - v_at))::int, null);
  if v_mode = 'off' then
    status := 'green'; detail := 'purchase feed is OFF — QuickBooks bills do not reach the stock ledger';
  elsif v_at is null then
    status := case when v_unbilled > 0 then 'red' else 'green' end;
    detail := 'purchase feed runner has not logged yet' || case when v_unbilled > 0 then ' · ' || v_unbilled || ' receipt(s) with no QuickBooks bill after an hour' else '' end;
  else
    status := case when v_status = 'error' or v_unbilled > 0 then 'red'
                   when v_at < now() - interval '60 minutes' then (case when v_mode = 'live' then 'red' else 'yellow' end)
                   else 'green' end;
    detail := case when v_mode = 'live' then 'LIVE' else 'watching only (shadow)' end
      || ' · last run ' || greatest(0, extract(epoch from (now()-v_at))::int/60) || 'm ago'
      || ' · ' || coalesce(v_meta->>'new','0') || ' new / ' || coalesce(v_meta->>'edited','0') || ' edited / ' || coalesce(v_meta->>'voided','0') || ' voided line(s) last run'
      || case when v_pending > 0 then ' · ' || v_pending || ' line(s) pending' else '' end
      || case when v_unbilled > 0 then ' · ' || v_unbilled || ' receipt(s) whose QuickBooks bill FAILED — retry from the PO' else '' end
      || case when v_status = 'error' then ' [ERROR: ' || coalesce(left(v_err,140),'') || ']' else '' end;
  end if;
  return next;
end;
$$;
revoke all on function ops.fn_purchase_feed_health() from public, anon, authenticated;

do $$
declare
  v_def text;
  v_anchor text := '  -- Bills paid in QuickBooks outside Brixpense.';
  v_insert text := '  -- QuickBooks purchasing: the 15-min PO/bill/item pull and the purchase feed into the stock ledger.' || chr(10)
    || '  return query select * from ops.fn_purchasing_sync_health();' || chr(10)
    || '  return query select * from ops.fn_purchase_feed_health();' || chr(10) || chr(10);
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if v_def is null then raise exception 'ops.fn_sync_health_extra not found — wire the purchasing checks by hand'; end if;
  if position('fn_purchase_feed_health' in v_def) > 0 then raise notice 'purchasing checks already wired — skipping'; return; end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'anchor line not found in live fn_sync_health_extra — it changed shape; wire the purchasing checks by hand instead of guessing';
  end if;
  v_def := replace(v_def, v_anchor, v_insert || v_anchor);
  execute v_def;
end;
$$;

-- 10 ── the schedule ------------------------------------------------------------------
-- The Netlify function holds the QuickBooks token; pg_cron only knocks. Same
-- header + secret the other Netlify-hosted crons use (SF_AUTOPOST_CRON_SECRET).
-- :10/:25/:40/:55 — between the invoice CDC (:00) and the sales feed (:05) so
-- nothing shares a minute. The purchase feed runs inside the same call.
select cron.unschedule(jobid) from cron.job where jobname = 'qbo-purchasing-sync';
select cron.schedule(
  'qbo-purchasing-sync',
  '10,25,40,55 * * * *',
  $cron$
  select net.http_post(
    url := 'https://apbg-billing.netlify.app/api/qbo-purchasing-sync',
    headers := jsonb_build_object(
      'x-sf-autopost-secret', '1b50240878fe88f031165ed9c22c777628337f8c4a80e816',
      'Content-Type', 'application/json'
    ),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
