-- 20260829b — Link a Fleet Complete asset to the actual vehicle it is attached to.
--
-- Fleet Complete's asset list is a list of DEVICES, not of trucks. Three of the
-- ten assets on this account are not vehicles at all: two are unpaired trackers
-- whose asset name is the device serial, and one is a SECOND device on a truck
-- that already has its own asset record. Left alone the fleet reads as ten
-- vehicles when we own six, and an insurance schedule reconciled against it
-- comes out wrong.
--
-- linked_vehicle_id points a duplicate/secondary asset at the row that IS the
-- vehicle. It is ours, not Fleet Complete's — the hourly upsert never touches
-- it, so the link survives the sync rewriting the asset's name.

alter table ops.fleet_vehicles
  add column if not exists linked_vehicle_id bigint references ops.fleet_vehicles(id) on delete set null;

comment on column ops.fleet_vehicles.linked_vehicle_id is
  'This Fleet Complete asset is a second/older device on the vehicle in this row, not a vehicle of its own. Set it and the asset stops being counted as a vehicle.';

-- A row cannot be a duplicate of itself. Deliberately NOT a full cycle check:
-- one hop is all this models, and a trigger to police longer chains would be
-- more machinery than the problem deserves.
do $$ begin
  alter table ops.fleet_vehicles
    add constraint fleet_vehicles_link_not_self check (linked_vehicle_id is null or linked_vehicle_id <> id);
exception when duplicate_object then null; end $$;

create index if not exists fleet_vehicles_linked_idx
  on ops.fleet_vehicles (linked_vehicle_id) where linked_vehicle_id is not null;
