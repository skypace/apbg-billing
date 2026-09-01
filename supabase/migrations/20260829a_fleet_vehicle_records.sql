-- 20260829a — Vehicle records on the EXISTING Fleet Complete table.
--
-- ops.fleet_vehicles ALREADY EXISTS and is written every hour by the
-- `sync-fleetcomplete` edge function (upsert on fc_asset_id, 8 named columns:
-- vehicle_name, vin, license_plate, make, model, year, status, synced_at).
-- This migration EXTENDS it rather than creating a second vehicle table,
-- because two lists of the same trucks is how a registration expiry ends up
-- filed against a row nobody reads.
--
-- ⚠ THE FC-OWNED COLUMNS ARE NOT YOURS TO EDIT. vehicle_name / vin /
--   license_plate / make / model / year / status are overwritten on every
--   sync. Fix those in Fleet Complete. Everything added below is untouched
--   by the sync, so it survives. Human hide/show uses archived_at, NOT
--   status, for exactly this reason.
--
-- ⚠ NO UNIQUE INDEX ON vin, deliberately. A duplicate or mistyped VIN would
--   make the hourly upsert throw and take the whole fleet sync down; a
--   duplicate VIN is a data-quality problem, not an outage.

alter table ops.fleet_vehicles
  add column if not exists source              text not null default 'fleetcomplete',
  add column if not exists plate_state         text,
  add column if not exists registration_expires date,
  add column if not exists registration_notes  text,
  add column if not exists odometer_at         timestamptz,
  add column if not exists odometer_source     text,
  add column if not exists last_service_date   date,
  add column if not exists last_service_notes  text,
  add column if not exists next_service_due    date,
  add column if not exists insurance_carrier   text,
  add column if not exists insurance_policy    text,
  add column if not exists entity              text,
  add column if not exists assigned_to         text,
  add column if not exists archived_at         timestamptz,
  add column if not exists archived_by         text,
  add column if not exists updated_at          timestamptz default now();

comment on column ops.fleet_vehicles.source is
  'fleetcomplete = created by the hourly sync (FC owns name/vin/plate/make/model/year/status). manual = keyed in here; the sync never sees it.';
comment on column ops.fleet_vehicles.odometer_at is
  'When the odometer reading was taken. An odometer with no date is a number, not a fact.';
comment on column ops.fleet_vehicles.archived_at is
  'Soft hide. Never delete a vehicle row — its registration and service history are the record for a period we owned it.';

do $$ begin
  alter table ops.fleet_vehicles
    add constraint fleet_vehicles_source_check check (source in ('fleetcomplete','manual'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table ops.fleet_vehicles
    add constraint fleet_vehicles_entity_check
    check (entity is null or entity in ('alameda_soda','brix','freeflow','shared'));
exception when duplicate_object then null; end $$;

create index if not exists fleet_vehicles_reg_expiry_idx
  on ops.fleet_vehicles (registration_expires)
  where archived_at is null and registration_expires is not null;

-- Vehicle documents live in the SAME compliance vault as everything else, so
-- a registration renewal sits beside the COI it is evidence against.
alter table ops.compliance_documents
  add column if not exists vehicle_id bigint references ops.fleet_vehicles(id) on delete set null;

create index if not exists compliance_documents_vehicle_idx
  on ops.compliance_documents (vehicle_id) where vehicle_id is not null;

alter table ops.compliance_documents drop constraint if exists compliance_documents_category_check;
alter table ops.compliance_documents add constraint compliance_documents_category_check
  check (category in ('insurance','permit','food_safety','safety','tax','legal','vehicle','other'));

-- A vehicle document identifies the vehicle, so it needs neither a holder
-- entity nor a third-party party row.
alter table ops.compliance_documents drop constraint if exists compliance_documents_check;
alter table ops.compliance_documents add constraint compliance_documents_check
  check (holder_entity is not null or party_id is not null or vehicle_id is not null);

-- ── Access ────────────────────────────────────────────────────────────────
-- Anon read is REVOKED. Two duplicate `USING (true)` policies made VINs,
-- plates and (now) insurance policy numbers readable with the public anon
-- key alone, on a project that also authenticates brix-order customers and
-- distribution partners. Verified before revoking that nothing depends on
-- it: public/dashboard.html is superadmin-gated and sends its session
-- bearer, and Refractor's Fleet page reads through `sbq`, which sends the
-- caller's own token. Postgres checks GRANTs before RLS, so both go.
drop policy if exists "anon read fleet_vehicles" on ops.fleet_vehicles;
drop policy if exists anon_read_vehicles on ops.fleet_vehicles;
revoke select on ops.fleet_vehicles from anon;

-- Staff may add a vehicle FC cannot see (a truck on the insurance schedule
-- with no telematics unit) and maintain registration / service / insurance.
-- The GRANTs are written next to the policies on purpose — the 20260825a
-- lesson: a policy without a grant is a button that does nothing.
grant insert, update on ops.fleet_vehicles to authenticated;
grant usage, select on sequence ops.fleet_vehicles_id_seq to authenticated;

drop policy if exists fleet_vehicles_staff_write on ops.fleet_vehicles;
create policy fleet_vehicles_staff_write on ops.fleet_vehicles
  for insert to authenticated with check (ops.fn_is_staff());

drop policy if exists fleet_vehicles_staff_update on ops.fleet_vehicles;
create policy fleet_vehicles_staff_update on ops.fleet_vehicles
  for update to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());
