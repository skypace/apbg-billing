-- Repack: NEVER an uneven 8-pack. Cans in must equal cans out.
--
-- Sky (2026-09-04), on the first cut of the sheet: "we should only be doing exact
-- 8 packs that match the 24 pack count. so dont ever make uneven 8 packs. the
-- system should tell you that you have to make even 8 packs. or allow you to
-- convert some of the unevens into 8 pack variety."
--
-- The first cut let a sheet be unbalanced with a note ("8 loose cans to the
-- tasting fridge"), because the 8/24 hand-keyed sheet had not balanced. That
-- was the wrong lesson: the sheet did not balance because nobody had a tool
-- forcing it to. Now the arithmetic does the work —
--
--   a case is 24 cans = exactly 3 eight-packs, so for each flavour
--       leftover cans = 24 x cases - 8 x flavour packs
--   is always a multiple of 8 (or negative, which means more packs than the
--   cases hold — refused). Every leftover can goes into the VARIETY 8-pack, and
--   the variety count is therefore total leftover / 8, always whole. No 24-pack
--   variety item is needed; variety is MADE from the flavours' leftovers.
--
-- Rules the function enforces (the page derives the variety count from the
-- same arithmetic, so a human never types it):
--   1. flavour packs <= 3 x that flavour's cases (cannot make more than you broke)
--   2. cans in = cans out exactly; the message says how many variety packs the
--      leftover is, so the fix is one number away
--   3. variance notes are gone — there is nothing to explain any more
--
-- The 4-arg signature replaces the 5-arg one (p_variance_note dropped).

alter table ops.repack_orders drop constraint if exists repack_orders_balanced;
alter table ops.repack_orders add constraint repack_orders_balanced check (cans_in = cans_out and cans_unaccounted = 0) not valid;

drop function if exists ops.fn_repack_create(jsonb, text, text, text, text);

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
  v_ppc      numeric;           -- packs per case, derived: cans_per_case / cans_per_pack
  v_cases    numeric;
  v_packs    numeric;
  v_left     numeric;
  pr         record;
begin
  perform ops.fn_assert_staff_or_service();

  select * into s from ops.repack_settings where id = 1;
  if s.id is null then raise exception 'repack settings row missing (ops.repack_settings id=1)'; end if;
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

  -- Rule 1: a flavour cannot yield more packs than its cases hold.
  for pr in
    select p.label, p.pack_qbo_item_id, p.case_qbo_item_id,
           coalesce((select sum((l->>'qty')::numeric) from jsonb_array_elements(p_lines) l
                      where l->>'kind' = 'consume' and l->>'qbo_item_id' = p.case_qbo_item_id), 0) as cases,
           coalesce((select sum((l->>'qty')::numeric) from jsonb_array_elements(p_lines) l
                      where l->>'kind' = 'produce' and l->>'qbo_item_id' = p.pack_qbo_item_id), 0) as packs
      from ops.repack_pairs p where p.active and p.case_qbo_item_id is not null
  loop
    if pr.packs > pr.cases * v_ppc then
      raise exception '% 8-packs of % need % case(s); the sheet only breaks down % — a case makes exactly % packs',
        pr.packs, pr.label, ceil(pr.packs / v_ppc)::int, pr.cases, v_ppc::int;
    end if;
  end loop;

  -- Rule 2: every can breaks into a pack. The leftover is always a multiple of
  -- the pack size (each flavour's leftover is), so it is always whole variety packs.
  if v_in <> v_out then
    v_left := v_in - v_out;
    if v_left > 0 then
      raise exception 'cans in (%) and cans out (%) do not match: % leftover can(s) = % more variety 8-pack(s) to make — no loose cans, no uneven packs',
        v_in, v_out, v_left, (v_left / s.cans_per_pack)::int;
    else
      raise exception 'cans out (%) exceed cans in (%) by % — % more case(s) must be broken down, or % fewer pack(s) made',
        v_out, v_in, -v_left, ceil(-v_left / s.cans_per_case)::int, (-v_left / s.cans_per_pack)::int;
    end if;
  end if;

  v_num := 'RP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('ops.repack_seq')::text, 5, '0');

  insert into ops.repack_orders (id, repack_number, location_id, cans_in, cans_out, cans_unaccounted,
                                 variance_note, notes, signed_by_name, signed_by_email, signature_data, created_by)
  values (v_id, v_num, s.location_id, v_in, v_out, 0,
          null, nullif(trim(p_notes), ''), trim(p_signed_by_name), v_email,
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
    'lines', v_no, 'warnings', to_jsonb(v_warn),
    'qbo_adjust_account_id', s.qbo_adjust_account_id, 'qbo_adjust_account_name', s.qbo_adjust_account_name);
end;
$$;
revoke all on function ops.fn_repack_create(jsonb, text, text, text) from public, anon;
grant execute on function ops.fn_repack_create(jsonb, text, text, text) to authenticated, service_role;
