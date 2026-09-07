-- Repack accounting, per Sky (2026-09-04, after the first two sheets posted):
--   "when an 8 pack variety is being made and we move cases to variety bin i
--    still want that to be deducted from inventory on the Inventory Shrinkage
--    line -- under Ecommerce Repack. also move the rest of the repacks to that
--    line as well rather than just shrink."
--
-- TWO CHANGES.
--
-- (1) THE ACCOUNT. Every repack adjustment now posts to 1150040010 "Ecommerce
--     Repackaging" — the account the hand-keyed 8/24 repack (QBO ref 500) used —
--     instead of 353 "Inventory Shrinkage". ops.repack_settings is the one
--     place it lives; repack.mjs reads it at push time. The two sheets already
--     in QuickBooks on 353 (RP-2026-00001 → adj 174302, RP-2026-00002 → 174303)
--     are repointed by the new `repoint` action in repack.mjs, which the page
--     offers when a posted sheet's account differs from the setting — the
--     account each sheet was posted to is now stamped on the row
--     (repack_orders.qbo_account_id) so that comparison is a column, not a
--     QuickBooks read. ⚠ QuickBooks has TWO accounts named "Inventory
--     Shrinkage" (353 and 44) and a 328 "Repack - leaking 24pks"; this picks
--     the account the hand repack used. One UPDATE on repack_settings changes it.
--
-- (2) THE BIN DEDUCTS. Until now moving cases into the variety bin was a
--     ledger-only move (Brix Warehouse → VARIETY-BIN, QuickBooks unchanged)
--     and a case left the books only when its 24th can was drawn. Now the case
--     leaves BOTH books the moment it goes into the bin: the ledger movement
--     goes to the Adjustment Counter and the QuickBooks adjustment carries
--     QtyDiff −N for it. The variety draw then moves nothing on either book —
--     the bin's own count (ops.repack_bin, in cans) is the only record of what
--     is inside, and v_repack_bin still says how many variety packs it can
--     make. The VARIETY-BIN ledger location is therefore retired (inactive);
--     it holds zero stock live (RP-2026-00003, the only bin sheet, was voided).
--
-- Consequences worth stating: a bin-only sheet now needs a QuickBooks
-- adjustment (qbo_required=true), "Used in runs/repacks" on Inventory Planning
-- counts cases the day they enter the bin, and the drift strip stays flat
-- because both books move together.
--
-- Applied live 2026-09-04 via apply_migration (repack_accounting_ecommerce_bin_deducts).

-- 1 ── the account -------------------------------------------------------------------
update ops.repack_settings
   set qbo_adjust_account_id = '1150040010', qbo_adjust_account_name = 'Ecommerce Repackaging', updated_at = now()
 where id = 1;

-- 2 ── which account each posted sheet actually went to ---------------------------------
alter table ops.repack_orders add column if not exists qbo_account_id text;
comment on column ops.repack_orders.qbo_account_id is 'QBO AdjustAccountRef the adjustment was posted with (stamped by repack.mjs). Differs from repack_settings → the page offers Move to <account>.';
update ops.repack_orders set qbo_account_id = '353' where qbo_txn_id is not null and qbo_account_id is null;

-- 3 ── the bin location is no longer a ledger location ---------------------------------------
update ops.inventory_locations
   set is_active = false,
       notes = coalesce(notes, '') || ' RETIRED 2026-09-04 (20260904j): a case moved into the variety bin now leaves the ledger and QuickBooks at once; the bin count is ops.repack_bin (cans), read through v_repack_bin.'
 where code = 'VARIETY-BIN' and is_active;

-- 4 ── fn_repack_create: to_bin deducts, variety_draw moves nothing ----------------------------
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
      else v_bin_in := v_bin_in + v_qty; v_qbo := true; end if;   -- 20260904j: a bin move IS a QuickBooks deduction
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
      -- 20260904j (Sky): moving a case into the variety bin takes it OFF the
      -- books — ledger to the Adjustment Counter here, QtyDiff -N on the
      -- QuickBooks adjustment (repack.mjs). The bin's own count lives in
      -- ops.repack_bin (cans), not in a ledger location.
      values ('adjustment', v_item, v_qty, s.location_id, v_adj, 'repack_bin', v_id, now(), v_actor,
              v_num || ' - cases moved into the variety bin (off the books) - ' || trim(p_signed_by_name)) returning id into v_mv;
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
      -- 20260904j: the cases already left the ledger and QuickBooks when they
      -- went INTO the bin, so a draw moves nothing on either book. cases_posted
      -- still records how many whole cases this draw emptied (bin bookkeeping).
      v_mv := null;
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

