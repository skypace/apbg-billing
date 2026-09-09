-- 20260909d — one asset line, composed once
--
-- Ask (Sky): "anywhere outside of the order module, I would like to have the
-- equipment show up as The asset line, which is the model make and serial and
-- then the contract ID and when you click on them, they go into that actual
-- piece of equipment that should be mirrored and SD and in refractor under the
-- customer".
--
-- ⚠ THE CONTRACT NUMBER WAS ALREADY BEING ECHOED AND NOTHING JOINED IT.
-- `ops.equipment_contracts` holds 168 rows, every one with a `contract_number`
-- (C-2026-00178, QBO-RT-100476, 558462521A — native, QuickBooks-derived and
-- legacy-paperwork numbers all readable). So this needed no schema widening
-- and no change to the ERLS sync: it is a JOIN and a display. Same shape as
-- `sub_distributor_accounts` (a working screen, zero rows, nothing read it),
-- `job_tasks`/`job_notes` (declared and abandoned) and `techs.map_symbol`
-- (filled the day it was asked for, unread for four days).
--
-- ⚠ AND `equipment_assets.contract_id` IS A UUID, WHICH IS NOT AN ID A HUMAN
-- READS. A screen printing it would satisfy the letter of the ask and none of
-- its point. It is also a foreign key into a DIFFERENT Supabase project
-- (ERLS), so it cannot be resolved anywhere but here, against the echo.
--
-- ⚠ DO NOT CONFUSE THIS CONTRACT WITH `ops.pricing_contracts`. BrixSD's
-- customer profile already returns a `contracts` array and it is the PRICING
-- contract — Refractor's price book. An equipment lease and a price book share
-- one English word and nothing else; joining or merging them would put a
-- price-book name where a lease number belongs.
--
-- WHY THE COMPOSITION LIVES IN SQL. Three surfaces want this line (BrixSD's
-- customer page, BrixSD's job record, Refractor's customer page) and they are
-- in two repos with no shared module — one is plain HTML talking to PostgREST,
-- the other a React/Vite bundle. Formatting it three times is the drift this
-- estate keeps paying for (`componentSourcing.ts` was extracted after three
-- screens each re-implemented the price/vendor precedence, `pm-pricing.mjs`
-- after the same rule disagreed with itself in four places). The join and the
-- fallbacks are SQL-side anyway, so this is where the one implementation goes.
--
-- MEASURED FIRST, because the fallbacks are the whole design (154 assets):
--   make 149 · model 144 · serial 121 · contract 137 · description 35
--   asset_tag  2   ← essentially empty, so the line must NOT lead with it
--   5 carry neither make nor model · 33 no serial · 17 on no contract
--   17 unlinked and 0 broken links, so a missing contract is a real state
--   (company-owned gear that is not rented), never a data fault to hide.
-- A line that reads "Equipment — · #— · —" is worse than one that says which
-- of those three facts we do not have, so each blank is named in words.

create or replace view ops.v_equipment_line as
select
  e.id,
  e.qbo_customer_id,
  e.source_customer_id,

  -- IDENTITY, and it can never be blank. Sky's "model make" is the useful
  -- half on 149 of 154 rows; the ladder below it is what `fn_customer_equipment`
  -- already used for its description, kept so the two cannot disagree.
  coalesce(
    nullif(btrim(concat_ws(' ', nullif(btrim(e.make), ''),
                                nullif(btrim(e.model_number), ''))), ''),
    nullif(btrim(e.catalog_name), ''),
    nullif(btrim(e.qbo_item_name), ''),
    nullif(btrim(e.description), ''),
    'Equipment ' || coalesce(nullif(btrim(e.asset_tag), ''), left(e.id::text, 8))
  ) as make_model,

  nullif(btrim(e.make), '')          as make,
  nullif(btrim(e.model_number), '')  as model_number,
  nullif(btrim(e.serial_number), '') as serial_number,
  nullif(btrim(e.asset_tag), '')     as asset_tag,

  -- THE CONTRACT NUMBER A PERSON READS. `agreement_number` is what ERLS
  -- prints on the customer's paperwork and `contract_number` is its internal
  -- one; measured on ERLS today the agreement number is set on 6 of 171 rows
  -- and EQUALS the contract number on all 6, so this coalesce changes nothing
  -- yet and is right the day they diverge.
  e.contract_id,
  coalesce(nullif(btrim(c.agreement_number), ''),
           nullif(btrim(c.contract_number), '')) as contract_number,
  c.contract_type,
  c.status      as contract_status,
  c.start_date  as contract_start,
  c.end_date    as contract_end,
  c.external_document_url as contract_document_url,

  -- THE WHOLE LINE, as one string. A surface may print this, or build from the
  -- parts above — but it must not invent a fourth ladder of its own, which is
  -- the only reason this column exists next to its own components.
  concat_ws(' · ',
    coalesce(
      nullif(btrim(concat_ws(' ', nullif(btrim(e.make), ''),
                                  nullif(btrim(e.model_number), ''))), ''),
      nullif(btrim(e.catalog_name), ''),
      nullif(btrim(e.qbo_item_name), ''),
      nullif(btrim(e.description), ''),
      'Equipment ' || coalesce(nullif(btrim(e.asset_tag), ''), left(e.id::text, 8))
    ),
    case when nullif(btrim(e.serial_number), '') is not null
         then '#' || btrim(e.serial_number)
         else 'no serial on file' end,
    case when coalesce(nullif(btrim(c.agreement_number), ''),
                       nullif(btrim(c.contract_number), '')) is not null
         then coalesce(nullif(btrim(c.agreement_number), ''),
                       nullif(btrim(c.contract_number), ''))
         else 'not on a contract' end
  ) as asset_line,

  e.category,
  e.qbo_item_name,
  e.catalog_name,
  e.description,
  e.vendor,
  e.qty,
  e.monthly_rent,
  e.ownership_type,
  e.status,
  e.is_loaner,
  e.installed_at,
  e.removed_at,
  (e.removed_at is null) as on_site,
  e.useful_life_months,
  e.image_url,
  e.spec_sheet_url,
  e.service_fusion_equipment_id,
  e.synced_at
from ops.equipment_assets e
left join ops.equipment_contracts c on c.id = e.contract_id;

comment on view ops.v_equipment_line is
  'One composition of the equipment asset line (make/model, serial, contract '
  'number) for every surface outside the order module — BrixSD customers and '
  'job records, Refractor customers. The contract number comes from the '
  'ops.equipment_contracts echo, NOT ops.pricing_contracts (a price book is '
  'not a lease). Read this rather than formatting a line of your own.';

-- security_invoker so the caller's own RLS decides which assets they see. The
-- base tables carry a restrictive no-distributor policy and this view must
-- inherit it rather than running as the owner and handing a sub-distributor
-- login every customer's rent.
alter view ops.v_equipment_line set (security_invoker = true);

revoke all on ops.v_equipment_line from public;
grant select on ops.v_equipment_line to authenticated, service_role;


-- The single asset, for the click-through. A function rather than letting each
-- surface filter the view, because "open this asset" is one question and both
-- repos should be asking it the same way — and because this is the natural
-- place to refuse an id that is not a uuid rather than handing PostgREST a
-- malformed filter (which comes back as a 400 and reads as a broken screen;
-- brix-order paid for that exact confusion in its 1.105 addendum).
create or replace function ops.fn_equipment_asset(p_asset_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ops, public
as $fn$
  select to_jsonb(v) from ops.v_equipment_line v where v.id = p_asset_id;
$fn$;

revoke all on function ops.fn_equipment_asset(uuid) from public;
grant execute on function ops.fn_equipment_asset(uuid) to authenticated, service_role;


-- ⚠ ANON COULD READ THE WHOLE FLEET, AND THAT IS NOT A DISPLAY DETAIL.
-- Both echo tables carried `SELECT` to `anon` plus a permissive `USING (true)`
-- read policy, so every serial, every customer's equipment and every
-- `monthly_rent` was readable with the public anon key that ships in every
-- bundle on this shared project. Per-customer rent is commercial terms, and
-- ERLS bills off exactly these rows.
--
-- This repo has revoked the same exposure twice: `ops.qbo_invoices`/`_lines`
-- (20260820b F2, "the full invoice mirror was readable with just the public
-- anon key") and `ops.fleet_vehicles` (2026-08-29, VINs, plates and insurance
-- policy numbers). Same bucket, same fix.
--
-- Checked before revoking, the 2026-08-29 rule — nothing reads these
-- unauthenticated:
--   · brix-order's customer Equipment page reads `orders.v_equipment_assets`,
--     which is `security_invoker=true` and reached by a signed-in customer,
--     i.e. `authenticated`; `authenticated` keeps SELECT here.
--   · brix-order's closure gate, `customer-group-assets` and the mirror sync
--     itself all run on the service-role key.
--   · BrixSD reads through `dispatch.fn_customer_equipment` /
--     `core.fn_customer_profile` under a gateway JWT.
--   · Refractor reads as staff.
revoke select on ops.equipment_assets    from anon;
revoke select on ops.equipment_contracts from anon;
drop policy if exists equipment_assets_read    on ops.equipment_assets;
drop policy if exists equipment_contracts_read on ops.equipment_contracts;
create policy equipment_assets_read on ops.equipment_assets
  for select to authenticated using (true);
create policy equipment_contracts_read on ops.equipment_contracts
  for select to authenticated using (true);


-- Prove the composition against the live data rather than trusting it. Each
-- number here was measured before the view was written; if the fallbacks stop
-- working the migration fails instead of shipping a screen full of dashes.
do $assert$
declare
  v_rows integer; v_blank integer; v_contract integer; v_serial_note integer;
begin
  select count(*),
         count(*) filter (where coalesce(btrim(make_model), '') = ''),
         count(contract_number),
         count(*) filter (where asset_line like '%no serial on file%')
    into v_rows, v_blank, v_contract, v_serial_note
    from ops.v_equipment_line;

  if v_rows = 0 then
    raise exception 'ops.v_equipment_line returned no rows — the join is wrong '
                    'or the mirror is empty (fn_equipment_mirror_health reds on '
                    'an empty mirror; check it before reading this as a view bug)';
  end if;
  if v_blank > 0 then
    raise exception '% asset lines have a BLANK identity — the fallback ladder '
                    'is broken; a line must never render as a dash', v_blank;
  end if;
  if v_contract = 0 then
    raise exception 'not one asset resolved a contract number — the join to '
                    'ops.equipment_contracts is wrong (137 of 154 resolved when '
                    'this was written)';
  end if;
  raise notice 'v_equipment_line: % assets, % with a contract number, % with no serial',
    v_rows, v_contract, v_serial_note;
end;
$assert$;
