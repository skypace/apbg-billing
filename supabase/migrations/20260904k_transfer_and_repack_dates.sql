-- Dates a person can set, on transfers and on the repack sheet.
--
-- Sky (2026-09-04): "the transfers also dont have a date, they use the system
-- date. I need a date that can be changed. I also need that on the repack
-- screens. need to enter dates or change names on repack screen not just whos
-- logged in."
--
-- A transfer had three dates and NONE of them was the operator's to set: the
-- document date was `created_at` (when the row happened to be typed), and
-- ship/received were stamped CURRENT_DATE by the RPCs, which the UI called
-- with no date at all. Paperwork written up on Monday for a Friday load then
-- reads Monday, on the BOL and in the ledger's own history.
--
--   • ops.inventory_transfers.transfer_date — the DOCUMENT date. Defaults to
--     today, backfilled from created_at for every existing row, and printed as
--     "Issued" on the BOL.
--   • ops.fn_set_transfer_dates(id, transfer, ship, received) — set any of the
--     three, before or after the fact. ⚠ It does NOT move the inventory
--     movements those dates describe: a movement is stamped when it is posted
--     and history is never edited (the reconcile rule). Changing ship_date
--     after shipping corrects the paperwork, not the ledger — the function
--     says so and refuses a ship/received date on a transfer that has not
--     reached that state, so a date cannot imply an event that never happened.
--   • fn_repack_create gains p_repack_date. ⚠ The 4-argument version is
--     DROPPED, not left beside it: with every added argument defaulted, a call
--     naming the old four would match BOTH and Postgres refuses it as
--     ambiguous. The signer NAME was always editable on the sheet (it is
--     prefilled from the login, not locked to it) — the date was the gap.
--
-- Applied live 2026-09-04 (transfer_and_repack_dates).

-- 1 ── the transfer's own document date -------------------------------------------------
alter table ops.inventory_transfers
  add column if not exists transfer_date date not null default (now() at time zone 'America/Los_Angeles')::date;

comment on column ops.inventory_transfers.transfer_date is
  'The document date the operator set (BOL "Issued"). Defaults to today; editable through fn_set_transfer_dates. Not the row''s created_at, and not the date any movement was posted.';

update ops.inventory_transfers
   set transfer_date = (created_at at time zone 'America/Los_Angeles')::date
 where transfer_date = (now() at time zone 'America/Los_Angeles')::date
   and (created_at at time zone 'America/Los_Angeles')::date <> (now() at time zone 'America/Los_Angeles')::date;

-- 2 ── set any of the three dates ---------------------------------------------------------
create or replace function ops.fn_set_transfer_dates(
  p_transfer_id   uuid,
  p_transfer_date date default null,
  p_ship_date     date default null,
  p_received_date date default null
) returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'pg_temp'
as $$
declare t ops.inventory_transfers%rowtype;
begin
  perform ops.fn_assert_internal();
  select * into t from ops.inventory_transfers where id = p_transfer_id for update;
  if t.id is null then raise exception 'transfer not found'; end if;
  if t.status = 'void' then raise exception '% is void', t.bol_number; end if;
  if p_transfer_date is null and p_ship_date is null and p_received_date is null then
    raise exception 'nothing to change';
  end if;
  -- A date must not assert an event that has not happened.
  if p_ship_date is not null and t.status not in ('in_transit','received') then
    raise exception '% has not shipped yet — ship it, then set the date', t.bol_number;
  end if;
  if p_received_date is not null and t.status <> 'received' then
    raise exception '% has not been received yet', t.bol_number;
  end if;
  if p_transfer_date is not null and p_ship_date is not null and p_ship_date < p_transfer_date then
    raise exception 'the ship date cannot be before the transfer date';
  end if;

  update ops.inventory_transfers
     set transfer_date = coalesce(p_transfer_date, transfer_date),
         ship_date     = coalesce(p_ship_date, ship_date),
         received_date = coalesce(p_received_date, received_date),
         updated_at    = now()
   where id = p_transfer_id;

  insert into ops.production_doc_events (doc_type, doc_id, event_type, payload, created_by)
  values ('transfer', p_transfer_id, 'edit',
          jsonb_strip_nulls(jsonb_build_object('transfer_date', p_transfer_date, 'ship_date', p_ship_date, 'received_date', p_received_date)),
          auth.uid());

  select * into t from ops.inventory_transfers where id = p_transfer_id;
  return jsonb_build_object('id', t.id, 'bol_number', t.bol_number,
    'transfer_date', t.transfer_date, 'ship_date', t.ship_date, 'received_date', t.received_date);
end $$;
revoke all on function ops.fn_set_transfer_dates(uuid, date, date, date) from public, anon;
grant execute on function ops.fn_set_transfer_dates(uuid, date, date, date) to authenticated, service_role;

-- 3 ── the repack sheet carries its own date ---------------------------------------------
-- ops.repack_orders.repack_date ALREADY EXISTED and already drives the
-- QuickBooks adjustment's TxnDate (repack.mjs) — it was simply never settable:
-- fn_repack_create left it to the column default, so every sheet was stamped
-- the day it was typed. A 5th argument is the whole fix.
--
-- ⚠ This is an anchor-checked READ-MODIFY-WRITE of the LIVE definition, not a
--   pasted body — the house pattern (fn_items_master, fn_sync_health_extra).
--   fn_repack_create is 150 lines of ledger and variety-bin arithmetic that
--   20260904a/b/c/j each edited; re-typing it here to add one parameter is how
--   a transcription slip silently reverts one of those. Every anchor must
--   match EXACTLY ONCE or the migration raises and changes nothing.
--
-- ⚠ The 4-argument signature is DROPPED at the end. With every added argument
--   defaulted, a call naming the old four would match BOTH and Postgres
--   refuses it as ambiguous (42725) — which is exactly what a stray overload of
--   fn_create_transfer did to this session's own first attempt at raising a
--   transfer. PostgREST calls this by NAMED arguments, so the four-key call in
--   repack.mjs keeps resolving to the new signature.
--
-- ⚠ The movements keep occurred_at = now(). A movement is stamped when it is
--   POSTED and ledger history is not edited (the reconcile rule); repack_date
--   is the document's date, the same split transfer_date makes above. It is
--   the date QuickBooks receives, which is what a backdated sheet is for.

do $mig$
declare
  src text;
  n   int;

  procedure_anchor text;
  a_sig_from text := 'p_notes text DEFAULT NULL::text)';
  a_sig_to   text := 'p_notes text DEFAULT NULL::text, p_repack_date date DEFAULT NULL::date)';

  a_dec_from text := '  v_email    text := coalesce(auth.jwt()->>''email'', null);';
  a_dec_to   text := '  v_email    text := coalesce(auth.jwt()->>''email'', null);' || E'\n'
                  || '  v_today    date := (now() at time zone ''America/Los_Angeles'')::date;' || E'\n'
                  || '  v_date     date := coalesce(p_repack_date, (now() at time zone ''America/Los_Angeles'')::date);';

  a_grd_from text := '    raise exception ''signed_by_name is required — the sheet says who did the repack'';' || E'\n' || '  end if;';
  a_grd_to   text := '    raise exception ''signed_by_name is required — the sheet says who did the repack'';' || E'\n'
                  || '  end if;' || E'\n'
                  || '  -- A sheet records work that has been DONE. A future date would also post' || E'\n'
                  || '  -- a QuickBooks adjustment into a period that has not happened.' || E'\n'
                  || '  if v_date > v_today then' || E'\n'
                  || '    raise exception ''the repack date cannot be in the future (got %, today is %)'', v_date, v_today;' || E'\n'
                  || '  end if;';

  a_col_from text := 'insert into ops.repack_orders (id, repack_number, location_id, cans_in,';
  a_col_to   text := 'insert into ops.repack_orders (id, repack_number, location_id, repack_date, cans_in,';

  a_val_from text := 'values (v_id, v_num, s.location_id, v_cases_in * s.cans_per_case,';
  a_val_to   text := 'values (v_id, v_num, s.location_id, v_date, v_cases_in * s.cans_per_case,';

  a_ret_from text := '''id'', v_id, ''repack_number'', v_num,';
  a_ret_to   text := '''id'', v_id, ''repack_number'', v_num, ''repack_date'', v_date,';
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
   where nsp.nspname = 'ops' and p.proname = 'fn_repack_create'
     and pg_get_function_identity_arguments(p.oid) = 'p_lines jsonb, p_signed_by_name text, p_signature_data text, p_notes text';
  if src is null then
    raise exception 'the 4-argument ops.fn_repack_create was not found — has it already been migrated?';
  end if;

  -- Every anchor exactly once, or stop.
  foreach procedure_anchor in array array[a_sig_from, a_dec_from, a_grd_from, a_col_from, a_val_from, a_ret_from]
  loop
    n := (length(src) - length(replace(src, procedure_anchor, ''))) / nullif(length(procedure_anchor), 0);
    if n <> 1 then
      raise exception 'anchor matched % times, expected 1: %', n, left(procedure_anchor, 60);
    end if;
  end loop;

  src := replace(src, a_sig_from, a_sig_to);
  src := replace(src, a_dec_from, a_dec_to);
  src := replace(src, a_grd_from, a_grd_to);
  src := replace(src, a_col_from, a_col_to);
  src := replace(src, a_val_from, a_val_to);
  src := replace(src, a_ret_from, a_ret_to);

  execute src;
end
$mig$;

-- Only once the 5-arg exists, so a failed transform above leaves the live one alone.
drop function if exists ops.fn_repack_create(jsonb, text, text, text);

revoke all on function ops.fn_repack_create(jsonb, text, text, text, date) from public, anon;
grant execute on function ops.fn_repack_create(jsonb, text, text, text, date) to authenticated, service_role;
