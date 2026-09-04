-- Repack: cases of cans become 8-packs, and the ledger AND QuickBooks move
-- together, off one signed sheet.
--
-- WHAT THIS IS FOR (2026-09-04, Sky): "we take cases of cans, and we turn them
-- into 8 packs … this is how many cases of these flavors we used to make 8 packs
-- from 24 packs. so please adjust this 24P item by this much and adjust the
-- 8 pack item this much. a name of who did it, a signature, and autodate."
--
-- WHAT WAS THERE BEFORE: two repacks keyed into QuickBooks by hand as
-- InventoryAdjustments — ref 500 (2026-08-24, account 1150040010 "Ecommerce
-- Repackaging", 14 lines) and ref 503 (2026-08-26, account 353 "Inventory
-- Shrinkage", memo "need 8pk conversion numbers from Kyle"). Nothing in the
-- stock ledger knew about either, so the 24P items read high and the 8PK items
-- were not tracked at all. Two different accounts in two weeks is also how the
-- account ends up being whichever one the bookkeeper remembered.
--
-- THE MODEL:
--   * ops.repack_pairs  — which case item feeds which 8-pack item. The tool can
--     only ever adjust items on this list (a random SKU cannot be moved through
--     a repack sheet). Variety (891) is produce-only: it has no single case.
--   * ops.repack_orders — the signed sheet: who, when, cans in / cans out, the
--     signature PNG, and the QuickBooks adjustment it became (or the error).
--   * ops.repack_order_lines — one row per item, consume (cases) or produce
--     (packs), each pointing at the ledger movement it posted.
--   * ops.repack_settings — the QBO adjustment account (353 per Sky, one edit to
--     change) and the one location repacking happens at (Brix Warehouse only).
--
-- LEDGER: movements are ordinary 'adjustment' rows through the Adjustment
-- Counter, exactly the shape fn_reconcile_inventory_to_qbo writes — so every
-- on-hand, drift and status view already understands them, and no CHECK
-- constraint or reader changes. source_doc_type='repack' is what says why.
--
-- ⚠ CANS IN vs CANS OUT IS SHOWN, NEVER ENFORCED. The 8/24 sheet in QuickBooks
-- did not balance (42 cases = 1,008 cans in; 82 packs = 656 cans out) — loose
-- singles, damage and tasting stock are real. A hard equality would refuse the
-- actual work; instead an unbalanced sheet must carry a note saying where the
-- cans went, and the gap is stored on the row for anyone auditing shrink.
--
-- ⚠ Guard rule (20260820b): the RPCs are SECURITY DEFINER with the staff guard
-- INLINE (new functions, not generator-wrapped — keep the PERFORM on any edit).
-- EXECUTE revoked from public/anon.

-- 1 ── settings + pairs ---------------------------------------------------------
create table if not exists ops.repack_settings (
  id                       int primary key default 1 check (id = 1),
  location_id              uuid not null references ops.inventory_locations(id),
  qbo_adjust_account_id    text not null default '353',
  qbo_adjust_account_name  text not null default 'Inventory Shrinkage',
  cans_per_case            int  not null default 24 check (cans_per_case > 0),
  cans_per_pack            int  not null default 8  check (cans_per_pack > 0),
  default_packs_per_case   int  not null default 3  check (default_packs_per_case > 0),
  updated_at               timestamptz not null default now()
);
insert into ops.repack_settings (id, location_id)
select 1, l.id from ops.inventory_locations l where l.code = 'BRIX-WAREHOUSE'
on conflict (id) do nothing;

create table if not exists ops.repack_pairs (
  pack_qbo_item_id  text primary key,
  case_qbo_item_id  text unique,          -- NULL = produce-only (variety)
  label             text not null,
  active            boolean not null default true,
  sort_order        int not null default 100
);
insert into ops.repack_pairs (pack_qbo_item_id, case_qbo_item_id, label, sort_order) values
  ('885',  '572', 'Hangar 25 Cola',           10),
  ('1061', '570', 'Hangar 25 Diet Cola',      20),
  ('886',  '573', 'Cable Car Lemon Lime',     30),
  ('887',  '574', 'Oaktown Root Beer',        40),
  ('888',  '576', 'Lost Island Ginger Beer',  50),
  ('889',  '575', 'Golden Gate Orange',       60),
  ('890',  '560', 'Olde Fountain Creme',      70),
  ('891',  null,  'Alameda Soda Variety',     80)
on conflict (pack_qbo_item_id) do nothing;

-- 2 ── the sheet --------------------------------------------------------------------
create sequence if not exists ops.repack_seq;

create table if not exists ops.repack_orders (
  id               uuid primary key default gen_random_uuid(),
  repack_number    text not null unique,
  location_id      uuid not null references ops.inventory_locations(id),
  repack_date      date not null default (now() at time zone 'America/Los_Angeles')::date,
  cans_in          numeric not null default 0,
  cans_out         numeric not null default 0,
  cans_unaccounted numeric not null default 0,   -- cans_in - cans_out; a loose-singles / damage figure
  variance_note    text,
  notes            text,
  signed_by_name   text not null,
  signed_by_email  text,
  signature_data   text check (signature_data is null or (signature_data like 'data:image/%' and length(signature_data) <= 400000)),
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  qbo_txn_id       text,
  qbo_doc_number   text,
  qbo_pushed_at    timestamptz,
  qbo_error        text,
  qbo_attempts     int not null default 0,
  voided_at        timestamptz,
  voided_by        uuid references auth.users(id),
  void_reason      text
);
create index if not exists repack_orders_created_idx on ops.repack_orders (created_at desc);
create index if not exists repack_orders_unpushed_idx on ops.repack_orders (created_at) where qbo_txn_id is null and voided_at is null;

create table if not exists ops.repack_order_lines (
  id            uuid primary key default gen_random_uuid(),
  repack_id     uuid not null references ops.repack_orders(id) on delete cascade,
  line_no       int not null,
  kind          text not null check (kind in ('consume','produce')),
  qbo_item_id   text not null,
  item_name     text,
  qty           numeric not null check (qty > 0),
  cans          numeric not null,
  movement_id   uuid references ops.inventory_movements(id),
  unique (repack_id, kind, qbo_item_id)
);

-- Grants next to the policies (20260825a: Postgres checks GRANTs before RLS).
-- Reads are staff-only; every write goes through the RPCs below or service_role.
grant select on ops.repack_settings, ops.repack_pairs, ops.repack_orders, ops.repack_order_lines to authenticated;
grant update on ops.repack_settings to authenticated;
grant all on ops.repack_settings, ops.repack_pairs, ops.repack_orders, ops.repack_order_lines to service_role;
grant usage, select on sequence ops.repack_seq to service_role;

alter table ops.repack_settings     enable row level security;
alter table ops.repack_pairs        enable row level security;
alter table ops.repack_orders       enable row level security;
alter table ops.repack_order_lines  enable row level security;
drop policy if exists repack_settings_staff on ops.repack_settings;
create policy repack_settings_staff on ops.repack_settings for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());
drop policy if exists repack_pairs_staff on ops.repack_pairs;
create policy repack_pairs_staff on ops.repack_pairs for select to authenticated using (ops.fn_is_staff());
drop policy if exists repack_orders_staff on ops.repack_orders;
create policy repack_orders_staff on ops.repack_orders for select to authenticated using (ops.fn_is_staff());
drop policy if exists repack_order_lines_staff on ops.repack_order_lines;
create policy repack_order_lines_staff on ops.repack_order_lines for select to authenticated using (ops.fn_is_staff());

-- 3 ── track the 8-packs ------------------------------------------------------------
-- The 24P cases were already location-tracked; the 8PK items were not, so a
-- repack would have deducted cases from the ledger and produced packs into
-- nothing. Tracking them means the sales feed deducts 8-pack sales from today
-- (zero 8PK invoice lines since apply_from, checked before applying).
insert into ops.inventory_settings (qbo_item_id, track_locations)
select p.pack_qbo_item_id, true from ops.repack_pairs p
on conflict (qbo_item_id) do update set track_locations = true, updated_at = now();

-- 4 ── create ------------------------------------------------------------------------
create or replace function ops.fn_repack_create(
  p_lines          jsonb,
  p_signed_by_name text,
  p_signature_data text default null,
  p_notes          text default null,
  p_variance_note  text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  s          ops.repack_settings%rowtype;
  v_adj      uuid;
  v_id       uuid := gen_random_uuid();
  v_num      text;
  v_line     jsonb;
  v_kind     text;
  v_item     text;
  v_qty      numeric;
  v_cans     numeric;
  v_in       numeric := 0;
  v_out      numeric := 0;
  v_n_in     int := 0;
  v_n_out    int := 0;
  v_no       int := 0;
  v_name     text;
  v_mv       uuid;
  v_onhand   numeric;
  v_warn     text[] := '{}';
  v_actor    uuid := auth.uid();
  v_email    text := coalesce(auth.jwt()->>'email', null);
begin
  perform ops.fn_assert_staff_or_service();

  select * into s from ops.repack_settings where id = 1;
  if s.id is null then raise exception 'repack settings row missing (ops.repack_settings id=1)'; end if;
  select id into v_adj from ops.inventory_locations where kind = 'adjustment' and is_active limit 1;
  if v_adj is null then raise exception 'no active adjustment location configured'; end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines are required';
  end if;
  if coalesce(trim(p_signed_by_name), '') = '' then
    raise exception 'signed_by_name is required — the sheet says who did the repack';
  end if;

  -- Pass 1: validate + total. Nothing is written until every line is good.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_kind := v_line->>'kind';
    v_item := v_line->>'qbo_item_id';
    v_qty  := (v_line->>'qty')::numeric;
    if v_kind not in ('consume','produce') then raise exception 'line kind must be consume or produce (got %)', v_kind; end if;
    if v_qty is null or v_qty <= 0 or v_qty <> trunc(v_qty) then
      raise exception 'quantity for item % must be a whole number above zero', v_item;
    end if;
    if v_kind = 'consume' then
      if not exists (select 1 from ops.repack_pairs p where p.case_qbo_item_id = v_item and p.active) then
        raise exception 'item % is not a repackable case (see ops.repack_pairs)', v_item;
      end if;
      v_in := v_in + v_qty * s.cans_per_case; v_n_in := v_n_in + 1;
    else
      if not exists (select 1 from ops.repack_pairs p where p.pack_qbo_item_id = v_item and p.active) then
        raise exception 'item % is not an 8-pack this tool produces (see ops.repack_pairs)', v_item;
      end if;
      v_out := v_out + v_qty * s.cans_per_pack; v_n_out := v_n_out + 1;
    end if;
  end loop;
  if v_n_in = 0 then raise exception 'at least one case must be consumed'; end if;
  if v_n_out = 0 then raise exception 'at least one 8-pack line must be produced'; end if;
  if v_in <> v_out and coalesce(trim(p_variance_note), '') = '' then
    raise exception 'cans in (%) and cans out (%) differ by % — say where the cans went (variance note)', v_in, v_out, v_in - v_out;
  end if;

  v_num := 'RP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('ops.repack_seq')::text, 5, '0');

  insert into ops.repack_orders (id, repack_number, location_id, cans_in, cans_out, cans_unaccounted,
                                 variance_note, notes, signed_by_name, signed_by_email, signature_data, created_by)
  values (v_id, v_num, s.location_id, v_in, v_out, v_in - v_out,
          nullif(trim(p_variance_note), ''), nullif(trim(p_notes), ''), trim(p_signed_by_name), v_email,
          nullif(p_signature_data, ''), v_actor);

  -- Pass 2: lines + movements. Cases leave the warehouse for the Adjustment
  -- Counter; packs arrive from it — the reconcile's own shape.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_no   := v_no + 1;
    v_kind := v_line->>'kind';
    v_item := v_line->>'qbo_item_id';
    v_qty  := (v_line->>'qty')::numeric;
    v_cans := v_qty * case when v_kind = 'consume' then s.cans_per_case else s.cans_per_pack end;
    select coalesce(name, fully_qualified_name) into v_name from ops.qbo_items where qbo_item_id = v_item;

    if v_kind = 'consume' then
      select coalesce(on_hand, 0) into v_onhand from ops.v_inventory_on_hand
       where qbo_item_id = v_item and location_id = s.location_id;
      if coalesce(v_onhand, 0) < v_qty then
        v_warn := v_warn || format('%s: ledger shows %s case(s) at the warehouse, sheet consumes %s', coalesce(v_name, v_item), coalesce(v_onhand,0), v_qty);
      end if;
    end if;

    insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id,
                                         source_doc_type, source_doc_id, occurred_at, created_by, notes)
    values ('adjustment', v_item, v_qty,
            case when v_kind = 'consume' then s.location_id else v_adj end,
            case when v_kind = 'consume' then v_adj else s.location_id end,
            'repack', v_id, now(), v_actor,
            v_num || ' - ' || case when v_kind = 'consume' then 'cases repacked into 8-packs' else '8-packs made from cases' end
              || ' - ' || trim(p_signed_by_name))
    returning id into v_mv;

    insert into ops.repack_order_lines (repack_id, line_no, kind, qbo_item_id, item_name, qty, cans, movement_id)
    values (v_id, v_no, v_kind, v_item, v_name, v_qty, v_cans, v_mv);
  end loop;

  return jsonb_build_object(
    'id', v_id, 'repack_number', v_num, 'cans_in', v_in, 'cans_out', v_out,
    'cans_unaccounted', v_in - v_out, 'lines', v_no, 'warnings', to_jsonb(v_warn),
    'qbo_adjust_account_id', s.qbo_adjust_account_id, 'qbo_adjust_account_name', s.qbo_adjust_account_name);
end;
$$;
revoke all on function ops.fn_repack_create(jsonb, text, text, text, text) from public, anon;
grant execute on function ops.fn_repack_create(jsonb, text, text, text, text) to authenticated, service_role;

-- 5 ── void --------------------------------------------------------------------------
-- Reverses every movement the sheet posted (one new movement each — history is
-- never edited) and stamps the row. The QuickBooks side is the caller's job
-- (repack.mjs deletes the InventoryAdjustment BEFORE calling this); a sheet
-- still carrying a live qbo_txn_id is refused so the two cannot drift apart.
create or replace function ops.fn_repack_void(p_id uuid, p_reason text, p_qbo_cleared boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  r      ops.repack_orders%rowtype;
  l      record;
  m      ops.inventory_movements%rowtype;
  v_n    int := 0;
begin
  perform ops.fn_assert_staff_or_service();
  select * into r from ops.repack_orders where id = p_id for update;
  if r.id is null then raise exception 'repack not found'; end if;
  if r.voided_at is not null then raise exception '% is already voided', r.repack_number; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required to void a repack'; end if;
  if r.qbo_txn_id is not null and not p_qbo_cleared then
    raise exception '% was posted to QuickBooks as adjustment % — delete that adjustment first (the Void button does this)', r.repack_number, r.qbo_txn_id;
  end if;

  for l in select * from ops.repack_order_lines where repack_id = p_id loop
    select * into m from ops.inventory_movements where id = l.movement_id;
    if m.id is not null then
      insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id,
                                           source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
      values ('adjustment', m.qbo_item_id, m.qty, m.to_location_id, m.from_location_id,
              'repack_void', p_id, l.id, now(), auth.uid(),
              'VOID ' || r.repack_number || ' - ' || trim(p_reason));
      v_n := v_n + 1;
    end if;
  end loop;

  update ops.repack_orders
     set voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason),
         qbo_txn_id = case when p_qbo_cleared then null else qbo_txn_id end,
         qbo_error = case when p_qbo_cleared then null else qbo_error end
   where id = p_id;

  return jsonb_build_object('id', p_id, 'repack_number', r.repack_number, 'movements_reversed', v_n);
end;
$$;
revoke all on function ops.fn_repack_void(uuid, text, boolean) from public, anon;
grant execute on function ops.fn_repack_void(uuid, text, boolean) to authenticated, service_role;

-- 6 ── the watcher --------------------------------------------------------------------
-- A repack whose QuickBooks push failed is a ledger that moved while the books
-- did not — the exact split this tool exists to prevent. Red after an hour
-- unpushed; yellow while a fresh push error is still within the retry window.
create or replace function ops.fn_repack_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql
security definer
set search_path to 'ops', 'public'
as $$
declare
  v_last     timestamptz;
  v_unpushed int;
  v_stale    int;
  v_month    int;
  v_err      text;
begin
  select max(created_at) into v_last from ops.repack_orders where voided_at is null;
  select count(*) filter (where qbo_txn_id is null),
         count(*) filter (where qbo_txn_id is null and created_at < now() - interval '60 minutes'),
         count(*) filter (where created_at >= date_trunc('month', now()))
    into v_unpushed, v_stale, v_month
    from ops.repack_orders where voided_at is null;
  select qbo_error into v_err from ops.repack_orders
   where voided_at is null and qbo_txn_id is null and qbo_error is not null
   order by created_at desc limit 1;

  check_name := 'repack_qbo_push';
  last_event_at := v_last;
  age_seconds := coalesce(extract(epoch from (now() - v_last))::int, null);
  if v_last is null then
    status := 'green'; detail := 'no repack sheets yet (alamedapointbg.com/repack)';
  elsif v_stale > 0 then
    status := 'red';
    detail := v_stale || ' repack sheet(s) moved the ledger but never reached QuickBooks (>1h) — retry from /repack'
      || case when v_err is not null then ' [' || left(v_err, 140) || ']' else '' end;
  elsif v_unpushed > 0 then
    status := 'yellow';
    detail := v_unpushed || ' repack sheet(s) still pushing to QuickBooks'
      || case when v_err is not null then ' [last error: ' || left(v_err, 140) || ']' else '' end;
  else
    status := 'green';
    detail := v_month || ' repack sheet(s) this month, all in QuickBooks';
  end if;
  return next;
end;
$$;
revoke all on function ops.fn_repack_health() from public, anon, authenticated;

do $$
declare
  v_def text;
  v_anchor text := '  -- Bills paid in QuickBooks outside Brixpense.';
  v_insert text := '  -- Repack sheets (cases -> 8-packs) that moved the ledger but not QuickBooks.' || chr(10)
    || '  return query select * from ops.fn_repack_health();' || chr(10) || chr(10);
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if v_def is null then raise exception 'ops.fn_sync_health_extra not found — wire fn_repack_health by hand'; end if;
  if position('fn_repack_health' in v_def) > 0 then raise notice 'fn_repack_health already wired — skipping'; return; end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'anchor line not found in live fn_sync_health_extra — it changed shape; wire fn_repack_health by hand instead of guessing';
  end if;
  v_def := replace(v_def, v_anchor, v_insert || v_anchor);
  execute v_def;
end;
$$;
