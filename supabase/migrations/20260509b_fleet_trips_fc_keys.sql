-- Add fc_asset_id + fc_driver_id text columns to ops.fleet_trips so trips
-- written by sync-fleetcomplete can attribute by Unity UUID without
-- requiring a bigint join from fc_asset_id → fleet_vehicles.id at write
-- time. The legacy bigint vehicle_id / driver_id columns stay (unused for
-- now, available for cross-referencing against ops.staff later).
--
-- Also: drop the conflicting unique constraint candidate. We use
-- fc_trip_id (deterministic sha1 of fc_asset_id + start_time) as the
-- upsert key.

ALTER TABLE ops.fleet_trips
  ADD COLUMN IF NOT EXISTS fc_asset_id  text,
  ADD COLUMN IF NOT EXISTS fc_driver_id text;

CREATE INDEX IF NOT EXISTS fleet_trips_fc_asset_idx ON ops.fleet_trips(fc_asset_id, start_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_trips_fc_trip_id_uniq ON ops.fleet_trips(fc_trip_id);

COMMENT ON COLUMN ops.fleet_trips.fc_asset_id IS
  'Unity vehicle UUID. Populated by sync-fleetcomplete (mode=trips). Joins to ops.fleet_vehicles.fc_asset_id.';
COMMENT ON COLUMN ops.fleet_trips.fc_driver_id IS
  'Unity driver UUID (from CommonFormat.driver.driverId). Joins to ops.fleet_drivers.fc_person_id.';
