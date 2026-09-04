-- Repack: the VARIETY BIN. Variety 8-packs are built to a recipe, from cases
-- moved into a bin — not from whatever was left over.
--
-- Sky (2026-09-04), minutes after the exact-eights rule: "Variety packs consist
-- of 2 colas, and one of every flavor. so maybe there needs to be a variety
-- pack warehouse or something, where we move cases to build variety packs out
-- of. So when those get moved you move 24x of each into those. then each
-- variety pack made pulls one of each flavor and 2 cola out of the variety
-- bin / warehouse."
--
-- THE MODEL, three operations on one signed sheet:
--   repack   N cases of a flavour -> exactly 3N flavour 8-packs (derived, never typed)
--   to_bin   N whole cases of a flavour move Brix Warehouse -> VARIETY-BIN
--            (a ledger move only: still 24P cases, still ours, QuickBooks unchanged)
--   variety  M variety 8-packs are made; each pulls its RECIPE out of the bin
--            (ops.repack_variety_recipe: 2 x Cola + 1 x each of the six others = 8)
--
-- THE BIN COUNTS CANS, THE LEDGER COUNTS CASES. ops.repack_bin holds each
-- flavour's cans (24 x cases moved in - cans drawn). The ledger and QuickBooks
-- only ever see whole cases: a 24P case is posted OUT of the bin (and off
-- QuickBooks) the moment its 24th can has been drawn. So an opened case still
-- reads as a case in the bin until it is empty — which is what a person
-- counting the bin would say too. ⚠ Between the first and 24th can of an open
-- case, QuickBooks overstates that flavour by the cans already sitting inside
-- variety packs (at most 23 cans a flavour). Whole numbers everywhere are worth
-- that; fractional cases would drift on every sum.
--
-- A sheet that ONLY moved cases into the bin needs no QuickBooks adjustment
-- (nothing changed on the books) — qbo_required=false, and the health check
-- leaves it alone.

-- 1 ── the bin location + settings ---------------------------------------------------
insert into ops.inventory_locations (code, name, kind, entity, notes)
select 'VARIETY-BIN', 'Variety Pack Bin', 'warehouse', 'brix',
       'Cases of cans staged for variety 8-packs (repack sheet). Whole cases in; each variety pack draws its recipe. An opened case stays here until its last can is drawn. Inside Brix Warehouse.'
where not exists (select 1 from ops.inventory_locations where code = 'VARIETY-BIN');

alter table ops.repack_settings add column if not exists bin_location_id uuid references ops.inventory_locations(id);
update ops.repack_settings set bin_location_id = (select id from ops.inventory_locations where code = 'VARIETY-BIN') where id = 1 and bin_location_id is null;

-- 2 ── recipe + bin ----------------------------------------------------------------------
create table if not exists ops.repack_variety_recipe (
  pack_qbo_item_id  text not null references ops.repack_pairs(pack_qbo_item_id),
  case_qbo_item_id  text not null,
  cans              int  not null check (cans > 0),
  primary key (pack_qbo_item_id, case_qbo_item_id)
);
insert into ops.repack_variety_recipe (pack_qbo_item_id, case_qbo_item_id, cans) values
  ('891', '572', 2),   -- Hangar 25 Cola x2
  ('891', '570', 1),   -- Hangar 25 Diet Cola
  ('891', '573', 1),   -- Cable Car Lemon Lime
  ('891', '574', 1),   -- Oaktown Root Beer
  ('891', '576', 1),   -- Lost Island Ginger Beer
  ('891', '575', 1),   -- Golden Gate Orange
  ('891', '560', 1)    -- Olde Fountain Creme
on conflict do nothing;

create table if not exists ops.repack_bin (
  case_qbo_item_id  text primary key,
  cases_moved_in    numeric not null default 0 check (cases_moved_in >= 0),
  cans_drawn        numeric not null default 0 check (cans_drawn >= 0),
  updated_at        timestamptz not null default now()
);
insert into ops.repack_bin (case_qbo_item_id)
select case_qbo_item_id from ops.repack_pairs where case_qbo_item_id is not null
on conflict do nothing;

grant select on ops.repack_variety_recipe, ops.repack_bin to authenticated;
grant all on ops.repack_variety_recipe, ops.repack_bin to service_role;
alter table ops.repack_variety_recipe enable row level security;
alter table ops.repack_bin enable row level security;
drop policy if exists repack_variety_recipe_staff on ops.repack_variety_recipe;
create policy repack_variety_recipe_staff on ops.repack_variety_recipe for select to authenticated using (ops.fn_is_staff());
drop policy if exists repack_bin_staff on ops.repack_bin;
create policy repack_bin_staff on ops.repack_bin for select to authenticated using (ops.fn_is_staff());

-- 3 ── lines + orders grow ----------------------------------------------------------------
alter table ops.repack_order_lines drop constraint if exists repack_order_lines_kind_check;
alter table ops.repack_order_lines add constraint repack_order_lines_kind_check
  check (kind in ('consume','produce','to_bin','variety_draw','variety_produce'));
alter table ops.repack_order_lines add column if not exists unit text not null default 'case' check (unit in ('case','pack','can'));
alter table ops.repack_order_lines add column if not exists cases_posted numeric not null default 0;  -- variety_draw: whole cases that left the bin/QBO on this line
alter table ops.repack_orders add column if not exists qbo_required boolean not null default true;
alter table ops.repack_orders add column if not exists variety_packs numeric not null default 0;
alter table ops.repack_orders add column if not exists cases_to_bin numeric not null default 0;
-- cans_in = cans_out was the exact-eights rule for flavour packs; a bin move is
-- neither in nor out and a variety pack's cans came in on an earlier sheet, so
-- the balance check moves into the function, per operation.
alter table ops.repack_orders drop constraint if exists repack_orders_balanced;

-- 4 ── create --------------------------------------------------------------------------------
create or replace function ops.fn_repack_create(
  p_lines          jsonb,
  p_signed_by_name text,
  p_signature_data text default null,
  p_notes          text default null
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
  v_ppc      numeric;
  v_no       int := 0;
  v_name     text;
  v_pname    text;
  v_pack     text;
  v_mv       uuid;
  v_onhand   numeric;
  v_warn     text[] := '{}';
  v_actor    uuid := auth.uid();
  v_email    text := coalesce(auth.jwt()->>'email', null);
  v_cases_in numeric := 0;   -- flavour cases broken into flavour packs
  v_packs    numeric := 0;   -- flavour packs made
  v_bin_in   numeric := 0;   -- cases moved into the bin
  v_var      numeric := 0;   -- variety packs made
  v_qbo      boolean := false;
  rc         record;
  v_bin      ops.repack_bin%rowtype;
  v_need     numeric;
  v_have     numeric;
  v_prev     numeric;
  v_post     numeric;
  v_recipe_cans numeric;
begin
  perform ops.fn_assert_staff_or_service();

  select * into s from ops.repack_settings where id = 1;
  if s.id is null then raise exception 'repack settings row missing (ops.repack_settings id=1)'; end if;
  if s.bin_location_id is null then raise exception 'repack settings: no variety bin location (bin_location_id)'; end if;
  if s.cans_per_case % s.cans_per_pack <> 0 then
    raise exception 'repack settings: % cans a case does not divide into %-can packs', s.cans_per_case, s.cans_per_pack;
  end if;
  v_ppc := s.cans_per_case / s.cans_per_pack;
  select id into v_adj from ops.inventory_locations where kind = 'adjustment' and is_active limit 1;
  if v_adj is null then raise exception 'no active adjustment location configured'; end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines are required';
  end if;
  if coalesce(trim(p_signed_by_name), '') = '' then
    raise exception 'signed_by_name is required — the sheet says who did the repack';
  end if;

  -- Pass 1: validate everything before writing anything.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_kind := v_line->>'kind';
    v_item := v_line->>'qbo_item_id';
    v_qty  := (v_line->>'qty')::numeric;
    if v_kind not in ('repack','to_bin','variety') then raise exception 'line kind must be repack, to_bin or variety (got %)', v_kind; end if;
    if v_qty is null or v_qty <= 0 or v_qty <> trunc(v_qty) then
      raise exception 'quantity for item % must be a whole number above zero', v_item;
    end if;
    if v_kind in ('repack','to_bin') then
      if not exists (select 1 from ops.repack_pairs p where p.case_qbo_item_id = v_item and p.active) then
        raise exception 'item % is not a repackable case (see ops.repack_pairs)', v_item;
      end if;
      if v_kind = 'repack' then v_cases_in := v_cases_in + v_qty; v_packs := v_packs + v_qty * v_ppc; v_qbo := true;
      else v_bin_in := v_bin_in + v_qty; end if;
    else
      if not exists (select 1 from ops.repack_pairs p where p.pack_qbo_item_id = v_item and p.case_qbo_item_id is null and p.active) then
        raise exception 'item % is not a variety 8-pack (see ops.repack_pairs)', v_item;
      end if;
      select coalesce(sum(cans),0) into v_recipe_cans from ops.repack_variety_recipe where pack_qbo_item_id = v_item;
      if v_recipe_cans <> s.cans_per_pack then
        raise exception 'the variety recipe for % adds up to % cans, not % — fix ops.repack_variety_recipe first', v_item, v_recipe_cans, s.cans_per_pack;
      end if;
      v_var := v_var + v_qty; v_qbo := true;
    end if;
  end loop;
  if v_cases_in = 0 and v_bin_in = 0 and v_var = 0 then raise exception 'nothing on the sheet'; end if;

  -- Variety: the bin must hold every can the recipe needs, AFTER today's moves in.
  if v_var > 0 then
    for rc in
      select r.case_qbo_item_id, r.cans, p.label
        from ops.repack_variety_recipe r join ops.repack_pairs p on p.case_qbo_item_id = r.case_qbo_item_id
       where r.pack_qbo_item_id = (select pack_qbo_item_id from ops.repack_pairs where case_qbo_item_id is null and active limit 1)
    loop
      select * into v_bin from ops.repack_bin where case_qbo_item_id = rc.case_qbo_item_id;
      v_have := coalesce(v_bin.cases_moved_in, 0) * s.cans_per_case - coalesce(v_bin.cans_drawn, 0)
              + coalesce((select sum((l->>'qty')::numeric) from jsonb_array_elements(p_lines) l
                           where l->>'kind' = 'to_bin' and l->>'qbo_item_id' = rc.case_qbo_item_id), 0) * s.cans_per_case;
      v_need := rc.cans * v_var;
      if v_have < v_need then
        raise exception '% variety pack(s) need % can(s) of %; the bin has % — move % more case(s) of % into the bin first',
          v_var, v_need, rc.label, v_have, ceil((v_need - v_have) / s.cans_per_case)::int, rc.label;
      end if;
    end loop;
  end if;

  v_num := 'RP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('ops.repack_seq')::text, 5, '0');

  insert into ops.repack_orders (id, repack_number, location_id, cans_in, cans_out, cans_unaccounted,
                                 notes, signed_by_name, signed_by_email, signature_data, created_by,
                                 qbo_required, variety_packs, cases_to_bin)
  values (v_id, v_num, s.location_id, v_cases_in * s.cans_per_case, v_packs * s.cans_per_pack, 0,
          nullif(trim(p_notes), ''), trim(p_signed_by_name), v_email, nullif(p_signature_data, ''), v_actor,
          v_qbo, v_var, v_bin_in);

  -- Pass 2: write. Flavour repacks and bin moves first, then variety draws
  -- (so today's bin moves are in the bin before the variety packs pull from it).
  for v_line in select * from jsonb_array_elements(p_lines) where value->>'kind' in ('repack','to_bin') loop
    v_kind := v_line->>'kind'; v_item := v_line->>'qbo_item_id'; v_qty := (v_line->>'qty')::numeric;
    select coalesce(name, fully_qualified_name) into v_name from ops.qbo_items where qbo_item_id = v_item;
    select coalesce(on_hand, 0) into v_onhand from ops.v_inventory_on_hand where qbo_item_id = v_item and location_id = s.location_id;
    if coalesce(v_onhand, 0) < v_qty then
      v_warn := v_warn || format('%s: ledger shows %s case(s) at the warehouse, sheet uses %s', coalesce(v_name, v_item), coalesce(v_onhand,0), v_qty);
    end if;

    if v_kind = 'repack' then
      select p.pack_qbo_item_id into v_pack from ops.repack_pairs p where p.case_qbo_item_id = v_item;
      select coalesce(name, fully_qualified_name) into v_pname from ops.qbo_items where qbo_item_id = v_pack;
      insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, source_doc_type, source_doc_id, occurred_at, created_by, notes)
      values ('adjustment', v_item, v_qty, s.location_id, v_adj, 'repack', v_id, now(), v_actor,
              v_num || ' - cases repacked into 8-packs - ' || trim(p_signed_by_name)) returning id into v_mv;
      v_no := v_no + 1;
      insert into ops.repack_order_lines (repack_id, line_no, kind, qbo_item_id, item_name, qty, cans, unit, movement_id)
      values (v_id, v_no, 'consume', v_item, v_name, v_qty, v_qty * s.cans_per_case, 'case', v_mv);
      insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, source_doc_type, source_doc_id, occurred_at, created_by, notes)
      values ('adjustment', v_pack, v_qty * v_ppc, v_adj, s.location_id, 'repack', v_id, now(), v_actor,
              v_num || ' - 8-packs made from cases - ' || trim(p_signed_by_name)) returning id into v_mv;
      v_no := v_no + 1;
      insert into ops.repack_order_lines (repack_id, line_no, kind, qbo_item_id, item_name, qty, cans, unit, movement_id)
      values (v_id, v_no, 'produce', v_pack, v_pname, v_qty * v_ppc, v_qty * s.cans_per_case, 'pack', v_mv);
    else
      insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, source_doc_type, source_doc_id, occurred_at, created_by, notes)
      values ('adjustment', v_item, v_qty, s.location_id, s.bin_location_id, 'repack_bin', v_id, now(), v_actor,
              v_num || ' - cases staged in the variety bin - ' || trim(p_signed_by_name)) returning id into v_mv;
      v_no := v_no + 1;
      insert into ops.repack_order_lines (repack_id, line_no, kind, qbo_item_id, item_name, qty, cans, unit, movement_id)
      values (v_id, v_no, 'to_bin', v_item, v_name, v_qty, v_qty * s.cans_per_case, 'case', v_mv);
      insert into ops.repack_bin (case_qbo_item_id, cases_moved_in) values (v_item, v_qty)
      on conflict (case_qbo_item_id) do update set cases_moved_in = ops.repack_bin.cases_moved_in + v_qty, updated_at = now();
    end if;
  end loop;

  if v_var > 0 then
    select pack_qbo_item_id into v_pack from ops.repack_pairs where case_qbo_item_id is null and active limit 1;
    select coalesce(name, fully_qualified_name) into v_pname from ops.qbo_items where qbo_item_id = v_pack;
    for rc in
      select r.case_qbo_item_id, r.cans from ops.repack_variety_recipe r where r.pack_qbo_item_id = v_pack order by r.cans desc, r.case_qbo_item_id
    loop
      v_need := rc.cans * v_var;
      select * into v_bin from ops.repack_bin where case_qbo_item_id = rc.case_qbo_item_id for update;
      v_prev := floor(v_bin.cans_drawn / s.cans_per_case);
      v_post := floor((v_bin.cans_drawn + v_need) / s.cans_per_case) - v_prev;   -- whole cases emptied by this draw
      update ops.repack_bin set cans_drawn = cans_drawn + v_need, updated_at = now() where case_qbo_item_id = rc.case_qbo_item_id;
      select coalesce(name, fully_qualified_name) into v_name from ops.qbo_items where qbo_item_id = rc.case_qbo_item_id;
      v_mv := null;
      if v_post > 0 then
        insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, source_doc_type, source_doc_id, occurred_at, created_by, notes)
        values ('adjustment', rc.case_qbo_item_id, v_post, s.bin_location_id, v_adj, 'repack', v_id, now(), v_actor,
                v_num || ' - case(s) emptied into variety 8-packs - ' || trim(p_signed_by_name)) returning id into v_mv;
      end if;
      v_no := v_no + 1;
      insert into ops.repack_order_lines (repack_id, line_no, kind, qbo_item_id, item_name, qty, cans, unit, cases_posted, movement_id)
      values (v_id, v_no, 'variety_draw', rc.case_qbo_item_id, v_name, v_need, v_need, 'can', v_post, v_mv);
    end loop;
    insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id, source_doc_type, source_doc_id, occurred_at, created_by, notes)
    values ('adjustment', v_pack, v_var, v_adj, s.location_id, 'repack', v_id, now(), v_actor,
            v_num || ' - variety 8-packs made from the bin - ' || trim(p_signed_by_name)) returning id into v_mv;
    v_no := v_no + 1;
    insert into ops.repack_order_lines (repack_id, line_no, kind, qbo_item_id, item_name, qty, cans, unit, movement_id)
    values (v_id, v_no, 'variety_produce', v_pack, v_pname, v_var, v_var * s.cans_per_pack, 'pack', v_mv);
  end if;

  return jsonb_build_object(
    'id', v_id, 'repack_number', v_num,
    'cases_repacked', v_cases_in, 'flavour_packs', v_packs, 'cases_to_bin', v_bin_in, 'variety_packs', v_var,
    'qbo_required', v_qbo, 'lines', v_no, 'warnings', to_jsonb(v_warn),
    'qbo_adjust_account_id', s.qbo_adjust_account_id, 'qbo_adjust_account_name', s.qbo_adjust_account_name);
end;
$$;
revoke all on function ops.fn_repack_create(jsonb, text, text, text) from public, anon;
grant execute on function ops.fn_repack_create(jsonb, text, text, text) to authenticated, service_role;

-- 5 ── void: also unwind the bin counters --------------------------------------------------
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
  v_bin  ops.repack_bin%rowtype;
  s      ops.repack_settings%rowtype;
begin
  perform ops.fn_assert_staff_or_service();
  select * into s from ops.repack_settings where id = 1;
  select * into r from ops.repack_orders where id = p_id for update;
  if r.id is null then raise exception 'repack not found'; end if;
  if r.voided_at is not null then raise exception '% is already voided', r.repack_number; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required to void a repack'; end if;
  if r.qbo_txn_id is not null and not p_qbo_cleared then
    raise exception '% was posted to QuickBooks as adjustment % — delete that adjustment first (the Void button does this)', r.repack_number, r.qbo_txn_id;
  end if;

  -- The bin must still be able to give the cans back. A later sheet may have
  -- drawn the cases this one moved in; then this one cannot be undone.
  for l in select * from ops.repack_order_lines where repack_id = p_id and kind in ('to_bin','variety_draw') loop
    select * into v_bin from ops.repack_bin where case_qbo_item_id = l.qbo_item_id for update;
    if l.kind = 'to_bin' then
      if (v_bin.cases_moved_in - l.qty) * s.cans_per_case < v_bin.cans_drawn then
        raise exception 'cannot void %: a later sheet already drew cans from the % case(s) of % it moved into the bin', r.repack_number, l.qty, coalesce(l.item_name, l.qbo_item_id);
      end if;
      update ops.repack_bin set cases_moved_in = cases_moved_in - l.qty, updated_at = now() where case_qbo_item_id = l.qbo_item_id;
    else
      if v_bin.cans_drawn < l.qty then
        raise exception 'cannot void %: bin draw bookkeeping for % is out of step (drawn % < line %)', r.repack_number, coalesce(l.item_name, l.qbo_item_id), v_bin.cans_drawn, l.qty;
      end if;
      update ops.repack_bin set cans_drawn = cans_drawn - l.qty, updated_at = now() where case_qbo_item_id = l.qbo_item_id;
    end if;
  end loop;

  for l in select * from ops.repack_order_lines where repack_id = p_id and movement_id is not null loop
    select * into m from ops.inventory_movements where id = l.movement_id;
    if m.id is not null then
      insert into ops.inventory_movements (movement_type, qbo_item_id, qty, from_location_id, to_location_id,
                                           source_doc_type, source_doc_id, source_doc_line_id, occurred_at, created_by, notes)
      values ('adjustment', m.qbo_item_id, m.qty, m.to_location_id, m.from_location_id,
              'repack_void', p_id, l.id, now(), auth.uid(), 'VOID ' || r.repack_number || ' - ' || trim(p_reason));
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

-- 6 ── the bin, readable ------------------------------------------------------------------
create or replace view ops.v_repack_bin as
select p.label, p.case_qbo_item_id, p.pack_qbo_item_id,
       b.cases_moved_in, b.cans_drawn,
       b.cases_moved_in * s.cans_per_case - b.cans_drawn                    as cans_on_hand,
       b.cases_moved_in - floor(b.cans_drawn / s.cans_per_case)             as cases_in_bin,      -- what the ledger shows (open case counts)
       (b.cans_drawn % s.cans_per_case) > 0                                 as has_open_case,
       coalesce(r.cans, 0)                                                  as cans_per_variety_pack,
       case when coalesce(r.cans,0) > 0
            then floor((b.cases_moved_in * s.cans_per_case - b.cans_drawn) / r.cans) end as variety_packs_possible
  from ops.repack_pairs p
  join ops.repack_bin b on b.case_qbo_item_id = p.case_qbo_item_id
  cross join ops.repack_settings s
  left join ops.repack_variety_recipe r on r.case_qbo_item_id = p.case_qbo_item_id
 where p.active and p.case_qbo_item_id is not null
 order by p.sort_order;
alter view ops.v_repack_bin set (security_invoker = true);
grant select on ops.v_repack_bin to authenticated, service_role;

-- 7 ── health: a bin-only sheet needs no QuickBooks push ---------------------------------------
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
  select count(*) filter (where qbo_required and qbo_txn_id is null),
         count(*) filter (where qbo_required and qbo_txn_id is null and created_at < now() - interval '60 minutes'),
         count(*) filter (where created_at >= date_trunc('month', now()))
    into v_unpushed, v_stale, v_month
    from ops.repack_orders where voided_at is null;
  select qbo_error into v_err from ops.repack_orders
   where voided_at is null and qbo_required and qbo_txn_id is null and qbo_error is not null
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
